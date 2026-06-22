// SIG-304 (review CLI) Phase 1b — the rich truecolor review panel.

import { describe, it, expect } from "vitest"
import { renderRich } from "./rich"
import { renderPlain } from "./plain"
import { stripAnsi } from "@/src/cli/ansi/ansi"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { PrOverviewVerdict } from "@/src/lib/triage-pr-overview"

function finding(o: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/a.ts",
    line: 10,
    score: 5,
    category: "security",
    headline: "SQL injection",
    body: "x",
    ...o,
  } as PrReviewFinding
}
function review(findings: PrReviewFinding[], unanchored: PrReviewFinding[] = []): DryRunReview {
  return {
    verdict: { summary: "issues found", confidence: 3, confidenceReason: "x", findings } as PrReviewVerdict,
    unanchoredFindings: unanchored,
  }
}

describe("renderRich", () => {
  it("color:false delegates to renderPlain (byte-identical, ANSI-free)", () => {
    const r = review([finding(), finding({ score: 2, headline: "nit" })])
    expect(renderRich(r, null, { color: false })).toBe(renderPlain(r))
  })

  it("color:true emits the P0 accent + headline + path + confidence + legend", () => {
    const out = renderRich(review([finding()]), null, { color: true, width: 88, subject: "o/r#1" })
    expect(out).toContain("185;28;28m") // P0 accent #B91C1C
    const plain = stripAnsi(out)
    expect(plain).toContain("SQL injection")
    expect(plain).toContain("src/a.ts:10")
    expect(plain).toContain("3/5")
    expect(plain).toContain("o/r#1")
    expect(plain).toContain("LEGEND")
    expect(plain).toContain("exit 1")
  })

  it("renders the real mermaid diagram + prefers the overview confidence", () => {
    const ov = {
      summary: "overview summary",
      confidence: 4,
      confidenceReason: "",
      bullets: [],
      files: [{ path: "a.ts", score: 5, overview: "bad", nextStep: "fix" }],
      mermaidDiagram: "sequenceDiagram\n  A->>B: go()",
    } as PrOverviewVerdict
    const plain = stripAnsi(renderRich(review([finding()]), ov, { color: true, width: 88 }))
    expect(plain).toContain("SEQUENCE DIAGRAM")
    expect(plain).toContain("go()")
    expect(plain).toContain("4/5") // overview confidence wins over the review's 3
  })

  it("orders findings by severity (P0 above P3) regardless of input order", () => {
    const plain = stripAnsi(
      renderRich(
        review([
          finding({ score: 1, headline: "low", path: "z.ts" }),
          finding({ score: 5, headline: "high", path: "a.ts" }),
        ]),
        null,
        {
          color: true,
          width: 88,
        },
      ),
    )
    expect(plain.indexOf("high")).toBeLessThan(plain.indexOf("low"))
  })

  it("RECALL-SAFETY: a degraded (incomplete) review shows the partial banner AND a non-zero exit footer (never 'exit 0')", () => {
    const r: DryRunReview = { ...review([]), incomplete: { rolesMissing: ["logic"] } }
    const plain = stripAnsi(renderRich(r, null, { color: true, width: 88 }))
    expect(plain).toContain("Partial review") // the OVERVIEW banner
    expect(plain).toContain("logic")
    expect(plain).toContain("exit 2") // the footer matches the real process exit code, NOT exit 0
    expect(plain).not.toContain("exit 0")
  })

  it("proof tally counts trust tiers", () => {
    const plain = stripAnsi(
      renderRich(
        review([
          finding({ trust: { tier: "runner-confirmed" } } as Partial<PrReviewFinding>),
          finding({ score: 3, trust: { tier: "reproduced-by-execution" } } as Partial<PrReviewFinding>),
        ]),
        null,
        { color: true, width: 88 },
      ),
    )
    expect(plain).toMatch(/VERIFIED\s+1/)
    expect(plain).toMatch(/REPRODUCED\s+1/)
  })
})
