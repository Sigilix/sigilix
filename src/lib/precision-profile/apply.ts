// SIG-147: review-time consumption — apply a per-repo PrecisionProfile to a
// finding set. Pure + exported for tests.
//
// SUPPRESSION is concrete here: a finding whose pattern (contentFingerprint)
// has crossed the suppression threshold is a repeatedly-dismissed false
// positive and is dropped (in `enforce`) before posting.
//
// BOOST is computed + surfaced here but APPLIED at the prompt gate (SIG-104),
// which doesn't exist yet — "categories with high boost get priority in the
// suggestion prompt". We therefore return the boosted set for telemetry and the
// future prompt-injection hook, and do NOT mutate scores at this post-synthesis
// gate (a blind score bump risks over-escalation). See README.

import { isCategoryBoosted, isPatternSuppressed } from "./ema"
import type { PrecisionApplyResult, PrecisionProfile, ProfilableFinding } from "./types"

/**
 * Recall-safety hard floor (mirrors review-memory's `SOFTEN_FLOOR_TIER`): a
 * P0/P1 (score ≥ 4) is NEVER suppressed by the precision profile, no matter how
 * often its pattern was dismissed. A blocker stays a blocker.
 */
export const SUPPRESS_FLOOR_TIER = 4

/**
 * Partition `findings` against the repo profile. `enforce` controls whether the
 * suppressed findings are actually removed from `kept` (enforce) or left in for
 * shadow telemetry (shadow). Findings without a `contentFingerprint` can't be
 * pattern-matched and are never suppressed.
 *
 * Pure — exported for tests.
 */
export function applyPrecisionProfile<F extends ProfilableFinding>(
  findings: ReadonlyArray<F>,
  profile: PrecisionProfile | null,
  opts: { enforce: boolean },
): PrecisionApplyResult<F> {
  if (!profile) return { kept: [...findings], suppressed: [], boosted: [] }

  const suppressed: PrecisionApplyResult<F>["suppressed"] = []
  const boosted: PrecisionApplyResult<F>["boosted"] = []
  const kept: F[] = []

  for (const f of findings) {
    const patternStat = f.contentFingerprint ? profile.patterns[f.contentFingerprint] : undefined
    const categoryStat = profile.categories[f.category]

    // Recall-safety: a P0/P1 is never suppressed, even with a hot pattern.
    const suppress = f.score < SUPPRESS_FLOOR_TIER && isPatternSuppressed(patternStat)
    if (suppress) {
      suppressed.push({ finding: f, suppressWeight: patternStat!.suppress })
    }
    if (isCategoryBoosted(categoryStat)) {
      boosted.push({ finding: f, boostWeight: categoryStat!.boost })
    }

    // In enforce, drop a suppressed finding; in shadow, keep everything (the
    // suppressed list is telemetry-only).
    if (!(suppress && opts.enforce)) kept.push(f)
  }

  return { kept, suppressed, boosted }
}
