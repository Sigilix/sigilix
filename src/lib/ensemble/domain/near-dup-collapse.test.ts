// SIG-392 — near-duplicate collapse, calibrated on REAL probe findings.
// The must-collapse and must-not-collapse cases below are verbatim headlines
// from prod probes #28/#30/#31 (the cases that motivated the pass).

import { describe, expect, it } from "vitest"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { applySynthSourceFindingFloor } from "@/src/lib/degraded-finding-floor"
import { collapseNearDuplicateFindings, headlineJaccard } from "@/src/lib/ensemble/domain/near-dup-collapse"

function finding(over: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    path: "server/payments.ts",
    line: 149,
    score: 4,
    category: "logic",
    headline: "h",
    body: "b",
    ...over,
  }
}

const prov = (ids: string[]) => ({
  sourceSpecialists: ["logic" as const],
  sourceFindingIds: ids,
  action: "kept" as const,
  verifiedViaRetrieval: false,
})

describe("headlineJaccard — calibration on real probe pairs", () => {
  it("probe-30 N+1 pair scores well above the threshold", () => {
    const j = headlineJaccard(
      "Payments list endpoint runs an N+1 query loop to fetch refunds per payment row",
      "N+1 query loop fetches refunds per payment sequentially",
    )
    expect(j).toBeGreaterThan(0.4)
  })

  it("probe-31 units pair clears the threshold", () => {
    const j = headlineJaccard(
      "Refund endpoint passes dollars amount to cents function without conversion",
      "Refund endpoint accepts dollars while the rest of the system uses integer cents",
    )
    expect(j).toBeGreaterThanOrEqual(0.25)
  })

  it("probe-30 distinct-bugs-same-line pair stays far below the threshold", () => {
    const j = headlineJaccard(
      "Charge endpoint reads paid total before inserting the new payment, then adds the new amount in memory — stale",
      "Charge endpoint does not validate that `amountCents` is a positive integer",
    )
    expect(j).toBeLessThan(0.2)
  })
})

describe("collapseNearDuplicateFindings", () => {
  it("collapses the probe-31 units pair, keeping the higher score and merging sources ascending", () => {
    const a = finding({
      line: 110,
      score: 4,
      headline: "Refund endpoint passes dollars amount to cents function without conversion",
    })
    const b = finding({
      line: 110,
      score: 5,
      headline: "Refund endpoint accepts dollars while the rest of the system uses integer cents",
    })
    const out = collapseNearDuplicateFindings([a, b], [prov(["logic-3"]), prov(["logic-1", "logic-9"])])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.score).toBe(5)
    expect(out.provenanceFindings[0]!.sourceFindingIds).toEqual(["logic-1", "logic-3", "logic-9"])
    expect(out.collapsedPairs).toHaveLength(1)
    expect(out.collapsedPairs[0]!.jaccard).toBeGreaterThanOrEqual(0.25)
  })

  it("does NOT collapse two different bugs on the same line (probe-30 b2 vs b17)", () => {
    const a = finding({
      line: 48,
      headline:
        "Charge endpoint reads paid total before inserting the new payment, then adds the new amount in memory — stale",
    })
    const b = finding({
      line: 48,
      headline: "Charge endpoint does not validate that `amountCents` is a positive integer",
    })
    const out = collapseNearDuplicateFindings([a, b], [prov(["logic-0"]), prov(["logic-5"])])
    expect(out.findings).toHaveLength(2)
    expect(out.collapsedPairs).toHaveLength(0)
    // identity fast path: inputs returned by reference when nothing collapses
    expect(out.findings).toEqual([a, b])
  })

  it("collapses on shared sourceFindingId even when headlines diverge", () => {
    const a = finding({ headline: "N+1 query loop fetches refunds per payment sequentially" })
    const b = finding({ headline: "Sequential refund enrichment makes one round-trip per row" })
    const out = collapseNearDuplicateFindings([a, b], [prov(["logic-2"]), prov(["logic-2", "logic-7"])])
    expect(out.findings).toHaveLength(1)
    expect(out.collapsedPairs[0]!.sharedSource).toBe(true)
    expect(out.provenanceFindings[0]!.sourceFindingIds).toEqual(["logic-2", "logic-7"])
  })

  it("respects the hard gates: different path, far line, or different category never collapse", () => {
    const a = finding({ headline: "N+1 query loop fetches refunds per payment row" })
    const samePathFarLine = finding({ line: 190, headline: "N+1 query loop fetches refunds per payment row" })
    const otherCategory = finding({
      category: "performance",
      headline: "N+1 query loop fetches refunds per payment row",
    })
    const otherPath = finding({ path: "server/refunds.ts", headline: "N+1 query loop fetches refunds per payment row" })
    const out = collapseNearDuplicateFindings(
      [a, samePathFarLine, otherCategory, otherPath],
      [prov(["l-0"]), prov(["l-1"]), prov(["l-2"]), prov(["l-3"])],
    )
    expect(out.findings).toHaveLength(4)
  })

  it("chains transitively to one survivor (A~B, B~C)", () => {
    const a = finding({ score: 3, headline: "N+1 query loop fetches refunds per payment" })
    const b = finding({
      score: 5,
      headline: "Payments list endpoint runs an N+1 query loop to fetch refunds per payment row",
    })
    const c = finding({ score: 4, headline: "N+1 query loop fetches refunds per payment sequentially" })
    const out = collapseNearDuplicateFindings([a, b, c], [prov(["l-0"]), prov(["l-1"]), prov(["l-2"])])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.score).toBe(5)
    expect(out.provenanceFindings[0]!.sourceFindingIds).toEqual(["l-0", "l-1", "l-2"])
    expect(out.collapsedPairs).toHaveLength(2)
  })

  it("floor-interaction guarantee: a collapsed twin is not re-restored when the floor runs BEFORE the collapse", () => {
    // The prod ordering inside applyRecallFloors: source floor FIRST, collapse
    // LAST. Chain them in that order over a near-dup pair whose sources are
    // both score>=4: the floor sees both sources accounted (one per finding),
    // restores nothing, and the collapse then merges the rows — no
    // resurrection path remains because no floor pass follows.
    const kept = finding({
      line: 110,
      score: 5,
      headline: "Refund endpoint accepts dollars while the rest of the system uses integer cents",
    })
    const twin = finding({
      line: 110,
      score: 4,
      headline: "Refund endpoint passes dollars amount to cents function without conversion",
    })
    const sourceA = { ...kept, id: "logic-1" }
    const sourceB = { ...twin, id: "logic-3" }
    const floored = applySynthSourceFindingFloor({
      findings: [kept, twin],
      provenanceFindings: [prov(["logic-1"]), prov(["logic-3"])],
      provenanceDropped: [],
      specialists: [{ role: "logic", findings: [sourceA, sourceB] }],
    })
    expect(floored.restored).toHaveLength(0)
    const out = collapseNearDuplicateFindings(floored.findings, floored.provenanceFindings)
    expect(out.findings).toHaveLength(1)
    expect(out.provenanceFindings[0]!.sourceFindingIds).toEqual(["logic-1", "logic-3"])
  })
})
