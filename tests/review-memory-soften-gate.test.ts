// SIG-280 PR B: soften-gate pure helper tests.
import { describe, it, expect } from "vitest"
import { isSoftenActive, softenScoreWithFloor } from "../src/lib/review-memory/soften-gate"

describe("isSoftenActive", () => {
  it("is true ONLY for mode 'soften' AND per-repo claimSoftening true", () => {
    expect(isSoftenActive("soften", true)).toBe(true)
  })
  it("is false when the per-repo bool is off, even in soften mode", () => {
    expect(isSoftenActive("soften", false)).toBe(false)
  })
  it("is false in every non-soften mode, even with the per-repo bool on", () => {
    expect(isSoftenActive("off", true)).toBe(false)
    expect(isSoftenActive("shadow", true)).toBe(false)
    expect(isSoftenActive("render", true)).toBe(false)
  })
})

describe("softenScoreWithFloor — P0/P1 hard floor", () => {
  it("NEVER softens a P0 (score 5) or P1 (score 4) below its tier", () => {
    expect(softenScoreWithFloor(5)).toBe(5)
    expect(softenScoreWithFloor(4)).toBe(4)
  })
  it("decrements P2/P3 by one tier", () => {
    expect(softenScoreWithFloor(3)).toBe(2)
    expect(softenScoreWithFloor(2)).toBe(1)
  })
  it("floors at 1 (never below)", () => {
    expect(softenScoreWithFloor(1)).toBe(1)
  })
})
