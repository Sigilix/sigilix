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

  it("color:true emits the P0 accent + headline + a finding card + confidence + legend", () => {
    const out = renderRich(review([finding()]), null, { color: true, width: 96, subject: "o/r#1" })
    expect(out).toContain("185;28;28m") // P0 accent #B91C1C
    const plain = stripAnsi(out)
    expect(plain).toContain("SQL injection")
    expect(plain).toContain("Comment 1") // per-finding card header
    expect(plain).toContain("↳ src/a.ts") // file anchor
    expect(plain).toContain("L10") // line range (not "path:line")
    expect(plain).toContain("3/5")
    expect(plain).toContain("o/r#1")
    expect(plain).toContain("FINDINGS (1)")
    expect(plain).toContain("LEGEND")
    expect(plain).toContain("exit 1")
  })

  it("ALIGNMENT: every rendered row is exactly W visible columns (incl. unbreakable long tokens)", () => {
    // a body + headline with a token longer than the card width must NOT overflow the border
    const longTok = "x".repeat(300)
    const r = review([
      finding({ body: `see ${longTok} for details`, headline: longTok }),
      finding({ score: 2, headline: "a much longer headline that wraps across the card body width" }),
    ])
    const ov = { summary: longTok, confidence: 3, confidenceReason: "", bullets: [], files: [] } as PrOverviewVerdict
    const W = 96
    const lines = stripAnsi(renderRich(r, ov, { color: true, width: W }))
      .split("\n")
      .filter((l) => l.length > 0)
    for (const ln of lines) expect(ln.length).toBe(W)
  })

  it("DEPTH: renders the code panel (line numbers + source) + suggestion diff from codeContext", () => {
    const f = finding({
      line: 30,
      suggestedReplacement: "acct.balanceCents += amountCents",
      codeContext: {
        side: "RIGHT" as const,
        lines: [
          { newNumber: 29, text: "if (!acct) throw new Error('x')", kind: "ctx" as const },
          { newNumber: 30, text: "acct.balanceCents -= amountCents", kind: "add" as const },
        ],
      },
    })
    const plain = stripAnsi(renderRich(review([f]), null, { color: true, width: 96 }))
    expect(plain).toContain("acct.balanceCents -= amountCents") // the flagged source line
    expect(plain).toContain("30") // its line number in the gutter
    expect(plain).toContain("Suggestion")
    expect(plain).toContain("acct.balanceCents += amountCents") // the fix
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
    const plain = stripAnsi(renderRich(review([finding()]), ov, { color: true, width: 96 }))
    expect(plain).toContain("ARCHITECTURE")
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
