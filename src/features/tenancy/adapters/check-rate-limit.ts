// SIG-38 Task 3 — per-author rate-limit decision orchestrator (adapter layer).
//
// Composes Task 1 (domain/rate-limit) + Task 2 (d1-rate-limit-read) into a
// single, never-throws call site.  Fail-open at every layer:
//   • mode=off          → immediate allow, zero I/O.
//   • bypassReason set  → immediate allow (mentions/reruns not gated).
//   • authorLogin blank → immediate allow (never pretend per-user without one).
//   • D1 fault          → allow + log (a DB hiccup must never block a review).
//   • shadow mode       → always allows; carries real numbers for the footer.
//   • enforce mode      → real gate; allowed:false when over cap+burst.
//
// Admission wiring (Task 4) will call this and act on `allowed`.

import type { Env } from "@/src/shared/types/env"
import {
  resolveRateLimitMode,
  resolveRateLimitCap,
  resolveTierCostBudgetUsd,
  decideRateLimit,
  decideCostBudget,
  computeResetMs,
  formatUsageFooter,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_BURST,
} from "@/src/features/tenancy/domain/rate-limit"
import type { RateLimitMode } from "@/src/features/tenancy/domain/rate-limit"
import { readRollingReviewCount } from "@/src/features/tenancy/adapters/d1-rate-limit-read"

// ─── RateLimitDecision ───────────────────────────────────────────────────────

export interface RateLimitDecision {
  /** What the CALLER should do: shadow → always true; enforce → real decision. */
  allowed: boolean
  mode: RateLimitMode
  used: number
  cap: number
  resetMs: number
  /**
   * sig-cost-based-metering — the DOLLAR dimension, the PRIMARY enforced cap.
   * `usedCostUsd` is the summed `cost_usd` (blended model spend) in the window;
   * `costBudgetUsd` is the tier's per-window USD budget (null = UNBOUNDED, e.g.
   * enterprise); `costRemainingUsd` = max(0, budget − used) or null when unbounded.
   * Zeroed on off/bypass/no-author/fault (same as the count fields).
   */
  usedCostUsd: number
  costBudgetUsd: number | null
  costRemainingUsd: number | null
  /**
   * Empty string when no usage data (off / bypass / no-author / fault).
   * Otherwise `formatUsageFooter(used, cap, resetMs)`.
   */
  footer: string
}

// ─── checkRateLimit ──────────────────────────────────────────────────────────

/**
 * Orchestrate the per-author rolling-window rate-limit decision.
 *
 * Never throws — the whole body is wrapped in a try/catch that logs a warn
 * and returns `allowed:true` on any unexpected error so a transient fault
 * never blocks the review path.
 */
export async function checkRateLimit(
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE">,
  args: {
    installationId: number
    authorLogin: string | undefined
    nowMs: number
    tier?: string | null
    /** sig-trial-cap: true → the tier's HALF (trial) cap; false/absent → full tier cap. */
    trialing?: boolean
    bypassReason?: string
  },
): Promise<RateLimitDecision> {
  const mode = resolveRateLimitMode(env)
  const cap = resolveRateLimitCap(args.tier, args.trialing)
  const burst = RATE_LIMIT_BURST
  // sig-cost-based-metering: the DOLLAR budget for this tier over the SAME 5h
  // rolling window (RATE_LIMIT_WINDOW_MS). `null` → UNBOUNDED (enterprise) → the
  // cost dimension never blocks. This is the PRIMARY enforced dimension; the count
  // `cap` above stays as a cheap secondary guardrail against many-tiny-request abuse.
  const costBudgetUsd = resolveTierCostBudgetUsd(env, args.tier, "session", args.trialing)
  const costRemaining = (usedCostUsd: number): number | null =>
    costBudgetUsd === null ? null : Math.max(0, costBudgetUsd - usedCostUsd)

  /** Convenience: always-allowed response with optional usage fields. */
  const allow = (used = 0, resetMs = 0, footer = "", usedCostUsd = 0): RateLimitDecision => ({
    allowed: true,
    mode,
    used,
    cap,
    resetMs,
    usedCostUsd,
    costBudgetUsd,
    costRemainingUsd: costRemaining(usedCostUsd),
    footer,
  })

  try {
    // 1. mode=off → no I/O at all.
    if (mode === "off") return allow()

    // 2. Bypass fast-path (mentions, manual reruns, etc.) — no counting.
    if (args.bypassReason) {
      console.log(
        JSON.stringify({
          event: "rate-limit-bypass",
          installationId: args.installationId,
          bypassReason: args.bypassReason,
        }),
      )
      return allow()
    }

    // 3. Author required for per-user gating; fail-open when missing.
    if (!args.authorLogin) {
      console.log(JSON.stringify({ event: "rate-limit-no-author", installationId: args.installationId }))
      return allow()
    }

    // 4. Read the rolling window from D1.
    const sinceIso = new Date(args.nowMs - RATE_LIMIT_WINDOW_MS).toISOString()
    const res = await readRollingReviewCount(env, {
      installationId: args.installationId,
      authorLogin: args.authorLogin,
      sinceIso,
      limit: cap + burst + 1,
    })

    // 5. D1 fault → fail-open; never block on a read error.
    if (!res.ok) {
      console.log(JSON.stringify({ event: "rate-limit-read-failed", installationId: args.installationId, mode }))
      return allow()
    }

    // 6. Compute decision values. Cost is the PRIMARY dimension; count is the
    //    secondary guardrail. A request is allowed only when it is under BOTH —
    //    blocked when EITHER the window's summed cost has reached the tier budget
    //    OR the request count has reached the cap. Each decider fails open on its
    //    own non-finite/null input, so a partial fault never over-blocks.
    const used = res.count
    const usedCostUsd = res.costUsd
    const costRemainingUsd = costRemaining(usedCostUsd)
    const countAllowed = decideRateLimit(used, cap, burst)
    const costAllowed = decideCostBudget(usedCostUsd, costBudgetUsd)
    const rawAllowed = countAllowed && costAllowed
    // resetMs is COUNT-based (when the oldest review ages out of the window). When
    // the COST dimension is what blocks (count still under cap), this is 0 — an
    // approximation: the true cost-reset instant needs every in-window row's cost,
    // not just the `cap+burst+1` slice fetched for count-reset math. The BLOCK is
    // still correct; only the "resets in ~Nm" hint understates the wait. Acceptable
    // for v1 (a retry just re-blocks) — an exact cost countdown is a later refinement.
    const resetMs = computeResetMs(res.windowRowsAscMs, RATE_LIMIT_WINDOW_MS, used, cap, burst, args.nowMs)
    const footer = formatUsageFooter(used, cap, resetMs)
    const base = { mode, used, cap, resetMs, usedCostUsd, costBudgetUsd, costRemainingUsd, footer } as const

    // 7. Under BOTH caps → allowed for all modes.
    if (rawAllowed) {
      console.log(
        JSON.stringify({ event: "rate-limit-ok", installationId: args.installationId, mode, used, cap, usedCostUsd }),
      )
      return { allowed: true, ...base }
    }

    // The binding dimension (which cap was hit) — for telemetry only.
    const limitedBy = !costAllowed ? "cost" : "count"

    // 8. Over a cap — split by mode.
    if (mode === "shadow") {
      // Shadow: observe but never block; carry real numbers for the footer.
      console.log(
        JSON.stringify({
          event: "rate-limit-would-skip",
          installationId: args.installationId,
          limitedBy,
          used,
          cap,
          usedCostUsd,
          costBudgetUsd,
          resetMs,
        }),
      )
      return { allowed: true, ...base }
    }

    // enforce: real gate fires.
    console.log(
      JSON.stringify({
        event: "rate-limit-skip",
        installationId: args.installationId,
        limitedBy,
        used,
        cap,
        usedCostUsd,
        costBudgetUsd,
        resetMs,
      }),
    )
    return { allowed: false, ...base }
  } catch (err) {
    console.warn(JSON.stringify({ event: "rate-limit-check-failed", err }))
    return {
      allowed: true,
      mode,
      used: 0,
      cap,
      resetMs: 0,
      usedCostUsd: 0,
      costBudgetUsd,
      costRemainingUsd: costRemaining(0),
      footer: "",
    }
  }
}
