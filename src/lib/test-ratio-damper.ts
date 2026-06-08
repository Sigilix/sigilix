// SIG-347 (AC #3 of epic SIG-166): diff-wide test-to-source ratio damper.
//
// Why this exists:
//   The tests specialist over-fires "needs more tests" even on PRs that
//   ALREADY add substantial test coverage. When a PR's diff is itself
//   test-heavy, a surviving "lacks coverage" finding is much more likely
//   to be noise — the author is visibly investing in tests. This module
//   computes the diff-wide test-to-source added-line ratio and damps a
//   surviving testing finding's confidence by one point when the ratio is
//   positive (> THRESHOLD).
//
// FALSE-NEGATIVE SAFETY: the damper only LOWERS confidence by one point —
//   it never drops. A real high-confidence finding (e.g. a deleted
//   regression test, score 5) is at worst demoted from 5→4, still
//   actionable; a borderline P2 over-fire (score 4) becomes a quiet P3
//   body note. Nothing is hidden — this is de-emphasis, not suppression
//   (the suppression gates are the SIG-111 specificity checks). The
//   damper is applied only to `category: "testing"` findings the gate
//   already KEPT, so it never interacts with the specificity drop logic.

import { classifyKind } from "./diff-file-classify"
import { isSubstantiveAddedLine } from "./helper-coverage"

/**
 * Ratio above which the damper fires. Founder-defined per epic SIG-166
 * AC #3 ("positive test-to-source line ratio (> 0.3)").
 */
export const TEST_RATIO_DAMPER_THRESHOLD = 0.3

/**
 * Diff-wide ratio of substantive added TEST lines to substantive added
 * SOURCE lines. Docs/config/other files are excluded from both terms (the
 * ratio is test-to-source). Input is the added-line text map from
 * `buildAddedLineTextByLine` (path → line → `+`-stripped text).
 *
 * When the diff adds test lines but zero source lines (a pure test-only
 * PR), the denominator is floored at 1 so the ratio is large-and-positive
 * (the damper should fire — the PR is entirely tests). When neither term
 * has substantive lines, the ratio is 0 (no damping).
 */
export function computeTestToSourceAddedRatio(
  addedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>,
): number {
  let testLines = 0
  let sourceLines = 0
  for (const [path, lineMap] of addedLineTextByPath) {
    const kind = classifyKind(path)
    if (kind !== "test" && kind !== "source") continue
    let substantive = 0
    for (const text of lineMap.values()) {
      if (isSubstantiveAddedLine(text)) substantive++
    }
    if (kind === "test") testLines += substantive
    else sourceLines += substantive
  }
  if (testLines === 0) return 0
  return testLines / Math.max(sourceLines, 1)
}

/**
 * Lower a testing finding's confidence by one point when the diff-wide
 * test-to-source ratio is positive (> THRESHOLD). Pure + bounded: never
 * returns below 2, never raises a score. Returns the input unchanged when
 * the ratio is at/below threshold.
 *
 * The floor is 2 (not 1) on purpose: a score-1 testing finding is routed to
 * the advisory bucket and hidden from the review body, so damping 2→1 would
 * HIDE a finding rather than de-emphasize it — violating the "never hidden,
 * only quieter" contract. A score-2 nit is already minimal severity, so it's
 * left untouched; the damper only quiets the loud score>=3 over-fires.
 */
export function dampTestingScoreForRatio(score: number, ratio: number): number {
  if (ratio > TEST_RATIO_DAMPER_THRESHOLD && score > 2) return score - 1
  return score
}
