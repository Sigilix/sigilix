// SIG-114 — per-specialist FP-rate computation (pure).
//
// IMPORTANT honesty contract (see design doc): the dismissal-based hard-FP
// rate is a LOWER BOUND on the true FP rate (not every FP is dismissed), and
// the Wilson interval is sampling uncertainty on the OBSERVED rate. This
// metric supports "at least this bad" + trend; it does NOT support a ceiling
// claim ("FP rate is at most Y%"). A ceiling needs the curated eval set
// (next PR). `observedMeetsTarget` therefore reports whether the observed
// (lower-bound) rate clears the target — never dressed up as a guarantee.

import { wilsonInterval } from "@/src/lib/bakeoff-report"
import { ALL_SPECIALISTS, type SpecialistRole } from "@/src/lib/ensemble-router"
import type { AttributionResult } from "./attribute"

export const DEFAULT_MIN_N = 30
export const SPECIALIST_HARD_FP_TARGET = 0.1
export const SYNTH_HARD_FP_TARGET = 0.05

export type RateRole = SpecialistRole | "synth"

export interface RoleRate {
  role: RateRole
  postedN: number
  hard: number
  soft: number
  unlabeled: number
  /** hard / postedN, or null when postedN === 0. The lower-bound point estimate. */
  hardFpRate: number | null
  /** Wilson 95% CI on the hard-FP proportion (sampling uncertainty). */
  wilsonLower: number
  wilsonUpper: number
  sufficientN: boolean
  target: number
  /** Whether the OBSERVED rate clears target. null when n insufficient / 0. */
  observedMeetsTarget: boolean | null
}

export interface FpRateReport {
  rows: RoleRate[]
  unattributed: { possiblyExpired: number; notFound: number }
  reviewsScanned: number
  reviewsRealFanout: number
  reviewsZeroPostedFindings: number
  minN: number
}

export interface ComputeOpts {
  minN?: number
  specialistTarget?: number
  synthTarget?: number
}

function rateRow(
  role: RateRole,
  postedN: number,
  buckets: { hard: number; soft: number; unlabeled: number },
  target: number,
  minN: number,
): RoleRate {
  const w = wilsonInterval(buckets.hard, postedN) // n=0 -> {lower:0, upper:1}
  const sufficientN = postedN >= minN
  const hardFpRate = postedN > 0 ? buckets.hard / postedN : null
  // meets-target is the WORST CASE: unlabeled dismissals could each be a hard
  // FP (the capture pipeline doesn't emit a reason yet), so the target only
  // counts as met if it holds even when EVERY unlabeled dismissal is hard.
  // Soft dismissals are valid findings (not FPs) and never count here.
  const worstCaseHardRate = postedN > 0 ? (buckets.hard + buckets.unlabeled) / postedN : null
  const observedMeetsTarget =
    sufficientN && worstCaseHardRate !== null ? worstCaseHardRate <= target : null
  return {
    role,
    postedN,
    hard: buckets.hard,
    soft: buckets.soft,
    unlabeled: buckets.unlabeled,
    hardFpRate,
    wilsonLower: w.lower,
    wilsonUpper: w.upper,
    sufficientN,
    target,
    observedMeetsTarget,
  }
}

/**
 * Compute per-specialist + synth hard-FP rates with Wilson CIs and a min-n
 * gate. Pure. Synth is the final-gate aggregate (all posted score-gated
 * findings / all dismissed); the four specialists are attributed via
 * full-credit sourceSpecialists.
 */
export function computeFpRates(
  attr: AttributionResult,
  opts: ComputeOpts = {},
): FpRateReport {
  const minN = opts.minN ?? DEFAULT_MIN_N
  const specialistTarget = opts.specialistTarget ?? SPECIALIST_HARD_FP_TARGET
  const synthTarget = opts.synthTarget ?? SYNTH_HARD_FP_TARGET

  const rows: RoleRate[] = []
  for (const role of ALL_SPECIALISTS) {
    rows.push(
      rateRow(role, attr.denominator[role].length, attr.numerator[role], specialistTarget, minN),
    )
  }
  rows.push(
    rateRow("synth", attr.synthDenominator.length, attr.synthNumerator, synthTarget, minN),
  )

  return {
    rows,
    unattributed: attr.unattributed,
    reviewsScanned: attr.reviewsScanned,
    reviewsRealFanout: attr.reviewsRealFanout,
    reviewsZeroPostedFindings: attr.reviewsZeroPostedFindings,
    minN,
  }
}
