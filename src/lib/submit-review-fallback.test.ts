// Unit tests for the submit-review fallback path (Greptile-style port).
//
// When GitHub rejects an inline-anchored review (typical 422 on a bad
// position), the orchestrator re-submits the same review WITHOUT inline
// comments, embedding every finding in the body as markdown grouped by
// file. The point of this test file is to verify three pure helpers:
//
//   1. validateForSubmission populates `unanchoredFindings` for findings
//      that pass the hallucination guard but fail line-validity. These
//      are the findings the fallback recovers.
//   2. buildFallbackBody renders body-only findings as compact bullets,
//      sorts by score desc, includes both anchored + unanchored, and preserves
//      the dedupe marker.
//   3. buildFallbackSubmission emits a SubmitReviewBody with NO
//      `comments` array (so GitHub doesn't re-validate inline anchors).
//
// Orchestrator-level integration testing of the catch-and-retry flow is
// deferred to shadow-mode dogfooding — same rationale as the existing
// triage-pr-review-ensemble.test.ts: too much network mocking surface
// for unit value, and Phase 4a ships off-by-default.

import { describe, expect, it } from "vitest"
import { buildFallbackBody, buildFallbackSubmission, buildReviewSubmission } from "@/src/lib/triage-pr-review"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

const baseFinding: PrReviewFinding = {
  path: "src/lib/foo.ts",
  line: 42,
  score: 4,
  category: "logic",
  headline: "off-by-one in `clampIndex`",
  body: "Use `i <= n` instead of `i < n`.",
}

const baseVerdict: PrReviewVerdict = {
  summary: "One real bug.",
  confidence: 4,
  confidenceReason: "Clear off-by-one.",
  findings: [baseFinding],
}

describe("buildFallbackBody", () => {
  it("preserves the dedupe marker so existing comment-marker logic still finds it", () => {
    const body = buildFallbackBody(baseVerdict, [])
    expect(body.startsWith("<!-- sigilix:pr-review -->")).toBe(true)
  })

  it("SIG-471 PR-3: minimal body — no heading/summary/confidenceReason; the finding is in the dropdown", () => {
    const body = buildFallbackBody(baseVerdict, [])
    // SIG-471 PR-3: the lead heading, summary, and confidenceReason are GONE from
    // the body. The (unanchored) finding routes into the outside-the-diff dropdown.
    expect(body).not.toMatch(/^\*\*\d+ high-severity finding/m)
    expect(body).not.toContain("One real bug.")
    expect(body).not.toContain("Clear off-by-one.")
    expect(body).toContain("<summary><b>1 finding outside the diff</b></summary>")
    expect(body).toContain("off-by-one in `clampIndex`")
  })

  it("ARC-293: APPROVE path is MARKER-ONLY (no findings sections, no heading, no provenance)", () => {
    const body = buildFallbackBody({ ...baseVerdict, findings: [] }, [])
    // ARC-293: APPROVE bodies render as just the marker + newline.
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
    // None of the legacy / verbose strings survive.
    expect(body).not.toContain("### Findings")
    expect(body).not.toContain("### Review Body Findings")
    expect(body).not.toContain("### Fix Plan")
    expect(body).not.toContain("## Sigilix: Approved")
    expect(body).not.toContain("No issues found")
    expect(body).not.toContain("### Sigilix Summary")
  })

  it("renders compact anchors without orphan file headings", () => {
    const findings: PrReviewFinding[] = [
      { ...baseFinding, path: "src/z.ts", line: 10, headline: "z-issue" },
      { ...baseFinding, path: "src/a.ts", line: 20, headline: "a-issue" },
      { ...baseFinding, path: "src/m.ts", line: 30, headline: "m-issue" },
    ]
    const body = buildFallbackBody({ ...baseVerdict, findings }, [])
    // SIG-471 PR-3: the body-only findings render as rows in the ONE
    // outside-the-diff dropdown table — File cell is the path:line anchor.
    expect(body).toContain("<summary><b>3 findings outside the diff</b></summary>")
    expect(body).toContain("`src/a.ts:20`")
    expect(body).toContain("`src/m.ts:30`")
    expect(body).toContain("`src/z.ts:10`")
    expect(body).toContain("a-issue")
    expect(body).not.toContain("Fix Plan")
  })

  it("SIG-471 PR-3: lists every body-only finding in the dropdown (upstream order, none dropped)", () => {
    // SIG-471 PR-3: the minimal dropdown no longer re-sorts by score — it lists the
    // findings in the order they arrive (the prior score-DESC body-row sort was part
    // of the removed detailed render). Recall is what matters: all three appear.
    const findings: PrReviewFinding[] = [
      { ...baseFinding, line: 100, score: 2, headline: "low-score-late" },
      { ...baseFinding, line: 50, score: 5, headline: "high-score-early" },
      { ...baseFinding, line: 10, score: 5, headline: "high-score-earlier" },
    ]
    const body = buildFallbackBody({ ...baseVerdict, findings }, [])
    expect(body).toContain("<summary><b>3 findings outside the diff</b></summary>")
    expect(body).toContain("low-score-late")
    expect(body).toContain("high-score-early")
    expect(body).toContain("high-score-earlier")
  })

  it("MERGES anchored verdict.findings with unanchored findings", () => {
    const anchored = { ...baseFinding, line: 10, headline: "anchored-finding" }
    const unanchored: PrReviewFinding = {
      ...baseFinding,
      line: 999,
      headline: "unanchored-finding",
    }
    const body = buildFallbackBody({ ...baseVerdict, findings: [anchored] }, [unanchored])
    // SIG-471 PR-3: both findings appear in the ONE outside-the-diff dropdown —
    // anchored + unanchored merged, neither lost. No lead heading.
    expect(body).toContain("anchored-finding")
    expect(body).toContain("unanchored-finding")
    expect(body).toContain("<summary><b>2 findings outside the diff</b></summary>")
    expect(body).not.toMatch(/^\*\*\d+ high-severity finding/m)
    expect(body).not.toContain("Fix Plan")
  })

  it("renders a multi-line range when startLine differs from line", () => {
    const ranged: PrReviewFinding = {
      ...baseFinding,
      startLine: 40,
      line: 50,
    }
    const body = buildFallbackBody({ ...baseVerdict, findings: [ranged] }, [])
    // SIG-471 PR-3: the ranged span is in the dropdown row's File cell anchor.
    expect(body).toContain("`src/lib/foo.ts:40-50`")
    expect(body).toContain("file-scope")
    expect(body).not.toContain("**`src/lib/foo.ts:40-50`**:")
  })

  it("renders single-line target when startLine is omitted", () => {
    const single: PrReviewFinding = { ...baseFinding, line: 50 }
    const body = buildFallbackBody({ ...baseVerdict, findings: [single] }, [])
    // SIG-471 PR-3: single-line anchor in the dropdown File cell.
    expect(body).toContain("`src/lib/foo.ts:50`")
    expect(body).not.toContain("**`src/lib/foo.ts:50`**:")
  })

  it("includes the finding headline + path in the dropdown row", () => {
    const body = buildFallbackBody(baseVerdict, [])
    // SIG-471 PR-3: the minimal dropdown row is `| File | Scope | Finding |` —
    // headline (plain, not bold) + path anchor. No category badge img.
    expect(body).toContain("off-by-one in `clampIndex`")
    expect(body).toContain("`src/lib/foo.ts:42`")
    expect(body).not.toContain('alt="LOGIC"')
  })

  it("SIG-471 PR-3: the finding body prose is NOT echoed in the minimal dropdown", () => {
    const body = buildFallbackBody(
      {
        ...baseVerdict,
        findings: [{ ...baseFinding, body: "first line\nsecond line", headline: "the headline only" }],
      },
      [],
    )
    // The dropdown shows the headline only — the body prose lives on the inline
    // comment (when anchorable) / the check annotation, not the minimal row.
    expect(body).toContain("the headline only")
    expect(body).not.toContain("first line")
    expect(body).not.toContain("second line")
  })

  it("SIG-471 PR-3: confidenceReason is never rendered in the body, even when populated", () => {
    const populated = buildFallbackBody(baseVerdict, [])
    expect(populated).not.toContain("Clear off-by-one.")
    const blank = buildFallbackBody({ ...baseVerdict, confidenceReason: "" }, [])
    // Summary is no longer in the body either; the finding flows into the dropdown.
    expect(blank).not.toContain("One real bug.")
    expect(blank).toContain("<summary><b>1 finding outside the diff</b></summary>")
  })
})

describe("buildFallbackSubmission", () => {
  it("emits no `comments` array (so GitHub does not re-validate inline anchors)", () => {
    const submission = buildFallbackSubmission({
      verdict: baseVerdict,
      unanchored: [],
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.comments).toBeUndefined()
  })

  it("uses COMMENT when body-only fallback findings are trivial style/docs nits", () => {
    const submission = buildFallbackSubmission({
      verdict: { ...baseVerdict, findings: [{ ...baseFinding, category: "style", score: 3 }] },
      unanchored: [],
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.event).toBe("COMMENT")
  })

  it("ESCALATES to REQUEST_CHANGES when a body-only fallback finding is SUBSTANTIVE sub-4 (founder rule)", () => {
    const submission = buildFallbackSubmission({
      verdict: { ...baseVerdict, findings: [{ ...baseFinding, category: "logic", score: 3 }] },
      unanchored: [],
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.event).toBe("REQUEST_CHANGES")
  })

  it("SIG-281 PR A: ESCALATES to REQUEST_CHANGES when a body-only fallback finding is a blocker (score >= 4)", () => {
    // baseFinding is score 4 (P1). A real blocker that lands body-only
    // (GitHub dropped the anchor) must still gate the merge — appearing
    // in body text alone would otherwise surface as a green COMMENT.
    const submission = buildFallbackSubmission({
      verdict: baseVerdict,
      unanchored: [],
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.event).toBe("REQUEST_CHANGES")
  })

  it("returns APPROVE when both anchored and unanchored are empty", () => {
    const submission = buildFallbackSubmission({
      verdict: { ...baseVerdict, findings: [] },
      unanchored: [],
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.event).toBe("APPROVE")
  })

  it("returns COMMENT when only trivial style/docs unanchored nits exist (anchored empty)", () => {
    const unanchored: PrReviewFinding[] = [
      {
        ...baseFinding,
        category: "style",
        score: 3,
        line: 999,
        headline: "drift-flagged-but-line-out-of-diff",
      },
    ]
    const submission = buildFallbackSubmission({
      verdict: { ...baseVerdict, findings: [] },
      unanchored,
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.event).toBe("COMMENT")
  })

  it("SIG-281 PR A: ESCALATES when only unanchored findings exist but one is a blocker (score >= 4)", () => {
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, score: 4, line: 999, headline: "real-P1-but-unanchorable" },
    ]
    const submission = buildFallbackSubmission({
      verdict: { ...baseVerdict, findings: [] },
      unanchored,
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.event).toBe("REQUEST_CHANGES")
  })

  it("preserves an explicit REQUEST_CHANGES override for policy blockers", () => {
    const submission = buildFallbackSubmission({
      verdict: baseVerdict,
      unanchored: [],
      prAuthor: null,
      headSha: "deadbeef",
      eventOverride: "REQUEST_CHANGES",
    })
    expect(submission.event).toBe("REQUEST_CHANGES")
    // SIG-471 PR-3: the dismiss hint moved to the overview Manage line — the body
    // routes the finding into the outside-the-diff dropdown.
    expect(submission.body).not.toContain("@sigilix dismiss")
    expect(submission.body).toContain("<summary><b>1 finding outside the diff</b></summary>")
  })

  it("SIG-471 PR-3: renders the policy-blocker sentence when a zero-finding blocker forces REQUEST_CHANGES", () => {
    const submission = buildFallbackSubmission({
      verdict: {
        ...baseVerdict,
        summary: "Approval validation still has an unresolved policy blocker.",
        findings: [],
      },
      unanchored: [],
      prAuthor: null,
      headSha: "deadbeef",
      eventOverride: "REQUEST_CHANGES",
    })

    expect(submission.event).toBe("REQUEST_CHANGES")
    expect(submission.body).toContain(
      "This review was submitted as **Request changes** due to a repository policy blocker. " +
        "No automated findings were generated.",
    )
    expect(submission.body).not.toContain("0 findings")
  })

  it("threads commit_id from headSha so the review is pinned to the reviewed sha", () => {
    const submission = buildFallbackSubmission({
      verdict: baseVerdict,
      unanchored: [],
      prAuthor: null,
      headSha: "abc123",
    })
    expect(submission.commit_id).toBe("abc123")
  })

  it("body contains every finding from both anchored + unanchored sources", () => {
    const anchored = { ...baseFinding, headline: "anchored-here" }
    const unanchored: PrReviewFinding = {
      ...baseFinding,
      line: 999,
      headline: "unanchored-here",
    }
    const submission = buildFallbackSubmission({
      verdict: { ...baseVerdict, findings: [anchored] },
      unanchored: [unanchored],
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.body).toContain("anchored-here")
    expect(submission.body).toContain("unanchored-here")
  })
})

describe("buildReviewSubmission with unanchored findings (CR+Sigilix PR #38 catch)", () => {
  it("rolls unanchored findings into the body even on the success path", () => {
    const anchored = { ...baseFinding, line: 42, headline: "anchored-here" }
    const unanchored: PrReviewFinding[] = [{ ...baseFinding, line: 999, headline: "unanchored-must-not-be-lost" }]
    const submission = buildReviewSubmission({
      verdict: { ...baseVerdict, findings: [anchored] },
      prAuthor: null,
      headSha: "deadbeef",
      unanchored,
    })
    expect(submission.body).toContain("unanchored-must-not-be-lost")
    // SIG-471 PR-3: the unanchored finding is rolled into the outside-the-diff
    // dropdown (recall-safety — never lost). The anchored finding posts inline.
    expect(submission.body).toContain("<summary><b>1 finding outside the diff</b></summary>")
  })

  it("still emits inline comments for the anchored findings (UX preserved)", () => {
    const anchored = { ...baseFinding, line: 42, headline: "anchored-here" }
    const unanchored: PrReviewFinding[] = [{ ...baseFinding, line: 999, headline: "drift" }]
    const submission = buildReviewSubmission({
      verdict: { ...baseVerdict, findings: [anchored] },
      prAuthor: null,
      headSha: "deadbeef",
      unanchored,
    })
    expect(submission.comments).toBeDefined()
    expect(submission.comments).toHaveLength(1)
    expect(submission.comments?.[0]?.line).toBe(42)
  })

  it("uses COMMENT when trivial style/docs nits only render in the review body", () => {
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, category: "style", score: 3, line: 999, headline: "nit-but-unanchored" },
    ]
    const submission = buildReviewSubmission({
      verdict: { ...baseVerdict, findings: [] },
      prAuthor: null,
      headSha: "deadbeef",
      unanchored,
    })
    expect(submission.event).toBe("COMMENT")
  })

  it("SIG-281 PR A: ESCALATES to REQUEST_CHANGES when a body-only finding is a blocker (score >= 4)", () => {
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, score: 5, line: 999, headline: "real-P0-but-unanchorable" },
    ]
    const submission = buildReviewSubmission({
      verdict: { ...baseVerdict, findings: [] },
      prAuthor: null,
      headSha: "deadbeef",
      unanchored,
    })
    expect(submission.event).toBe("REQUEST_CHANGES")
  })

  it("APPROVE when both anchored and unanchored are empty", () => {
    const submission = buildReviewSubmission({
      verdict: { ...baseVerdict, findings: [] },
      prAuthor: null,
      headSha: "deadbeef",
      unanchored: [],
    })
    expect(submission.event).toBe("APPROVE")
  })

  it("SIG-471 PR-3: common path (empty unanchored, anchorable finding) → marker-only body", () => {
    // With no unanchored findings and an anchorable finding, the finding posts as
    // an inline comment and the body is marker-only — no heading, no Fix Plan, no
    // body-only section.
    const submission = buildReviewSubmission({
      verdict: baseVerdict,
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.body).toBe("<!-- sigilix:pr-review -->\n")
    expect(submission.body).not.toContain("Review Body Findings")
    expect(submission.body).not.toMatch(/inline below/i)
  })
})

describe("validateForSubmission populates unanchoredFindings", () => {
  // Two reviewable lines on `src/lib/foo.ts` so the deriveSide() guard
  // is exercised — line 42 valid, line 999 not.
  const reviewable: ReviewableMap = new Map([["src/lib/foo.ts", [{ line: 42, side: "RIGHT" as const }]]])

  const specialistVerdicts = [
    {
      role: "logic" as const,
      verdict: {
        ...baseVerdict,
        findings: [{ ...baseFinding, id: "logic-0" }],
      },
      elapsedMs: 100,
    },
  ]

  it("pushes line-invalid (but non-hallucinated, score>=2) findings into unanchoredFindings", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 999, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.unanchoredFindings).toHaveLength(1)
    expect(out.unanchoredFindings[0]?.line).toBe(999)
  })

  it("INLINES a line-1 finding when line 1 IS a reviewable anchor (SIG-245: new-file line-1 is anchorable)", () => {
    // A genuine finding on the first line of a newly-added file (e.g. a
    // hardcoded secret — observed on the e2e repos) must INLINE, not body-dump.
    // line 1 is RIGHT-reviewable here, so inline-first applies.
    const reviewableLine1: ReviewableMap = new Map([["src/lib/foo.ts", [{ line: 1, side: "RIGHT" as const }]]])
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, findings: [{ ...baseFinding, line: 1, score: 5 }] },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable: reviewableLine1,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1) // inlined, not body-dumped
    expect(out.verdict.findings[0]?.line).toBe(1)
    expect(out.unanchoredFindings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(0)
  })

  it("body-routes a line-1 finding when line 1 is NOT reviewable (header on an unchanged file = outside-diff)", () => {
    // line 1 is absent from `reviewable` (only line 42) → genuinely outside this
    // PR's diff → body-route, preserving the SIG-141 header-over-fire suppression.
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, findings: [{ ...baseFinding, line: 1, score: 4 }] },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable, // only line 42 is reviewable
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.unanchoredFindings).toHaveLength(1)
    expect(out.unanchoredFindings[0]?.line).toBe(1)
    expect(out.droppedForInvalidLine).toBe(1)
  })

  it("does NOT push hallucinated findings into unanchoredFindings (still fully dropped)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 999, score: 4 }],
        },
        provenance: {
          // sourceFindingIds references a specialist finding that does
          // not exist — this should fail the hallucination guard, not
          // make it into unanchored.
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-nonexistent"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.droppedForHallucination).toBe(1)
    expect(out.unanchoredFindings).toHaveLength(0)
  })

  it("does NOT push score-1 findings into unanchoredFindings or default/chill summary", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          summary: "ok",
          findings: [{ ...baseFinding, line: 999, score: 1, headline: "tiny nit" }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.demotedScore1).toBe(1)
    expect(out.unanchoredFindings).toHaveLength(0)
    expect(out.verdict.summary).not.toContain("tiny nit")
    expect(out.provenance.dropped).toEqual([
      {
        specialist: "logic",
        sourceFindingId: "logic-0",
        headline: "tiny nit",
        reason: "score-1-advisory",
      },
    ])
  })

  it("returns empty unanchoredFindings on the happy-path (line valid)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, findings: [baseFinding] },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.unanchoredFindings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(0)
  })
})
