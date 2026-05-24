import { describe, expect, it } from "vitest"
import { badgeAssetUrl } from "../src/lib/badge-assets"
import { formatIssueTriageComment, issueTriagePriorityBadge } from "../src/lib/triage"

describe("issue triage comment formatting (SIG-204)", () => {
  it("renders the Sigilix priority badge instead of a text severity/estimate tag", () => {
    const out = formatIssueTriageComment({
      headline: "Linear retrieval should use the mapped repo namespace",
      severity: "P1",
      body: "`src/lib/mention-reply.ts` should map the Linear team before retrieval.",
    })

    expect(out.startsWith(`![P1](${badgeAssetUrl("p1")}) Linear retrieval should use the mapped repo namespace`)).toBe(true)
    expect(out).not.toContain("[P1 · M]")
    expect(out).not.toContain("· M")
    expect(out).toContain("`src/lib/mention-reply.ts` should map the Linear team before retrieval.")
  })

  it("maps every Linear severity to the shared badge asset route", () => {
    expect(issueTriagePriorityBadge("P0")).toBe(`![P0](${badgeAssetUrl("p0")})`)
    expect(issueTriagePriorityBadge("P1")).toBe(`![P1](${badgeAssetUrl("p1")})`)
    expect(issueTriagePriorityBadge("P2")).toBe(`![P2](${badgeAssetUrl("p2")})`)
    expect(issueTriagePriorityBadge("P3")).toBe(`![P3](${badgeAssetUrl("p3")})`)
  })

  it("falls back to P2 for unexpected severity input", () => {
    expect(issueTriagePriorityBadge("unknown")).toBe(`![P2](${badgeAssetUrl("p2")})`)
  })
})
