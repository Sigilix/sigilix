// SIG-280 PR C — review-memory soften calibration, OFFLINE FIT.
//
// Pure functions that turn the two production corpora into the
// per-claim-type params blob `calibration.ts` consumes. OFFLINE-ONLY:
// nothing on the worker review path imports this (the ensemble imports
// only `calibration.ts`); it's driven by `scripts/phase4-calibrate.mjs`.
//
// Estimator + join spec — DeepSeek-v4-pro (2026-05-29), believability-
// dominant (false-soften >> missed-soften):
//
//   • Label (leakage-safe): a claim-matched shadow row at PR `p` for fid
//     `f` is a DISMISSAL success iff some dismissal signal exists with
//     the same fid AND `signal.prNumber >= p`. The `>=` excludes the
//     dismissal that BUILT the memory (which sits at a strictly EARLIER
//     PR) — otherwise every match would label as dismissed and p_dismiss
//     would be spuriously ~1.0.
//
//   • Unit: DISTINCT PRs, not raw rows — two findings of the same claim
//     type on one PR are one correlated observation, not two. This is
//     strictly more conservative than counting rows (smaller n, harder
//     to reach the trustworthy floor).
//
//   • Estimator: Beta(1,9) prior (mean 0.10, pessimistic), report the
//     5% lower quantile via the normal approximation (accurate at
//     n >= 100, no incomplete-beta needed). Wilson is NOT used — it is
//     anti-conservative here (100/100 → Wilson 0.964 vs Beta 0.875).
//
//   • Maturity lag: drop shadow records younger than 14 days so PRs that
//     simply haven't been reviewed yet don't right-censor the success
//     count downward (would UNDER-soften, which is safe, but biased).
//
//   • Aggregation is GLOBAL per claim type — valid while single-tenant
//     (one homogeneous repo). Multi-tenant MUST stratify per repo
//     (Simpson's paradox); see the multi-tenant TODO below.

import type { ReviewMemoryClaimType } from "./types"
import { ALL_REVIEW_MEMORY_CLAIM_TYPES } from "./types"
import {
  CLAIM_SOFTEN_TRUSTWORTHY_N,
  type CalibrationBlob,
  type ClaimCalibrationParams,
} from "./calibration"

/** Standard-normal 5% one-sided z (P(Z < -z) = 0.05). */
const Z_95_ONE_SIDED = 1.6448536269514722

const DEFAULT_MATURITY_LAG_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Lower 5% quantile of a Beta(1 + s, 9 + (n - s)) posterior on the
 * dismissal proportion, via the normal approximation. Clamped to [0,1].
 * `n = 0` returns 0 (no data → maximally cold).
 */
export function betaLowerBound(s: number, n: number): number {
  if (n <= 0) return 0
  const alpha = 1 + s
  const beta = 9 + (n - s)
  const mean = alpha / (alpha + beta)
  const variance = (mean * (1 - mean)) / (alpha + beta + 1)
  const lower = mean - Z_95_ONE_SIDED * Math.sqrt(variance)
  return Math.min(1, Math.max(0, lower))
}

/** One persisted shadow event, normalized to the fields the fit needs. */
export interface CalibrationShadowRecord {
  /** The PR the claim-matched findings were raised on. */
  prNumber: number
  /** Event creation time (ms), recovered from the KV key's reverse-ts. */
  createdMs: number
  /** The claim-matched rows (`null` claimType = category-no-claim-match). */
  rows: ReadonlyArray<{ fid: string; claimType: ReviewMemoryClaimType | null }>
}

/** One dismissal signal, normalized to the join fields. */
export interface CalibrationDismissal {
  fid: string
  prNumber: number
}

/**
 * Fit the per-claim-type calibration blob. Pure: `nowMs` is injected.
 * Types with zero mature observations are omitted (absent → the consumer
 * vetoes). Every emitted type carries `n`, `s`, the Beta lower bound,
 * `trustworthyN` (n >= floor), and `cold` (currently `!trustworthyN`).
 *
 * SINGLE-REPO INPUT (Codex P2): the leakage label compares raw PR NUMBERS
 * and the denominator dedupes by PR number — both are per-repo, so the
 * caller MUST pass one repo's records/dismissals per fit (the
 * `phase4-calibrate` script enforces `--repo`). Multi-tenant calibration
 * stratifies per repo and fits each separately.
 */
export function computeClaimCalibration(args: {
  shadowRecords: readonly CalibrationShadowRecord[]
  dismissals: readonly CalibrationDismissal[]
  nowMs: number
  maturityLagDays?: number
  trustworthyN?: number
}): CalibrationBlob {
  const lagDays = args.maturityLagDays ?? DEFAULT_MATURITY_LAG_DAYS
  const trustFloor = args.trustworthyN ?? CLAIM_SOFTEN_TRUSTWORTHY_N
  const maturityCutoffMs = args.nowMs - lagDays * DAY_MS

  // Max dismissal PR per fid → `dismissed(row) = maxPr[fid] >= row.prNumber`
  // (∃ a dismissal on the same-or-later PR).
  const maxDismissalPrByFid = new Map<string, number>()
  for (const d of args.dismissals) {
    const prev = maxDismissalPrByFid.get(d.fid)
    if (prev === undefined || d.prNumber > prev) {
      maxDismissalPrByFid.set(d.fid, d.prNumber)
    }
  }

  const mature = args.shadowRecords.filter((r) => r.createdMs <= maturityCutoffMs)

  const out: CalibrationBlob = {}
  for (const claimType of ALL_REVIEW_MEMORY_CLAIM_TYPES) {
    const typePRs = new Set<number>()
    const dismissedPRs = new Set<number>()
    for (const record of mature) {
      let typeOnThisPr = false
      let dismissedOnThisPr = false
      for (const row of record.rows) {
        if (row.claimType !== claimType) continue
        typeOnThisPr = true
        const maxPr = maxDismissalPrByFid.get(row.fid)
        if (maxPr !== undefined && maxPr >= record.prNumber) {
          dismissedOnThisPr = true
        }
      }
      // Nest the dismissal insert inside the type guard so `dismissedPRs`
      // is STRUCTURALLY a subset of `typePRs` (s <= n always). Today
      // `dismissedOnThisPr` is only ever set for rows of this claim type
      // (the `continue` above), so this is belt-and-suspenders — but it
      // makes the invariant local: a future edit can't let another claim
      // type's dismissal inflate `s` past `n` and drive Beta's
      // `β = 9 + (n - s)` negative (DeepSeek-v4-pro hardening).
      if (typeOnThisPr) {
        typePRs.add(record.prNumber)
        if (dismissedOnThisPr) dismissedPRs.add(record.prNumber)
      }
    }
    const n = typePRs.size
    if (n === 0) continue
    const s = dismissedPRs.size
    const trustworthyN = n >= trustFloor
    const params: ClaimCalibrationParams = {
      lowerBound: betaLowerBound(s, n),
      n,
      s,
      trustworthyN,
      // Cold whenever the sample is below the trustworthy floor. The
      // field is kept separate from `trustworthyN` so a future fit can
      // hard-disable a type for data-quality reasons the n-gate misses.
      cold: !trustworthyN,
    }
    out[claimType] = params
  }
  return out
}
