// Pure consolidation domain: cosine, seed-anchored clustering + thresholds,
// conflict resolution (recency/appliedCount ordering + the suppress+require
// guard), and the two canonical guards (suppression-backdoor + type choice).

import { describe, expect, it } from "vitest"

import {
  CONSOLIDATE_MIN_CLUSTER_SIZE,
  CONSOLIDATE_SIMILARITY_THRESHOLD,
  canonicalPolarityAllowed,
  chooseCanonicalType,
  clusterBySimilarity,
  clusterHasPolarityConflict,
  cosine,
  isDurableConsolidationCandidate,
  resolveClusterConflict,
} from "./consolidate"
import type { LearningEntry, LearningPolarity } from "./types"

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: overrides.id ?? "l1",
    rule: overrides.rule ?? "rule text",
    polarity: overrides.polarity ?? "context",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: overrides.scope ?? "repo",
    subjectId: overrides.subjectId ?? "123",
    source: overrides.source ?? { kind: "top-level" },
    createdTs: overrides.createdTs ?? "2026-05-01T00:00:00.000Z",
    appliedCount: overrides.appliedCount ?? 0,
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
    ...(overrides.lifespanAnchor !== undefined ? { lifespanAnchor: overrides.lifespanAnchor } : {}),
  }
}

describe("cosine", () => {
  it("identical vectors → 1; orthogonal → 0; opposite → -1", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1)
  })
  it("magnitude-invariant (direction only)", () => {
    expect(cosine([2, 0], [5, 0])).toBeCloseTo(1)
  })
  it("degenerate inputs → 0 (zero vector / length mismatch / empty)", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([1, 2, 3], [1, 2])).toBe(0)
    expect(cosine([], [])).toBe(0)
  })
})

describe("clusterBySimilarity", () => {
  const opts = { threshold: CONSOLIDATE_SIMILARITY_THRESHOLD, minClusterSize: CONSOLIDATE_MIN_CLUSTER_SIZE }

  it("groups the 3 near-duplicate rules and drops the lone dissimilar one", () => {
    const entries = [
      entry({ id: "a", rule: "wrap db calls in a service layer" }),
      entry({ id: "b", rule: "always wrap db calls in a service" }),
      entry({ id: "c", rule: "db calls go through the service layer" }),
      entry({ id: "d", rule: "unrelated preference about tabs" }),
    ]
    // a/b/c identical direction (>0.85); d orthogonal.
    const vectors = [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]
    const clusters = clusterBySimilarity(entries, vectors, opts)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.map((e) => e.id).sort()).toEqual(["a", "b", "c"])
  })

  it("a 2-member near-duplicate pair is BELOW minClusterSize → no cluster", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })]
    const vectors = [
      [1, 0],
      [1, 0],
      [0, 1],
    ]
    expect(clusterBySimilarity(entries, vectors, opts)).toHaveLength(0)
  })

  it("respects the threshold strictly (> not >=): a cluster at exactly 0.85 is NOT formed", () => {
    // Construct three vectors pairwise cosine == 0.85 exactly.
    const t = 0.85
    const s = Math.sqrt(1 - t * t)
    const v = [t, s]
    const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })]
    // seed=[1,0]; others=[t,s] give cosine == t == 0.85 → NOT > threshold.
    const vectors = [[1, 0], v, v]
    expect(clusterBySimilarity(entries, vectors, opts)).toHaveLength(0)
  })

  it("finds two separate clusters in one store", () => {
    const entries = [
      entry({ id: "a1" }),
      entry({ id: "a2" }),
      entry({ id: "a3" }),
      entry({ id: "b1" }),
      entry({ id: "b2" }),
      entry({ id: "b3" }),
    ]
    const vectors = [
      [1, 0],
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 1],
      [0, 1],
    ]
    const clusters = clusterBySimilarity(entries, vectors, opts)
    expect(clusters).toHaveLength(2)
    expect(clusters.map((c) => c.length)).toEqual([3, 3])
  })

  it("skips entries with no aligned vector (never compares against a bogus zero)", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" }), entry({ id: "d" })]
    // Only 3 vectors provided → entry d is never clustered.
    const vectors = [
      [1, 0],
      [1, 0],
      [1, 0],
    ]
    const clusters = clusterBySimilarity(entries, vectors, opts)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.map((e) => e.id)).not.toContain("d")
  })
})

describe("clusterHasPolarityConflict / resolveClusterConflict", () => {
  it("suppress + require in one cluster → polarity conflict (never merged)", () => {
    const cluster = [
      entry({ id: "s", polarity: "suppress" }),
      entry({ id: "r", polarity: "require" }),
      entry({ id: "c", polarity: "context" }),
    ]
    expect(clusterHasPolarityConflict(cluster)).toBe(true)
    const res = resolveClusterConflict(cluster)
    expect(res.kind).toBe("polarity-conflict")
    if (res.kind === "polarity-conflict") {
      expect(res.polarities.sort()).toEqual(["context", "require", "suppress"])
    }
  })

  it("suppress + context (no require) → NOT a conflict", () => {
    const cluster = [
      entry({ id: "s", polarity: "suppress" }),
      entry({ id: "c1", polarity: "context" }),
      entry({ id: "c2", polarity: "context" }),
    ]
    expect(clusterHasPolarityConflict(cluster)).toBe(false)
    expect(resolveClusterConflict(cluster).kind).toBe("ok")
  })

  it("orders by createdTs DESC, then appliedCount DESC; preferred is the winner", () => {
    const older = entry({ id: "old", createdTs: "2026-01-01T00:00:00.000Z", appliedCount: 99 })
    const newer = entry({ id: "new", createdTs: "2026-06-01T00:00:00.000Z", appliedCount: 1 })
    const middle = entry({ id: "mid", createdTs: "2026-03-01T00:00:00.000Z", appliedCount: 5 })
    const res = resolveClusterConflict([older, newer, middle])
    expect(res.kind).toBe("ok")
    if (res.kind === "ok") {
      expect(res.ordered.map((e) => e.id)).toEqual(["new", "mid", "old"])
      expect(res.preferred.id).toBe("new")
    }
  })

  it("appliedCount breaks a createdTs tie", () => {
    const a = entry({ id: "a", createdTs: "2026-06-01T00:00:00.000Z", appliedCount: 3 })
    const b = entry({ id: "b", createdTs: "2026-06-01T00:00:00.000Z", appliedCount: 10 })
    const c = entry({ id: "c", createdTs: "2026-06-01T00:00:00.000Z", appliedCount: 1 })
    const res = resolveClusterConflict([a, b, c])
    if (res.kind === "ok") expect(res.preferred.id).toBe("b")
  })

  it("does not mutate the input array", () => {
    const cluster = [
      entry({ id: "a", createdTs: "2026-01-01T00:00:00.000Z" }),
      entry({ id: "b", createdTs: "2026-06-01T00:00:00.000Z" }),
      entry({ id: "c", createdTs: "2026-03-01T00:00:00.000Z" }),
    ]
    resolveClusterConflict(cluster)
    expect(cluster.map((e) => e.id)).toEqual(["a", "b", "c"])
  })
})

describe("canonicalPolarityAllowed (suppression-backdoor guard)", () => {
  const noSuppress = [entry({ polarity: "require" }), entry({ polarity: "context" })]
  const withSuppress = [entry({ polarity: "suppress" }), entry({ polarity: "context" })]
  const polarities: LearningPolarity[] = ["require", "context"]

  it("require/context canonicals always allowed", () => {
    for (const p of polarities) {
      expect(canonicalPolarityAllowed(noSuppress, p)).toBe(true)
      expect(canonicalPolarityAllowed(withSuppress, p)).toBe(true)
    }
  })
  it("a NEW suppress is rejected when no member was suppress", () => {
    expect(canonicalPolarityAllowed(noSuppress, "suppress")).toBe(false)
  })
  it("a suppress canonical is allowed when the cluster already had a suppress", () => {
    expect(canonicalPolarityAllowed(withSuppress, "suppress")).toBe(true)
  })
})

describe("chooseCanonicalType", () => {
  it("architectural_fact when any member is an architectural fact", () => {
    expect(
      chooseCanonicalType([
        entry({ type: "durable_preference" }),
        entry({ type: "architectural_fact" }),
        entry({ type: "ephemeral_project" }),
      ]),
    ).toBe("architectural_fact")
  })
  it("durable_preference otherwise", () => {
    expect(chooseCanonicalType([entry({ type: "durable_preference" }), entry({ type: "transient_feedback" })])).toBe(
      "durable_preference",
    )
  })
})

describe("isDurableConsolidationCandidate", () => {
  it("accepts ONLY the two durable tiers", () => {
    expect(isDurableConsolidationCandidate(entry({ type: "durable_preference" }))).toBe(true)
    expect(isDurableConsolidationCandidate(entry({ type: "architectural_fact" }))).toBe(true)
  })
  it("rejects ephemeral tiers and legacy (untyped) records", () => {
    expect(isDurableConsolidationCandidate(entry({ type: "ephemeral_project" }))).toBe(false)
    expect(isDurableConsolidationCandidate(entry({ type: "transient_feedback" }))).toBe(false)
    expect(isDurableConsolidationCandidate(entry())).toBe(false)
  })
})
