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
  decideRateLimit,
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
    bypassReason?: string
  },
): Promise<RateLimitDecision> {
  const mode = resolveRateLimitMode(env)
  const cap = resolveRateLimitCap(args.tier)
  const burst = RATE_LIMIT_BURST

  /** Convenience: always-allowed response with optional usage fields. */
  const allow = (used = 0, resetMs = 0, footer = ""): RateLimitDecision => ({
    allowed: true,
    mode,
    used,
    cap,
    resetMs,
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

    // 6. Compute decision values.
    const used = res.count
    const rawAllowed = decideRateLimit(used, cap, burst)
    const resetMs = computeResetMs(res.windowRowsAscMs, RATE_LIMIT_WINDOW_MS, used, cap, burst, args.nowMs)
    const footer = formatUsageFooter(used, cap, resetMs)

    // 7. Under cap+burst → allowed for all modes.
    if (rawAllowed) {
      console.log(JSON.stringify({ event: "rate-limit-ok", installationId: args.installationId, mode, used, cap }))
      return { allowed: true, mode, used, cap, resetMs, footer }
    }

    // 8. Over cap+burst — split by mode.
    if (mode === "shadow") {
      // Shadow: observe but never block; carry real numbers for the footer.
      console.log(
        JSON.stringify({ event: "rate-limit-would-skip", installationId: args.installationId, used, cap, resetMs }),
      )
      return { allowed: true, mode, used, cap, resetMs, footer }
    }

    // enforce: real gate fires.
    console.log(JSON.stringify({ event: "rate-limit-skip", installationId: args.installationId, used, cap, resetMs }))
    return { allowed: false, mode, used, cap, resetMs, footer }
  } catch (err) {
    console.warn(JSON.stringify({ event: "rate-limit-check-failed", err }))
    return { allowed: true, mode, used: 0, cap, resetMs: 0, footer: "" }
  }
}
