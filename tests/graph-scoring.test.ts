import { describe, expect, it } from "vitest"
import { edgeWeight, hopDecay, hybridScore, normalizeVectorScores, LAMBDA } from "../src/lib/graph-scoring"

describe("graph-scoring", () => {
  it("edge + hop weights match the spec table", () => {
    expect(edgeWeight("same_file")).toBe(1.0)
    expect(edgeWeight("imported_binding")).toBe(0.85)
    expect(edgeWeight("import")).toBe(0.65)
    expect(edgeWeight("unresolved")).toBe(0.2)
    expect(edgeWeight("totally-unknown")).toBe(0.2)
    expect(hopDecay(1)).toBe(1.0)
    expect(hopDecay(2)).toBe(0.55)
    expect(hopDecay(3)).toBe(0)
  })
  it("min-max normalizes; range~0 → all 1; empty → []", () => {
    expect(normalizeVectorScores([0.2, 0.7, 1.2])).toEqual([0, 0.5, 1])
    expect(normalizeVectorScores([0.5, 0.5])).toEqual([1, 1])
    expect(normalizeVectorScores([])).toEqual([])
  })
  it("blends with LAMBDA=0.70 (vector weight)", () => {
    expect(LAMBDA).toBe(0.7)
    expect(hybridScore({ vectorNorm: 1, graphNorm: 0 })).toBeCloseTo(0.7)
    expect(hybridScore({ vectorNorm: 0, graphNorm: 1 })).toBeCloseTo(0.3)
    expect(hybridScore({ vectorNorm: 1, graphNorm: 1 })).toBeCloseTo(1.0)
  })
})
