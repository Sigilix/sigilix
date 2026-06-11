// SIG-280 PR B: review-memory soften gate (veto-only spine, cold-regime).
//
// Phase 4 makes softening CALIBRATED + opt-in. Two gates decide whether a
// review-memory-matched finding is actually softened:
//
//   1. `softenActive` — soften only runs when the global flag is `soften`
//      AND the per-repo `reviewMemory.claimSoftening` bool is true. In any
//      other mode (off / shadow / render) or with the per-repo bool false,
//      soften does NOT change scores (telemetry only). This is the
//      deliberate behavior change vs the pre-Phase-4 always-on,
//      uncalibrated soften.
//
//   2. The calibrated VETO — even when active, a soften only stands if a
//      calibrated claim vouches for it (PR C). PR B ships the COLD regime:
//      no calibration params exist yet, so the gate vetoes EVERYTHING —
//      soften is off until PR C produces params AND the founder enables it.
//      Worst case is therefore "no soften", never over-soften (the
//      believability-dominant choice; founder decision 2026-05-29 over the
//      ticket's softer "category-only" cold fallback).
//
// The P0/P1 HARD FLOOR (`softenScoreWithFloor`) is shipped here ready for
// when the calibrated path turns on in PR C: a P0/P1 (score >= 4) source
// finding is NEVER softened below its tier, even when soften is active and
// calibrated. Pure + unit-tested so the invariant is pinned now.

import type { ClaimShadowMode } from "./shadow-match"

/**
 * Soften is active only in `soften` mode WITH the per-repo opt-in. Pure.
 */
export function isSoftenActive(mode: ClaimShadowMode, claimSoftening: boolean): boolean {
  return mode === "soften" && claimSoftening === true
}

/** The P0/P1 floor: scores >= 4 (P0/P1) are blockers and never softened. */
const SOFTEN_FLOOR_TIER = 4

/**
 * Apply the one-tier soften to a finding's SOURCE score, with the P0/P1
 * hard floor. A source P0 (>=5) or P1 (===4) is returned UNCHANGED — a
 * blocker is never softened below its tier. P2/P3 decrement by one tier
 * (floored at 1). The source score is reliable post-SIG-284 (the renderer
 * is the single soften point; the synth no longer pre-decrements). Pure.
 */
export function softenScoreWithFloor(sourceScore: number): number {
  if (sourceScore >= SOFTEN_FLOOR_TIER) return sourceScore
  return Math.max(1, sourceScore - 1)
}
