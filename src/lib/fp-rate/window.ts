// SIG-114 — window scoping (pure). Kept out of the core so the clock lives
// only in the IO script; tests pass an explicit `nowMs`.

import type { FpRateReview } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Keep reviews posted within [nowMs - windowDays, nowMs - maturityDays].
 * The maturity lag excludes very recent reviews that have not had time to be
 * dismissed (matching SIG-280's 14-day default), so the rate isn't deflated
 * by un-aged findings. Pure.
 */
export function filterReviewsToWindow(
  reviews: ReadonlyArray<FpRateReview>,
  nowMs: number,
  windowDays: number,
  maturityDays: number,
): FpRateReview[] {
  const oldest = nowMs - windowDays * DAY_MS
  const newest = nowMs - maturityDays * DAY_MS
  return reviews.filter((r) => r.createdMs >= oldest && r.createdMs <= newest)
}
