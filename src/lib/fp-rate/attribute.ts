// SIG-114 — the dismissal -> specialist attribution join (pure).
//
// Chain (verified against persisted shapes, see design doc):
//   dismissal.fid  ->  recompute fid over synthesizer.verdict.findings[i]
//                  ->  provenance.findings[i].sourceSpecialists
//
// sourceSpecialists is ALREADY persisted (synthesizer.provenance), so the
// exact join works on the historical corpus — no prod change, no path/line
// fallback (signals carry no path anyway). Unmatched dismissals are bucketed,
// never silently dropped and never mis-attributed.

import { computeFid } from "../review-memory/marker"
import { ALL_SPECIALISTS, type SpecialistRole } from "../ensemble-router"
import {
  bucketForReason,
  type DismissBucket,
  type FpFindingRef,
  type FpRateDismissal,
  type FpRateReview,
} from "./types"

/** Severity floor for the denominator — the epic's score-4+ headline population. */
export const FP_SCORE_GATE = 4

/** Telemetry KV TTL (days). Used to classify unmatched dismissals. */
export const TELEMETRY_TTL_DAYS = 30

/** fellBackReason values that mean the ensemble never ran (exclude from denom). */
export const GUARD_SKIP_REASONS: ReadonlySet<string> = new Set([
  "merged_before_fanout",
  "stale_head_before_fanout",
])

function emptyBuckets(): Record<DismissBucket, number> {
  return { hard: 0, soft: 0, unlabeled: 0 }
}

/** When a finding has multiple dismissals, the most severe reason wins. */
const BUCKET_SEVERITY: Record<DismissBucket, number> = { hard: 2, soft: 1, unlabeled: 0 }

/**
 * Index/dedup key. Scoped by PR so the SAME (path,line,headline) fid in two
 * DIFFERENT PRs counts as two distinct findings (and a dismissal on one PR is
 * never attributed to another PR's roles), while reruns of the same PR dedupe.
 * A dismissal carries prNumber, so the join key matches.
 */
export function findingKey(prNumber: number, fid: string): string {
  return `${prNumber}:${fid}`
}

function isRealReview(review: FpRateReview): boolean {
  if (review.fellBackReason && GUARD_SKIP_REASONS.has(review.fellBackReason)) return false
  return review.synthFindings !== null
}

export interface AttributionResult {
  /** Posted score>=gate findings attributed to each specialist (denominator). */
  denominator: Record<SpecialistRole, FpFindingRef[]>
  /** Dismissals attributed to each specialist, bucketed (numerator). */
  numerator: Record<SpecialistRole, Record<DismissBucket, number>>
  /** Synth = the final gate: ALL posted score>=gate findings / all dismissed. */
  synthDenominator: FpFindingRef[]
  synthNumerator: Record<DismissBucket, number>
  /** Dismissals matching no in-scope posted finding. */
  unattributed: {
    /** Dismissal older than the telemetry TTL — its review likely aged out. */
    possiblyExpired: number
    /** Dismissal within TTL but still unmatched — a real data-quality flag. */
    notFound: number
  }
  /** Engine-health counters over the scanned reviews. */
  reviewsScanned: number
  reviewsRealFanout: number
  reviewsZeroPostedFindings: number
}

/**
 * Build the (prNumber:fid) -> finding index over the in-scope reviews. Only
 * real reviews (ensemble ran) contribute, and only findings at or above the
 * score gate. Deduped by (prNumber, fid): reruns of one PR count once (roles
 * unioned); the same (path,line,headline) in a DIFFERENT PR is distinct.
 * `computeFid` is async (crypto.subtle), so this is async. Pure (no IO/clock).
 */
export async function buildFindingIndex(
  reviews: ReadonlyArray<FpRateReview>,
): Promise<Map<string, FpFindingRef>> {
  const index = new Map<string, FpFindingRef>()
  for (const review of reviews) {
    if (!isRealReview(review)) continue
    for (const finding of review.synthFindings ?? []) {
      if (finding.score < FP_SCORE_GATE) continue
      const fid = await computeFid({
        ruleId: null,
        path: finding.path,
        line: finding.line,
        headline: finding.headline,
      })
      const key = findingKey(review.prNumber, fid)
      // De-dup + sanity: keep only known specialist roles, unique.
      const roles = [...new Set(finding.sourceSpecialists)].filter(
        (r): r is SpecialistRole => (ALL_SPECIALISTS as readonly string[]).includes(r),
      )
      const existing = index.get(key)
      if (existing) {
        // Same finding re-posted across runs of THIS PR may attribute
        // DIFFERENT specialists; UNION the roles so no specialist loses credit
        // for a finding it ever contributed to. Matches the full-credit model
        // and keeps numerator ⊆ denominator (a dismissal credits these roles).
        existing.roles = [...new Set([...existing.roles, ...roles])]
        continue
      }
      index.set(key, {
        fid,
        prNumber: review.prNumber,
        score: finding.score,
        roles,
        createdMs: review.createdMs,
      })
    }
  }
  return index
}

/**
 * Attribute dismissals to specialists via the exact fid join. `reviews`
 * must already be scoped to one repo + the measurement window (the IO layer
 * does that with the real clock). `nowMs` only classifies unmatched
 * dismissals as expired-vs-not-found; pass it explicitly for determinism.
 * Pure + async.
 */
export async function attributeDismissals(
  reviews: ReadonlyArray<FpRateReview>,
  dismissals: ReadonlyArray<FpRateDismissal>,
  nowMs: number,
  ttlDays: number = TELEMETRY_TTL_DAYS,
): Promise<AttributionResult> {
  const index = await buildFindingIndex(reviews)

  const denominator = {} as Record<SpecialistRole, FpFindingRef[]>
  const numerator = {} as Record<SpecialistRole, Record<DismissBucket, number>>
  for (const role of ALL_SPECIALISTS) {
    denominator[role] = []
    numerator[role] = emptyBuckets()
  }
  const synthDenominator: FpFindingRef[] = []
  const synthNumerator = emptyBuckets()

  // Denominator: every distinct posted finding counts once for synth, and
  // once for EACH of its source specialists (full-credit multi-specialist).
  for (const ref of index.values()) {
    synthDenominator.push(ref)
    for (const role of ref.roles) denominator[role].push(ref)
  }

  // Numerator: the rate is "fraction of posted findings dismissed", so the
  // numerator counts DISTINCT dismissed findings (fids), NOT dismissal events.
  // A finding dismissed by two comments is ONE false positive — counting per
  // event would let the numerator exceed the denominator (rate > 100% ->
  // wilsonInterval throws). Collapse matched dismissals to one bucket per fid
  // (most severe reason wins), then count distinct fids. This guarantees
  // numerator ⊆ denominator per role.
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000
  const unattributed = { possiblyExpired: 0, notFound: 0 }
  const matchedBucketByKey = new Map<string, DismissBucket>()
  for (const d of dismissals) {
    // Match on the SAME (prNumber:fid) key the denominator was built with, so
    // a dismissal is attributed only to the finding on its own PR.
    const key = findingKey(d.prNumber, d.fid)
    if (!index.has(key)) {
      // tsMs<=0 means the signal timestamp failed to parse — treat it as a
      // data-quality miss (notFound), not a benign aged-out (possiblyExpired).
      if (d.tsMs > 0 && d.tsMs < nowMs - ttlMs) unattributed.possiblyExpired += 1
      else unattributed.notFound += 1
      continue
    }
    const bucket = bucketForReason(d.dismissReason)
    const prev = matchedBucketByKey.get(key)
    if (prev === undefined || BUCKET_SEVERITY[bucket] > BUCKET_SEVERITY[prev]) {
      matchedBucketByKey.set(key, bucket)
    }
  }
  for (const [key, bucket] of matchedBucketByKey) {
    const ref = index.get(key)! // present by construction
    synthNumerator[bucket] += 1
    for (const role of ref.roles) numerator[role][bucket] += 1
  }

  // Engine health.
  let reviewsRealFanout = 0
  let reviewsZeroPostedFindings = 0
  for (const review of reviews) {
    if (!isRealReview(review)) continue
    reviewsRealFanout += 1
    const postedScored = (review.synthFindings ?? []).filter((f) => f.score >= FP_SCORE_GATE)
    if (postedScored.length === 0) reviewsZeroPostedFindings += 1
  }

  return {
    denominator,
    numerator,
    synthDenominator,
    synthNumerator,
    unattributed,
    reviewsScanned: reviews.length,
    reviewsRealFanout,
    reviewsZeroPostedFindings,
  }
}

/**
 * Dedupe dismissal signals by commentId (the dual SIG-247 keyspace writes the
 * same signal under legacy `owner/repo` AND canonical `repo:<id>` keys). Keep
 * the first occurrence. Pure.
 */
export function dedupeDismissals(
  dismissals: ReadonlyArray<FpRateDismissal>,
): FpRateDismissal[] {
  const seen = new Set<number>()
  const out: FpRateDismissal[] = []
  for (const d of dismissals) {
    if (seen.has(d.commentId)) continue
    seen.add(d.commentId)
    out.push(d)
  }
  return out
}
