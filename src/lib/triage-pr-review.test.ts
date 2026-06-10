// Proactive PR-review pure helpers: response parser + review-submission
// builder + approval-event picker.

import { describe, expect, it } from "vitest"
import {
  chooseRenderedEventWithOverride,
  chooseReviewEvent,
  chooseReviewEventForRenderedFindings,
  formatFindingComment,
  previewReviewSubmissionEvent,
  parsePrReviewResponse,
  type AuthoredItem,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "@/lib/triage-pr-review"
import { baseFinding } from "@/lib/triage-pr-review.test-helpers"

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

  it("repairs unescaped double quotes inside finding string fields", () => {
    const text = '{ "summary": "Parser coverage gap.", "confidence": 5, "confidenceReason": "Visible from testing evidence.", "findings": [{ "path": "src/lib/parse-kind.ts", "line": 5, "scope": "file", "score": 4, "category": "testing", "headline": "Exported parser function `parseKind` ships without test coverage", "body": "`parseKind` calls `String(raw ?? "task").toLowerCase()` and should test `"bug"` plus `"task"` inputs." }] }'
    const out = parsePrReviewResponse(text)
    expect(out?.findings).toHaveLength(1)
    expect(out?.findings[0]?.body).toContain('String(raw ?? "task").toLowerCase()')
    expect(out?.findings[0]?.body).toContain('"bug"')
  })

  it("repairs unescaped quoted object-key text inside finding string fields", () => {
    const text = '{ "summary": "Parser coverage gap.", "confidence": 5, "confidenceReason": "Visible from testing evidence.", "findings": [{ "path": "src/lib/parse-kind.ts", "line": 5, "scope": "file", "score": 4, "category": "testing", "headline": "Exported parser function `parseKind` ships without test coverage", "body": "The parser should cover `"kind": "bug"` and `"kind": "task"` payloads." }] }'
    const out = parsePrReviewResponse(text)
    expect(out?.findings).toHaveLength(1)
    expect(out?.findings[0]?.body).toContain('"kind": "bug"')
    expect(out?.findings[0]?.body).toContain('"kind": "task"')
  })

  it("preserves already-escaped quotes inside finding string fields", () => {
    const text = JSON.stringify({
      ...valid,
      findings: [{
        ...baseFinding,
        body: '`parseKind` should keep `String(raw ?? "task").toLowerCase()` and `"bug"` examples intact.',
      }],
    })
    const out = parsePrReviewResponse(text)
    expect(out?.findings[0]?.body).toContain('String(raw ?? "task").toLowerCase()')
    expect(out?.findings[0]?.body).toContain('"bug"')
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

  it("SIG-282: parses dismissedScanFacts and drops malformed entries", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        dismissedScanFacts: [
          { evidenceId: "secret:generic-high-entropy-token:abc:18", reason: "SRI hash next to a CDN URL; public" },
          { evidenceId: "", reason: "no id" }, // dropped
          { reason: "missing evidenceId" }, // dropped
          { evidenceId: "secret:x:y:1" }, // dropped (no reason)
          "not-an-object", // dropped
        ],
      })
    )
    expect(out?.dismissedScanFacts).toEqual([
      { evidenceId: "secret:generic-high-entropy-token:abc:18", reason: "SRI hash next to a CDN URL; public" },
    ])
  })

  it("SIG-282: omits dismissedScanFacts when the model emits none", () => {
    expect(parsePrReviewResponse(JSON.stringify(valid))?.dismissedScanFacts).toBeUndefined()
  })

  it("SIG-308: parses clearedLogicCandidates and drops malformed entries", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        clearedLogicCandidates: [
          { path: "src/ui/app.tsx", line: 50, hypothesis: "x*60*60*1000 could overflow", mitigation: "Math.min(parsed, 2160) clamps it" },
          { path: "", line: 50, hypothesis: "h", mitigation: "m" }, // dropped (no path)
          { path: "src/a.ts", line: 0, hypothesis: "h", mitigation: "m" }, // dropped (line <= 0)
          { path: "src/a.ts", line: 5, hypothesis: "", mitigation: "m" }, // dropped (no hypothesis)
          { path: "src/a.ts", line: 5, hypothesis: "h" }, // dropped (no mitigation)
          "not-an-object", // dropped
        ],
      })
    )
    expect(out?.clearedLogicCandidates).toEqual([
      { path: "src/ui/app.tsx", line: 50, hypothesis: "x*60*60*1000 could overflow", mitigation: "Math.min(parsed, 2160) clamps it" },
    ])
  })

  it("SIG-308: clearedLogicCandidates coexist with findings and dismissedScanFacts", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        dismissedScanFacts: [{ evidenceId: "secret:x:y:1", reason: "public SRI hash next to a CDN url" }],
        clearedLogicCandidates: [{ path: "src/a.ts", line: 9, hypothesis: "off-by-one", mitigation: "guarded by i < n" }],
      })
    )
    expect(out?.findings).toHaveLength(1)
    expect(out?.dismissedScanFacts).toHaveLength(1)
    expect(out?.clearedLogicCandidates).toHaveLength(1)
  })

  it("SIG-308: omits clearedLogicCandidates when the model emits none", () => {
    expect(parsePrReviewResponse(JSON.stringify(valid))?.clearedLogicCandidates).toBeUndefined()
  })

  it("SIG-282: reads per-finding independentAssessment", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{ ...baseFinding, independentAssessment: "Used as an Authorization header value" }],
      })
    )
    expect(out?.findings[0]?.independentAssessment).toBe("Used as an Authorization header value")
  })

  it("clamps score into 1-5", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, score: 4.6 }] })
    )
    expect(out?.findings[0]?.score).toBe(5)
  })

  it.each([
    ["line", "line"],
    ["file", "file"],
    ["pr", "pr"],
    ["comment", "comment"],
    ["comment/event", "comment"],
    ["event", "comment"],
    ["review-comment", "comment"],
    ["pull-request", "pr"],
    ["pull_request", "pr"],
    ["review", "pr"],
  ] as const)("normalizes finding scope %s to %s", (raw, expected) => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, scope: raw }] })
    )
    expect(out?.findings[0]?.scope).toBe(expected)
  })

  it.each(["thread", ""])("ignores invalid finding scope %j for back-compat", (scope) => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, scope }] })
    )
    expect(out?.findings[0]?.scope).toBeUndefined()
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

  it("parses structured finding examples and test-gap details", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          failureExample: "input: FINAL(wrong) then FINAL(correct)",
          fixExample: "match = re.search(r\"FINAL\\\\((.*?)\\\\)\", response, re.DOTALL)",
          testGap: "The existing test only covers one FINAL(...) token.",
        }],
      }),
    )
    expect(out?.findings[0]?.failureExample).toBe("input: FINAL(wrong) then FINAL(correct)")
    expect(out?.findings[0]?.fixExample).toContain("re.search")
    expect(out?.findings[0]?.testGap).toBe("The existing test only covers one FINAL(...) token.")
  })

  it("normalizes fenced structured examples and caps long details", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          failureExample: "```text\n" + "x".repeat(2200) + "\n```",
          fixExample: 42,
        }],
      }),
    )
    expect(out?.findings[0]?.failureExample).toHaveLength(2000)
    expect(out?.findings[0]?.failureExample).not.toContain("```")
    expect(out?.findings[0]?.fixExample).toBeUndefined()
  })

  it("unwraps CRLF and no-final-newline fenced structured examples", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          failureExample: "```text\r\nvalue```",
          fixExample: "```ts\r\nconst ok = true\r\n```",
        }],
      }),
    )
    expect(out?.findings[0]?.failureExample).toBe("value")
    expect(out?.findings[0]?.fixExample).toBe("const ok = true")
  })

  it("keeps backtick-heavy structured examples renderable", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          failureExample: "value includes ``` inside",
        }],
      }),
    )
    const comment = formatFindingComment(out!.findings[0]!, 5)
    expect(comment).toContain("````text")
    expect(comment).toContain("value includes ``` inside")
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

describe("chooseReviewEventForRenderedFindings", () => {
  const f = (score = 3): PrReviewFinding => ({ ...baseFinding, score })
  const crThread: AuthoredItem = { user: { login: "coderabbitai[bot]" } }
  const sigilixThread: AuthoredItem = { user: { login: "sigilix[bot]" } }

  it("APPROVE when no rendered findings or Sigilix-owned open items remain", () => {
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [],
    })).toBe("APPROVE")
  })

  it("REQUEST_CHANGES when at least one finding rendered inline", () => {
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [f()],
      bodyOnlyFindings: [f(2)],
    })).toBe("REQUEST_CHANGES")
  })

  it("COMMENT when rendered findings are testing-only, even at high score", () => {
    const testingFinding: PrReviewFinding = { ...baseFinding, category: "testing", score: 5 }
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [testingFinding],
      bodyOnlyFindings: [],
    })).toBe("COMMENT")
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [testingFinding],
    })).toBe("COMMENT")
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [testingFinding],
      bodyOnlyFindings: [f(3)],
    })).toBe("REQUEST_CHANGES")
  })

  // Founder verdict rule: ANY substantive finding blocks, even a sub-4 nit —
  // "no competitor approves on a P2/P3". (`f` has no category → substantive.)
  it("REQUEST_CHANGES on substantive sub-4 findings (a real finding always blocks)", () => {
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [f(3), f(2)],
    })).toBe("REQUEST_CHANGES")
  })

  // The only non-blocking tier: a truly trivial style/docs nit below P0/P1.
  it("COMMENT only for a truly trivial style/docs nit below P0/P1", () => {
    const triv = (category: "style" | "docs", score = 2): PrReviewFinding => ({ ...baseFinding, category, score })
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [], bodyOnlyFindings: [triv("style"), triv("docs")],
    })).toBe("COMMENT")
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [triv("style")], bodyOnlyFindings: [],
    })).toBe("COMMENT") // a trivial nit inline is still just a COMMENT (category, not anchor)
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [], bodyOnlyFindings: [triv("style", 4)],
    })).toBe("REQUEST_CHANGES") // a P0/P1 style finding is NOT trivial → blocks (recall floor)
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [], bodyOnlyFindings: [triv("style"), f(2)],
    })).toBe("REQUEST_CHANGES") // substantive alongside a trivial → blocks
  })

  // SIG-281 PR A — believability floor: a real blocker routed body-only (e.g.
  // unanchorable, or demoted by later routing discipline) must STILL block.
  // Appearing in body text does not gate the merge; only the review event does.
  it("REQUEST_CHANGES when a body-only finding is a blocker (score >= 4)", () => {
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [f(5)],
    })).toBe("REQUEST_CHANGES")
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [f(4)], // a lone P1 (exactly the floor) blocks on its own
    })).toBe("REQUEST_CHANGES")
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [f(2), f(4)], // one blocker among nits → still blocks
    })).toBe("REQUEST_CHANGES")
  })

  it("APPROVES when the only finding is OUT-OF-PR-SCOPE — never blocks on code not in the PR (founder ask, Codex-hardened)", () => {
    // out-of-PR-scope = path is not a changed file (NOT mere anchor-failure).
    const outside = (score: number): PrReviewFinding => ({ ...baseFinding, score, outOfPrScope: true })
    // out-of-scope-only, even a "P1", APPROVES (informational, not about this PR — like CodeRabbit)
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [outside(5)],
    })).toBe("APPROVE")
    // an IN-SCOPE body blocker still blocks — a mis-anchored real finding on a
    // CHANGED file (no outOfPrScope flag) holds the SIG-281 floor (recall hole closed).
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [outside(5), f(5)],
    })).toBe("REQUEST_CHANGES")
    // out-of-scope + an in-scope SUBSTANTIVE finding → blocks (the in-scope one is real)
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [outside(5), f(3)],
    })).toBe("REQUEST_CHANGES")
    // out-of-scope + an in-scope TRIVIAL style nit → COMMENT (the nit surfaces, doesn't block)
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [outside(5), { ...baseFinding, category: "style", score: 2 }],
    })).toBe("COMMENT")
  })

  it("REQUEST_CHANGES for unresolved Sigilix-authored items, but not competitor items", () => {
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [],
      openItems: [crThread],
    })).toBe("APPROVE")

    // a competitor (CodeRabbit) open item must NOT escalate; with only a trivial
    // style nit present, the verdict stays a non-blocking COMMENT.
    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [{ ...baseFinding, category: "style", score: 2 }],
      openItems: [crThread],
    })).toBe("COMMENT")

    expect(chooseReviewEventForRenderedFindings({
      inlineFindings: [],
      bodyOnlyFindings: [],
      openItems: [sigilixThread],
    })).toBe("REQUEST_CHANGES")
  })
})

describe("chooseRenderedEventWithOverride — SIG-287 degraded/low-confidence downgrade", () => {
  const f = (score = 3): PrReviewFinding => ({ ...baseFinding, score })

  it("REQUEST_CHANGES override always escalates (a real blocker must block)", () => {
    expect(
      chooseRenderedEventWithOverride({ inlineFindings: [], bodyOnlyFindings: [] }, "REQUEST_CHANGES"),
    ).toBe("REQUEST_CHANGES")
  })

  it("COMMENT override DOWNGRADES an otherwise-clean APPROVE to COMMENT (degraded coverage / low confidence)", () => {
    // The SIG-287 fake-approve bug: 0 findings would APPROVE; when the review is
    // degraded (logic specialist absent) or low-confidence, we must post a
    // neutral COMMENT instead of a confident clean sign-off.
    expect(
      chooseRenderedEventWithOverride({ inlineFindings: [], bodyOnlyFindings: [] }, "COMMENT"),
    ).toBe("COMMENT")
  })

  it("COMMENT override NEVER weakens a REQUEST_CHANGES (a blocker still blocks)", () => {
    expect(
      chooseRenderedEventWithOverride({ inlineFindings: [f(4)], bodyOnlyFindings: [] }, "COMMENT"),
    ).toBe("REQUEST_CHANGES")
    expect(
      chooseRenderedEventWithOverride({ inlineFindings: [], bodyOnlyFindings: [f(5)] }, "COMMENT"),
    ).toBe("REQUEST_CHANGES")
  })

  it("COMMENT override is a no-op when rendered findings already make it COMMENT", () => {
    // base is COMMENT only for a trivial style/docs nit (the founder verdict rule)
    expect(
      chooseRenderedEventWithOverride(
        { inlineFindings: [], bodyOnlyFindings: [{ ...baseFinding, category: "style", score: 2 }] },
        "COMMENT",
      ),
    ).toBe("COMMENT")
  })

  it("no override → unchanged base behavior (clean → APPROVE)", () => {
    expect(
      chooseRenderedEventWithOverride({ inlineFindings: [], bodyOnlyFindings: [] }),
    ).toBe("APPROVE")
  })
})

describe("previewReviewSubmissionEvent", () => {
  it("matches final rendering for body-only routing without building the body", () => {
    const fileFinding: PrReviewFinding = {
      ...baseFinding,
      scope: "file",
      score: 4,
    }

    // SIG-281 PR A: a body-only score>=4 (P1) blocker escalates to
    // REQUEST_CHANGES; the preview must mirror that escalation.
    expect(previewReviewSubmissionEvent({
      verdict: {
        summary: "Body-only issue.",
        confidence: 4,
        confidenceReason: "Specific.",
        findings: [fileFinding],
      },
      headSha: "abc",
    })).toBe("REQUEST_CHANGES")
  })

  it("COMMENT for a trivial style/docs nit below the blocker floor (score < 4)", () => {
    const fileFinding: PrReviewFinding = { ...baseFinding, scope: "file", category: "style", score: 3 }
    expect(previewReviewSubmissionEvent({
      verdict: { summary: "Body-only nit.", confidence: 4, confidenceReason: "Specific.", findings: [fileFinding] },
      headSha: "abc",
    })).toBe("COMMENT")
  })

  it("honors explicit event overrides", () => {
    expect(previewReviewSubmissionEvent({
      verdict: {
        summary: "Body-only issue.",
        confidence: 4,
        confidenceReason: "Specific.",
        findings: [{ ...baseFinding, scope: "file" }],
      },
      headSha: "abc",
      eventOverride: "REQUEST_CHANGES",
    })).toBe("REQUEST_CHANGES")
  })
})

// SIG-161 PR 4a — new thresholded gate (`chooseReviewEventWithGate`)
// runs alongside the legacy `chooseReviewEvent`. Used in shadow/enforce
// modes; the legacy path remains in `off` mode for back-compat.
// Implements the four-event table from DESIGN.md §4:
//   - any finding with gateScore >= threshold → REQUEST_CHANGES (blocking)
//   - no blocking + any Sigilix-authored open item → REQUEST_CHANGES
//   - no blocking + findings in [FLOOR_SUPPRESS, threshold) → COMMENT
//   - no findings + no open items → APPROVE
