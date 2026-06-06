import { describe, expect, it } from "vitest"
import {
  MAX_FINDING_OUTCOME_MARKERS,
  parseFindingCategory,
  parseFindingFingerprint,
  parseFindingOutcomeMarkers,
  parseFindingSeverity,
} from "../src/lib/pr-finding-markers"

const FINGERPRINT_A = "a".repeat(64)
const FINGERPRINT_B = "b".repeat(64)

function findingBlock(fingerprint: string, category = "performance"): string {
  return [
    "<!-- sigilix:pr-review-finding -->",
    `<!-- sigilix:category:${category} -->`,
    "<!-- sigilix:severity:3 -->",
    `<!-- sigilix:fingerprint:${fingerprint} -->`,
  ].join("\n")
}

describe("pr finding marker parsing", () => {
  it("parses fingerprint, category, and severity from a single finding body", () => {
    const body = findingBlock(FINGERPRINT_A)

    expect(parseFindingFingerprint(body)).toBe(FINGERPRINT_A)
    expect(parseFindingCategory(body)).toBe("performance")
    expect(parseFindingSeverity(body)).toBe(3)
  })

  it("parses multiple finding blocks and dedupes repeated category/fingerprint pairs", () => {
    const markers = parseFindingOutcomeMarkers([
      findingBlock(FINGERPRINT_A, "performance"),
      findingBlock(FINGERPRINT_A, "performance"),
      findingBlock(FINGERPRINT_B, "security"),
    ].join("\n\n"))

    expect(markers).toEqual([
      { patternHash: FINGERPRINT_A, category: "performance" },
      { patternHash: FINGERPRINT_B, category: "security" },
    ])
  })

  it("falls back to logic for unknown category markers", () => {
    expect(parseFindingCategory(findingBlock(FINGERPRINT_A, "unknown"))).toBe("logic")
  })

  it("caps finding block parsing on oversized bodies", () => {
    const body = Array.from({ length: MAX_FINDING_OUTCOME_MARKERS + 5 }, (_, i) =>
      findingBlock(i.toString(16).padStart(64, "0"), "performance"),
    ).join("\n")

    expect(parseFindingOutcomeMarkers(body)).toHaveLength(MAX_FINDING_OUTCOME_MARKERS)
  })
})
