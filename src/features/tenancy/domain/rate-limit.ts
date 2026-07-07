// SIG-38 (Task 1) — pure rate-limit knobs (domain layer).
//
// Pure, side-effect-free utilities the per-tenant rate-limit layer needs:
//   1. resolveRateLimitMode  — env-flag → "off" | "shadow" | "enforce".
//   2. resolveRateLimitCap   — tier string → numeric per-window cap (seam for SIG-41).
//   3. decideRateLimit       — (used, cap, burst) → allowed boolean (fail-open).
//   4. computeResetMs        — when will the oldest slot free up? (ms until reset).
//   5. formatUsageFooter     — the _Sigilix · N of M reviews used …_ footer line.
//
// Domain-layer contract: NO env reads, NO I/O, NO clock calls, NO network.
// All non-deterministic inputs (env, now) are injected by the caller.
// The only import is the `Env` type (type-only; zero runtime cost).

import type { Env } from "@/src/shared/types/env"

// ─── RateLimitMode ───────────────────────────────────────────────────────────

export type RateLimitMode = "off" | "shadow" | "enforce"

// ─── resolveRateLimitMode ────────────────────────────────────────────────────

/**
 * Resolve the per-tenant rate-limit feature-flag from the Worker env.
 *
 * Three-state rollout:
 *   - `"enforce"` — reviews are rejected when a tenant exceeds their rolling-window cap.
 *   - `"off"`     — rate-limit logic fully bypassed.
 *   - `"shadow"`  — (default) rate-limit state is tracked and telemetered; no blocking.
 *
 * Absent, unknown, or mis-cased values all resolve to `"shadow"` (the safe,
 * observable default — mirrors `resolveQuotaMode` in `./quota.ts` exactly,
 * with `"shadow"` as the fallthrough instead of `"off"`).
 */
export function resolveRateLimitMode(env: Pick<Env, "SIGILIX_RATE_LIMIT_MODE">): RateLimitMode {
  const v = env.SIGILIX_RATE_LIMIT_MODE?.trim().toLowerCase()
  if (v === "enforce") return "enforce"
  if (v === "off") return "off"
  return "shadow"
}

// ─── Window constants ─────────────────────────────────────────────────────────

/**
 * Rolling window duration (5 hours in ms).
 *
 * Free-launch retune (2026-06-30): SIG-38 originally shipped at 1h/cap-3 (the
 * "CodeRabbit way" steer). The free-tier spec is 5h window / 1-2 reviews per
 * developer; `DEFAULT_RATE_LIMIT_CAP` below is the upper end (2) of that range.
 */
export const RATE_LIMIT_WINDOW_MS = 18_000_000

/** Default per-window review cap (free / OSS / CLI tier). */
export const DEFAULT_RATE_LIMIT_CAP = 2

/**
 * Burst allowance: the number of reviews above `cap` a tenant may consume
 * before the gate fires.
 *
 * Set to 0 (literal cap): a review is metered at finalize() AFTER it runs,
 * so at admission `used` reflects prior reviews only. With burst=1 the cap+1-th
 * review (used=cap < cap+1) would be admitted, giving an effective cap+1/hr.
 * burst=0 → allow when `used < cap + 0`, enforcing a literal cap/hr (reviews
 * at used=0…cap-1 admitted; used=cap denied).
 */
export const RATE_LIMIT_BURST = 0

// ─── Linear-triage window/cap constants ──────────────────────────────────────
//
// Free-launch caps (2026-06-26): Linear triage gets its OWN rolling-window
// cap, counted via a SEPARATE ledger (`triage_usage_ledger`, independent of
// the PR-review `usage_ledger`) so hitting one cap never consumes the other's
// budget. The window happens to equal `RATE_LIMIT_WINDOW_MS` today (both 5h),
// but the two are deliberately separate named constants — tuning one must
// never silently retune the other.

/** Rolling window duration for the Linear-triage cap (5 hours in ms). */
export const TRIAGE_RATE_LIMIT_WINDOW_MS = 18_000_000

/** Default per-window Linear-triage cap (free tier — the upper end of the 2-3 range). */
export const DEFAULT_TRIAGE_RATE_LIMIT_CAP = 3

// ─── resolveRateLimitCap ─────────────────────────────────────────────────────

/**
 * Return the per-rolling-window review cap for a given subscription tier.
 *
 * This is the seam that SIG-41 (Stripe) will replace with live tier data.
 * Until then the caps are static, conservative defaults that the Stripe
 * entitlement layer will override per tenant after billing is wired.
 *
 * Tier matching is case-insensitive. Unknown, null, or undefined tiers
 * fall back to `DEFAULT_RATE_LIMIT_CAP` (the free-tier floor).
 *
 * TODO (SIG-41): replace the static map with Stripe entitlement lookup.
 */
export function resolveRateLimitCap(tier?: string | null): number {
  switch (tier?.trim().toLowerCase()) {
    case "oss":
    case "cli":
    case "free":
      return 2
    case "pro":
      return 5
    case "max":
      return 10
    case "pro_plus":
    case "pro+":
      return 10
    case "enterprise":
      return 12
    case "ultra":
      // Highest paid consumer tier (see ENTITLED_TIERS = {pro, max, ultra}).
      return 20
    default:
      return DEFAULT_RATE_LIMIT_CAP
  }
}

// ─── decideRateLimit ─────────────────────────────────────────────────────────

/**
 * Return `true` (allowed) when the tenant is within their rolling-window cap.
 *
 * A burst allowance is included: the tenant may consume up to `cap + burst`
 * reviews before being blocked, i.e. `used < cap + burst` → allowed.
 *
 * Fail-open: when `used` or `cap` is non-finite (NaN, ±Infinity) the call
 * is allowed. Blocks only when we have clear, finite evidence of excess.
 */
export function decideRateLimit(used: number, cap: number, burst: number): boolean {
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return true
  return used < cap + burst
}

// ─── computeResetMs ──────────────────────────────────────────────────────────

/**
 * Return the number of milliseconds until at least one review slot opens up.
 *
 * When the tenant is within cap (`used < cap + burst`) → 0 (no wait).
 *
 * When over cap:
 *   `needed = used − (cap + burst) + 1`
 *   The `needed`-th oldest in-window review (index `needed − 1` in
 *   `windowRowsAscMs`) ages out of the window at `rowMs + windowMs`.
 *   Returns `max(0, resetAt − nowMs)`.
 *
 * If the required row is missing or non-finite, returns `windowMs`
 * (conservative fallback — no earlier information available).
 *
 * @param windowRowsAscMs Timestamps (epoch ms) of reviews in the current
 *   window, sorted ascending (oldest first).
 * @param windowMs        Rolling window duration in ms.
 * @param used            Number of reviews consumed in the window.
 * @param cap             Per-window review cap for this tenant.
 * @param burst           Burst allowance (same as passed to `decideRateLimit`).
 * @param nowMs           Current epoch time in ms.
 */
export function computeResetMs(
  windowRowsAscMs: readonly number[],
  windowMs: number,
  used: number,
  cap: number,
  burst: number,
  nowMs: number,
): number {
  if (decideRateLimit(used, cap, burst)) return 0
  const needed = used - (cap + burst) + 1
  const rowMs = windowRowsAscMs[needed - 1]
  if (rowMs === undefined || !Number.isFinite(rowMs)) return windowMs
  return Math.max(0, rowMs + windowMs - nowMs)
}

// ─── formatUsageFooter ───────────────────────────────────────────────────────

/**
 * Render the per-tenant usage footer appended to review bodies.
 *
 * Format (under cap — no reset clause):
 *   `_Sigilix · 2 of 3 reviews used in past 5h_`
 *
 * Format (over cap — with reset clause):
 *   `_Sigilix · 4 of 3 reviews used in past 5h · resets in 23m_`
 *
 * The reset countdown is ceiled to whole minutes with a floor of 1m so the
 * line never reads "resets in 0m". The italic underscore wrapping matches the
 * existing `_Sigilix · …_` footer style used in the render layer
 * (review-body.ts ~line 223).
 */
export function formatUsageFooter(used: number, cap: number, resetMs: number): string {
  const usagePart = `_Sigilix · ${used} of ${cap} reviews used in past 5h`
  if (resetMs <= 0) return `${usagePart}_`
  const m = Math.max(1, Math.ceil(resetMs / 60_000))
  return `${usagePart} · resets in ${m}m_`
}
