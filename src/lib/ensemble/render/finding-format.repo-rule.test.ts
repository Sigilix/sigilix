// Config-as-code — formatRepoRuleAttribution: the quiet <sub> provenance line
// rendered under a finding the model tagged with a repo rule, mirroring
// formatSdkGuidanceAttribution's shape.

import { describe, expect, it } from "vitest"

import { formatRepoRuleAttribution } from "./finding-format"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/db/query.ts",
    line: 10,
    score: 4,
    category: "security",
    headline: "h",
    body: "b",
    ...overrides,
  } as PrReviewFinding
}

describe("formatRepoRuleAttribution", () => {
  it("returns empty string when the finding has no repoRule attribution", () => {
    expect(formatRepoRuleAttribution(finding())).toBe("")
  })

  it("renders the rule id in a quiet <sub> line", () => {
    const f = finding({ repoRule: { id: "no-raw-sql", rule: "Flag string-concatenated SQL." } })
    const rendered = formatRepoRuleAttribution(f)
    expect(rendered).toContain("<sub>")
    expect(rendered).toContain("via repo rule")
    expect(rendered).toContain("no-raw-sql")
  })

  it("HTML-escapes the id field", () => {
    const f = finding({ repoRule: { id: "<script>", rule: "x" } })
    const rendered = formatRepoRuleAttribution(f)
    expect(rendered).not.toContain("<script>")
    expect(rendered).toContain("&lt;script&gt;")
  })
})
