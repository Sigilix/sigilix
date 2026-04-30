// Severity → priority and estimate → points mappings. These are pure
// functions and the most likely place for a silent regression — if the
// table drifts, every triage starts writing wrong values to Linear.

import { describe, expect, it } from "vitest"
import { estimateToPoints, severityToPriority } from "../src/lib/linear"

describe("severityToPriority", () => {
  it.each([
    ["P0", 1], // Urgent
    ["P1", 2], // High
    ["P2", 3], // Normal
    ["P3", 4], // Low
  ])("%s → %i", (severity, expected) => {
    expect(severityToPriority(severity)).toBe(expected)
  })

  it("returns 0 (None) for unknown severities", () => {
    expect(severityToPriority("UNKNOWN")).toBe(0)
    expect(severityToPriority("")).toBe(0)
  })

  it("is case-insensitive", () => {
    expect(severityToPriority("p1")).toBe(2)
  })
})

describe("estimateToPoints", () => {
  it.each([
    ["trivial", 1],
    ["S", 2],
    ["M", 3],
    ["L", 5],
    ["XL", 8],
  ])("%s → %i points", (estimate, expected) => {
    expect(estimateToPoints(estimate)).toBe(expected)
  })

  it("returns undefined for unknown estimates (operator sizes by hand)", () => {
    expect(estimateToPoints("XXL")).toBeUndefined()
    expect(estimateToPoints("epic")).toBeUndefined()
    expect(estimateToPoints("")).toBeUndefined()
  })

  it("never auto-assigns 13 — that's a true epic the operator should size", () => {
    // 13 is intentionally absent from the mapping. Verify by checking that
    // no input produces 13.
    const allInputs = ["trivial", "S", "M", "L", "XL", "XXL", "epic", ""]
    for (const input of allInputs) {
      expect(estimateToPoints(input)).not.toBe(13)
    }
  })
})
