// SIG-38 free-launch caps — Linear-triage rate-limit decision orchestrator (adapter layer).
//
// Mirrors `check-rate-limit.ts` (the PR-review orchestrator) but keyed by a
// Linear `teamId` instead of (installationId, authorLogin), and counted
// against the separate `triage_usage_ledger` table so the PR-review cap and
// the Linear-triage cap are fully independent — hitting one never consumes
// the other's budget. Shares `resolveRateLimitMode` / `SIGILIX_RATE_LIMIT_MODE`
// with the PR-review gate (one flag governs both surfaces), but the window,
// cap, and ledger are all separate.
//
// Fail-open at every layer, same contract as checkRateLimit:
//   • mode=off    → immediate allow, zero I/O.
//   • teamId blank → immediate allow (never pretend per-team without one).
//   • D1 fault    → allow + log (a DB hiccup must never block a triage).
//   • shadow mode → always allows; carries real numbers for telemetry.
//   • enforce mode → real gate; allowed:false when over cap+burst.

import type { Env } from "@/src/shared/types/env"
import {
  resolveRateLimitMode,
  decideRateLimit,
  computeResetMs,
  TRIAGE_RATE_LIMIT_WINDOW_MS,
  DEFAULT_TRIAGE_RATE_LIMIT_CAP,
  RATE_LIMIT_BURST,
} from "@/src/features/tenancy/domain/rate-limit"
import type { RateLimitMode } from "@/src/features/tenancy/domain/rate-limit"
import { readRollingTriageCount } from "@/src/features/tenancy/adapters/d1-triage-rate-limit-read"

// ─── TriageRateLimitDecision ─────────────────────────────────────────────────

export interface TriageRateLimitDecision {
  /** What the CALLER should do: shadow → always true; enforce → real decision. */
  allowed: boolean
  mode: RateLimitMode
  used: number
  cap: number
  resetMs: number
}

// ─── checkTriageRateLimit ─────────────────────────────────────────────────────

/**
 * Orchestrate the per-team rolling-window Linear-triage rate-limit decision.
 *
 * Never throws — the whole body is wrapped in a try/catch that logs a warn
 * and returns `allowed:true` on any unexpected error so a transient fault
 * never blocks triage.
 */
export async function checkTriageRateLimit(
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE">,
  args: { teamId: string | undefined; nowMs: number },
): Promise<TriageRateLimitDecision> {
  const mode = resolveRateLimitMode(env)
  const cap = DEFAULT_TRIAGE_RATE_LIMIT_CAP
  const burst = RATE_LIMIT_BURST

  /** Convenience: always-allowed response with optional usage fields. */
  const allow = (used = 0, resetMs = 0): TriageRateLimitDecision => ({ allowed: true, mode, used, cap, resetMs })

  try {
    // 1. mode=off → no I/O at all.
    if (mode === "off") return allow()

    // 2. Team required for per-team gating; fail-open when missing.
    if (!args.teamId) {
      console.log(JSON.stringify({ event: "triage-rate-limit-no-team" }))
      return allow()
    }

    // 3. Read the rolling window from D1.
    const sinceIso = new Date(args.nowMs - TRIAGE_RATE_LIMIT_WINDOW_MS).toISOString()
    const res = await readRollingTriageCount(env, {
      teamId: args.teamId,
      sinceIso,
      limit: cap + burst + 1,
    })

    // 4. D1 fault → fail-open; never block on a read error.
    if (!res.ok) {
      console.log(JSON.stringify({ event: "triage-rate-limit-read-failed", teamId: args.teamId, mode }))
      return allow()
    }

    // 5. Compute decision values.
    const used = res.count
    const rawAllowed = decideRateLimit(used, cap, burst)
    const resetMs = computeResetMs(res.windowRowsAscMs, TRIAGE_RATE_LIMIT_WINDOW_MS, used, cap, burst, args.nowMs)

    // 6. Under cap+burst → allowed for all modes.
    if (rawAllowed) {
      console.log(JSON.stringify({ event: "triage-rate-limit-ok", teamId: args.teamId, mode, used, cap }))
      return { allowed: true, mode, used, cap, resetMs }
    }

    // 7. Over cap+burst — split by mode.
    if (mode === "shadow") {
      // Shadow: observe but never block.
      console.log(JSON.stringify({ event: "triage-rate-limit-would-skip", teamId: args.teamId, used, cap, resetMs }))
      return { allowed: true, mode, used, cap, resetMs }
    }

    // enforce: real gate fires.
    console.log(JSON.stringify({ event: "triage-rate-limit-skip", teamId: args.teamId, used, cap, resetMs }))
    return { allowed: false, mode, used, cap, resetMs }
  } catch (err) {
    console.warn(JSON.stringify({ event: "triage-rate-limit-check-failed", err }))
    return { allowed: true, mode, used: 0, cap, resetMs: 0 }
  }
}
