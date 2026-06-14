// SIG-417 — the cost-trim disclosure aspect of the review body. Split from
// `triage-pr-review-body.test.ts` (dot-aspect naming, COMPLIANCE §5) to keep
// both files under the size budget. Covers `buildReviewDisclosure`'s costTrimmed
// reconciliation + the distinct 💸 render copy (vs the spillover wording).

import { describe, expect, it } from "vitest"

import {
  renderRequestChangesBody,
  type PrReviewVerdict,
  type PrReviewFinding,
  type CoverageRoles,
} from "@/src/lib/triage-pr-review"
// `buildReviewDisclosure` isn't on the façade's public surface; import direct.
import { buildReviewDisclosure, type ReviewDisclosure } from "@/src/lib/ensemble/render/review-body"

function verdict(overrides: Partial<PrReviewVerdict> = {}): PrReviewVerdict {
  return {
    summary: "The PR adds a feature flag and a test.",
    confidence: 4,
    confidenceReason: "All changes are clean.",
    findings: [],
    ...overrides,
  }
}

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/foo.ts",
    line: 42,
    headline: "Headline text",
    body: "Body text.",
    score: 3,
    category: "logic",
    ...overrides,
  }
}

const FULL: CoverageRoles = {
  dispatched: ["logic", "security", "performance", "tests"],
  succeeded: ["logic", "security", "performance", "tests"],
}

function disclosure(overrides: Partial<ReviewDisclosure> = {}): ReviewDisclosure {
  return { policySkipped: [], oversized: [], spillover: [], reviewedCount: 0, totalChangedCount: 0, ...overrides }
}

describe("SIG-417 cost-trim disclosure", () => {
  it("buildReviewDisclosure includes costTrimmed + reconciles totalChangedCount", () => {
    const d = buildReviewDisclosure({
      policySkipped: [],
      oversized: [],
      spillover: ["src/spill.ts"],
      reviewedCount: 3,
      costTrimmed: ["src/cheap-a.ts", "src/cheap-b.ts"],
    })
    expect(d).not.toBeNull()
    expect(d!.costTrimmed).toEqual(["src/cheap-a.ts", "src/cheap-b.ts"])
    // m = reviewed(3) + spillover(1) + costTrimmed(2) = 6.
    expect(d!.totalChangedCount).toBe(6)
  })

  it("buildReviewDisclosure returns null when ONLY costTrimmed is empty and nothing else dropped (governor-off)", () => {
    const d = buildReviewDisclosure({
      policySkipped: [],
      oversized: [],
      spillover: [],
      reviewedCount: 5,
      costTrimmed: [],
    })
    expect(d).toBeNull()
  })

  it("buildReviewDisclosure surfaces a disclosure when ONLY costTrimmed is non-empty", () => {
    const d = buildReviewDisclosure({
      policySkipped: [],
      oversized: [],
      spillover: [],
      reviewedCount: 2,
      costTrimmed: ["src/cheap.ts"],
    })
    expect(d).not.toBeNull()
    expect(d!.costTrimmed).toEqual(["src/cheap.ts"])
    expect(d!.totalChangedCount).toBe(3)
  })

  it("renders the distinct 💸 cost-trim copy (NOT the spillover wording), plural", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({
        costTrimmed: ["src/cheap-a.ts", "src/cheap-b.ts"],
        reviewedCount: 3,
        totalChangedCount: 5,
      }),
    })
    expect(body).toContain("💸 2 lower-risk files were not reviewed to keep this PR within its cost budget")
    expect(body).toContain("`src/cheap-a.ts`")
    expect(body).toContain("`src/cheap-b.ts`")
    // Distinct from the large-PR spillover wording.
    expect(body).not.toContain("below the priority cutoff")
  })

  it("renders singular cost-trim copy for one file", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({ costTrimmed: ["src/cheap.ts"], reviewedCount: 3, totalChangedCount: 4 }),
    })
    expect(body).toContain("💸 1 lower-risk file was not reviewed to keep this PR within its cost budget")
  })

  it("renders NOTHING for cost-trim when costTrimmed is absent (governor-off byte-identical)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({ spillover: ["src/a.ts"], reviewedCount: 3, totalChangedCount: 4 }),
    })
    expect(body).not.toContain("💸")
    expect(body).not.toContain("cost budget")
  })
})
