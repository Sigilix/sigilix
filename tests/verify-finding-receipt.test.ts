// SIG-285 v2 PR1 — receipt-join verification tests.
//
// The pure verdict: a sev>=4 security finding with a resolvable evidenceId is
// CONFIRMED when the SAME rule-class still fires at its path+(windowed)line in
// the runner receipt's HEAD SARIF, INCONCLUSIVE on any absence (NEVER refuted —
// absence is over-determined), NO-CHECK when not eligible.

import { describe, expect, it } from "vitest"
import {
  buildReceiptIndex,
  isReceiptJoinEligible,
  ruleIdFromEvidenceId,
  verifyFindingAgainstReceipt,
  type ReceiptScanResult,
} from "../src/lib/verification/verify-finding-receipt"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/auth.ts",
    line: 42,
    score: 5,
    category: "security",
    headline: "hardcoded credential",
    body: "An API key literal.",
    evidenceId: "secret:aws-access-key:abc123:42",
    ...over,
  } as PrReviewFinding
}

function index(results: ReceiptScanResult[]): Map<string, ReceiptScanResult[]> {
  return buildReceiptIndex(results)
}

describe("isReceiptJoinEligible", () => {
  it("eligible: sev>=4 security finding with a resolvable evidenceId", () => {
    expect(isReceiptJoinEligible(finding())).toBe(true)
  })
  it("NOT eligible: score < 4", () => {
    expect(isReceiptJoinEligible(finding({ score: 3 }))).toBe(false)
  })
  it("NOT eligible: non-security category", () => {
    expect(isReceiptJoinEligible(finding({ category: "logic" }))).toBe(false)
  })
  it("NOT eligible: no evidenceId / the authz NONE sentinel", () => {
    expect(isReceiptJoinEligible(finding({ evidenceId: undefined }))).toBe(false)
    expect(isReceiptJoinEligible(finding({ evidenceId: "NONE" }))).toBe(false)
    expect(isReceiptJoinEligible(finding({ evidenceId: "" }))).toBe(false)
  })
})

describe("ruleIdFromEvidenceId", () => {
  it("extracts the rule-id segment (tool:rule-id:hash:line)", () => {
    expect(ruleIdFromEvidenceId("secret:aws-access-key:abc123:42")).toBe("aws-access-key")
    expect(ruleIdFromEvidenceId("semgrep:python.lang.security.audit.x:h:7")).toBe("python.lang.security.audit.x")
  })
  it("returns null on an unrecognizable shape", () => {
    expect(ruleIdFromEvidenceId("noseparator")).toBeNull()
    expect(ruleIdFromEvidenceId("tool:")).toBeNull()
  })
})

describe("verifyFindingAgainstReceipt", () => {
  it("NO-CHECK for an ineligible finding (no scan touched)", () => {
    const r = verifyFindingAgainstReceipt(finding({ category: "logic" }), index([
      { path: "src/auth.ts", ruleId: "aws-access-key", line: 42 },
    ]))
    expect(r.verdict).toBe("no-check")
  })

  it("CONFIRMED: same rule-class still fires at the path + exact line on HEAD", () => {
    const r = verifyFindingAgainstReceipt(finding(), index([
      { path: "src/auth.ts", ruleId: "aws-access-key", line: 42 },
    ]))
    expect(r.verdict).toBe("confirmed")
    expect(r.check?.kind).toBe("receipt-join")
    expect(r.check?.status).toBe("pass")
  })

  it("CONFIRMED within the line window (merge/head drift absorbed)", () => {
    const r = verifyFindingAgainstReceipt(finding({ line: 42 }), index([
      { path: "src/auth.ts", ruleId: "aws-access-key", line: 49 }, // +7, within ±10
    ]))
    expect(r.verdict).toBe("confirmed")
  })

  it("CONFIRMED on a path-only (line-less) result", () => {
    const r = verifyFindingAgainstReceipt(finding(), index([
      { path: "src/auth.ts", ruleId: "aws-access-key" }, // no line (IaC/dep)
    ]))
    expect(r.verdict).toBe("confirmed")
  })

  it("CONFIRMED on a namespaced ruleId (either-contains-other)", () => {
    const r = verifyFindingAgainstReceipt(finding(), index([
      { path: "src/auth.ts", ruleId: "semgrep.aws-access-key.v2", line: 42 },
    ]))
    expect(r.verdict).toBe("confirmed")
  })

  it("INCONCLUSIVE: no result at the path (absence is over-determined, NEVER refuted)", () => {
    const r = verifyFindingAgainstReceipt(finding(), index([]))
    expect(r.verdict).toBe("inconclusive")
    expect(r.verdict).not.toBe("refuted")
  })

  it("INCONCLUSIVE: matching rule but the line is OUTSIDE the window", () => {
    const r = verifyFindingAgainstReceipt(finding({ line: 42 }), index([
      { path: "src/auth.ts", ruleId: "aws-access-key", line: 80 }, // +38, outside ±10
    ]))
    expect(r.verdict).toBe("inconclusive")
  })

  it("INCONCLUSIVE: a DIFFERENT rule fires at the same path/line (not the same check)", () => {
    const r = verifyFindingAgainstReceipt(finding(), index([
      { path: "src/auth.ts", ruleId: "sql-injection", line: 42 },
    ]))
    expect(r.verdict).toBe("inconclusive")
  })

  it("INCONCLUSIVE: a result on a DIFFERENT path doesn't confirm", () => {
    const r = verifyFindingAgainstReceipt(finding(), index([
      { path: "src/other.ts", ruleId: "aws-access-key", line: 42 },
    ]))
    expect(r.verdict).toBe("inconclusive")
  })

  it("NEVER emits `refuted` across any input (PR1 cannot demote)", () => {
    const inputs: ReceiptScanResult[][] = [[], [{ path: "src/auth.ts", ruleId: "x", line: 999 }]]
    for (const results of inputs) {
      const r = verifyFindingAgainstReceipt(finding(), index(results))
      expect(r.verdict).not.toBe("refuted")
    }
  })

  it("never throws on degenerate input", () => {
    expect(() => verifyFindingAgainstReceipt(finding({ evidenceId: "weird", line: undefined }), index([]))).not.toThrow()
  })
})

describe("buildReceiptIndex", () => {
  it("groups results by path; drops path-less entries", () => {
    const idx = buildReceiptIndex([
      { path: "a.ts", ruleId: "r1", line: 1 },
      { path: "a.ts", ruleId: "r2", line: 2 },
      { path: "", ruleId: "r3", line: 3 },
    ])
    expect(idx.get("a.ts")).toHaveLength(2)
    expect(idx.has("")).toBe(false)
  })
})
