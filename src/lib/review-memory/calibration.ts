// SIG-280 PR C — review-memory soften CALIBRATION (consume contract).
//
// This module is the ENSEMBLE-SAFE half of Phase 4 calibration: the
// per-claim-type params shape, the thresholds, the KV-blob parser, and
// the `shouldKeepSoften` veto rule the warm veto consults. It is pure
// and dependency-free (no model calls, no KV, no stats library) so it
// can sit on the hot review path. The OFFLINE FIT that produces the
// blob (`computeClaimCalibration`) lives in `calibration-fit.ts` — it
// imports the types + thresholds from here so the producer and the
// consumer agree on the contract by construction.
//
// Believability contract: every ambiguous case — params absent, type
// unknown, fit marked cold, sample below the trustworthy floor, lower
// bound under threshold, malformed numbers — resolves to VETO (do NOT
// soften). The ONLY path that softens is a fully-formed, trustworthy,
// high-lower-bound entry. Worst case is "no soften", never over-soften.

import type { ReviewMemoryClaimType } from "./types"
import { ALL_REVIEW_MEMORY_CLAIM_TYPES } from "./types"

/**
 * Minimum distinct-PR denominator before a claim type's calibration is
 * trusted (DeepSeek-v4-pro: n >= ~100). Below this, the 95% lower bound
 * is too wide to act on regardless of point estimate, so the type stays
 * in the cold (veto-all) regime.
 */
export const CLAIM_SOFTEN_TRUSTWORTHY_N = 100

/**
 * The 95% LOWER credible/confidence bound of P(dismiss) a claim type
 * must clear to permit softening. We gate on the LOWER bound, not the
 * point estimate, so noisy high-mean/low-n types never sneak through
 * (the `trustworthyN` gate is the companion guard). DeepSeek-v4-pro set
 * 0.80 against a conservative prior.
 */
export const CLAIM_SOFTEN_LOWER_BOUND = 0.8

/**
 * KV key the offline fit writes and the warm veto reads. Versioned in
 * the key (`:v1:`) so a future schema change ships a new key rather
 * than silently re-interpreting old params.
 */
export const CALIBRATION_PARAMS_KV_KEY = "calibration-params:v1:claim-types"

/**
 * Per-claim-type calibrated parameters. Precomputed offline so the hot
 * path compares numbers only (no inverse-incomplete-beta in the worker).
 */
export interface ClaimCalibrationParams {
  /**
   * 95% LOWER bound of P(reviewer dismisses a finding carrying this
   * claim type | the finding claim-matched an active memory). Computed
   * offline as the lower 5% quantile of a Beta(1,9) posterior (normal
   * approximation) on the distinct-PR dismissal proportion — NOT a
   * Wilson interval, which DeepSeek-v4-pro showed is anti-conservative
   * here (e.g. 100/100 → Wilson 0.964 vs Beta(1,9) 0.855). The
   * pessimistic prior is the believability margin. See
   * `computeClaimCalibration` in `calibration-fit.ts`.
   */
  lowerBound: number
  /** Denominator: distinct PRs that raised a claim-matched finding of this type. */
  n: number
  /** Numerator: distinct PRs with a (leakage-safe) dismissal of such a finding. */
  s: number
  /** `n >= CLAIM_SOFTEN_TRUSTWORTHY_N`. Precomputed so the gate is explicit. */
  trustworthyN: boolean
  /**
   * Fit-asserted "do not trust this type" flag. Set when the denominator
   * is below the floor OR the fit detected a data-quality problem
   * (degenerate window, no negative class, etc.). Independent of the
   * numeric gates so the producer can hard-disable a type the math alone
   * would otherwise wave through.
   */
  cold: boolean
}

/** The full blob: a partial map from claim type to its params. */
export type CalibrationBlob = Partial<
  Record<ReviewMemoryClaimType, ClaimCalibrationParams>
>

const CLAIM_TYPE_SET: ReadonlySet<string> = new Set(ALL_REVIEW_MEMORY_CLAIM_TYPES)

/**
 * The single soften-or-veto decision for one claim type's params. Returns
 * `true` (KEEP the soften) ONLY when the entry is present, warm, has a
 * trustworthy sample, and clears the lower-bound threshold. Everything
 * else — undefined, cold, thin sample, low bound, NaN — VETOES.
 */
export function shouldKeepSoften(
  params: ClaimCalibrationParams | undefined,
): boolean {
  if (!params) return false
  if (params.cold) return false
  if (!params.trustworthyN) return false
  if (!Number.isFinite(params.lowerBound)) return false
  // A probability can't exceed 1 — a corrupt `lowerBound: 2` must not be
  // able to authorize softening (defense-in-depth alongside `isValidParams`).
  if (params.lowerBound > 1) return false
  return params.lowerBound >= CLAIM_SOFTEN_LOWER_BOUND
}

/**
 * Read + parse the calibration blob from a KV-like store. Best-effort:
 * any failure (miss, throw, malformed) returns null so the warm veto
 * falls back to the cold (veto-all) regime. Takes a minimal getter so it
 * stays ensemble-safe and unit-testable without a real KV binding.
 */
export async function readCalibrationParams(
  kv: { get(key: string): Promise<string | null> },
): Promise<CalibrationBlob | null> {
  try {
    return parseCalibrationBlob(await kv.get(CALIBRATION_PARAMS_KV_KEY))
  } catch {
    return null
  }
}

/**
 * One softened finding considered for the warm calibrated veto. The
 * `index` (consensus-array position) is the STABLE join key the
 * orchestrator maps decisions back through — never headline/fid. The
 * `matchedTypes` are the claim types this finding matched an active
 * memory on (shadowClaims-conditioned), matching exactly what the
 * calibration corpus measured.
 */
export interface WarmSoftenCandidate {
  /**
   * Consensus-array index of the softened finding. This is the STABLE
   * survival key — the orchestrator softens / accounts a finding by INDEX,
   * never by `sourceFindingId`. Keying by source id would leak: one
   * specialist source id can appear in more than one synthesized finding,
   * so a kept decision for one would soften a sibling too (Codex + CodeRabbit
   * P1). Index is one-to-one with the output finding.
   */
  index: number
  fid: string
  /**
   * Claim types this finding matched an active memory on (shadowClaims-
   * conditioned) — exactly what the calibration corpus measured.
   */
  matchedTypes: readonly ReviewMemoryClaimType[]
}

export interface WarmSoftenDecision {
  index: number
  fid: string
  kept: boolean
  /** The matched claim types that voted KEEP (for telemetry). */
  keepingTypes: ReviewMemoryClaimType[]
}

/**
 * The believability-critical warm soften decision, as a PURE function.
 * A candidate's soften SURVIVES only if at least one of the claim types
 * it matched a memory on has trustworthy, high-lower-bound calibration
 * (`shouldKeepSoften`). Everything else VETOES: no matched claim type,
 * only cold/thin/low-bound types, params absent. Returns one decision per
 * candidate, keyed by output-finding `index`; the orchestrator softens /
 * accounts by index and derives any source-id view FROM the surviving
 * indices, so a survival can never leak onto a sibling finding. The P0/P1
 * floor is applied separately by the renderer as the final guard.
 */
export function decideWarmSoftenSurvival(args: {
  candidates: readonly WarmSoftenCandidate[]
  blob: CalibrationBlob
}): WarmSoftenDecision[] {
  return args.candidates.map((c) => {
    const keepingTypes = c.matchedTypes.filter((t) => shouldKeepSoften(args.blob[t]))
    return { index: c.index, fid: c.fid, kept: keepingTypes.length > 0, keepingTypes }
  })
}

function isValidParams(v: unknown): v is ClaimCalibrationParams {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  if (
    typeof o.lowerBound !== "number" ||
    typeof o.n !== "number" ||
    typeof o.s !== "number" ||
    typeof o.trustworthyN !== "boolean" ||
    typeof o.cold !== "boolean"
  ) {
    return false
  }
  // Range sanity (believability, Codex P2): a hand-corrupted blob must not
  // be able to authorize softening. `lowerBound` is a probability, the
  // counts are non-negative integers, and successes cannot exceed the
  // denominator. Any violation drops the entry → that claim type then has
  // no params → it vetoes.
  if (!Number.isFinite(o.lowerBound) || o.lowerBound < 0 || o.lowerBound > 1) return false
  if (!Number.isInteger(o.n) || o.n < 0) return false
  if (!Number.isInteger(o.s) || o.s < 0 || o.s > o.n) return false
  return true
}

/**
 * Parse the KV-stored params blob. Best-effort + defensive: returns null
 * on missing / non-JSON / non-object input so the caller treats the
 * whole regime as cold (veto-all). Within a valid object, unknown claim
 * types are dropped (forward-compat with future enum values) and entries
 * whose field types don't match are dropped (that type then has no
 * params → vetoes). A surviving entry is a fully-validated
 * `ClaimCalibrationParams`.
 */
export function parseCalibrationBlob(raw: string | null): CalibrationBlob | null {
  if (raw === null || raw === "") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const out: CalibrationBlob = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!CLAIM_TYPE_SET.has(key)) continue
    if (!isValidParams(value)) continue
    out[key as ReviewMemoryClaimType] = value
  }
  return out
}
