// SIG-304 (review CLI) Phase 1 — CI coverage for the json / agent-markdown / plain
// output modes + the exit-code mapping (pure functions; the live engine path is
// covered by e2e/run-review-in-node.live.test.ts).

import { describe, it, expect } from "vitest"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import { renderJson } from "./json"
import { renderAgentMarkdown } from "./agent-markdown"
import { renderPlain } from "./plain"
import { toFindingView } from "./finding-view"
import { exitCodeForFindings } from "@/src/cli/app/exit-code"

function finding(o: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/a.ts",
    line: 10,
    score: 5,
    category: "security",
    headline: "SQL injection via string interpolation",
    body: "User input is interpolated into the query.",
    ...o,
  } as PrReviewFinding
}

function review(findings: PrReviewFinding[], unanchored: PrReviewFinding[] = []): DryRunReview {
  return {
    verdict: { summary: "issues found", confidence: 4, confidenceReason: "x", findings } as PrReviewVerdict,
    unanchoredFindings: unanchored,
  }
}

describe("render: --json", () => {
  it("emits counts, per-severity tally, and proof fields", () => {
    const out = JSON.parse(renderJson(review([finding(), finding({ score: 2, headline: "nit" })])))
    expect(out.counts.total).toBe(2)
    expect(out.counts.bySeverity).toMatchObject({ P0: 1, P3: 1 })
    expect(out.findings[0]).toMatchObject({
      path: "src/a.ts",
      line: 10,
      severity: "P0",
      category: "security",
      trust: "MODEL",
    })
  })
  it("includes a suggestedReplacement when present", () => {
    const out = JSON.parse(renderJson(review([finding({ suggestedReplacement: "db.prepare(?)" })])))
    expect(out.findings[0].suggestedReplacement).toBe("db.prepare(?)")
  })
})

describe("render: --ai (agent markdown)", () => {
  it("renders a stable path:line + [P][CAT][TRUST] header, body, and suggestion fence", () => {
    const md = renderAgentMarkdown(review([finding({ suggestedReplacement: "safe()" })]))
    expect(md).toContain("### src/a.ts:10 — [P0][security][MODEL] SQL injection via string interpolation")
    expect(md).toContain("User input is interpolated")
    expect(md).toContain("```suggestion\nsafe()\n```")
  })
  it("notes no findings cleanly", () => {
    expect(renderAgentMarkdown(review([]))).toContain("_No findings._")
  })
})

describe("render: --plain", () => {
  it("one terse line per finding + a severity tally footer", () => {
    const out = renderPlain(review([finding(), finding({ score: 4, headline: "race" })]))
    expect(out).toContain("src/a.ts:10  P0  SECURITY  MODEL  SQL injection via string interpolation")
    expect(out).toContain("2 findings (1 P0 · 1 P1 · 0 P2 · 0 P3)")
  })
})

describe("exit codes", () => {
  const v = (f: PrReviewFinding[]) => f.map(toFindingView)
  it("0 when clean", () => expect(exitCodeForFindings([])).toBe(0))
  it("1 when a P0/P1 is present (blocking)", () => expect(exitCodeForFindings(v([finding({ score: 4 })]))).toBe(1))
  it("2 when only advisory P2/P3", () =>
    expect(exitCodeForFindings(v([finding({ score: 3 }), finding({ score: 1 })]))).toBe(2))
})
