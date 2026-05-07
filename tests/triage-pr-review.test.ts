// Proactive PR-review pure helpers: response parser + review-submission
// builder + approval-event picker.

import { describe, expect, it } from "vitest"
import {
  buildFallbackBody,
  buildReviewSubmission,
  chooseReviewEvent,
  parsePrReviewResponse,
  renderFixPlan,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "../src/lib/triage-pr-review"

const baseFinding: PrReviewFinding = {
  path: "src/lib/foo.ts",
  line: 42,
  score: 3,
  headline: "missing null guard on `user.profile`",
  body: "Wrap with `if (!user) return` before accessing `user.profile`.",
}

describe("parsePrReviewResponse", () => {
  const valid: PrReviewVerdict = {
    summary: "Safe; one nit.",
    confidence: 4,
    confidenceReason: "Narrow surface, well-tested.",
    findings: [baseFinding],
  }

  it("parses a well-formed JSON object", () => {
    const out = parsePrReviewResponse(JSON.stringify(valid))
    expect(out?.summary).toBe(valid.summary)
    expect(out?.confidence).toBe(4)
    expect(out?.findings).toHaveLength(1)
  })

  it("strips a surrounding ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parsePrReviewResponse(text)?.summary).toBe(valid.summary)
  })

  it("returns null on missing summary", () => {
    expect(parsePrReviewResponse(JSON.stringify({ ...valid, summary: "" }))).toBeNull()
  })

  it("returns null on out-of-range confidence", () => {
    expect(parsePrReviewResponse(JSON.stringify({ ...valid, confidence: 0 }))).toBeNull()
    expect(parsePrReviewResponse(JSON.stringify({ ...valid, confidence: 6 }))).toBeNull()
  })

  it("drops findings missing path / line / score / headline / body", () => {
    const broken = {
      ...valid,
      findings: [
        baseFinding,
        { ...baseFinding, path: "" },
        { ...baseFinding, line: 0 },
        { ...baseFinding, headline: "" },
        { ...baseFinding, body: "" },
        { ...baseFinding, score: 99 }, // out of range — dropped
      ],
    }
    const out = parsePrReviewResponse(JSON.stringify(broken))
    expect(out?.findings).toHaveLength(1)
  })

  it("clamps score into 1-5", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, score: 4.6 }] })
    )
    expect(out?.findings[0]?.score).toBe(5)
  })

  it("includes startLine when valid (positive, less than line)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, startLine: 38 }] })
    )
    expect(out?.findings[0]?.startLine).toBe(38)
  })

  it("drops invalid startLine (>= line, negative, NaN)", () => {
    const finding = { ...baseFinding, line: 50, startLine: 60 }
    const out = parsePrReviewResponse(JSON.stringify({ ...valid, findings: [finding] }))
    expect(out?.findings[0]?.startLine).toBeUndefined()
  })

  it("caps findings at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...baseFinding,
      headline: `f${i}`,
      line: 10 + i,
    }))
    const out = parsePrReviewResponse(JSON.stringify({ ...valid, findings: many }))
    expect(out?.findings).toHaveLength(8)
  })
})

describe("chooseReviewEvent", () => {
  const f = (score: number): PrReviewFinding => ({ ...baseFinding, score })

  // Two-state strict verdict: empty findings → APPROVE, anything else
  // → REQUEST_CHANGES. Score still sorts/severity-tags findings in the
  // body but no longer changes the verdict. Closed-loop semantics:
  // user pushes fixes → arc re-reviews on the new SHA → empty findings
  // → APPROVE. See PR #28 (synchronize re-review).

  it("APPROVE only when findings are empty", () => {
    expect(chooseReviewEvent([])).toBe("APPROVE")
  })

  it("REQUEST_CHANGES on ANY finding regardless of score", () => {
    // Critical: even score-1 nits block now. The model is told via the
    // prompt to only emit findings worth blocking over — if it surfaces
    // one, treat it as a blocker.
    expect(chooseReviewEvent([f(1)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(2)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(3)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(4)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(5)])).toBe("REQUEST_CHANGES")
  })

  it("REQUEST_CHANGES on a mix regardless of max score", () => {
    expect(chooseReviewEvent([f(1), f(2), f(2)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(2), f(5), f(3)])).toBe("REQUEST_CHANGES")
  })
})

describe("buildReviewSubmission", () => {
  const verdict: PrReviewVerdict = {
    summary: "Mostly clean; one logic bug.",
    confidence: 2,
    confidenceReason: "Off-by-one in the bounds check.",
    findings: [{ ...baseFinding, score: 5, headline: "off-by-one in `clampIndex`" }],
  }

  it("submits REQUEST_CHANGES on a score-5 finding", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc123" })
    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.commit_id).toBe("abc123")
  })

  it("includes one inline comment per finding with `path` + `line`", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.path).toBe(baseFinding.path)
    expect(out.comments?.[0]?.line).toBe(baseFinding.line)
    expect(out.comments?.[0]?.side).toBe("RIGHT")
  })

  it("omits start_line when finding has no startLine", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.comments?.[0]?.start_line).toBeUndefined()
    expect(out.comments?.[0]?.start_side).toBeUndefined()
  })

  it("includes start_line + start_side when finding has startLine", () => {
    const v: PrReviewVerdict = {
      ...verdict,
      findings: [{ ...baseFinding, startLine: 38 }],
    }
    const out = buildReviewSubmission({ verdict: v, prAuthor: "alice", headSha: "abc" })
    expect(out.comments?.[0]?.start_line).toBe(38)
    expect(out.comments?.[0]?.start_side).toBe("RIGHT")
  })

  it("omits comments[] entirely on empty findings (clean approval)", () => {
    const empty: PrReviewVerdict = {
      summary: "Looks clean — nothing CR missed.",
      confidence: 5,
      confidenceReason: "Mechanical change.",
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: empty, prAuthor: "alice", headSha: "abc" })
    expect(out.event).toBe("APPROVE")
    expect(out.comments).toBeUndefined()
  })

  it("renders the dedupe marker, summary header, and confidence reason in the body", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).toContain("<!-- openclaw:pr-review -->")
    expect(out.body).toContain("### Sigilix Summary")
    expect(out.body).toContain(verdict.summary)
    expect(out.body).toContain(verdict.confidenceReason)
    // Greptile-style format: no numerical confidence score in the body,
    // no `[BLOCKER]` / `[READY]` tag, no "Findings: N (max score N)"
    // footer. Findings live as inline comments below.
    expect(out.body).not.toContain("[BLOCKER]")
    expect(out.body).not.toContain("**Confidence:**")
    expect(out.body).not.toContain("max score")
  })

  it("body is prose-only — no hardcoded author dialogue", () => {
    // The body lets the model's summary speak. We don't append
    // canned `@author — flagging items below for visibility...`
    // dialogue because it reads mechanical when it recurs across PRs.
    // Author-facing tone is the model's responsibility via `summary`.
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).not.toMatch(/@alice — /)
    expect(out.body).not.toMatch(/non-blocking/i)
    expect(out.body).not.toMatch(/Approving\.$/m)
  })

  it("renders the finding-count pointer when there are findings", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).toMatch(/1 finding inline below/i)
  })

  it("omits the finding-count pointer when there are zero findings", () => {
    const empty: PrReviewVerdict = {
      summary: "Looks clean.",
      confidence: 5,
      confidenceReason: "Mechanical.",
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: empty, prAuthor: "alice", headSha: "abc" })
    expect(out.body).not.toMatch(/inline below/)
  })

  it("does not @-mention bot authors", () => {
    const empty: PrReviewVerdict = {
      summary: "Clean.",
      confidence: 5,
      confidenceReason: "Mechanical.",
      findings: [],
    }
    const out = buildReviewSubmission({
      verdict: empty,
      prAuthor: "openclaw[bot]",
      headSha: "abc",
    })
    expect(out.body).not.toContain("@openclaw[bot]")
  })

  it("preserves a ```suggestion block in finding body", () => {
    const v: PrReviewVerdict = {
      ...verdict,
      findings: [
        {
          ...baseFinding,
          body: "Use `??`.\n\n```suggestion\nconst x = a ?? b\n```",
        },
      ],
    }
    const out = buildReviewSubmission({ verdict: v, prAuthor: "alice", headSha: "abc" })
    expect(out.comments?.[0]?.body).toContain("```suggestion")
    expect(out.comments?.[0]?.body).toContain("const x = a ?? b")
  })
})

describe("buildReviewSubmission — ARC-189 sigilix marker append (Task 2.5)", () => {
  const verdict: PrReviewVerdict = {
    summary: "Two findings.",
    confidence: 3,
    confidenceReason: "Mixed.",
    findings: [
      { ...baseFinding, score: 5, headline: "off-by-one in clampIndex" },
      { ...baseFinding, score: 2, headline: "double-fetch in handler", line: 100 },
    ],
  }

  it("appends the marker on its own line at end of comment body", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [
        "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->",
        "<!-- sigilix:fid:2222222222222222:cat:logic:sev:info:path:222222222222 -->",
      ],
    })
    expect(out.comments?.[0]?.body.endsWith(
      "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->",
    )).toBe(true)
    expect(out.comments?.[1]?.body).toContain(
      "<!-- sigilix:fid:2222222222222222:cat:logic:sev:info:path:222222222222 -->",
    )
  })

  it("preserves the existing openclaw:pr-review-finding marker AND appends sigilix marker", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [
        "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->",
        null,
      ],
    })
    const body = out.comments?.[0]?.body ?? ""
    expect(body).toContain("<!-- openclaw:pr-review-finding -->")
    expect(body).toContain("<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->")
  })

  it("emits no marker when findingMarkers entry is null (sparse opt-out per finding)", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [null, null],
    })
    expect(out.comments?.[0]?.body).not.toContain("sigilix:fid:")
    expect(out.comments?.[1]?.body).not.toContain("sigilix:fid:")
  })

  it("emits no marker when findingMarkers omitted entirely (backward compat)", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
    })
    expect(out.comments?.[0]?.body).not.toContain("sigilix:fid:")
  })

  it("separates marker from body with a blank line", () => {
    const marker =
      "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->"
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [marker, null],
    })
    expect(out.comments?.[0]?.body).toMatch(
      /[^\n]\n\n<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->$/,
    )
  })
})

describe("provenance footer (ARC-184)", () => {
  const verdict: PrReviewVerdict = {
    summary: "Solid.",
    confidence: 5,
    confidenceReason: "All passing.",
    findings: [],
  }
  const HEAD = "abc1234567890abcdef1234567890abcdef1234"
  const NOW = 1733494200000 // 2024-12-06T13:30:00.000Z

  it("formatReviewBody (via buildReviewSubmission) ends with the provenance footer", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    const body = out.body ?? ""
    expect(body).toMatch(
      /_Reviewed against `abc1234` at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\._\s*$/,
    )
  })

  it("buildFallbackBody also ends with the provenance footer", () => {
    const expected = `_Reviewed against \`abc1234\` at ${new Date(NOW).toISOString()}._`
    const out = buildFallbackBody(verdict, [], { headSha: HEAD, nowMs: NOW })
    expect(out.trimEnd().endsWith(expected)).toBe(true)
  })

  it("body is well under 65000 chars on a small fixture", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    expect((out.body ?? "").length).toBeLessThan(2000)
  })

  it("WRITER-SIDE 65k CAP: when summary is huge, summary truncates but footer stays intact", () => {
    const huge: PrReviewVerdict = {
      summary: "x".repeat(64000),
      confidence: 5,
      confidenceReason: "y".repeat(2000),
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: huge, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    const body = out.body ?? ""
    expect(body.length).toBeLessThanOrEqual(65000)
    // Footer survived
    expect(body).toMatch(/_Reviewed against `abc1234` at .+\._/)
    // Truncation marker is present
    expect(body).toContain("[summary truncated to fit GitHub's 65535 limit]")
  })
})

describe("renderFixPlan (ARC-180)", () => {
  const fnd = (overrides: Partial<PrReviewFinding>): PrReviewFinding => ({
    ...baseFinding,
    ...overrides,
  })

  it("returns null when no findings score >= 4", () => {
    expect(renderFixPlan([fnd({ score: 1 }), fnd({ score: 3 })])).toBeNull()
  })

  it("returns null on an empty list", () => {
    expect(renderFixPlan([])).toBeNull()
  })

  it("renders only the Critical section when no High findings exist", () => {
    const out = renderFixPlan([
      fnd({ score: 5, path: "a.ts", line: 1, headline: "deref crash" }),
      fnd({ score: 2, path: "b.ts", line: 5, headline: "naming" }),
    ])
    expect(out).not.toBeNull()
    expect(out!).toContain("Fix Plan")
    expect(out!).toContain("Critical (score 5)")
    expect(out!).not.toContain("High (score 4)")
    expect(out!).toContain("a.ts:1")
    expect(out!).not.toContain("b.ts:5")
  })

  it("renders Critical before High and groups within each severity by path then line", () => {
    const out = renderFixPlan([
      fnd({ score: 4, path: "z.ts", line: 10, headline: "h1" }),
      fnd({ score: 5, path: "a.ts", line: 50, headline: "h2" }),
      fnd({ score: 5, path: "a.ts", line: 5, headline: "h3" }),
      fnd({ score: 4, path: "a.ts", line: 20, headline: "h4" }),
    ])!
    // Critical block appears before High block.
    const criticalIdx = out.indexOf("Critical (score 5)")
    const highIdx = out.indexOf("High (score 4)")
    expect(criticalIdx).toBeGreaterThan(-1)
    expect(highIdx).toBeGreaterThan(criticalIdx)
    // Within Critical: a.ts:5 before a.ts:50 (line ASC within same path).
    const a5 = out.indexOf("a.ts:5", criticalIdx)
    const a50 = out.indexOf("a.ts:50", criticalIdx)
    expect(a5).toBeGreaterThan(-1)
    expect(a50).toBeGreaterThan(a5)
    // Within High: a.ts:20 before z.ts:10 (path ASC).
    const a20 = out.indexOf("a.ts:20", highIdx)
    const z10 = out.indexOf("z.ts:10", highIdx)
    expect(a20).toBeGreaterThan(-1)
    expect(z10).toBeGreaterThan(a20)
  })

  it("renders multi-line range when startLine is set", () => {
    const out = renderFixPlan([
      fnd({ score: 5, path: "a.ts", line: 20, startLine: 15, headline: "h" }),
    ])!
    expect(out).toContain("a.ts:15-20")
    expect(out).not.toContain("a.ts:20 ")
  })

  it("uses single-line format when startLine equals line", () => {
    const out = renderFixPlan([
      fnd({ score: 5, path: "a.ts", line: 20, startLine: 20, headline: "h" }),
    ])!
    expect(out).toContain("a.ts:20")
    expect(out).not.toContain("a.ts:20-20")
  })

  it("truncates over-long headlines", () => {
    const long = "x".repeat(200)
    const out = renderFixPlan([fnd({ score: 5, headline: long })])!
    expect(out).toContain("…")
    expect(out.length).toBeLessThan(long.length + 200)
  })

  it("singularizes the count label", () => {
    const out = renderFixPlan([fnd({ score: 5, headline: "only one" })])!
    expect(out).toMatch(/Critical \(score 5\)\*\*\s*—\s*1 finding\b/)
    expect(out).not.toMatch(/1 findings\b/)
  })

  it("pluralizes the count label", () => {
    const out = renderFixPlan([
      fnd({ score: 4, path: "a.ts", line: 1, headline: "h1" }),
      fnd({ score: 4, path: "b.ts", line: 1, headline: "h2" }),
    ])!
    expect(out).toMatch(/High \(score 4\)\*\*\s*—\s*2 findings\b/)
  })
})
