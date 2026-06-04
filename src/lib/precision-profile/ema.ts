// SIG-147: the EMA rollup — pure profile math, exported for unit tests.
//
// An exponential moving average over each (pattern | category) key keeps the
// signal adaptive: recent outcomes dominate, old ones decay, no retrain needed.
// `foldOutcomeIntoProfile` is the single pure transition the KV store wraps.

import type {
  CategoryStat,
  FindingOutcome,
  OutcomeEvent,
  PatternStat,
  PrecisionProfile,
} from "./types"
import { PRECISION_PROFILE_SCHEMA_VERSION } from "./types"

/** Smoothing factor — higher = more reactive to recent outcomes (~last ~6 dominate). */
export const EMA_ALPHA = 0.3
/** Minimum observations before a key can suppress/boost — guards premature action on 1-2 signals. */
export const MIN_OBSERVATIONS = 3
/** Pattern suppression fires at/above this EMA. */
export const SUPPRESS_THRESHOLD = 0.6
/** Category boost fires at/above this EMA. */
export const BOOST_THRESHOLD = 0.6
/** Cap stored patterns per repo (LRU — evict oldest-touched by lastTs) so a busy repo's profile stays bounded. */
export const MAX_PATTERNS = 500

/** EMA targets per outcome. `undefined` = leave that dimension untouched. */
export function outcomeTargets(outcome: FindingOutcome): {
  patternSuppress?: number
  categoryBoost?: number
} {
  switch (outcome) {
    case "dismissed":
      // Repeated dismissal → this pattern is noise; the category is not valued here.
      return { patternSuppress: 1, categoryBoost: 0 }
    case "accepted":
      // Repeated acceptance → this category is valued; the pattern is a true positive.
      return { patternSuppress: 0, categoryBoost: 1 }
    case "stale":
      // A dismissal whose decay window lapsed → relax the suppression back toward
      // neutral; carries no category-acceptance signal.
      return { patternSuppress: 0 }
    default: {
      const _exhaustive: never = outcome
      return _exhaustive
    }
  }
}

function ema(prev: number, target: number): number {
  return EMA_ALPHA * target + (1 - EMA_ALPHA) * prev
}

/** True when a pattern stat is confident enough to suppress. */
export function isPatternSuppressed(stat: PatternStat | undefined): boolean {
  return stat !== undefined && stat.n >= MIN_OBSERVATIONS && stat.suppress >= SUPPRESS_THRESHOLD
}

/** True when a category stat is confident enough to boost. */
export function isCategoryBoosted(stat: CategoryStat | undefined): boolean {
  return stat !== undefined && stat.n >= MIN_OBSERVATIONS && stat.boost >= BOOST_THRESHOLD
}

/** An empty profile for a repo (used on KV miss). */
export function emptyProfile(repoId: string, nowIso: string): PrecisionProfile {
  return {
    schemaVersion: PRECISION_PROFILE_SCHEMA_VERSION,
    repoId,
    patterns: {},
    categories: {},
    updatedTs: nowIso,
  }
}

/**
 * Fold one outcome into the profile, returning a NEW profile (pure). EMA-updates
 * the pattern's suppression and/or the category's boost per `outcomeTargets`,
 * bumps the observation count, and FIFO-prunes patterns past `MAX_PATTERNS`.
 */
export function foldOutcomeIntoProfile(
  profile: PrecisionProfile,
  event: OutcomeEvent,
  nowIso: string,
): PrecisionProfile {
  const targets = outcomeTargets(event.outcome)
  const patterns: Record<string, PatternStat> = { ...profile.patterns }
  const categories: PrecisionProfile["categories"] = { ...profile.categories }

  if (targets.patternSuppress !== undefined) {
    const prev = patterns[event.patternHash]
    patterns[event.patternHash] = {
      suppress: ema(prev?.suppress ?? 0, targets.patternSuppress),
      n: (prev?.n ?? 0) + 1,
      lastTs: nowIso,
    }
  }
  if (targets.categoryBoost !== undefined) {
    const prev = categories[event.category]
    categories[event.category] = {
      boost: ema(prev?.boost ?? 0, targets.categoryBoost),
      n: (prev?.n ?? 0) + 1,
      lastTs: nowIso,
    }
  }

  return {
    schemaVersion: PRECISION_PROFILE_SCHEMA_VERSION,
    repoId: profile.repoId,
    patterns: prunePatterns(patterns),
    categories,
    updatedTs: nowIso,
  }
}

/** Keep the MAX_PATTERNS most-recently-touched patterns (LRU — evict oldest by lastTs). */
export function prunePatterns(patterns: Record<string, PatternStat>): Record<string, PatternStat> {
  const keys = Object.keys(patterns)
  if (keys.length <= MAX_PATTERNS) return patterns
  const kept = keys
    .sort((a, b) => (patterns[a]!.lastTs < patterns[b]!.lastTs ? 1 : -1)) // newest first
    .slice(0, MAX_PATTERNS)
  const out: Record<string, PatternStat> = {}
  for (const k of kept) out[k] = patterns[k]!
  return out
}
