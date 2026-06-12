// SIG-392 — class-redundancy collapse, calibrated on the REAL recall-prompt
// output (v4-pro reported "no try/catch" once per handler) + the pinned
// recall-safety regressions: a distinct bug that shares the class phrase but is
// worded differently must NOT collapse, and a score>=4 finding is never folded.

import { describe, expect, it } from "vitest"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import {
  collapseClassRedundantFindings,
  collapsibleClassOf,
  CLASS_COLLAPSE_MIN,
  CLASS_COLLAPSE_MAX_SCORE,
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

// The actual recall-prompt output: near-identical "no try/catch" per handler.
const eh = (line: number, path = "server/payments.ts") =>
  finding({ path, line, headline: `Handler at ${line} has no try/catch — DB errors become unhandled rejections` })

describe("collapsibleClassOf — candidate gate", () => {
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
    for (const h of [
      "No try/catch around the INSERT causes a double-charge on retry",
      "Missing await + no error handling loses the payment row (data loss)",
      "No try/catch on the webhook — Stripe will retry and the customer is billed again",
      "No try/catch around the auth check — request proceeds unauthenticated",
    ]) {
      expect(collapsibleClassOf(finding({ headline: h }))).toBeNull()
    }
  })

  it("does NOT treat a score>=4 finding as a collapse candidate (severity is asserted)", () => {
    expect(CLASS_COLLAPSE_MAX_SCORE).toBe(3)
    expect(collapsibleClassOf(finding({ headline: "Handler has no try/catch", score: 4 }))).toBeNull()
    expect(collapsibleClassOf(finding({ headline: "Handler has no try/catch", score: 3 }))).toBe(
      "missing-error-handling",
    )
  })

  it("does NOT match unrelated findings", () => {
    expect(collapsibleClassOf(finding({ headline: "Pagination off-by-one skips the first page" }))).toBeNull()
  })
})

describe("collapseClassRedundantFindings", () => {
  it("collapses 3+ NEAR-IDENTICAL same-class findings into ONE pr-scope survivor", () => {
    const findings = [eh(44), eh(82), eh(130), finding({ line: 140, headline: "Pagination off-by-one" })]
    const provs = [prov(["logic-0"]), prov(["logic-1"]), prov(["logic-2"]), prov(["logic-3"])]
    const r = collapseClassRedundantFindings(findings, provs)
    expect(r.findings).toHaveLength(2) // 3 eh → 1 survivor + the pagination finding
    expect(r.findings.length).toBe(r.provenanceFindings.length)
    const survivor = r.findings.find((f) => f.scope === "pr")!
    expect(survivor.scopeLocked).toBe(true)
    // dropped HEADLINES preserved in the body (not just path:line)
    expect(survivor.body).toContain("Same issue also at:")
    expect(survivor.body).toContain("Handler at 82 has no try/catch")
    expect(survivor.body).toContain("server/payments.ts:130")
    const survivorProv = r.provenanceFindings[r.findings.indexOf(survivor)]!
    expect(survivorProv.sourceFindingIds).toEqual(["logic-0", "logic-1", "logic-2"])
    expect(r.collapsed[0]).toMatchObject({ classId: "missing-error-handling", collapsedCount: 2 })
    expect(r.collapsed[0]!.droppedHeadlines.length).toBe(2)
  })

  it("RECALL-SAFE: does NOT collapse same-class findings that are worded DIFFERENTLY (distinct bugs)", () => {
    // all 3 match the class signature, none trip the token gate, but their
    // headlines are not near-identical → they are distinct bugs → never folded.
    const findings = [
      finding({ line: 10, headline: "The charge handler has no try/catch around the DB call" }),
      finding({ line: 50, headline: "Webhook lacks an error wrapper so a 500 leaks the stack trace to the client" }),
      finding({ line: 90, headline: "Missing error handling means a failed refund silently returns success" }),
    ]
    const r = collapseClassRedundantFindings(findings, [prov(["a"]), prov(["b"]), prov(["c"])])
    expect(r.collapsed).toHaveLength(0)
    expect(r.findings).toHaveLength(3) // all three survive as distinct findings
  })

  it("survivor score is the MAX of the collapsed members", () => {
    const findings = [
      finding({ line: 44, score: 2, headline: "Handler at 44 has no try/catch on the query" }),
      finding({ line: 82, score: 3, headline: "Handler at 82 has no try/catch on the query" }),
      finding({ line: 130, score: 2, headline: "Handler at 130 has no try/catch on the query" }),
    ]
    const r = collapseClassRedundantFindings(findings, [prov(["a"]), prov(["b"]), prov(["c"])])
    const survivor = r.findings.find((f) => f.scope === "pr")!
    expect(survivor.score).toBe(3)
  })

  it("does NOT collapse a PAIR (that is the near-dup gate's job)", () => {
    const r = collapseClassRedundantFindings([eh(44), eh(82)], [prov(["a"]), prov(["b"])])
    expect(r.collapsed).toHaveLength(0)
    expect(r.findings).toHaveLength(2)
    expect(CLASS_COLLAPSE_MIN).toBe(3)
  })

  it("no-op (returns inputs by reference) when no class reaches the threshold", () => {
    const findings = [finding({ headline: "Pagination off-by-one" }), eh(82)]
    const r = collapseClassRedundantFindings(findings, [prov(["a"]), prov(["b"])])
    expect(r.findings).toBe(findings)
    expect(r.collapsed).toHaveLength(0)
  })
})
