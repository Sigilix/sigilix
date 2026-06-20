// SIG-477 PR-5 — the model-authored `failureExample` ("**Example:**") is suppressed for
// a finding the execution sandbox REPRODUCED, so a fabricated example can't sit next to
// (and undercut) the execution-proven REPRODUCED pill.

import { describe, expect, it } from "vitest"
import { formatFindingStructuredDetailsMarkdown } from "@/src/lib/ensemble/render/finding-format"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

const finding = (over: Partial<PrReviewFinding> = {}): PrReviewFinding =>
  ({
    category: "logic",
    score: 4,
    path: "src/x.ts",
    line: 7,
    headline: "off-by-one",
    body: "boundary slips by one",
    failureExample: "input: f([1,2,3], 2)\nactual: [1,2,3]\nexpected: [1,2]",
    ...over,
  }) as PrReviewFinding

describe("formatFindingStructuredDetailsMarkdown — failureExample overclaim (SIG-477 PR-5)", () => {
  it("renders the model **Example:** for a non-reproduced finding", () => {
    const out = formatFindingStructuredDetailsMarkdown(finding())
    expect(out).toContain("**Example:**")
    expect(out).toContain("expected: [1,2]")
  })

  it("SUPPRESSES the model **Example:** for a reproduced-by-execution finding", () => {
    const out = formatFindingStructuredDetailsMarkdown(finding({ trust: { tier: "reproduced-by-execution" } }))
    expect(out).not.toContain("**Example:**")
  })

  it("does NOT suppress for a grounded finding (scope is reproduced-only)", () => {
    const out = formatFindingStructuredDetailsMarkdown(finding({ trust: { tier: "grounded-model" } }))
    expect(out).toContain("**Example:**")
  })
})
