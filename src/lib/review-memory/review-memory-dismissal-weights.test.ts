// SIG-173 — dismissal-weights: the per-reason softening weight table +
// the pure weighted-count helper used by `isMemoryActive`.

import { describe, expect, it } from "vitest"
import {
  DEFAULT_DISMISSAL_WEIGHT,
  DISMISSAL_SOFTENING_WEIGHTS,
  weightForReason,
  weightedSignalCount,
} from "@/lib/review-memory/dismissal-weights"
import { ALL_DISMISS_REASONS } from "@/lib/dismiss-reasons"

describe("DISMISSAL_SOFTENING_WEIGHTS table", () => {
  it("pins the only above-1.0 reason to too-minor at 1.5x (spec-locked)", () => {
    expect(DISMISSAL_SOFTENING_WEIGHTS["too-minor"]).toBe(1.5)
  })

  it("leaves every other reason at the default 1.0 in v1", () => {
    expect(DISMISSAL_SOFTENING_WEIGHTS["not-a-bug"]).toBe(1.0)
    expect(DISMISSAL_SOFTENING_WEIGHTS["bad-anchor"]).toBe(1.0)
    expect(DISMISSAL_SOFTENING_WEIGHTS["already-covered"]).toBe(1.0)
    expect(DISMISSAL_SOFTENING_WEIGHTS["wrong-context"]).toBe(1.0)
    expect(DISMISSAL_SOFTENING_WEIGHTS["unlabeled"]).toBe(1.0)
  })

  it("covers every canonical reason — no missing keys", () => {
    for (const r of ALL_DISMISS_REASONS) {
      expect(DISMISSAL_SOFTENING_WEIGHTS[r]).toBeDefined()
    }
  })
})

describe("weightForReason", () => {
  it("returns the table entry for a known reason", () => {
    expect(weightForReason("too-minor")).toBe(1.5)
    expect(weightForReason("not-a-bug")).toBe(1.0)
    expect(weightForReason("unlabeled")).toBe(1.0)
  })

  it("returns DEFAULT_DISMISSAL_WEIGHT (1.0) for undefined input", () => {
    expect(weightForReason(undefined)).toBe(DEFAULT_DISMISSAL_WEIGHT)
    expect(weightForReason(undefined)).toBe(1.0)
  })
})

describe("weightedSignalCount", () => {
  it("returns 0 on an empty list", () => {
    expect(weightedSignalCount([])).toBe(0)
  })

  it("sums weights using DEFAULT_DISMISSAL_WEIGHT for missing reasons", () => {
    // Three signals without dismissReason → 3 * 1.0 = 3.0
    expect(weightedSignalCount([{}, {}, {}])).toBe(3)
  })

  it("differentially weights too-minor at 1.5x", () => {
    // 2 too-minor = 3.0; same count as 3 unlabeled.
    expect(weightedSignalCount([
      { dismissReason: "too-minor" },
      { dismissReason: "too-minor" },
    ])).toBe(3)
  })

  it("mixes weights correctly across reasons", () => {
    // 1 too-minor (1.5) + 1 not-a-bug (1.0) + 1 unlabeled (1.0) = 3.5
    expect(weightedSignalCount([
      { dismissReason: "too-minor" },
      { dismissReason: "not-a-bug" },
      { dismissReason: "unlabeled" },
    ])).toBe(3.5)
  })
})
