// SIG-287 — degraded-coverage finding floor: re-inject the findings the synth
// dropped on a degraded run, so a partial review can't silently erase the only
// signal the surviving specialists produced. Index-alignment between findings
// and provenance is load-bearing (the hallucination guard pairs them by index),
// so every test asserts the two arrays stay the same length.

import { describe, it, expect } from "vitest"
import {
  applyDegradedCoverageFindingFloor,
  DEGRADED_FLOOR_MIN_SCORE,
  type FloorProvenanceFinding,
  type DegradedFloorSpecialist,
} from "../src/lib/degraded-finding-floor"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

function finding(id: string, score: number, over: Partial<PrReviewFinding> = {}): PrReviewFinding & { id: string } {
  return {
    id,
    path: "src/x.ts",
    line: 10,
    score,
    category: "performance",
    headline: `finding ${id}`,
    body: "body",
    ...over,
  } as PrReviewFinding & { id: string }
}

function prov(...ids: string[]): FloorProvenanceFinding {
  return { sourceSpecialists: ["logic"], sourceFindingIds: ids, action: "kept", verifiedViaRetrieval: false }
}

describe("applyDegradedCoverageFindingFloor", () => {
  it("pins the min-score floor at 2 (nits stay dropped)", () => {
    expect(DEGRADED_FLOOR_MIN_SCORE).toBe(2)
  })

  it("re-injects a returned specialist finding the synth dropped (the #218 perf case)", () => {
    // Synth emitted 0 findings; performance returned a score-2 finding.
    const specialists: DegradedFloorSpecialist[] = [
      { role: "performance", findings: [finding("performance-0", 2)] },
    ]
    const r = applyDegradedCoverageFindingFloor({
      findings: [],
      provenanceFindings: [],
      specialists,
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
    expect(r.findings.length).toBe(r.provenanceFindings.length) // index-parallel
    expect(r.restored).toEqual([{ role: "performance", id: "performance-0", score: 2, headline: "finding performance-0" }])
    expect(r.provenanceFindings[0]).toMatchObject({
      sourceSpecialists: ["performance"],
      sourceFindingIds: ["performance-0"],
      action: "kept",
    })
  })

  it("does NOT re-inject a finding the synth already accounted for", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [finding("security-3", 3)],
      provenanceFindings: [prov("security-3")], // synth kept it
      specialists: [{ role: "security", findings: [finding("security-3", 3)] }],
    })
    expect(r.findings).toHaveLength(1) // unchanged
    expect(r.restored).toHaveLength(0)
  })

  it("drops nits below the floor (score 1)", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [],
      provenanceFindings: [],
      specialists: [{ role: "tests", findings: [finding("tests-0", 1)] }],
    })
    expect(r.findings).toHaveLength(0)
    expect(r.restored).toHaveLength(0)
  })

  it("keeps findings + provenance index-parallel when restoring several", () => {
    const synthFindings = [finding("logic-0", 4)]
    const r = applyDegradedCoverageFindingFloor({
      findings: synthFindings,
      provenanceFindings: [prov("logic-0")],
      specialists: [
        { role: "security", findings: [finding("security-1", 3), finding("security-2", 1)] }, // -2 is a nit
        { role: "performance", findings: [finding("performance-0", 2)] },
      ],
    })
    // logic-0 (kept) + security-1 + performance-0 restored; security-2 (nit) dropped.
    expect(r.findings).toHaveLength(3)
    expect(r.provenanceFindings).toHaveLength(3)
    expect(r.findings.length).toBe(r.provenanceFindings.length)
    expect(r.restored.map((x) => x.id)).toEqual(["security-1", "performance-0"])
    // The original synth finding stays at index 0; restored append after.
    expect(r.provenanceFindings[0]?.sourceFindingIds).toEqual(["logic-0"])
  })

  it("dedupes a (pathological) duplicate id across specialists — no double-inject", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [],
      provenanceFindings: [],
      specialists: [
        { role: "security", findings: [finding("dup-0", 3)] },
        { role: "performance", findings: [finding("dup-0", 3)] },
      ],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.provenanceFindings).toHaveLength(1)
  })

  it("is a no-op (returns equivalent arrays) when nothing qualifies", () => {
    const r = applyDegradedCoverageFindingFloor({
      findings: [finding("logic-0", 5)],
      provenanceFindings: [prov("logic-0")],
      specialists: [{ role: "logic", findings: [finding("logic-0", 5)] }],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.restored).toHaveLength(0)
  })
})
