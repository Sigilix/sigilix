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
    const result = normalizeVectorScores([0.2, 0.7, 1.2])
    expect(result.length).toBe(3)
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(0.5)
    expect(result[2]).toBeCloseTo(1)
    expect(normalizeVectorScores([0.5, 0.5])).toEqual([1, 1])
    expect(normalizeVectorScores([])).toEqual([])
  })

  it("edge case: single-element array", () => {
    const result = normalizeVectorScores([0.7])
    expect(result).toEqual([1])
  })

  it("edge case: negative scores", () => {
    const result = normalizeVectorScores([-1, -0.5, 0])
    expect(result.length).toBe(3)
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(0.5)
    expect(result[2]).toBeCloseTo(1)
  })

  it("edge case: all zero", () => {
    expect(normalizeVectorScores([0, 0, 0])).toEqual([1, 1, 1])
  })

  it("edge case: NaN in input → no NaN in output", () => {
    const result = normalizeVectorScores([0.2, NaN, 0.8])
    expect(result.length).toBe(3)
    // All elements must be finite (no NaN/Infinity)
    expect(Number.isFinite(result[0])).toBe(true)
    expect(Number.isFinite(result[1])).toBe(true)
    expect(Number.isFinite(result[2])).toBe(true)
    // Finite elements normalized [0,1]; non-finite (NaN) mapped to 0
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(0) // NaN → 0
    expect(result[2]).toBeCloseTo(1)
  })

  it("edge case: Infinity in input → no Infinity in output", () => {
    const result = normalizeVectorScores([0.2, Infinity, 0.8])
    expect(result.length).toBe(3)
    expect(Number.isFinite(result[0])).toBe(true)
    expect(Number.isFinite(result[1])).toBe(true)
    expect(Number.isFinite(result[2])).toBe(true)
    // Finite elements normalized; Infinity mapped to 0
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(0)
    expect(result[2]).toBeCloseTo(1)
  })

  it("edge case: all NaN → all 0", () => {
    const result = normalizeVectorScores([NaN, NaN])
    expect(result).toEqual([0, 0])
  })
  it("blends with LAMBDA=0.70 (vector weight)", () => {
    expect(LAMBDA).toBe(0.7)
    expect(hybridScore({ vectorNorm: 1, graphNorm: 0 })).toBeCloseTo(0.7)
    expect(hybridScore({ vectorNorm: 0, graphNorm: 1 })).toBeCloseTo(0.3)
    expect(hybridScore({ vectorNorm: 1, graphNorm: 1 })).toBeCloseTo(1.0)
  })
})
