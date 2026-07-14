// Memory consolidation — near-duplicate clustering + conflict resolution
// (Gardener P2 of the dynamic-memory moat).
//
// Pure domain logic: given a single store's learnings + their (runtime-embedded)
// rule vectors, find clusters of >=`minClusterSize` mutually near-duplicate rules
// and decide, deterministically, whether a cluster is SAFE to collapse into one
// canonical rule. The Gardener LLM only ever sees clusters this layer has already
// cleared; every ambiguous or conflicting signal keeps the originals untouched.
//
// Domain-layer contract: NO env, NO IO, NO clock, NO network, NO embedding call.
// The vectors are computed by the (adapter) caller and injected aligned to
// `entries` by index. Clustering is deliberately confined to ONE store — the
// caller never mixes vectors across `learnings:<scope>:<subjectId>` keys, so a
// cross-tenant merge is structurally impossible.

import type { LearningEntry, LearningPolarity } from "./types"

/** Default cosine threshold above which two rule vectors are "near-duplicate". */
export const CONSOLIDATE_SIMILARITY_THRESHOLD = 0.85

/** Minimum members before a cluster is worth collapsing (the plan's ">=3"). */
export const CONSOLIDATE_MIN_CLUSTER_SIZE = 3

export interface ClusterOptions {
  /** Cosine similarity strictly ABOVE which two entries join a cluster. */
  threshold: number
  /** Clusters smaller than this are discarded (never collapsed). */
  minClusterSize: number
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for a length mismatch
 * or a zero-magnitude vector (an undefined direction can never be "similar"), so
 * the caller never divides by zero and a degenerate embedding can never seed a
 * spurious cluster. Pure.
 */
export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Group `entries` into clusters of mutually near-duplicate rules.
 *
 * Greedy, seed-anchored single pass: each not-yet-clustered entry seeds a
 * cluster and pulls in every OTHER not-yet-clustered entry whose vector is
 * `cosine(seed, other) > threshold`. Anchoring every member to the seed (rather
 * than transitive/single-link growth) keeps a cluster tight — no chain of
 * pairwise-near but end-to-end-dissimilar rules can drift together. O(n^2) over a
 * single store's entries (bounded by MAX_LEARNINGS = 50), so the cost is a few
 * thousand float ops per store.
 *
 * Only clusters with `>= minClusterSize` members are returned; a member's
 * original entry object is returned (never a copy) so the caller can archive it
 * by identity. `vectors` MUST be index-aligned to `entries`; an entry with no
 * aligned vector is skipped (never clustered) rather than compared against a
 * bogus zero vector.
 */
export function clusterBySimilarity(
  entries: ReadonlyArray<LearningEntry>,
  vectors: ReadonlyArray<ReadonlyArray<number>>,
  options: ClusterOptions,
): LearningEntry[][] {
  const { threshold, minClusterSize } = options
  const n = Math.min(entries.length, vectors.length)
  const claimed = new Array<boolean>(entries.length).fill(false)
  const clusters: LearningEntry[][] = []

  for (let i = 0; i < n; i++) {
    if (claimed[i]) continue
    const seedEntry = entries[i]
    const seedVec = vectors[i]
    if (seedEntry === undefined || seedVec === undefined) continue

    const memberIdx = [i]
    for (let j = i + 1; j < n; j++) {
      if (claimed[j]) continue
      const otherVec = vectors[j]
      if (otherVec === undefined) continue
      if (cosine(seedVec, otherVec) > threshold) memberIdx.push(j)
    }

    if (memberIdx.length < minClusterSize) continue
    // Claim only once we know the cluster qualifies, so a sub-threshold seed
    // doesn't lock its would-be members out of a later, larger cluster.
    const members: LearningEntry[] = []
    for (const idx of memberIdx) {
      claimed[idx] = true
      const e = entries[idx]
      if (e !== undefined) members.push(e)
    }
    clusters.push(members)
  }

  return clusters
}

/** The distinct polarities present in a cluster. */
function clusterPolarities(cluster: ReadonlyArray<LearningEntry>): Set<LearningPolarity> {
  return new Set(cluster.map((e) => e.polarity))
}

/**
 * A cluster carries an irreconcilable polarity conflict when it contains BOTH a
 * `suppress` and a `require` rule — collapsing those into one canonical rule
 * would silently pick a side (either muting a real requirement or re-flagging a
 * deliberately-suppressed pattern). `context` is neutral and never conflicts.
 * This is the hard guard behind "never let the LLM collapse a suppress + a
 * require": the conflicted cluster never reaches the model.
 */
export function clusterHasPolarityConflict(cluster: ReadonlyArray<LearningEntry>): boolean {
  const polarities = clusterPolarities(cluster)
  return polarities.has("suppress") && polarities.has("require")
}

export type ClusterConflictResolution =
  | { kind: "polarity-conflict"; polarities: LearningPolarity[] }
  | { kind: "ok"; ordered: LearningEntry[]; preferred: LearningEntry }

/**
 * Decide whether a cluster is safe to collapse, and if so rank its members so
 * the Gardener prompt can "prefer most-recent + most-applied".
 *
 * - A suppress+require cluster is REJECTED (`polarity-conflict`) and never merged.
 * - Otherwise the members are ordered by `createdTs` DESC (most recent first),
 *   with `appliedCount` DESC as the tiebreak; `preferred` is that winner. The
 *   input array is never mutated (a defensive copy is sorted).
 *
 * Pure — the only clock input is each entry's own persisted `createdTs`.
 */
export function resolveClusterConflict(cluster: ReadonlyArray<LearningEntry>): ClusterConflictResolution {
  if (clusterHasPolarityConflict(cluster)) {
    return { kind: "polarity-conflict", polarities: [...clusterPolarities(cluster)] }
  }
  const ordered = [...cluster].sort((a, b) => {
    const ta = createdMs(a)
    const tb = createdMs(b)
    if (tb !== ta) return tb - ta // most-recent first
    return b.appliedCount - a.appliedCount // then most-applied
  })
  // A cluster always has members here (callers pass >= minClusterSize), but keep
  // the access total so the function never throws on an empty input.
  const preferred = ordered[0] ?? cluster[0]!
  return { kind: "ok", ordered, preferred }
}

function createdMs(entry: LearningEntry): number {
  const parsed = Date.parse(entry.createdTs)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/**
 * Anti-suppression-backdoor guard: a consolidation may only carry `suppress`
 * polarity when the cluster it collapses ALREADY contained a suppress rule.
 * Consolidation must never MINT a brand-new suppress (that would let the Gardener
 * quietly widen suppression — a recall regression) — it may only preserve an
 * existing one. `require`/`context` canonicals are always allowed.
 */
export function canonicalPolarityAllowed(
  cluster: ReadonlyArray<LearningEntry>,
  canonicalPolarity: LearningPolarity,
): boolean {
  if (canonicalPolarity !== "suppress") return true
  return clusterPolarities(cluster).has("suppress")
}

/**
 * The canonical taxonomy type for a consolidation. The collapsed rule is a
 * DURABLE rule (its `lifespanAnchor` is `{kind:"durable"}`), so it is one of the
 * two durable tiers: `architectural_fact` when any merged member was already an
 * architectural fact (a factual statement about the codebase outranks a mere
 * preference), else `durable_preference`.
 */
export function chooseCanonicalType(
  cluster: ReadonlyArray<LearningEntry>,
): "durable_preference" | "architectural_fact" {
  return cluster.some((e) => e.type === "architectural_fact") ? "architectural_fact" : "durable_preference"
}

/**
 * Only the two DURABLE tiers are consolidation candidates. Legacy (untyped)
 * records are excluded (moat guard: "never touch legacy"), and the two EPHEMERAL
 * tiers (`ephemeral_project` / `transient_feedback`) are excluded too: the
 * canonical a merge produces is always durable (`chooseCanonicalType` +
 * `lifespanAnchor:{kind:"durable"}`), so consolidating ephemerals would launder a
 * decay-reapable memory into an immortal one + archive the originals — undermining
 * the decay lane. Consolidation collapses durable duplicates only.
 */
export function isDurableConsolidationCandidate(entry: Pick<LearningEntry, "type">): boolean {
  return entry.type === "durable_preference" || entry.type === "architectural_fact"
}
