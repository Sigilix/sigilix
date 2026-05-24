import { describe, expect, it } from "vitest"
import { formatIssueTriageComment, issueTriagePriorityBadge } from "../src/lib/triage"

describe("issue triage comment formatting (SIG-204)", () => {
  it("renders the Linear priority inline instead of a block image or estimate tag", () => {
    const out = formatIssueTriageComment({
      headline: "Linear retrieval should use the mapped repo namespace",
      severity: "P1",
      body: "`src/lib/mention-reply.ts` should map the Linear team before retrieval.",
    })

    expect(out.startsWith("[P1] Linear retrieval should use the mapped repo namespace")).toBe(true)
    expect(out).not.toContain("![P1]")
    expect(out).not.toContain("[P1 · M]")
    expect(out).not.toContain("· M")
    expect(out).toContain("`src/lib/mention-reply.ts` should map the Linear team before retrieval.")
  })

  it("maps every Linear severity to an inline text priority", () => {
    expect(issueTriagePriorityBadge("P0")).toBe("[P0]")
    expect(issueTriagePriorityBadge("P1")).toBe("[P1]")
    expect(issueTriagePriorityBadge("P2")).toBe("[P2]")
    expect(issueTriagePriorityBadge("P3")).toBe("[P3]")
  })

  it("falls back to P2 for unexpected severity input", () => {
    expect(issueTriagePriorityBadge("unknown")).toBe("[P2]")
  })
})
