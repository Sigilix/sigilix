import { describe, expect, it } from "vitest"
import {
  assessApprovalReadiness,
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
})
