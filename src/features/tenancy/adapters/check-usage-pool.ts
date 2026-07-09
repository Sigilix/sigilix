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
  weeklyWindowStartMs,
  type UsageMeterMode,
  type UsagePool,
} from "@/src/features/tenancy/domain/usage-meters"
import { resolveTierCostBudgetUsd, decideCostBudget } from "@/src/features/tenancy/domain/rate-limit"
import { readUsageEventCount, readUsageEventCostSince } from "@/src/features/tenancy/adapters/d1-usage-events-read"
import { readTenantUsageSince } from "@/src/features/tenancy/adapters/d1-usage-read"

export interface UsagePoolWindowState {
  used: number
  cap: number | null
  /** sig-cost-based-metering: summed USD spend in the window (present when a `tier`
   *  was supplied so the cost dimension is evaluated; else absent). */
  usedCostUsd?: number
  /** The tier's USD budget for this window (null = UNBOUNDED). Present with usedCostUsd. */
  costBudgetUsd?: number | null
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
 * Sum a pool's total COST (USD) in [sinceIso, now] — the same meter membership as
 * `readPoolTotal`, but dollars instead of counts (sig-cost-based-metering). SEAT =
 * coding_agent + chatbot cost (usage_events); ORG = pr_reviews cost (usage_ledger)
 * + linear_triage + slack cost (usage_events). Returns `null` on ANY read fault so
 * the caller fails open (a partial read must not under-count and wrongly block).
 */
async function readPoolCost(
  env: CheckEnv,
  pool: UsagePool,
  scope: { installationId?: number; userKey?: string },
  sinceIso: string,
): Promise<number | null> {
  if (pool === "seat") {
    if (scope.userKey === undefined) return 0
    const [agent, chat] = await Promise.all([
      readUsageEventCostSince(env, { meter: "coding_agent", userKey: scope.userKey, sinceIso }),
      readUsageEventCostSince(env, { meter: "chatbot", userKey: scope.userKey, sinceIso }),
    ])
    if (!agent.ok || !chat.ok) return null
    return agent.costUsd + chat.costUsd
  }
  // org
  if (scope.installationId === undefined) return 0
  const [reviews, triage, slack] = await Promise.all([
    readTenantUsageSince(env, scope.installationId, sinceIso),
    readUsageEventCostSince(env, { meter: "linear_triage", installationId: scope.installationId, sinceIso }),
    readUsageEventCostSince(env, { meter: "slack", installationId: scope.installationId, sinceIso }),
  ])
  if (!reviews.ok || !triage.ok || !slack.ok) return null
  return reviews.costUsd + triage.costUsd + slack.costUsd
}

/**
 * Orchestrate the pool admission decision for BOTH windows. Never throws — the
 * whole body is wrapped so any unexpected error logs a warn and fails open.
 *
 * COST DIMENSION (sig-cost-based-metering): when `tier` is supplied, the pool is
 * ALSO gated on DOLLARS — the window's summed model spend vs the tier's per-window
 * cost budget (`resolveTierCostBudgetUsd`, trial-reduced when `trialing`). This is
 * how a FREE seat's CLI (coding_agent) + chatbot usage gets the same cost cap as the
 * org PR pool: both are blocked when spend reaches the tier budget. `enterprise` →
 * null budget → never cost-blocked. When `tier` is OMITTED the cost gate is inert
 * (count-only, unchanged) — the seam is opt-in per call site. Cost fails open on its
 * own read fault, independent of the count read.
 */
export async function checkUsagePool(
  env: CheckEnv,
  args: {
    pool: UsagePool
    installationId?: number
    userKey?: string
    nowMs: number
    tier?: string | null
    trialing?: boolean
  },
): Promise<UsagePoolDecision> {
  const mode = resolveUsageMeterMode(env)
  const capSession = resolveUsagePoolCap(env, args.pool, "session")
  const capWeekly = resolveUsagePoolCap(env, args.pool, "weekly")
  // Cost gate is opt-in: only when the caller supplies a tier. Budgets are null when
  // off so the cost dimension never blocks (and the window state omits cost fields).
  const costOn = args.tier !== undefined
  const costBudgetSession = costOn ? resolveTierCostBudgetUsd(env, args.tier ?? null, "session", args.trialing) : null
  const costBudgetWeekly = costOn ? resolveTierCostBudgetUsd(env, args.tier ?? null, "weekly", args.trialing) : null

  const allow = (usedSession = 0, usedWeekly = 0, costSession = 0, costWeekly = 0): UsagePoolDecision => ({
    allowed: true,
    mode,
    pool: args.pool,
    session: {
      used: usedSession,
      cap: capSession,
      ...(costOn ? { usedCostUsd: costSession, costBudgetUsd: costBudgetSession } : {}),
    },
    weekly: {
      used: usedWeekly,
      cap: capWeekly,
      ...(costOn ? { usedCostUsd: costWeekly, costBudgetUsd: costBudgetWeekly } : {}),
    },
  })

  try {
    if (mode === "off") return allow()

    const scope: { installationId?: number; userKey?: string } = {}
    if (args.installationId !== undefined) scope.installationId = args.installationId
    if (args.userKey !== undefined) scope.userKey = args.userKey
    // Session = 5h ROLLING; weekly = since the most recent Monday-09:00 UTC anchor
    // (a FIXED weekly reset, not a rolling 7d — see usage-meters.ts).
    const sinceSession = new Date(args.nowMs - USAGE_SESSION_WINDOW_MS).toISOString()
    const sinceWeekly = new Date(weeklyWindowStartMs(args.nowMs)).toISOString()
    const [usedSession, usedWeekly, costSession, costWeekly] = await Promise.all([
      readPoolTotal(env, args.pool, scope, sinceSession),
      readPoolTotal(env, args.pool, scope, sinceWeekly),
      costOn ? readPoolCost(env, args.pool, scope, sinceSession) : Promise.resolve(0),
      costOn ? readPoolCost(env, args.pool, scope, sinceWeekly) : Promise.resolve(0),
    ])

    // Any COUNT-read fault → fail open (never block on a read error).
    if (usedSession === null || usedWeekly === null) {
      console.log(JSON.stringify({ event: "usage-pool-read-failed", pool: args.pool, mode }))
      return allow()
    }
    // A cost-read fault fails open on the cost dimension ONLY (0 → decideCostBudget
    // allows); the count gate still applies. Coalesce null → 0 for that reason.
    const cS = costSession ?? 0
    const cW = costWeekly ?? 0

    const countAllowed = decideUsagePool({ usedSession, capSession, usedWeekly, capWeekly })
    const costAllowed = !costOn || (decideCostBudget(cS, costBudgetSession) && decideCostBudget(cW, costBudgetWeekly))
    const rawAllowed = countAllowed && costAllowed
    if (rawAllowed) return { ...allow(usedSession, usedWeekly, cS, cW), allowed: true }

    const limitedBy = !costAllowed ? "cost" : "count"

    // Over cap — shadow observes but never blocks; enforce fires.
    if (mode === "shadow") {
      console.log(
        JSON.stringify({
          event: "usage-pool-would-block",
          pool: args.pool,
          limitedBy,
          usedSession,
          usedWeekly,
          capSession,
          capWeekly,
          costSession: cS,
          costWeekly: cW,
          costBudgetSession,
          costBudgetWeekly,
        }),
      )
      return { ...allow(usedSession, usedWeekly, cS, cW), allowed: true }
    }
    console.log(
      JSON.stringify({
        event: "usage-pool-blocked",
        pool: args.pool,
        limitedBy,
        usedSession,
        usedWeekly,
        capSession,
        capWeekly,
        costSession: cS,
        costWeekly: cW,
        costBudgetSession,
        costBudgetWeekly,
      }),
    )
    return { ...allow(usedSession, usedWeekly, cS, cW), allowed: false }
  } catch (err) {
    console.warn(JSON.stringify({ event: "usage-pool-check-failed", pool: args.pool, err: String(err) }))
    return allow()
  }
}
