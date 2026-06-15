// SIG-437 — feature-flag parser tests. Default-off; only the literal "on"
// (trim + case-insensitive) enables.

import { describe, it, expect } from "vitest"

import { parsePrSummaryMode } from "@/src/lib/pr-summary-mode"

describe("parsePrSummaryMode", () => {
  it("defaults to off for unset / empty / unknown values", () => {
    expect(parsePrSummaryMode(undefined)).toBe("off")
    expect(parsePrSummaryMode("")).toBe("off")
    expect(parsePrSummaryMode("   ")).toBe("off")
    expect(parsePrSummaryMode("off")).toBe("off")
    expect(parsePrSummaryMode("shadow")).toBe("off")
    expect(parsePrSummaryMode("true")).toBe("off")
  })

  it("returns on for the literal on, trimmed + case-insensitive", () => {
    expect(parsePrSummaryMode("on")).toBe("on")
    expect(parsePrSummaryMode("  ON  ")).toBe("on")
    expect(parsePrSummaryMode("On")).toBe("on")
  })
})
