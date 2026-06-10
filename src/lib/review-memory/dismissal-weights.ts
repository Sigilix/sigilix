// SIG-173: differential weighting is wired through `weightedSignalCount`
// but the production signal writer (`captureReviewFeedback`) does not
// yet emit a `dismissReason` on the ReviewMemorySignal — bridging the
// explicit-dismiss → memory-signal path is its own design surface
// (which findings in the dismissed review get reason-attribution?) and
// will land in a follow-up ticket. Until then, this weighting fires
// only in tests + any future code path that writes a categorized
// reason signal. The infrastructure here is back-compat with the
// existing unlabeled (`dismissReason: undefined`) signals — default 1.0.
//
// SIG-173 — differential softening weights for review-memory signals.
//
// The review-memory activation threshold (see `lookup.ts::isMemoryActive`)
// counts dismissal signals against `config.minSignalThreshold`. Per SIG-173,
// signals tagged with a `dismissReason` weight differently: `too-minor`
// reaches the threshold faster than `not-a-bug` because "too minor to flag"
// is a louder signal that this category is noise on this repo than "this
// specific call wasn't a bug." Future tickets may tune the table; the
// constants are documented here so the rationale stays attached to the
// numbers.
//
// Weights apply at the activation-count layer ONLY. The downstream
// `score - 1` step in the synth's softening prompt is unchanged — the
// weights move the *bar* for softening to kick in, not the magnitude of
// the score adjustment, so a typo'd dismissal never accidentally hard-drops
// a finding it merely meant to nudge.

import type { DismissReason } from "@/src/lib/dismiss-reasons"

/**
 * Per-reason softening weight. Document the choices alongside the numbers:
 *
 *   - `too-minor` × 1.5 — the reviewer is saying "this whole category of
 *     finding is noise here." A single such signal counts as 1.5 toward the
 *     activation threshold, so three `too-minor` dismissals trip a
 *     threshold-3 gate after two real dismissals rather than three.
 *
 *   - `not-a-bug`, `bad-anchor`, `wrong-context`, `already-covered`,
 *     `unlabeled` × 1.0 — the existing default behavior. `not-a-bug` is
 *     anchored to one specific finding being wrong; it shouldn't soften a
 *     whole category any faster than today. `bad-anchor` and
 *     `wrong-context` are flagging an anchoring error, not a class of
 *     noise. `already-covered` may have a future weight tuning (this PR
 *     leaves it at 1.0 to keep the SIG-173 change minimal). `unlabeled`
 *     is the back-compat default for signals without a reason field.
 *
 * Loud-but-conservative: only ONE reason is currently above 1.0. Subsequent
 * tickets can tune as telemetry from `/metrics/dismissals` builds up
 * empirical evidence on which reasons reliably predict noise.
 */
export const DISMISSAL_SOFTENING_WEIGHTS: Readonly<Record<DismissReason, number>> = {
  "not-a-bug": 1.0,
  "bad-anchor": 1.0,
  "already-covered": 1.0,
  "too-minor": 1.5,
  "wrong-context": 1.0,
  "unlabeled": 1.0,
}

/** Default weight for any signal without a reason (or unknown reason). */
export const DEFAULT_DISMISSAL_WEIGHT = 1.0

/**
 * Look up the softening weight for one signal. Undefined / unknown reason →
 * `DEFAULT_DISMISSAL_WEIGHT` (1.0) so legacy signals (and signals from
 * surfaces that don't yet emit a reason, like the textual-dismissal
 * capture pipeline) behave exactly as before SIG-173.
 *
 * Pure — exported for tests.
 */
export function weightForReason(reason: DismissReason | undefined): number {
  if (reason === undefined) return DEFAULT_DISMISSAL_WEIGHT
  return DISMISSAL_SOFTENING_WEIGHTS[reason] ?? DEFAULT_DISMISSAL_WEIGHT
}

/**
 * Sum the softening weights for a set of signals. Each signal contributes
 * `weightForReason(signal.dismissReason)`. Pure — exported for tests.
 */
export function weightedSignalCount(
  signals: ReadonlyArray<{ dismissReason?: DismissReason }>,
): number {
  let total = 0
  for (const s of signals) total += weightForReason(s.dismissReason)
  return total
}
