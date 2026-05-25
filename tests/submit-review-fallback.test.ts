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
import {
  buildFallbackBody,
  buildFallbackSubmission,
  buildReviewSubmission,
} from "../src/lib/triage-pr-review"
import { validateForSubmission } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewVerdict, PrReviewFinding } from "../src/lib/triage-pr-review"
import type { ReviewableMap } from "../src/lib/diff-positions"

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

  it("ARC-281: renders the new heading + summary; confidenceReason is intentionally dropped", () => {
    const body = buildFallbackBody(baseVerdict, [])
    // New status heading replaces "### Sigilix Summary".
    expect(body).toMatch(/^## Sigilix: \d+ finding/m)
    // Summary survives — Kimi keeps it as a flat paragraph under
    // the heading.
    expect(body).toContain("One real bug.")
    // confidenceReason is no longer rendered in the body per Kimi's
    // redesign (it routinely echoes the summary).
    expect(body).not.toContain("Clear off-by-one.")
    expect(body).not.toContain("### Sigilix Summary")
  })

  it("ARC-293: APPROVE path is MARKER-ONLY (no findings sections, no heading, no provenance)", () => {
    const body = buildFallbackBody(
      { ...baseVerdict, findings: [] },
      []
    )
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
    expect(body).toContain("### Review Body Findings")
    expect(body).toContain("GitHub only supports PR review comments on diff lines")
    expect(body).toContain("`src/a.ts:20`")
    expect(body).toContain("`src/m.ts:30`")
    expect(body).toContain("`src/z.ts:10`")
    expect(body).not.toContain("**src/a.ts**")
    expect(body).not.toContain("**src/m.ts**")
    expect(body).not.toContain("**src/z.ts**")
  })

  it("sorts findings within a file by score DESC then line ASC", () => {
    const findings: PrReviewFinding[] = [
      { ...baseFinding, line: 100, score: 2, headline: "low-score-late" },
      { ...baseFinding, line: 50, score: 5, headline: "high-score-early" },
      { ...baseFinding, line: 10, score: 5, headline: "high-score-earlier" },
    ]
    const body = buildFallbackBody({ ...baseVerdict, findings }, [])
    const earlierIdx = body.indexOf("high-score-earlier")
    const earlyIdx = body.indexOf("high-score-early")
    const lateIdx = body.indexOf("low-score-late")
    // Score 5 (line 10) comes before score 5 (line 50) which comes before score 2.
    expect(earlierIdx).toBeLessThan(earlyIdx)
    expect(earlyIdx).toBeLessThan(lateIdx)
  })

  it("MERGES anchored verdict.findings with unanchored findings", () => {
    const anchored = { ...baseFinding, line: 10, headline: "anchored-finding" }
    const unanchored: PrReviewFinding = {
      ...baseFinding,
      line: 999,
      headline: "unanchored-finding",
    }
    const body = buildFallbackBody(
      { ...baseVerdict, findings: [anchored] },
      [unanchored]
    )
    expect(body).toContain("anchored-finding")
    expect(body).toContain("unanchored-finding")
    // ARC-281 + SIG-5: the anchorless-fallback path now pours everything
    // into the body-only findings section (since none of the findings
    // landed as inline comments). Heading count is in the top-of-body
    // status heading, not on the section.
    expect(body).toContain("### Review Body Findings")
    expect(body).toMatch(/^## Sigilix: 2 findings/m)
    expect(body).not.toContain("### Findings (2)")
  })

  it("renders a multi-line range when startLine differs from line", () => {
    const ranged: PrReviewFinding = {
      ...baseFinding,
      startLine: 40,
      line: 50,
    }
    const body = buildFallbackBody({ ...baseVerdict, findings: [ranged] }, [])
    expect(body).toContain("Lines 40-50 (high, score 4)")
    expect(body).not.toContain("Line 50 (")
  })

  it("renders single-line target when startLine is omitted", () => {
    const single: PrReviewFinding = { ...baseFinding, line: 50 }
    const body = buildFallbackBody({ ...baseVerdict, findings: [single] }, [])
    expect(body).toContain("Line 50 (high, score 4)")
    expect(body).not.toContain("Lines ")
  })

  it("includes category metadata next to the body-only anchor", () => {
    const body = buildFallbackBody(baseVerdict, [])
    expect(body).toContain("**off-by-one in `clampIndex`**")
    expect(body).toContain("`logic` · `src/lib/foo.ts:42`")
  })

  it("indents the finding body so it nests under its bullet visually", () => {
    const body = buildFallbackBody(
      {
        ...baseVerdict,
        findings: [{ ...baseFinding, body: "first line\nsecond line" }],
      },
      []
    )
    expect(body).toContain("  first line")
    expect(body).toContain("  second line")
  })

  it("ARC-281: confidenceReason is never rendered in the body, even when populated", () => {
    // Pre-ARC-281 the renderer emitted `verdict.confidenceReason`
    // as a second paragraph; Kimi's redesign drops it (it
    // routinely echoes the summary). Whether the field is empty or
    // populated, the body must not contain it.
    const populated = buildFallbackBody(baseVerdict, [])
    expect(populated).not.toContain("Clear off-by-one.")
    const blank = buildFallbackBody({ ...baseVerdict, confidenceReason: "" }, [])
    // Summary still renders; layout flows directly into the
    // body-only findings section per Kimi's spec.
    expect(blank).toContain("One real bug.")
    expect(blank).toContain("### Review Body Findings")
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

  it("preserves event from chooseReviewEvent (REQUEST_CHANGES with findings)", () => {
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

  // CR + Sigilix PR #38 catch: event derivation merges anchored AND
  // unanchored — otherwise a verdict whose only blocking findings are
  // unanchored posts as APPROVE while the body lists blockers.
  it("returns REQUEST_CHANGES when only unanchored findings exist (anchored empty)", () => {
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, line: 999, headline: "drift-flagged-but-line-out-of-diff" },
    ]
    const submission = buildFallbackSubmission({
      verdict: { ...baseVerdict, findings: [] },
      unanchored,
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.event).toBe("REQUEST_CHANGES")
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
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, line: 999, headline: "unanchored-must-not-be-lost" },
    ]
    const submission = buildReviewSubmission({
      verdict: { ...baseVerdict, findings: [anchored] },
      prAuthor: null,
      headSha: "deadbeef",
      unanchored,
    })
    expect(submission.body).toContain("unanchored-must-not-be-lost")
    expect(submission.body).toContain("Review Body Findings")
  })

  it("still emits inline comments for the anchored findings (UX preserved)", () => {
    const anchored = { ...baseFinding, line: 42, headline: "anchored-here" }
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, line: 999, headline: "drift" },
    ]
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

  it("derives event from anchored + unanchored merged set (no APPROVE-with-blockers)", () => {
    // Anchored empty + only-unanchored blocking findings → MUST be REQUEST_CHANGES.
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, line: 999, headline: "blocking-but-unanchored" },
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

  it("ARC-281: common path (empty unanchored) renders heading + summary + Fix Plan, no body-only findings section", () => {
    // With no unanchored findings, the body skips the
    // body-only findings section entirely. The inline-count
    // pointer ("_N findings inline below._") was removed in
    // ARC-281 — the heading already states the count.
    const submission = buildReviewSubmission({
      verdict: baseVerdict,
      prAuthor: null,
      headSha: "deadbeef",
    })
    expect(submission.body).not.toContain("Review Body Findings")
    expect(submission.body).not.toMatch(/inline below/i)
    expect(submission.body).toMatch(/^## Sigilix: 1 finding/m)
  })
})

describe("validateForSubmission populates unanchoredFindings", () => {
  // Two reviewable lines on `src/lib/foo.ts` so the deriveSide() guard
  // is exercised — line 42 valid, line 999 not.
  const reviewable: ReviewableMap = new Map([
    [
      "src/lib/foo.ts",
      [{ line: 42, side: "RIGHT" as const }],
    ],
  ])

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
