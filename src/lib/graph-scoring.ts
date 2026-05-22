// SIG-138 Phase 2 — Pure hybrid scoring helpers.
//
// No I/O, no Durable Object access. All functions are synchronous and
// dependency-free. Used by RepoGraphDO.contextForVectorHits and the
// ensemble wiring to blend vector similarity scores with graph-proximity
// signals into a single final ranking score.
//
// Weight table (from spec §4):
//   Edge kind        weight
//   same_file        1.00  (intra-file call)
//   imported_binding 0.85  (cross-file call via import)
//   import           0.65  (file dependency edge)
//   export           0.65
//   reexport         0.65
//   unresolved       0.20  (telemetry-only; low confidence)
//   ambiguous        0.20
//   raw              0.20  (not yet resolved)
//   <unknown>        0.20  (safe default — prefer missing over false)
//
// Hop decay table (K=2 cap from spec §4):
//   hop ≤ 1 → 1.00
//   hop = 2 → 0.55
//   hop > 2 → 0 (excluded from BFS in practice; guard here for purity)
//
// Hybrid formula (λ = 0.70 vector weight, spec §4):
//   final = LAMBDA * vector_norm + (1 - LAMBDA) * graph_norm

/** Vector weight in the hybrid blend. Spec: λ = 0.70. */
export const LAMBDA = 0.7

const EDGE_WEIGHTS: Readonly<Record<string, number>> = {
  same_file: 1.0,
  imported_binding: 0.85,
  import: 0.65,
  export: 0.65,
  reexport: 0.65,
  unresolved: 0.2,
  ambiguous: 0.2,
  raw: 0.2,
}

/**
 * Return the edge weight for a given edge kind / call_kind /
 * resolution_status string. Unknown kinds default to 0.2 (safe minimum).
 */
export function edgeWeight(kind: string): number {
  return EDGE_WEIGHTS[kind] ?? 0.2
}

/**
 * Hop-distance decay factor. BFS is capped at K=2 so hop > 2 receives 0,
 * acting as a hard exclusion guard should any caller violate the cap.
 */
export function hopDecay(hop: number): number {
  if (hop <= 1) return 1.0
  if (hop === 2) return 0.55
  return 0
}

/**
 * Min-max normalise an array of raw vector similarity scores to [0, 1].
 *
 * Non-finite (NaN, Infinity) inputs are handled defensively:
 * - Compute min/max over only finite values.
 * - Map any non-finite input element to 0 (lowest).
 * - If all inputs are non-finite, return all 0s (safe fallback).
 *
 * Edge cases:
 * - Empty array → [] (no-op).
 * - All scores identical (range < 1e-9) → all 1.0 (every candidate is
 *   equally good; do not penalise them by mapping to 0).
 */
export function normalizeVectorScores(scores: number[]): number[] {
  if (scores.length === 0) return []

  // Filter to finite values only; guard against NaN/Infinity poisoning.
  const finiteScores = scores.filter(Number.isFinite)

  // If no finite values exist, return all 0s (safe fallback).
  if (finiteScores.length === 0) return scores.map(() => 0)

  const min = Math.min(...finiteScores)
  const max = Math.max(...finiteScores)

  // If all finite values are identical, return 1.0 for finite, 0 for non-finite.
  if (max - min < 1e-9) {
    return scores.map((s) => (Number.isFinite(s) ? 1 : 0))
  }

  const range = max - min
  // Map each score: finite → normalized [0,1], non-finite → 0.
  return scores.map((s) => (Number.isFinite(s) ? (s - min) / range : 0))
}

/**
 * Blend a normalised vector score and a normalised graph score using the
 * spec's λ = 0.70 vector weight.
 *
 * Both inputs are expected to be in [0, 1] (i.e. already normalised by
 * the caller via normalizeVectorScores / a per-query graph_raw/max pass).
 */
export function hybridScore(a: { vectorNorm: number; graphNorm: number }): number {
  return LAMBDA * a.vectorNorm + (1 - LAMBDA) * a.graphNorm
}
