// SIG-114 — per-specialist false-positive-rate metric (offline harness).
//
// These are the MINIMAL input shapes the FP-rate core needs, deliberately
// decoupled from the giant internal `EnsembleTelemetry` type in
// triage-pr-review-ensemble.ts. The thin IO script (scripts/fp-rate-report.ts)
// maps raw KV JSON -> these shapes; the pure core operates on them so it
// stays unit-testable without the worker runtime.
//
// Design + grounding: .claude/handoff/sig-114-fp-rate-design.md

import type { SpecialistRole } from "@/src/lib/ensemble-router"
import type { DismissReason } from "@/src/lib/dismiss-reasons"

export type { SpecialistRole }

/**
 * How a dismissal reason maps to the FP-rate taxonomy. This is a NEW
 * classification for FP measurement, orthogonal to the SIG-173 softening
 * *activation* weights (dismissal-weights.ts), which serve a different
 * purpose (how fast a category softens).
 *
 *   - hard  — the engine's claim was WRONG. Counts against the target.
 *   - soft  — the finding was OK but mis-anchored / duplicate / noise.
 *   - unlabeled — no reason captured (today: ~100% of the live corpus,
 *     because the textual-dismissal pipeline doesn't emit a reason yet).
 */
export type DismissBucket = "hard" | "soft" | "unlabeled"

/** Reasons that mean "the finding itself was wrong" → hard FP. */
const HARD_FP_REASONS: ReadonlySet<DismissReason> = new Set<DismissReason>([
  "not-a-bug",
  "wrong-context",
])

/** Reasons where the finding was arguably valid but not worth posting → soft. */
const SOFT_FP_REASONS: ReadonlySet<DismissReason> = new Set<DismissReason>([
  "bad-anchor",
  "already-covered",
  "too-minor",
])

/**
 * Bucket a dismissal reason. `undefined` reason (legacy / textual-dismissal
 * capture that doesn't emit a reason) and the explicit `"unlabeled"` reason
 * both fall to `unlabeled`. Pure.
 */
export function bucketForReason(reason: DismissReason | undefined): DismissBucket {
  if (reason === undefined) return "unlabeled"
  if (HARD_FP_REASONS.has(reason)) return "hard"
  if (SOFT_FP_REASONS.has(reason)) return "soft"
  return "unlabeled"
}

/** One posted synthesizer finding, reduced to what the join needs. */
export interface RawSynthFinding {
  path: string
  line: number
  headline: string
  score: number
  /** From `synthesizer.provenance.findings[i].sourceSpecialists` (parallel index). */
  sourceSpecialists: SpecialistRole[]
}

/** One ensemble review, reduced to what the harness needs. */
export interface FpRateReview {
  owner: string
  repo: string
  prNumber: number
  /** Recovered from the reverse-ts KV key segment (REVERSE_TS_BASE - reverseTs). */
  createdMs: number
  /**
   * `merged_before_fanout` / `stale_head_before_fanout` mark guard-skipped
   * non-reviews (the ensemble never ran). Such records are excluded from the
   * denominator. Other values (or undefined) are real reviews.
   */
  fellBackReason?: string | null
  /** Posted synth findings, or null when synth produced nothing / failed. */
  synthFindings: RawSynthFinding[] | null
}

/** One dismissal signal (the FP label), reduced to what the join needs. */
export interface FpRateDismissal {
  /** sha16 of the dismissed finding's (ruleId:null, path, line, headline). */
  fid: string
  prNumber: number
  /** GitHub reply-comment id — the dedup key across the dual keyspace. */
  commentId: number
  dismissReason?: DismissReason
  tsMs: number
}

/** A posted, score-gated finding in the denominator, keyed by fid. */
export interface FpFindingRef {
  fid: string
  prNumber: number
  score: number
  roles: SpecialistRole[]
  createdMs: number
}
