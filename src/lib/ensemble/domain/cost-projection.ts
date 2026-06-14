// SIG-417 — the pure projected-cost math (domain leaf).
//
// Two pure functions, no IO / env / clock / model-provider import:
//   - `projectReviewCostUsd` — a pre-flight USD ESTIMATE of a review's cost from
//     the model lineup that will run × the reviewed-diff token size. Used for
//     `cost-projection` telemetry, and (when the dark governor is enabled) as
//     the trim target. Pricing comes from the pure `shared/domain/model-pricing`
//     leaf — NOT `ensemble-slo-telemetry` (the dependency rule, Codex sign-off).
//   - `applyCostGovernorTrim` — trims the lowest-risk (risk-ordered TAIL) files
//     until the projection is at/under the ceiling, with hard recall floors.
//
// The projection is intentionally a FLOOR-ish estimate, NOT a hard cap. It
// counts INPUT tokens only (diff + a fixed per-call overhead), priced at the
// per-model INPUT rate. It ignores: output tokens, retries, tool turns, the
// synth's free-form repo-overrides, and the actual `usage.cost` (which only
// exists after the call). Named honestly as a *projection*; the post-hoc
// `cost-projection-miss` telemetry calibrates it before any enforcement.

import { pricingForModel } from "@/src/shared/domain/model-pricing"

/** The model lineup a projection prices. Passed IN by the caller (the app
 *  layer reads it from `SPECIALIST_CONFIGS`/`SYNTHESIZER_CONFIG`) so this pure
 *  module never imports model-provider state. */
export interface CostProjectionLineup {
  /** Primary model id of each ROUTED specialist that will run this review. */
  specialistModels: string[]
  /** The synthesizer's primary model id. */
  synthModel: string
}

export interface CostProjectionInput extends CostProjectionLineup {
  /** Estimated token size of the reviewed diff (the batch the specialists see).
   *  Each model is charged for this once (each reads the same packed diff). */
  reviewedDiffTokens: number
  /** Fixed per-call overhead token estimate (system prompt + retrieval snapshot
   *  + output budget) added to the diff tokens for EACH model call. */
  perCallOverheadTokensEst: number
}

export interface CostProjection {
  /** The projected total cost in USD across every model that will run. */
  projectedUsd: number
  /** Per-model projected USD, for the telemetry drilldown. */
  byModelUsd: Record<string, number>
  /** The per-call input-token figure each model was priced on (diff + overhead). */
  perCallInputTokens: number
}

/**
 * Pre-flight USD projection. Each model (every routed specialist + the synth) is
 * priced on `reviewedDiffTokens + perCallOverheadTokensEst` INPUT tokens at its
 * `MODEL_PRICING` input rate. Pure; INPUT-only by design (see the module header).
 * A model appearing twice (e.g. synth == a specialist id) is priced twice — it
 * runs twice. Unknown models fall back to `DEFAULT_PRICING` (never $0).
 */
export function projectReviewCostUsd(input: CostProjectionInput): CostProjection {
  const perCallInputTokens = Math.max(0, input.reviewedDiffTokens) + Math.max(0, input.perCallOverheadTokensEst)
  const byModelUsd: Record<string, number> = {}
  let projectedUsd = 0
  for (const model of [...input.specialistModels, input.synthModel]) {
    const usd = (perCallInputTokens / 1_000_000) * pricingForModel(model).inputPerMTokUsd
    // Multiple calls on the same model id accumulate (it runs once per entry).
    byModelUsd[model] = (byModelUsd[model] ?? 0) + usd
    projectedUsd += usd
  }
  return { projectedUsd, byModelUsd, perCallInputTokens }
}

/** A file the governor may consider trimming. Minimal shape so this stays free
 *  of the diff-packing types (the caller maps its blocks to/from this). */
export interface TrimCandidate {
  path: string
}

export interface CostGovernorTrimArgs<F extends TrimCandidate> {
  /** Risk-ORDERED reviewed files (highest-risk first — the packer's order). The
   *  TAIL is the lowest-risk, trimmed first. */
  reviewedFiles: readonly F[]
  /** Re-projects the cost for a candidate kept-set. The caller closes over the
   *  lineup + overhead + its token estimator so this module stays pure. */
  projectUsdForFiles: (kept: readonly F[]) => number
  /** Founder-set ceiling; trimming stops once the projection is at/under it. */
  ceilingUsd: number
  /** Floor: never trim below this many reviewed files. */
  minReviewedFiles: number
  /** A file the governor must NEVER trim (high-risk path). Returns true for
   *  high-risk files — they stay in `kept` regardless of the ceiling. */
  isHighRisk: (path: string) => boolean
  /** Files with a deterministic-check or secret-scan hit on the PRE-trim batch.
   *  Untrimmable — trimming one would drop it from the cheap P0/P1 detectors
   *  too (those run on the packed diff). Codex sign-off #3. */
  protectedPaths: ReadonlySet<string>
}

export interface CostGovernorTrimResult<F extends TrimCandidate> {
  /** The files that survive (reviewed). Risk order preserved. */
  kept: F[]
  /** The files trimmed out (lowest-risk tail), in the order trimmed. */
  trimmed: F[]
  /** The projection after trimming (≤ ceiling unless a floor/guard stopped it). */
  projectedUsd: number
  /** True when a floor/guard (minReviewedFiles, all-remaining-protected) stopped
   *  the trim before reaching the ceiling — the run will still be over budget. */
  ceilingUnmet: boolean
}

/**
 * Trim the lowest-risk (risk-ordered TAIL) files until the projection is at/under
 * `ceilingUsd`, honoring hard recall floors:
 *   - never trim below `minReviewedFiles`,
 *   - never trim a high-risk file (`isHighRisk`),
 *   - never trim a file with a deterministic/secret hit (`protectedPaths`).
 * A protected/high-risk file in the tail is SKIPPED (kept) and the next-lowest
 * candidate is considered. Pure; no mutation of the input. When the floors stop
 * the trim before the ceiling, `ceilingUnmet` is true (the caller keeps the run
 * but stays over budget — it never drops a finding to hit a number).
 */
export function applyCostGovernorTrim<F extends TrimCandidate>(
  args: CostGovernorTrimArgs<F>,
): CostGovernorTrimResult<F> {
  const { reviewedFiles, projectUsdForFiles, ceilingUsd, minReviewedFiles, isHighRisk, protectedPaths } = args
  const kept: F[] = [...reviewedFiles]
  const trimmed: F[] = []
  const floor = Math.max(1, minReviewedFiles)

  let projectedUsd = projectUsdForFiles(kept)
  // Walk the tail (lowest-risk first). `cursor` is the index of the candidate we
  // are considering; protected/high-risk candidates are skipped (left in place)
  // by moving the cursor left without trimming.
  let cursor = kept.length - 1
  while (projectedUsd > ceilingUsd && kept.length > floor && cursor >= 0) {
    const candidate = kept[cursor]!
    if (isHighRisk(candidate.path) || protectedPaths.has(candidate.path)) {
      // Untrimmable — keep it, consider the next-lowest-risk file.
      cursor -= 1
      continue
    }
    kept.splice(cursor, 1)
    trimmed.push(candidate)
    projectedUsd = projectUsdForFiles(kept)
    // Removing shifted indices; the next candidate is at the new tail position.
    cursor = Math.min(cursor, kept.length - 1)
  }

  return { kept, trimmed, projectedUsd, ceilingUnmet: projectedUsd > ceilingUsd }
}
