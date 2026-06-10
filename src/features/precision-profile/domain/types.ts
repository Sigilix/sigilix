// SIG-147: per-repo "accepted/dismissed finding outcome" feedback loop.
//
// Implicit behavioral signal (distinct from SIG-104's explicit `/remember`
// facts): when reviewers dismiss or accept findings, that outcome is fed back
// into a compact per-repo `PrecisionProfile` that tunes future reviews —
// repeatedly-dismissed PATTERNS get suppressed, repeatedly-accepted CATEGORIES
// get boosted. The profile is an exponential-moving-average (EMA) rollup so it
// stays adaptive without a full retrain.
//
// This module is the SCHEMA + AGGREGATION + REVIEW-TIME CONSUMPTION core. The
// richer signal CAPTURE (reactions, top-level replies, formal review
// dismissals) is SIG-185; this core is fed today by the existing dismissal +
// decay (stale) signals and exposes `recordOutcome` for SIG-185 to extend.

import type { FindingCategory } from "@/src/shared/domain/finding-category"

/** The implicit outcome of a posted finding. */
export type FindingOutcome = "accepted" | "dismissed" | "stale"

/** A single outcome observation, keyed by category + pattern, scoped per repo. */
export interface OutcomeEvent {
  /**
   * Per-repo key. Today this is the `owner/repo` slug — BOTH the dismiss path
   * (github-mention) and the review gate (ensemble) key on `${owner}/${repo}`
   * identically, so the signal round-trips. (Named `repoId` to leave room for a
   * future migration to the SIG-247 stable id, but both sides must agree.)
   */
  repoId: string
  /** The finding's category — the boost dimension. */
  category: FindingCategory
  /**
   * The finding's content fingerprint (`computeContentFingerprint`) — the
   * suppression dimension. A stable per-pattern hash across pushes.
   */
  patternHash: string
  outcome: FindingOutcome
}

/** EMA stat for one suppression pattern (high suppress = repeatedly dismissed). */
export interface PatternStat {
  /** EMA in [0,1]; → 1 as the pattern is repeatedly dismissed. */
  suppress: number
  /** Number of observations folded in (gates premature suppression). */
  n: number
  /** ISO-8601 UTC of the last observation. */
  lastTs: string
}

/** EMA stat for one category (high boost = repeatedly accepted). */
export interface CategoryStat {
  /** EMA in [0,1]; → 1 as the category is repeatedly accepted. */
  boost: number
  n: number
  lastTs: string
}

/**
 * The compact per-repo precision signal the review planner reads. Stored in KV
 * under `precision-profile:repo:<repoId>`. Bounded: patterns FIFO-capped, so a
 * busy repo never grows the value without limit.
 */
export interface PrecisionProfile {
  schemaVersion: 1
  repoId: string
  /** key = patternHash (contentFingerprint). */
  patterns: Record<string, PatternStat>
  /** key = FindingCategory. */
  categories: Partial<Record<FindingCategory, CategoryStat>>
  /** ISO-8601 UTC of the last write. */
  updatedTs: string
}

/** Mode for the review-time gate — mirrors the review-memory shadow→enforce rollout. */
export type PrecisionMode = "off" | "shadow" | "enforce"

/** A minimal finding shape the apply gate operates on. */
export interface ProfilableFinding {
  category: FindingCategory
  contentFingerprint?: string
  /** Severity score (1–5). Recall-safety: a P0/P1 (≥4) is NEVER suppressed. */
  score: number
}

/** One review-time precision decision (for telemetry +, in enforce, filtering). */
export interface PrecisionDecision<F> {
  finding: F
  /** Pattern suppression EMA that crossed the threshold. */
  suppressWeight: number
}

/** One review-time boost decision (signal surfaced; applied at the SIG-104 prompt gate). */
export interface BoostDecision<F> {
  finding: F
  boostWeight: number
}

/** Result of applying a `PrecisionProfile` to a finding set at review time. */
export interface PrecisionApplyResult<F> {
  /** Findings to keep. In `enforce` this excludes `suppressed`; in `shadow` it is all of them. */
  kept: F[]
  /** Findings whose pattern crossed the suppression threshold (would-drop FPs). */
  suppressed: Array<PrecisionDecision<F>>
  /** Findings whose category crossed the boost threshold. */
  boosted: Array<BoostDecision<F>>
}

export const PRECISION_PROFILE_SCHEMA_VERSION = 1 as const
