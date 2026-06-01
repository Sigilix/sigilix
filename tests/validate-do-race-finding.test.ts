// SIG-307 — DurableObject intra-instance race-condition FP detector.

import { describe, expect, it } from "vitest"
import { findingClaimsIntraInstanceRace } from "../src/lib/validate-do-race-finding"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/do/repo-graph.ts",
    line: 42,
    score: 4,
    category: "logic",
    headline: "x",
    body: "y",
    ...over,
  }
}

describe("findingClaimsIntraInstanceRace", () => {
  it("fires on the observed 'DO alarm scheduling race' FP shape", () => {
    expect(
      findingClaimsIntraInstanceRace(
        finding({
          headline: "Race condition in alarm scheduling",
          body: "Two concurrent invocations could both read the alarm time and schedule duplicate alarms.",
        }),
      ),
    ).toBe(true)
  })

  it("fires on assorted intra-instance concurrency phrasings", () => {
    for (const headline of [
      "Concurrent access to the cache map can corrupt it",
      "This counter increment is not atomic",
      "TOCTOU between the read and the write",
      "Data race on the in-memory index",
    ]) {
      expect(findingClaimsIntraInstanceRace(finding({ headline })), headline).toBe(true)
    }
  })

  it("does NOT fire on a finding with no race/concurrency claim (a real logic bug)", () => {
    expect(
      findingClaimsIntraInstanceRace(
        finding({ headline: "Off-by-one in the retention boundary", body: "Records exactly 35 days old are deleted." }),
      ),
    ).toBe(false)
  })

  it("does NOT fire when the claim is about EXTERNAL / cross-instance state (a real concern on a DO)", () => {
    expect(
      findingClaimsIntraInstanceRace(
        finding({
          headline: "Race against external state",
          body: "After awaiting the fetch to another DO, the remote value may have changed — a cross-instance race.",
        }),
      ),
    ).toBe(false)
  })
})
