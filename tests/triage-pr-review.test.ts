// Proactive PR-review pure helpers: response parser + review-submission
// builder + approval-event picker.

import { describe, expect, it } from "vitest"
import {
  buildFallbackBody,
  buildReviewSubmission,
  chooseReviewEvent,
  filterToSigilixAuthored,
  formatFindingComment,
  parsePrReviewResponse,
  renderFixPlan,
  renderRequestChangesBody,
  resolveFindingConfidence,
  severityBadgeForScore,
  type AuthoredItem,
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

  // SIG-37 — when the caller passes in a list of open PR threads /
  // review comments / blocking items via the optional `openItems`
  // arg, Sigilix's APPROVE decision must only consider items it
  // itself authored. CodeRabbit / Greptile / other-bot / human-
  // reviewer items must NOT influence the gate.
  //
  // Establishes the clean Sigilix-only signal needed for the
  // head-to-head measurement framework (SIG-200, separately tracked).
  describe("SIG-37 — Sigilix-only gating of openItems", () => {
    const crThread: AuthoredItem = { user: { login: "coderabbitai[bot]" } }
    const greptileThread: AuthoredItem = { user: { login: "greptile-apps[bot]" } }
    const humanThread: AuthoredItem = { user: { login: "alice" } }
    const sigilixThread: AuthoredItem = { user: { login: "sigilix[bot]" } }

    it("APPROVE despite an unresolved CodeRabbit thread (zero Sigilix threads)", () => {
      // SIG-37 fixture 1: Sigilix has nothing to flag, CodeRabbit
      // has one unresolved thread. Pre-fix, an approval gate that
      // counted all open threads would withhold APPROVE; post-fix
      // the CR thread is filtered out and Sigilix posts APPROVE.
      expect(chooseReviewEvent([], [crThread])).toBe("APPROVE")
    })

    it("REQUEST_CHANGES when Sigilix has an unresolved thread (zero CR threads)", () => {
      // SIG-37 fixture 2: the Sigilix-authored open thread must
      // still block APPROVE. This is the half of the gate that
      // didn't change — Sigilix-only signal in, Sigilix-only signal
      // out.
      expect(chooseReviewEvent([], [sigilixThread])).toBe("REQUEST_CHANGES")
    })

    it("APPROVE when ALL open threads are non-Sigilix (CR + Greptile + human)", () => {
      // Mixed-bag of other-actor threads — none of which Sigilix
      // owns. Filter strips everything; gate sees an empty list +
      // empty findings → APPROVE.
      expect(
        chooseReviewEvent([], [crThread, greptileThread, humanThread]),
      ).toBe("APPROVE")
    })

    it("REQUEST_CHANGES when mixed open threads include at least one Sigilix-authored", () => {
      // Even with other-actor noise in the same list, a single
      // Sigilix-authored open thread is enough to withhold APPROVE.
      expect(
        chooseReviewEvent([], [crThread, sigilixThread, humanThread]),
      ).toBe("REQUEST_CHANGES")
    })

    it("REQUEST_CHANGES when the synth has its own findings, regardless of openItems mix", () => {
      // Findings short-circuit the gate (existing semantics). The
      // `openItems` arg is a secondary signal — never overrides a
      // non-empty findings list.
      expect(chooseReviewEvent([f(3)], [crThread])).toBe("REQUEST_CHANGES")
      expect(chooseReviewEvent([f(3)], [sigilixThread])).toBe("REQUEST_CHANGES")
      expect(chooseReviewEvent([f(3)], [])).toBe("REQUEST_CHANGES")
    })

    it("defaults openItems to [] so existing call sites are unaffected", () => {
      // Defensive: every existing caller passes only the synth
      // verdict's findings; they must keep producing APPROVE on
      // empty findings without needing to thread an openItems arg
      // through.
      expect(chooseReviewEvent([])).toBe("APPROVE")
      expect(chooseReviewEvent([f(2)])).toBe("REQUEST_CHANGES")
    })

    it("handles items with null user (deleted-author rows from GitHub) by dropping them", () => {
      // GitHub returns `user: null` for comments whose author has
      // been deleted. The filter treats those as non-Sigilix and
      // drops them — they shouldn't block APPROVE on the Sigilix-
      // only signal.
      const deletedAuthor: AuthoredItem = { user: null }
      expect(chooseReviewEvent([], [deletedAuthor])).toBe("APPROVE")
    })
  })
})

describe("filterToSigilixAuthored (SIG-37)", () => {
  // Pure predicate exposed for any future call site that wants to
  // count Sigilix-authored open threads separately from other-actor
  // threads (e.g. SIG-200's head-to-head measurement framework).
  // Same identity rule as `chooseReviewEvent`'s internal filter:
  // `user.login === "sigilix[bot]"`.

  const sig: AuthoredItem = { user: { login: "sigilix[bot]" } }
  const cr: AuthoredItem = { user: { login: "coderabbitai[bot]" } }
  const human: AuthoredItem = { user: { login: "alice" } }
  const nullUser: AuthoredItem = { user: null }
  const nullLogin: AuthoredItem = { user: { login: null } }

  it("keeps Sigilix-authored items", () => {
    expect(filterToSigilixAuthored([sig])).toEqual([sig])
  })

  it("drops CodeRabbit / human / null-user / null-login items", () => {
    expect(filterToSigilixAuthored([cr, human, nullUser, nullLogin])).toEqual([])
  })

  it("preserves order of the surviving items", () => {
    const a: AuthoredItem = { user: { login: "sigilix[bot]" } }
    const b: AuthoredItem = { user: { login: "sigilix[bot]" } }
    expect(filterToSigilixAuthored([cr, a, human, b, nullUser])).toEqual([a, b])
  })

  it("returns an empty list for an empty input", () => {
    expect(filterToSigilixAuthored([])).toEqual([])
  })

  it("is case-sensitive (legacy / off-brand casings do NOT match)", () => {
    // GitHub's bot login is the exact App slug; case-sensitive match
    // avoids accidentally counting a hypothetical human handle that
    // happens to differ only by case (`SIGILIX[bot]`) as Sigilix.
    const upper: AuthoredItem = { user: { login: "SIGILIX[bot]" } }
    expect(filterToSigilixAuthored([upper])).toEqual([])
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

  // ARC-293: APPROVE bodies render as MARKER-ONLY. The GitHub-native
  // "approved these changes" line carries the signal; the prior
  // verbose card (heading + coverage + "No issues found" + provenance
  // footer) was timeline noise.
  it("renders the ARC-293 marker-only APPROVE body on empty findings", () => {
    const empty: PrReviewVerdict = {
      summary: "Looks clean — nothing CR missed.",
      confidence: 5,
      confidenceReason: "Mechanical change.",
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: empty, prAuthor: "alice", headSha: "abc" })
    // ARC-293 minimal: just the marker.
    expect(out.body).toBe("<!-- sigilix:pr-review -->\n")
    // Pre-ARC-281 strings must not survive the redesign.
    expect(out.body).not.toContain("✅ Sigilix reviewed this PR — no issues found")
    expect(out.body).not.toContain("nothing worth flagging")
    expect(out.body).not.toContain("Four-specialist ensemble")
    expect(out.body).not.toContain("### Sigilix Summary")
    // ARC-281 explicitly drops the dismissal hint on APPROVE bodies
    // (no review to dismiss).
    expect(out.body).not.toContain("To dismiss this review")
  })

  it("does NOT render REQUEST_CHANGES heading on an empty-findings APPROVE body", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    // The REQUEST_CHANGES path on `verdict` (which has findings) MUST
    // emit the count heading, not the marker-only APPROVE body.
    expect(out.body).toMatch(/^## Sigilix: \d+ finding/m)
  })

  it("ARC-281: REQUEST_CHANGES body has the new heading + dropped legacy strings", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).toContain("<!-- sigilix:pr-review -->")
    // New status heading replaces "### Sigilix Summary" entirely.
    expect(out.body).toMatch(/^## Sigilix: \d+ finding/m)
    // Summary still appears — but as its own paragraph, not under a
    // header.
    expect(out.body).toContain(verdict.summary)
    // confidenceReason is intentionally dropped from the body. The
    // field stays on the type for inline-comment rendering, but the
    // body no longer echoes it.
    expect(out.body).not.toContain(verdict.confidenceReason)
    expect(out.body).not.toContain("### Sigilix Summary")
    // Old format markers also gone.
    expect(out.body).not.toContain("[BLOCKER]")
    expect(out.body).not.toContain("**Confidence:**")
    expect(out.body).not.toContain("max score")
    // Dismissal hint is now required on REQUEST_CHANGES.
    expect(out.body).toContain("To dismiss this review")
    expect(out.body).toContain("@sigilix dismiss")
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

  it("ARC-281: the legacy '_N findings inline below._' pointer is removed entirely", () => {
    // Pre-ARC-281, REQUEST_CHANGES bodies carried a redundant
    // "_1 finding inline below._" line. Kimi's redesign drops it
    // (the heading "## Sigilix: 1 finding" already states the
    // count). This guards against re-adding it.
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).not.toMatch(/inline below/i)
    // The count IS in the heading though.
    expect(out.body).toMatch(/^## Sigilix: \d+ finding/m)
  })

  it("omits the count + Fix Plan + dismissal hint when there are zero findings (APPROVE path)", () => {
    const empty: PrReviewVerdict = {
      summary: "Looks clean.",
      confidence: 5,
      confidenceReason: "Mechanical.",
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: empty, prAuthor: "alice", headSha: "abc" })
    expect(out.body).not.toMatch(/inline below/)
    expect(out.body).not.toContain("### Fix Plan")
    expect(out.body).not.toContain("To dismiss this review")
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

  it("preserves the existing sigilix:pr-review-finding marker AND appends sigilix marker", () => {
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
    expect(body).toContain("<!-- sigilix:pr-review-finding -->")
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

  // ARC-293: APPROVE bodies are marker-only and intentionally bypass
  // the provenance-footer helper (`capForGitHub`). GitHub's commit
  // attribution on the approve event carries the SHA. The footer
  // assertions below pin the REQUEST_CHANGES path instead — that's
  // where the footer still lives.
  const verdictWithFinding: PrReviewVerdict = {
    summary: "Solid.",
    confidence: 5,
    confidenceReason: "All passing.",
    findings: [baseFinding],
  }

  it("APPROVE body (empty findings) is marker-only and bypasses the provenance footer (ARC-293)", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    const body = out.body ?? ""
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
    expect(body).not.toContain("_Reviewed against")
  })

  it("REQUEST_CHANGES body still ends with the provenance footer (ARC-184 invariant)", () => {
    const out = buildReviewSubmission({
      verdict: verdictWithFinding, prAuthor: "alice", headSha: HEAD, nowMs: NOW,
    })
    const body = out.body ?? ""
    expect(body).toMatch(
      /_Reviewed against `abc1234` at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\._\s*$/,
    )
  })

  it("buildFallbackBody APPROVE path is marker-only (ARC-293)", () => {
    const out = buildFallbackBody(verdict, [], { headSha: HEAD, nowMs: NOW })
    expect(out).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("buildFallbackBody REQUEST_CHANGES path still ends with the provenance footer", () => {
    const expected = `_Reviewed against \`abc1234\` at ${new Date(NOW).toISOString()}._`
    const out = buildFallbackBody(verdictWithFinding, [], { headSha: HEAD, nowMs: NOW })
    expect(out.trimEnd().endsWith(expected)).toBe(true)
  })

  it("body is well under 65000 chars on a small fixture", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    expect((out.body ?? "").length).toBeLessThan(2000)
  })

  it("WRITER-SIDE 65k CAP: when summary is huge, summary truncates but footer stays intact", () => {
    // ARC-281: APPROVE bodies no longer render the model's summary
    // (the renderer prints "No issues found." instead), so the cap
    // test has to exercise the REQUEST_CHANGES path where the
    // summary IS in the body. Use a fixture with one finding so the
    // body goes through `renderRequestChangesBody`. Bump summary to
    // > 65k since confidenceReason is no longer rendered and the
    // (former) 64k summary + 2k confidenceReason combo now fits
    // under the cap.
    const huge: PrReviewVerdict = {
      summary: "x".repeat(66000),
      confidence: 5,
      confidenceReason: "y".repeat(2000),
      findings: [
        {
          path: "src/foo.ts",
          line: 10,
          headline: "headline",
          body: "body",
          score: 3,
          category: "logic",
        },
      ],
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

// ─── SIG-101 — severity badges, confidence, retrigger, counter ─────

describe("severityBadgeForScore (SIG-101)", () => {
  it("returns 🔴 P0 for score 5", () => {
    expect(severityBadgeForScore(5)).toBe("🔴 P0")
  })
  it("returns 🟠 P1 for score 4", () => {
    expect(severityBadgeForScore(4)).toBe("🟠 P1")
  })
  it("returns 🟡 P2 for score 3", () => {
    expect(severityBadgeForScore(3)).toBe("🟡 P2")
  })
  it("returns null for score 2 (informational)", () => {
    expect(severityBadgeForScore(2)).toBeNull()
  })
  it("returns null for score 1 (informational)", () => {
    expect(severityBadgeForScore(1)).toBeNull()
  })
  it("treats super-high scores as P0 (defensive clamp)", () => {
    expect(severityBadgeForScore(6)).toBe("🔴 P0")
    expect(severityBadgeForScore(99)).toBe("🔴 P0")
  })
})

describe("resolveFindingConfidence (SIG-101)", () => {
  const fnd = (overrides: Partial<PrReviewFinding>): PrReviewFinding => ({
    ...baseFinding,
    ...overrides,
  })

  it("returns the per-finding confidence when present + in range", () => {
    expect(resolveFindingConfidence(fnd({ confidence: 4 }), 2)).toBe(4)
    expect(resolveFindingConfidence(fnd({ confidence: 1 }), 5)).toBe(1)
  })

  it("falls back to the verdict-level confidence when finding lacks one", () => {
    expect(resolveFindingConfidence(fnd({}), 3)).toBe(3)
  })

  it("clamps the verdict-level fallback into 1-5 defensively", () => {
    expect(resolveFindingConfidence(fnd({}), 0)).toBe(1)
    expect(resolveFindingConfidence(fnd({}), 99)).toBe(5)
  })

  it("ignores out-of-range per-finding confidence and falls back", () => {
    expect(resolveFindingConfidence(fnd({ confidence: 0 }), 3)).toBe(3)
    expect(resolveFindingConfidence(fnd({ confidence: 6 }), 3)).toBe(3)
    expect(resolveFindingConfidence(fnd({ confidence: NaN }), 3)).toBe(3)
  })
})

describe("formatFindingComment (SIG-101 badges + confidence + details-wrap)", () => {
  // Local fnd helper that ensures `category` is populated (the
  // file-level `baseFinding` predates the strict category field).
  const fnd = (overrides: Partial<PrReviewFinding>): PrReviewFinding => ({
    ...baseFinding,
    category: "logic",
    ...overrides,
  })

  it("prefixes 🔴 P0 on score-5 findings", () => {
    const out = formatFindingComment(fnd({ score: 5, headline: "deref crash" }), 5)
    expect(out).toContain("🔴 P0")
    expect(out).toContain("**logic:** deref crash")
  })

  it("prefixes 🟠 P1 on score-4 findings", () => {
    const out = formatFindingComment(fnd({ score: 4 }), 4)
    expect(out).toContain("🟠 P1")
  })

  it("prefixes 🟡 P2 on score-3 findings", () => {
    const out = formatFindingComment(fnd({ score: 3 }), 4)
    expect(out).toContain("🟡 P2")
  })

  it("omits the badge on score 1-2 (informational, no severity prefix)", () => {
    const out = formatFindingComment(fnd({ score: 2 }), 4)
    expect(out).not.toContain("🔴")
    expect(out).not.toContain("🟠")
    expect(out).not.toContain("🟡")
    expect(out).not.toContain("P0")
    expect(out).not.toContain("P1")
    expect(out).not.toContain("P2")
  })

  it("appends `_confidence: N/5_` suffix on every finding regardless of score", () => {
    expect(formatFindingComment(fnd({ score: 5 }), 5)).toContain("_confidence: 5/5_")
    expect(formatFindingComment(fnd({ score: 2 }), 4)).toContain("_confidence: 4/5_")
    expect(formatFindingComment(fnd({ score: 3 }), 1)).toContain("_confidence: 1/5_")
  })

  it("collapses body inside a <details> block when confidence ≤ 2", () => {
    const out = formatFindingComment(fnd({ score: 3 }), 2)
    expect(out).toContain("<details>")
    expect(out).toContain("<summary>Low-confidence finding")
    expect(out).toContain("</details>")
    // The headline + badge + confidence suffix stay OUTSIDE the
    // details block so a reviewer skimming can still triage.
    const headIdx = out.indexOf("**logic:**")
    const detailsIdx = out.indexOf("<details>")
    expect(headIdx).toBeGreaterThan(-1)
    expect(detailsIdx).toBeGreaterThan(headIdx)
  })

  it("does NOT collapse on confidence ≥ 3", () => {
    const out = formatFindingComment(fnd({ score: 3 }), 3)
    expect(out).not.toContain("<details>")
    expect(out).not.toContain("<summary>")
  })

  it("preserves the inline-finding marker as the first line", () => {
    const out = formatFindingComment(fnd({ score: 4 }), 4)
    expect(out.split("\n")[0]).toBe("<!-- sigilix:pr-review-finding -->")
  })
})

describe("parsePrReviewResponse — SIG-101 per-finding confidence", () => {
  const valid: PrReviewVerdict = {
    summary: "Safe; one nit.",
    confidence: 4,
    confidenceReason: "Narrow surface.",
    findings: [],
  }

  it("reads `finding.confidence` when present and in range", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic", confidence: 5 }] }),
    )
    expect(out?.findings[0]?.confidence).toBe(5)
  })

  it("drops out-of-range confidence (leaves the field undefined)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic", confidence: 0 }] }),
    )
    expect(out?.findings[0]?.confidence).toBeUndefined()
  })

  it("clamps fractional confidence to nearest integer", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic", confidence: 3.7 }] }),
    )
    expect(out?.findings[0]?.confidence).toBe(4)
  })

  it("absent confidence stays undefined (caller defaults to verdict-level)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic" }] }),
    )
    expect(out?.findings[0]?.confidence).toBeUndefined()
  })
})

describe("parsePrReviewResponse — SIG-113 evidence citation fields", () => {
  const valid: PrReviewVerdict = {
    summary: "Test",
    confidence: 4,
    confidenceReason: "Reason",
    findings: [],
  }

  it("reads inspectedTestFiles when supplied (array of strings)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: ["tests/foo.test.ts", "tests/bar.test.ts"],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toEqual([
      "tests/foo.test.ts",
      "tests/bar.test.ts",
    ])
  })

  it("reads evidenceRefs when supplied", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
        }],
      }),
    )
    expect(out?.findings[0]?.evidenceRefs).toEqual([
      "siblingMapping:src/lib/foo.ts->NONE",
    ])
  })

  it("trims whitespace + drops empty entries on both fields", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: ["  tests/foo.test.ts  ", "", "  "],
          evidenceRefs: ["", "siblingMapping:x->y", "  "],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toEqual(["tests/foo.test.ts"])
    expect(out?.findings[0]?.evidenceRefs).toEqual(["siblingMapping:x->y"])
  })

  it("drops non-string entries (defensive against schema-bypass)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: ["tests/foo.test.ts", 42, null, "tests/bar.test.ts"],
          evidenceRefs: [{ shape: "object" }, "valid:ref"],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toEqual([
      "tests/foo.test.ts",
      "tests/bar.test.ts",
    ])
    expect(out?.findings[0]?.evidenceRefs).toEqual(["valid:ref"])
  })

  it("absent fields stay undefined (back-compat for staged rollout)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{ ...baseFinding, category: "testing" }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toBeUndefined()
    expect(out?.findings[0]?.evidenceRefs).toBeUndefined()
  })

  it("an empty array supplied also leaves the field undefined (less noise downstream)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: [],
          evidenceRefs: [],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toBeUndefined()
    expect(out?.findings[0]?.evidenceRefs).toBeUndefined()
  })
})

describe("renderRequestChangesBody — SIG-101 retrigger + counter footer", () => {
  const verdict: PrReviewVerdict = {
    summary: "Has issues.",
    confidence: 3,
    confidenceReason: "ok",
    findings: [{ ...baseFinding, score: 4, category: "logic" }],
  }

  it("renders the retrigger sub-text hint when retriggerUrl is supplied (founder pulled the visible button 2026-05-19)", () => {
    const body = renderRequestChangesBody({
      verdict,
      retriggerUrl: "https://github.com/owner/repo/pull/42",
    })
    expect(body).toContain("Comment `/sigilix review`")
    // The Greptile-style `[🔄 Re-run review](URL)` button was dropped
    // on founder feedback — visual noise inside the body.
    expect(body).not.toContain("[🔄 Re-run review]")
    expect(body).not.toContain("🔄 Re-run review")
  })

  it("renders the counter footer line when reviewCounter is supplied", () => {
    const body = renderRequestChangesBody({
      verdict,
      reviewCounter: 3,
      prov: { headSha: "abc1234", nowMs: 1747547318000 },
    })
    expect(body).toMatch(/_Sigilix · Review #3 for this PR · last rendered 2025-05-18T05:48:38\.000Z\._/)
  })

  it("renders BOTH retrigger hint + counter when both are supplied", () => {
    const body = renderRequestChangesBody({
      verdict,
      retriggerUrl: "https://github.com/owner/repo/pull/42",
      reviewCounter: 1,
      prov: { headSha: "abc1234", nowMs: 1747547318000 },
    })
    expect(body).toContain("Comment `/sigilix review`")
    expect(body).toContain("Review #1 for this PR")
  })

  it("omits both when neither field is supplied (back-compat)", () => {
    const body = renderRequestChangesBody({ verdict })
    expect(body).not.toContain("Comment `/sigilix review`")
    expect(body).not.toContain("Review #")
  })

  it("orders retrigger hint before counter; counter sits above the provenance footer", () => {
    const body = renderRequestChangesBody({
      verdict,
      retriggerUrl: "https://github.com/owner/repo/pull/42",
      reviewCounter: 7,
      prov: { headSha: "deadbeef0000", nowMs: 1747547318000 },
    })
    const hintIdx = body.indexOf("Comment `/sigilix review`")
    const counterIdx = body.indexOf("Review #7")
    const provIdx = body.indexOf("_Reviewed against")
    expect(hintIdx).toBeGreaterThan(-1)
    expect(counterIdx).toBeGreaterThan(hintIdx)
    expect(provIdx).toBeGreaterThan(counterIdx)
  })

  it("ignores reviewCounter <= 0 (defensive — counter should always be >= 1)", () => {
    const body = renderRequestChangesBody({ verdict, reviewCounter: 0 })
    expect(body).not.toContain("Review #")
  })
})

describe("parsePrReviewResponse — suggestedReplacement (SIG-125)", () => {
  const base = {
    summary: "s", confidence: 4, confidenceReason: "r",
    findings: [{
      path: "src/a.ts", line: 10, score: 4, category: "performance",
      headline: "h", body: "b", suggestedReplacement: "  return getUsers(ids)\n",
    }],
  }
  it("reads a non-empty suggestedReplacement (raw kept, incl. indentation/newline)", () => {
    const v = parsePrReviewResponse(JSON.stringify(base))
    expect(v?.findings[0]?.suggestedReplacement).toBe("  return getUsers(ids)\n")
  })
  it("drops an empty / whitespace-only suggestedReplacement", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: "   " }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })
  it("ignores a non-string suggestedReplacement", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: 42 }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })
})

import { extensionToFenceLang } from "../src/lib/triage-pr-review"

describe("extensionToFenceLang (SIG-125)", () => {
  it("maps known extensions", () => {
    expect(extensionToFenceLang("src/a.ts")).toBe("ts")
    expect(extensionToFenceLang("src/a.tsx")).toBe("tsx")
    expect(extensionToFenceLang("x.py")).toBe("python")
    expect(extensionToFenceLang("x.json")).toBe("json")
  })
  it("returns empty string for unknown/extensionless paths", () => {
    expect(extensionToFenceLang("Makefile")).toBe("")
    expect(extensionToFenceLang("x.weird")).toBe("")
  })
  it("returns empty string for Object.prototype-key extensions (no proto pollution)", () => {
    expect(extensionToFenceLang("x.constructor")).toBe("")
    expect(extensionToFenceLang("x.__proto__")).toBe("")
    expect(extensionToFenceLang("x.toString")).toBe("")
    expect(extensionToFenceLang("x.hasOwnProperty")).toBe("")
  })
})
