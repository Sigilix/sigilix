// SIG-303 full usage metering — pool gate orchestrator (adapter layer).
//
// Composes the domain knobs (usage-meters) + the read adapters into a single,
// never-throws admission decision for a POOL (org or seat). Fail-open at every
// layer, mirroring checkRateLimit:
//   • mode=off        → immediate allow, zero I/O.
//   • missing scope   → allow (never pretend a pool without its key).
//   • any read fault  → allow + log (a DB hiccup must never block work).
//   • shadow mode     → always allows; carries real numbers for telemetry/UI.
//   • enforce mode     → real gate; allowed:false when the pool total is at/over
//                         cap in EITHER window.
//
// GRACE POLICY (founder): callers invoke this at the START of a new run/request.
// Because usage is only ever read here (the row for THIS work is appended
// separately, after admission), an in-flight run is never aborted — the gate only
// ever blocks the NEXT admission. A user interrupt is handled by the caller's own
// cancel path, not here.

import type { Env } from "@/src/shared/types/env"
import {
  resolveUsageMeterMode,
  resolveUsagePoolCap,
  decideUsagePool,
  USAGE_SESSION_WINDOW_MS,
  USAGE_WEEKLY_WINDOW_MS,
  type UsageMeterMode,
  type UsagePool,
} from "@/src/features/tenancy/domain/usage-meters"
import { readUsageEventCount } from "@/src/features/tenancy/adapters/d1-usage-events-read"
import { readTenantUsageSince } from "@/src/features/tenancy/adapters/d1-usage-read"

export interface UsagePoolWindowState {
  used: number
  cap: number | null
}

export interface UsagePoolDecision {
  /** What the CALLER should do: shadow → always true; enforce → real decision. */
  allowed: boolean
  mode: UsageMeterMode
  pool: UsagePool
  session: UsagePoolWindowState
  weekly: UsagePoolWindowState
}

type CheckEnv = Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_USAGE_METER_MODE"> & Partial<Env>

/**
 * Sum a pool's total events in [sinceIso, now]. Returns `null` on ANY read fault
 * (so the caller can fail-open) — a partial/fault read must not under-count and
 * wrongly block. ORG = pr_reviews (usage_ledger) + linear_triage + slack
 * (usage_events); SEAT = coding_agent + chatbot (usage_events).
 */
async function readPoolTotal(
  env: CheckEnv,
  pool: UsagePool,
  scope: { installationId?: number; userKey?: string },
  sinceIso: string,
): Promise<number | null> {
  if (pool === "seat") {
    if (scope.userKey === undefined) return 0
    const [agent, chat] = await Promise.all([
      readUsageEventCount(env, { meter: "coding_agent", userKey: scope.userKey, sinceIso }),
      readUsageEventCount(env, { meter: "chatbot", userKey: scope.userKey, sinceIso }),
    ])
    if (!agent.ok || !chat.ok) return null
    return agent.count + chat.count
  }
  // org
  if (scope.installationId === undefined) return 0
  const [reviews, triage, slack] = await Promise.all([
    readTenantUsageSince(env, scope.installationId, sinceIso),
    readUsageEventCount(env, { meter: "linear_triage", installationId: scope.installationId, sinceIso }),
    readUsageEventCount(env, { meter: "slack", installationId: scope.installationId, sinceIso }),
  ])
  if (!reviews.ok || !triage.ok || !slack.ok) return null
  return reviews.reviews + triage.count + slack.count
}

/**
 * Orchestrate the pool admission decision for BOTH windows. Never throws — the
 * whole body is wrapped so any unexpected error logs a warn and fails open.
 */
export async function checkUsagePool(
  env: CheckEnv,
  args: { pool: UsagePool; installationId?: number; userKey?: string; nowMs: number },
): Promise<UsagePoolDecision> {
  const mode = resolveUsageMeterMode(env)
  const capSession = resolveUsagePoolCap(env, args.pool, "session")
  const capWeekly = resolveUsagePoolCap(env, args.pool, "weekly")

  const allow = (usedSession = 0, usedWeekly = 0): UsagePoolDecision => ({
    allowed: true,
    mode,
    pool: args.pool,
    session: { used: usedSession, cap: capSession },
    weekly: { used: usedWeekly, cap: capWeekly },
  })

  try {
    if (mode === "off") return allow()

    const scope: { installationId?: number; userKey?: string } = {}
    if (args.installationId !== undefined) scope.installationId = args.installationId
    if (args.userKey !== undefined) scope.userKey = args.userKey
    const sinceSession = new Date(args.nowMs - USAGE_SESSION_WINDOW_MS).toISOString()
    const sinceWeekly = new Date(args.nowMs - USAGE_WEEKLY_WINDOW_MS).toISOString()
    const [usedSession, usedWeekly] = await Promise.all([
      readPoolTotal(env, args.pool, scope, sinceSession),
      readPoolTotal(env, args.pool, scope, sinceWeekly),
    ])

    // Any fault → fail open (never block on a read error).
    if (usedSession === null || usedWeekly === null) {
      console.log(JSON.stringify({ event: "usage-pool-read-failed", pool: args.pool, mode }))
      return allow()
    }

    const rawAllowed = decideUsagePool({ usedSession, capSession, usedWeekly, capWeekly })
    if (rawAllowed) return { ...allow(usedSession, usedWeekly), allowed: true }

    // Over cap — shadow observes but never blocks; enforce fires.
    if (mode === "shadow") {
      console.log(
        JSON.stringify({
          event: "usage-pool-would-block",
          pool: args.pool,
          usedSession,
          usedWeekly,
          capSession,
          capWeekly,
        }),
      )
      return { ...allow(usedSession, usedWeekly), allowed: true }
    }
    console.log(
      JSON.stringify({ event: "usage-pool-blocked", pool: args.pool, usedSession, usedWeekly, capSession, capWeekly }),
    )
    return {
      allowed: false,
      mode,
      pool: args.pool,
      session: { used: usedSession, cap: capSession },
      weekly: { used: usedWeekly, cap: capWeekly },
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: "usage-pool-check-failed", pool: args.pool, err: String(err) }))
    return allow()
  }
}
