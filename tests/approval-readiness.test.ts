import { describe, expect, it } from "vitest"
import {
  assessApprovalReadiness,
  buildApprovalReadinessSummary,
  type ApprovalReadinessSourceFinding,
} from "../src/lib/approval-readiness"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

const sourceFinding: PrReviewFinding = {
  path: "src/lib/triage-pr-improve.ts",
  line: 221,
  score: 4,
  confidence: 4,
  category: "logic",
  headline: "duplicate `/sigilix improve` anchor drops preserved suggestion",
  body: "The preservation path still drops the conflicting fallback suggestion.",
}

const source: ApprovalReadinessSourceFinding = {
  role: "logic",
  id: "logic-0",
  finding: sourceFinding,
  verdictConfidence: 4,
}

describe("assessApprovalReadiness (SIG-205)", () => {
  it("does not alter an existing request-changes verdict", () => {
    const out = assessApprovalReadiness({
      intendedEvent: "REQUEST_CHANGES",
      sourceFindings: [source],
      provenance: { findings: [], dropped: [] },
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.blockers).toEqual([])
    expect(out.bodyOnlyFindings).toEqual([])
  })

  it("approves when no high-confidence source finding exists", () => {
    const out = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [
        {
          ...source,
          id: "logic-1",
          finding: { ...sourceFinding, score: 3, confidence: 5 },
        },
        {
          ...source,
          id: "logic-2",
          finding: { ...sourceFinding, score: 4, confidence: 3 },
        },
      ],
      provenance: { findings: [], dropped: [] },
    })

    expect(out.event).toBe("APPROVE")
    expect(out.blockers).toEqual([])
  })

  it("ignores high-confidence source findings with empty IDs", () => {
    const out = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [{ ...source, id: "" }],
      provenance: { findings: [], dropped: [] },
    })

    expect(out.event).toBe("APPROVE")
    expect(out.blockers).toEqual([])
    expect(out.bodyOnlyFindings).toEqual([])
  })

  it("approves when the synth kept or merged the source finding", () => {
    const out = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [source],
      provenance: {
        findings: [{ sourceFindingIds: ["logic-0"] }],
        dropped: [],
      },
    })

    expect(out.event).toBe("APPROVE")
    expect(out.blockers).toEqual([])
  })

  it("approves when the synth explicitly dropped the source finding", () => {
    const out = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [source],
      provenance: {
        findings: [],
        dropped: [{ sourceFindingId: "logic-0" }],
      },
    })

    expect(out.event).toBe("APPROVE")
    expect(out.blockers).toEqual([])
  })

  it("approves when review memory softened the source finding", () => {
    const out = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [source],
      provenance: {
        findings: [],
        dropped: [],
        softened: [{ sourceFindingId: "logic-0" }],
      },
    })

    expect(out.event).toBe("APPROVE")
    expect(out.blockers).toEqual([])
  })

  it("requests changes when a high-confidence source finding is unaccounted", () => {
    const out = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [source],
      provenance: { findings: [], dropped: [] },
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.blockers).toMatchObject([
      {
        kind: "unaccounted_high_confidence_source_finding",
        sourceFindingId: "logic-0",
        role: "logic",
        headline: "duplicate `/sigilix improve` anchor drops preserved suggestion",
        score: 4,
        confidence: 4,
      },
    ])
    expect(out.bodyOnlyFindings).toHaveLength(1)
    expect(out.bodyOnlyFindings[0]?.scope).toBe("pr")
    expect(out.bodyOnlyFindings[0]?.headline).toContain("Approval validation lost logic finding")
    expect(out.bodyOnlyFindings[0]?.body).toContain("kept, merged, softened, or explicitly dropped")
  })

  it("treats missing provenance as no accounted source findings", () => {
    const nullProvenance = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [source],
      provenance: null,
    })
    const undefinedProvenance = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [source],
      provenance: undefined,
    })

    expect(nullProvenance.event).toBe("REQUEST_CHANGES")
    expect(nullProvenance.blockers).toHaveLength(1)
    expect(undefinedProvenance.event).toBe("REQUEST_CHANGES")
    expect(undefinedProvenance.blockers).toHaveLength(1)
  })

  it("replaces stale clean summaries when approval readiness blocks", () => {
    const cleanSummary = "No issues found."
    const clean = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [],
      provenance: { findings: [], dropped: [] },
    })
    const blocked = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [source],
      provenance: { findings: [], dropped: [] },
    })

    expect(buildApprovalReadinessSummary(clean, cleanSummary)).toBe(cleanSummary)
    expect(buildApprovalReadinessSummary(blocked, cleanSummary)).toContain("Approval withheld")
    expect(buildApprovalReadinessSummary(blocked, cleanSummary)).toContain(
      "approval validation blocker below",
    )
    expect(buildApprovalReadinessSummary(blocked, cleanSummary)).not.toContain(cleanSummary)
  })

  it("pluralizes the approval-readiness blocker summary", () => {
    const blocked = assessApprovalReadiness({
      intendedEvent: "APPROVE",
      sourceFindings: [
        source,
        {
          ...source,
          id: "security-0",
          role: "security",
          finding: {
            ...sourceFinding,
            category: "security",
            headline: "missing webhook signature check",
          },
        },
      ],
      provenance: { findings: [], dropped: [] },
    })

    expect(buildApprovalReadinessSummary(blocked, "No issues found.")).toContain(
      "2 high-confidence Sigilix specialist findings were",
    )
    expect(buildApprovalReadinessSummary(blocked, "No issues found.")).toContain(
      "approval validation blockers below",
    )
  })
})
