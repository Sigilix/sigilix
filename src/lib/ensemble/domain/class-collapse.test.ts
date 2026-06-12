// SIG-392 — class-redundancy collapse, calibrated on the REAL recall-prompt
// output (v4-pro reported "no try/catch" once per handler) + the pinned
// negative-gate regression (a specific-consequence finding must survive).

import { describe, expect, it } from "vitest"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import {
  collapseClassRedundantFindings,
  collapsibleClassOf,
  CLASS_COLLAPSE_MIN,
} from "@/src/lib/ensemble/domain/class-collapse"

function finding(over: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    path: "server/payments.ts",
    line: 44,
    score: 3,
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

// The actual recall-prompt output (verbatim shape): "no try/catch" per handler.
const eh = (line: number, path = "server/payments.ts") =>
  finding({ path, line, headline: `Handler at ${line} has no try/catch — DB errors become unhandled rejections` })

describe("collapsibleClassOf — the curated signature", () => {
  it("matches pure missing-error-handling phrasings", () => {
    for (const h of [
      "Charge handler has no try/catch — DB errors become unhandled rejections",
      "Balance endpoint missing error handling",
      "Webhook handler lacks an error wrapper",
      "Refund route — unhandled promise rejection on query failure",
    ]) {
      expect(collapsibleClassOf(finding({ headline: h }))).toBe("missing-error-handling")
    }
  })

  it("does NOT match a finding that names a specific downstream consequence", () => {
    // these are distinct bugs that merely mention error handling — must survive
    for (const h of [
      "No try/catch around the INSERT causes a double-charge on retry",
      "Missing await + no error handling loses the payment row (data loss)",
      "Unhandled rejection masks a race condition in the refund path",
    ]) {
      expect(collapsibleClassOf(finding({ headline: h }))).toBeNull()
    }
  })

  it("does NOT match unrelated findings", () => {
    expect(collapsibleClassOf(finding({ headline: "Pagination off-by-one skips the first page" }))).toBeNull()
  })
})

describe("collapseClassRedundantFindings", () => {
  it("collapses 3+ same-class findings into ONE pr-scope survivor listing locations", () => {
    const findings = [eh(44), eh(82), eh(130), finding({ line: 140, headline: "Pagination off-by-one" })]
    const provs = [prov(["logic-0"]), prov(["logic-1"]), prov(["logic-2"]), prov(["logic-3"])]
    const r = collapseClassRedundantFindings(findings, provs)
    // 3 error-handling → 1 survivor; the pagination finding untouched → 2 total
    expect(r.findings).toHaveLength(2)
    expect(r.findings.length).toBe(r.provenanceFindings.length)
    const survivor = r.findings.find((f) => f.scope === "pr")!
    expect(survivor).toBeDefined()
    expect(survivor.scopeLocked).toBe(true)
    expect(survivor.body).toContain("Also at:")
    expect(survivor.body).toContain("server/payments.ts:82")
    expect(survivor.body).toContain("server/payments.ts:130")
    // provenance union of all 3 collapsed
    const survivorProv = r.provenanceFindings[r.findings.indexOf(survivor)]!
    expect(survivorProv.sourceFindingIds).toEqual(["logic-0", "logic-1", "logic-2"])
    expect(r.collapsed[0]).toMatchObject({ classId: "missing-error-handling", collapsedCount: 2 })
  })

  it("keeps the HIGHEST-score finding as the survivor", () => {
    const findings = [eh(44), finding({ line: 82, score: 5, headline: "Handler 82 has no try/catch" }), eh(130)]
    const r = collapseClassRedundantFindings(findings, [prov(["a"]), prov(["b"]), prov(["c"])])
    const survivor = r.findings.find((f) => f.scope === "pr")!
    expect(survivor.score).toBe(5)
  })

  it("does NOT collapse a PAIR (that is the near-dup gate's job)", () => {
    const findings = [eh(44), eh(82)]
    const r = collapseClassRedundantFindings(findings, [prov(["a"]), prov(["b"])])
    expect(r.collapsed).toHaveLength(0)
    expect(r.findings).toHaveLength(2)
    expect(CLASS_COLLAPSE_MIN).toBe(3)
  })

  it("does NOT collapse a specific-consequence finding in with the class", () => {
    const findings = [
      eh(44),
      eh(82),
      finding({ line: 100, headline: "No try/catch around INSERT causes a double-charge" }),
    ]
    const r = collapseClassRedundantFindings(findings, [prov(["a"]), prov(["b"]), prov(["c"])])
    // only 2 pure-class → below threshold → nothing collapses; the double-charge survives
    expect(r.collapsed).toHaveLength(0)
    expect(r.findings).toHaveLength(3)
  })

  it("no-op (returns inputs) when no class reaches the threshold", () => {
    const findings = [finding({ headline: "Pagination off-by-one" }), eh(82)]
    const r = collapseClassRedundantFindings(findings, [prov(["a"]), prov(["b"])])
    expect(r.findings).toBe(findings) // by reference
    expect(r.collapsed).toHaveLength(0)
  })
})
