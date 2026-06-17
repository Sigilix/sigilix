import { describe, expect, it } from "vitest"
import {
  buildFallbackSubmission,
  buildReviewSubmission,
  buildReviewSubmissionWithMetadata,
  previewFallbackSubmissionEvent,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import { baseFinding } from "@/src/lib/triage-pr-review.test-helpers"

describe("buildReviewSubmission — SIG-222 testing findings are non-blocking and inline-only", () => {
  const testingFinding: PrReviewFinding = {
    path: "src/lib/new-source.ts",
    line: 7,
    scope: "line",
    score: 5,
    category: "testing",
    headline: "new module has no sibling test",
    body: "Add a sibling test for the new exported behavior.",
    evidenceRefs: ["siblingMapping:src/lib/new-source.ts->NONE"],
  }
  const reviewable: ReviewableMap = new Map([["src/lib/new-source.ts", [{ line: 7, side: "RIGHT" }]]])
  const addedLineTextByLine = new Map<string, Map<number, string>>([
    ["src/lib/new-source.ts", new Map([[7, "export function newSource() { return run() }"]])],
  ])

  it("keeps an anchorable missing-test finding inline, clamps it to P3, and posts COMMENT", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "Testing gap.",
        confidence: 5,
        confidenceReason: "Concrete.",
        findings: [testingFinding],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })

    expect(out.submission.event).toBe("COMMENT")
    expect(out.submission.comments).toHaveLength(1)
    expect(out.submission.comments?.[0]?.line).toBe(7)
    expect(out.submission.comments?.[0]?.body).toContain("new module has no sibling test")
    expect(out.submission.comments?.[0]?.body).toContain("<!-- sigilix:severity:2 -->")
  })

  it("preserves explicit removed-test coverage severity while still posting COMMENT", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "Removed coverage.",
        confidence: 5,
        confidenceReason: "Concrete.",
        findings: [
          {
            ...testingFinding,
            score: 4,
            headline: "test coverage was removed",
            evidenceRefs: ["testFileChanged:tests/new-source.test.ts"],
          },
        ],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })

    expect(out.submission.event).toBe("COMMENT")
    expect(out.submission.comments).toHaveLength(1)
    expect(out.submission.comments?.[0]?.body).toContain("<!-- sigilix:severity:4 -->")
  })

  it("drops a testing finding instead of body-routing it when no substantive anchor exists", () => {
    const nonSubstantiveLines = new Map<string, Map<number, string>>([["src/lib/new-source.ts", new Map([[7, "}"]])]])
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "No anchor.",
        confidence: 5,
        confidenceReason: "Concrete.",
        findings: [testingFinding],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine: nonSubstantiveLines,
    })

    expect(out.submission.event).toBe("APPROVE")
    expect(out.submission.comments ?? []).toHaveLength(0)
    expect(out.bodyOnlyFindings).toEqual([])
    expect(out.submission.body).not.toContain("new module has no sibling test")
  })

  it("body-routes explicit removed-test coverage even when no substantive source anchor exists", () => {
    const nonSubstantiveLines = new Map<string, Map<number, string>>([["src/lib/new-source.ts", new Map([[7, "}"]])]])
    const removedCoverage = {
      ...testingFinding,
      score: 4,
      headline: "test coverage was removed",
      body: "The PR removes coverage for the exported behavior.",
      evidenceRefs: ["testFileChanged:tests/new-source.test.ts"],
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "Removed coverage.",
        confidence: 5,
        confidenceReason: "Concrete.",
        findings: [removedCoverage],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine: nonSubstantiveLines,
    })

    expect(out.submission.event).toBe("COMMENT")
    expect(out.submission.comments ?? []).toHaveLength(0)
    expect(out.bodyOnlyFindings).toEqual([expect.objectContaining(removedCoverage)])
    expect(out.submission.body).toContain("test coverage was removed")
  })

  it("body-routes non-missing-sibling testing evidence when no substantive anchor exists", () => {
    const nonSubstantiveLines = new Map<string, Map<number, string>>([["src/lib/new-source.ts", new Map([[7, "}"]])]])
    const coverageGapFinding = {
      ...testingFinding,
      headline: "branch coverage regressed",
      body: "The uncovered branch needs a focused test.",
      evidenceRefs: ["coverageGap:src/lib/new-source.ts:7"],
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "Coverage gap.",
        confidence: 5,
        confidenceReason: "Concrete.",
        findings: [coverageGapFinding],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine: nonSubstantiveLines,
    })

    expect(out.submission.event).toBe("COMMENT")
    expect(out.submission.comments ?? []).toHaveLength(0)
    expect(out.bodyOnlyFindings).toEqual([expect.objectContaining({ ...coverageGapFinding, score: 2 })])
    expect(out.submission.body).toContain("branch coverage regressed")
  })

  it("drops missing-sibling testing findings from anchorless fallback routing", () => {
    const verdict: PrReviewVerdict = {
      summary: "Fallback should not body-route missing tests.",
      confidence: 5,
      confidenceReason: "Concrete.",
      findings: [testingFinding],
    }

    expect(previewFallbackSubmissionEvent({ verdict, unanchored: [] })).toBe("APPROVE")

    const fallback = buildFallbackSubmission({
      verdict,
      unanchored: [],
      prAuthor: null,
      headSha: "abc",
    })
    expect(fallback.event).toBe("APPROVE")
    expect(fallback.body).not.toContain("new module has no sibling test")
  })

  it("keeps removed-test coverage in anchorless fallback routing", () => {
    const removedCoverage = {
      ...testingFinding,
      score: 4,
      headline: "test coverage was removed",
      body: "The PR removes coverage for the exported behavior.",
      evidenceRefs: ["testFileChanged:tests/new-source.test.ts"],
    }
    const verdict: PrReviewVerdict = {
      summary: "Fallback should keep removed coverage.",
      confidence: 5,
      confidenceReason: "Concrete.",
      findings: [removedCoverage],
    }

    expect(previewFallbackSubmissionEvent({ verdict, unanchored: [] })).toBe("COMMENT")

    const fallback = buildFallbackSubmission({
      verdict,
      unanchored: [],
      prAuthor: null,
      headSha: "abc",
    })
    expect(fallback.event).toBe("COMMENT")
    expect(fallback.body).toContain("test coverage was removed")
    expect(fallback.body).toContain("score 4")
  })
})

describe("buildReviewSubmission — SIG-411: low-confidence findings keep their inline thread (confidence-tier demotion removed)", () => {
  const path = "src/lib/specialist-mcp-tools.ts"
  const reviewable: ReviewableMap = new Map([[path, [{ line: 236, side: "RIGHT" }]]])
  const addedLineTextByLine = new Map<string, Map<number, string>>([
    [path, new Map([[236, "const [a, b, c] = parts"]])],
  ])

  // score 2 (< 4), no committable fix — the now-removed SIG-281 confidence-tier
  // gate WOULD have demoted this to the body. SIG-411: it keeps its inline thread.
  const lowSevFinding = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    path,
    line: 236,
    scope: "line",
    score: 2,
    category: "logic",
    headline: "isBlockedIpv4Parts ignores the 4th octet",
    body: "The helper destructures [a, b, c] from a 4-element tuple and never binds d, so the last octet is dropped.",
    trust: { tier: "grounded-model" },
    ...overrides,
  })
  const verdictFor = (f: PrReviewFinding, confidence: number): PrReviewVerdict => ({
    summary: "Octet dropped.",
    confidence,
    confidenceReason: "Low-confidence note.",
    findings: [f],
  })

  it("keeps a confidence<=2 no-fix low-severity finding inline (was demoted pre-SIG-411)", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: verdictFor(lowSevFinding(), 1),
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })

    expect(out.submission.comments ?? []).toHaveLength(1)
    expect(out.submission.comments?.[0]?.line).toBe(236)
    expect(out.bodyOnlyFindings).toEqual([])
  })

  it("keeps a confidence===3 no-fix/no-repro low-severity finding inline (the other removed arm)", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: verdictFor(lowSevFinding(), 3),
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })

    expect(out.submission.comments ?? []).toHaveLength(1)
    expect(out.bodyOnlyFindings).toEqual([])
  })

  it("keeps even an ungrounded low-confidence finding inline — grounding no longer gates this surface", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: verdictFor(lowSevFinding({ trust: { tier: "body-only-ungrounded" } }), 1),
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })

    expect(out.submission.comments ?? []).toHaveLength(1)
    expect(out.bodyOnlyFindings).toEqual([])
  })
})

describe("buildReviewSubmission — SIG-202 non-line scope routing", () => {
  const commentFinding: PrReviewFinding = {
    path: "src/lib/github-mention.ts",
    line: 436,
    scope: "comment",
    score: 4,
    category: "security",
    headline: "dismiss command trusts the issue-comment author",
    body: "The `/sigilix dismiss` path authorizes from the issue-comment sender instead of the review-thread participant. Check the parent review comment before accepting the dismissal.",
  }

  const addedLineTextByLine = new Map<string, Map<number, string>>([
    ["src/lib/github-mention.ts", new Map<number, string>([[436, "expirationTtl: MENTION_DEDUPE_TTL,"]])],
  ])

  it("routes comment-scoped findings to the review body even when the nearest changed line is substantive", () => {
    const out = buildReviewSubmission({
      verdict: {
        summary: "Comment-surface auth issue.",
        confidence: 2,
        confidenceReason: "High impact.",
        findings: [commentFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    // SIG-281 PR A: comment-scoped score-4 (P1) blocker → REQUEST_CHANGES
    // (request_changes posture, so the lead reads "high-severity finding",
    // not "non-blocking"), but still body-routed (no inline thread).
    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toMatch(/high-severity finding/)
    expect(out.body).not.toMatch(/non-blocking/)
    // SIG-440: a body-only BLOCKER (score >= 4) is a Fix Plan list entry and
    // its detail appears in the single non-inline dropdown.
    expect(out.body).toContain(
      "- **High (4)** · `src/lib/github-mention.ts:436` · `security` — dismiss command trusts the issue-comment author",
    )
    expect(out.body).toContain("couldn't be anchored to a line")
    expect(out.body).not.toContain("### Review Body Findings")
    // Kimi prominence: the location leads the row in BOLD; the score
    // collapses into a trailing <sub>. (Was the `<anchor> · score N`
    // meta line; the bracketed "Comment-level (high, score 4)" prefix
    // stays gone — the P1 badge conveys severity.)
    expect(out.body).toContain("**`src/lib/github-mention.ts:436`**:")
    expect(out.body).toContain("score 4")
    expect(out.body).not.toContain("Comment-level")
    expect(out.body).toContain("dismiss command trusts the issue-comment author")
  })

  it("routes file-scoped findings to the review body with a file-level label", () => {
    const fileFinding: PrReviewFinding = {
      ...commentFinding,
      scope: "file",
      score: 5,
      headline: "module-level lifecycle ordering is unsafe",
      body: "The issue spans the module's event flow rather than one changed statement, so it should not be forced into an inline thread.",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "File-level routing issue.",
        confidence: 2,
        confidenceReason: "High impact.",
        findings: [fileFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    // SIG-281 PR A: file-scoped score-5 (P0) blocker → REQUEST_CHANGES
    // (request_changes posture → "high-severity finding", not "non-blocking"),
    // still body-routed (no inline thread).
    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toMatch(/high-severity finding/)
    expect(out.body).not.toMatch(/non-blocking/)
    // SIG-440: file-scoped score-5 blocker → Fix Plan list entry +
    // single non-inline dropdown, not the "Review Body Findings"
    // section. Per Kimi Q3 the list location for a file-level
    // finding is the bare path (no `:line`).
    expect(out.body).toContain(
      "- **Critical (5)** · `src/lib/github-mention.ts` · `security` — module-level lifecycle ordering is unsafe",
    )
    expect(out.body).toContain("couldn't be anchored to a line")
    expect(out.body).not.toContain("### Review Body Findings")
    // SIG-216: file-scope anchor is the bare path (no `:line`) and
    // the meta line is just `<anchor> · score N` — no "File-level
    // (critical, ...)" bracketed prefix. Asserting on the legacy
    // `(critical, score 5)` parenthetical specifically (the verdict
    // summary still contains the word "File-level" for unrelated
    // reasons).
    expect(out.body).toContain("**`src/lib/github-mention.ts`**:")
    expect(out.body).toContain("score 5")
    expect(out.body).not.toContain("(critical, score 5)")
    expect(out.body).toContain("module-level lifecycle ordering is unsafe")
  })

  it("keeps suggestion-bearing non-line findings inline so the proposed fix is not dropped", () => {
    const fixFinding: PrReviewFinding = {
      ...commentFinding,
      scope: "file",
      category: "logic",
      headline: "ttl constant should stay localized",
      body: "This broad file-level finding still carries a localized replacement, so preserve the inline suggestion surface.",
      suggestedReplacement: "expirationTtl: REVIEW_THREAD_DEDUPE_TTL,",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "File-scoped finding with a localized fix.",
        confidence: 4,
        confidenceReason: "Specific replacement supplied.",
        findings: [fixFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(436)
    expect(out.comments?.[0]?.body).toContain("ttl constant should stay localized")
    expect(out.comments?.[0]?.body).toContain("REVIEW_THREAD_DEDUPE_TTL")
    expect(out.body).toContain("- **High (4)** ·")
    expect(out.body).toContain(
      "- **High (4)** · `src/lib/github-mention.ts:436` · `logic` — ttl constant should stay localized",
    )
    expect(out.body).not.toContain("### Review Body Findings")
  })

  it("keeps delete-intent non-line findings inline so the deletion suggestion is not dropped", () => {
    const deleteFinding: PrReviewFinding = {
      ...commentFinding,
      scope: "file",
      category: "logic",
      headline: "ttl constant should be removed",
      body: "This broad file-level finding carries an empty deletion replacement, so preserve the inline suggestion surface.",
      kind: "delete",
      suggestedReplacement: "",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "File-scoped finding with a localized deletion.",
        confidence: 4,
        confidenceReason: "Specific deletion supplied.",
        findings: [deleteFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(436)
    expect(out.comments?.[0]?.body).toContain("ttl constant should be removed")
    expect(out.comments?.[0]?.body).toContain("expirationTtl: MENTION_DEDUPE_TTL,")
    expect(out.body).toContain("- **High (4)** ·")
    expect(out.body).toContain(
      "- **High (4)** · `src/lib/github-mention.ts:436` · `logic` — ttl constant should be removed",
    )
    expect(out.body).not.toContain("### Review Body Findings")
  })

  it("SIG-281 PR B (Rec 6): surfaces body-only high findings IN the Fix Plan (inline + body-only blockers both listed)", () => {
    const inlineFinding: PrReviewFinding = {
      path: "src/lib/github-mention.ts",
      line: 436,
      score: 4,
      category: "logic",
      headline: "ttl is too short",
      body: "Use the configured TTL.",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "One inline and one body-only finding.",
        confidence: 2,
        confidenceReason: "Mixed.",
        findings: [inlineFinding, commentFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.comments).toHaveLength(1)
    expect(out.body).toContain("- **High (4)** ·")
    // Inline blocker → Fix Plan entry (unchanged).
    expect(out.body).toContain("- **High (4)** · `src/lib/github-mention.ts:436` · `logic` — ttl is too short")
    // SIG-281 PR B (Rec 6): the body-only blocker now ALSO appears as a
    // Fix Plan entry — surfacing it is the whole point. Previously it was
    // suppressed from the table, leaving a real blocker buried below.
    expect(out.body).toContain(
      "- **High (4)** · `src/lib/github-mention.ts:436` · `security` — dismiss command trusts the issue-comment author",
    )
    // ...and its full evidence lives in the single non-inline dropdown,
    // with the tightened `<anchor> · score N` meta (no "Comment-level" prefix).
    expect(out.body).toContain("couldn't be anchored to a line")
    expect(out.body).toContain("**`src/lib/github-mention.ts:436`**:")
    expect(out.body).toContain("score 4")
    expect(out.body).not.toContain("Comment-level")
  })
})

// ── SIG-281 PR B — routing discipline (Recs 2/3/5) + Rec 6 prominence ──
//
// Recs 2/5 (unified per Codex backend sign-off): a sub-4 line finding is
// demoted to the body when it is weakly grounded — confidence <= 2 with no
// committable fix, OR confidence === 3 with neither a fix nor a repro. A
// score >= 4 finding is NEVER demoted (the believability floor), and a
// confidence >= 4 sub-4 finding stays inline (guards against a blanket
// "demote all sub-4" rule). Rec 3 caps inline comments at 15, demoting the
// lowest-priority overflow to the body (never dropped) while preserving the
// SIG-247 marker invariant. Rec 6 (Kimi K2.6 layout) surfaces body-only
// blockers in the Fix Plan list + a collapsed evidence block.

describe("buildReviewSubmission — SIG-281 PR B routing discipline (Recs 2/3/5)", () => {
  const lf = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    ...baseFinding, // score 3, line-scoped, src/lib/foo.ts:42
    ...overrides,
  })
  const mkVerdict = (findings: PrReviewFinding[], confidence = 4): PrReviewVerdict => ({
    summary: "fixture",
    confidence,
    confidenceReason: "fixture",
    findings,
  })
  const submit = (findings: PrReviewFinding[], confidence = 4) =>
    buildReviewSubmission({
      verdict: mkVerdict(findings, confidence),
      prAuthor: "a",
      headSha: "abc",
    })

  // SIG-411: the Rec 5 confidence-tier body demotion was REMOVED — a sub-4
  // low-confidence finding now keeps its inline thread (see the dedicated
  // "SIG-411" describe block above for the kept-inline cases).

  it("Rec 5: KEEPS a sub-4 confidence-3 finding inline when it carries a repro (failureExample)", () => {
    const out = submit([lf({ score: 3, confidence: 3, failureExample: "throws when user is null" })])
    expect(out.comments).toHaveLength(1)
  })

  it("Rec 5: KEEPS a low-confidence finding inline when it carries a committable fix", () => {
    const out = submit([lf({ score: 3, confidence: 1, suggestedReplacement: "const x = a ?? b" })])
    expect(out.comments).toHaveLength(1)
  })

  it("SIG-103: strips an identical (no-op) replacement; the finding stays inline without a bogus suggestion block (SIG-411)", () => {
    const reviewable: ReviewableMap = new Map([["src/lib/foo.ts", [{ line: 42, side: "RIGHT" }]]])
    const addedLineTextByLine = new Map([["src/lib/foo.ts", new Map([[42, "const x = a ?? b"]])]])
    const out = buildReviewSubmissionWithMetadata({
      verdict: mkVerdict([lf({ score: 3, confidence: 1, suggestedReplacement: "const x = a ?? b" })]),
      prAuthor: "a",
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })

    // The no-op fix is stripped (no committable suggestion emitted), but SIG-411
    // keeps the weak finding inline rather than demoting it to the body.
    expect(out.submission.comments ?? []).toHaveLength(1)
    expect(out.submission.comments?.[0]?.body).not.toContain("```suggestion")
    expect(out.suggestionEmissions).toHaveLength(0)
  })

  it("Rec 5: KEEPS a sub-4 finding inline at confidence >= 4 (guards against a blanket Rec 2)", () => {
    const out = submit([lf({ score: 3, confidence: 4 })])
    expect(out.comments).toHaveLength(1)
  })

  it("believability floor: NEVER demotes a score >= 4 finding, even at confidence 1 with no fix", () => {
    const out = submit([lf({ score: 4, confidence: 1 })])
    expect(out.comments).toHaveLength(1)
  })

  it("SIG-127: a low-confidence finding moves to the substantive anchor and stays inline there (SIG-411)", () => {
    // The model says line 5; the only added line is 9. SIG-127 moves the anchor
    // forward to 9. Pre-SIG-411 the confidence gate then demoted it to the body;
    // now it keeps its inline thread at the moved line.
    const added = new Map<string, Map<number, string>>([
      ["src/lib/foo.ts", new Map<number, string>([[9, "const y = compute()"]])],
    ])
    const out = buildReviewSubmission({
      verdict: mkVerdict([lf({ score: 3, confidence: 2, line: 5 })]),
      prAuthor: "a",
      headSha: "abc",
      addedLineTextByLine: added,
    })
    expect(out.comments ?? []).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(9)
  })

  it("Rec 3 (SIG-392): does NOT cap a dense PR inline — every real finding keeps its thread", () => {
    // 18 gate-survived findings — all stay inline now (cap raised to a 50
    // pathological backstop; precision is gate-controlled, so surfacing real
    // findings inline is right). None demoted to the body.
    const findings = Array.from({ length: 18 }, (_, i) => lf({ score: 5, line: 100 + i, headline: `f-${i}` }))
    const out = buildReviewSubmissionWithMetadata({
      verdict: mkVerdict(findings),
      prAuthor: "a",
      headSha: "abc",
    })
    expect(out.submission.comments).toHaveLength(18)
    expect(out.bodyOnlyFindings).toHaveLength(0)
  })

  it("Rec 3 (SIG-392): the pathological backstop still demotes overflow above 50 to the body (never dropped)", () => {
    const findings = Array.from({ length: 52 }, (_, i) => lf({ score: 5, line: 100 + i, headline: `cap-${i}` }))
    const out = buildReviewSubmissionWithMetadata({
      verdict: mkVerdict(findings),
      prAuthor: "a",
      headSha: "abc",
    })
    expect(out.submission.comments).toHaveLength(50)
    expect(out.bodyOnlyFindings).toHaveLength(2) // 52 - 50, never dropped
    expect(out.submission.body).toContain("inline comment cap exceeded; shown here")
  })

  it("Rec 3: at the backstop, prioritizes higher-severity findings to keep inline; the lowest-severity blocker overflows", () => {
    const high = Array.from({ length: 50 }, (_, i) => lf({ score: 5, line: 100 + i, headline: `high-${i}` }))
    const low = lf({ score: 4, line: 999, headline: "low-priority blocker" })
    const out = buildReviewSubmissionWithMetadata({
      verdict: mkVerdict([low, ...high]),
      prAuthor: "a",
      headSha: "abc",
    })
    expect(out.submission.comments).toHaveLength(50)
    expect(out.bodyOnlyFindings.map((f) => f.headline)).toContain("low-priority blocker")
  })

  it("Rec 3: under the backstop, inlineOriginalIndex stays aligned so each kept comment carries ITS SIG-247 marker", () => {
    const findings = Array.from({ length: 51 }, (_, i) => lf({ score: 5, line: 100 + i, headline: `cap-${i}` }))
    const markers = findings.map(
      (_, i) =>
        `<!-- sigilix:fid:${String(i).padStart(16, "0")}:cat:logic:sev:error:path:${String(i).padStart(12, "0")} -->`,
    )
    const out = buildReviewSubmission({
      verdict: mkVerdict(findings),
      prAuthor: "a",
      headSha: "abc",
      findingMarkers: markers,
    })
    expect(out.comments).toHaveLength(50)
    for (const c of out.comments ?? []) {
      const idx = Number(/cap-(\d+)/.exec(c.body)?.[1])
      expect(c.body).toContain(markers[idx])
    }
  })

  it("believability floor: a score >= 4 finding demoted to the body by the cap still REQUEST_CHANGES", () => {
    // 52 blockers — 2 overflow the 50 backstop to the body, but inlineFindings
    // is still non-empty so the gate blocks; even an all-overflow case would
    // block via the body-only score>=4 floor (covered in PR A).
    const findings = Array.from({ length: 52 }, (_, i) => lf({ score: 5, line: 100 + i, headline: `cap-${i}` }))
    const out = submit(findings)
    expect(out.event).toBe("REQUEST_CHANGES")
  })
})

describe("renderFindingsReviewBody — SIG-281 PR B Rec 6 Fix-Plan prominence (Kimi K2.6)", () => {
  const lf = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    ...baseFinding,
    ...overrides,
  })
  const mkVerdict = (findings: PrReviewFinding[]): PrReviewVerdict => ({
    summary: "fixture",
    confidence: 4,
    confidenceReason: "fixture",
    findings,
  })
  const submit = (findings: PrReviewFinding[]) =>
    buildReviewSubmission({ verdict: mkVerdict(findings), prAuthor: "a", headSha: "abc" })

  it("a body-only blocker renders in the Fix Plan list + single dropdown detail, NOT Review Body Findings", () => {
    const out = submit([lf({ scope: "file", score: 5, headline: "file blocker" })])
    expect(out.body).toContain("- **Critical (5)** · `src/lib/foo.ts` · `logic` — file blocker")
    expect(out.body).toContain("couldn't be anchored to a line")
    expect(out.body).toContain("file blocker")
    expect(out.body).not.toContain("### Review Body Findings")
  })

  it("a body-only NON-blocker (score < 4) stays visible in the single non-inline dropdown", () => {
    const out = submit([lf({ scope: "file", score: 3, headline: "file nit" })])
    expect(out.body).not.toContain("### Review Body Findings")
    expect(out.body).toContain("couldn't be anchored to a line")
    expect(out.body).toContain("file nit")
    expect(out.body).not.toContain("Evidence &amp; suggested changes for body-only blockers")
  })

  it("Kimi Q3: a file-level blocker's Fix Plan location is the bare path (no `:line`)", () => {
    const out = submit([lf({ scope: "file", score: 5, path: "src/lib/foo.ts", line: 42, headline: "x" })])
    expect(out.body).toMatch(/- \*\*Critical \(5\)\*\* · `src\/lib\/foo\.ts` · `logic` — x/)
    expect(out.body).not.toContain("`src/lib/foo.ts:42`")
  })

  it("the Fix Plan caption appears only when the list contains body-only (non-inline) blockers", () => {
    const withBodyOnlyBlocker = submit([lf({ scope: "file", score: 5 })])
    expect(withBodyOnlyBlocker.body).toContain("Entries without a line number are file-level or PR-level")
    const inlineOnly = submit([lf({ score: 5, line: 42 })])
    expect(inlineOnly.body).toContain(
      "- **Critical (5)** · `src/lib/foo.ts:42` · `logic` — missing null guard on `user.profile`",
    )
    expect(inlineOnly.body).not.toContain("Entries without a line number are file-level or PR-level")
  })

  it("mixed: inline blocker + body-only blocker + body-only nit land in their three distinct surfaces", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: mkVerdict([
        lf({ score: 5, line: 42, headline: "inline blocker" }),
        lf({ scope: "pr", score: 4, headline: "body-only blocker" }),
        lf({ scope: "file", score: 2, headline: "body-only nit" }),
      ]),
      prAuthor: "a",
      headSha: "abc",
    })
    const body = out.submission.body
    expect(out.submission.comments).toHaveLength(1) // inline blocker
    expect(body).toContain("inline blocker") // Fix Plan row
    expect(body).toContain("body-only blocker") // Fix Plan row + dropdown detail
    expect(body).toContain("couldn't be anchored to a line")
    expect(body).not.toContain("### Review Body Findings")
    expect(body).toContain("couldn't be anchored to a line")
    expect(body).toContain("body-only nit")
  })
})

// ── SIG-216 — clickable file:line anchor + tightened meta line ───────

describe("renderBodyOnlyFindings (SIG-216 link + meta)", () => {
  // Use the same fixture shape as SIG-202: a body-only finding routed
  // through `buildReviewSubmission`. The renderer is private, so we
  // exercise it through the public path and assert on the rendered body.
  const headSha = "deadbeefcafe1234567890abcdef1234567890ab"
  const linkContext = { owner: "octo", repo: "demo", headSha } as const

  const lineFinding: PrReviewFinding = {
    path: "src/lib/foo.ts",
    line: 42,
    scope: "comment", // routes to body-only without needing an addedLineTextByLine miss
    // SIG-281 PR B (Rec 6): score 3 keeps this in the "Review Body
    // Findings" section so these body-only link/meta assertions aren't
    // confounded by a Fix Plan list entry (score>=4 body-only blockers now
    // also render in the list, which uses the compact `path:line` form).
    // The body-only renderer is severity-independent, so coverage is
    // unchanged.
    score: 3,
    category: "logic",
    headline: "missing null guard",
    body: "Wrap with a guard before deref.",
  }
  const rangedLineFinding: PrReviewFinding = {
    ...lineFinding,
    startLine: 38,
    line: 42,
    headline: "missing null guard across the range",
  }
  const fileFinding: PrReviewFinding = {
    ...lineFinding,
    scope: "file",
    score: 5,
    headline: "module invariant unclear",
  }
  const prFinding: PrReviewFinding = {
    ...lineFinding,
    scope: "pr",
    score: 3,
    headline: "PR-wide policy gap",
  }

  const buildBody = (f: PrReviewFinding, ctx?: { owner: string; repo: string; headSha: string }): string => {
    const args = {
      verdict: {
        summary: "One body-only finding.",
        confidence: 3,
        confidenceReason: "Fixture.",
        findings: [f],
      },
      prAuthor: "alice",
      headSha,
      ...(ctx ? { linkContext: ctx } : {}),
    }
    return buildReviewSubmission(args).body!
  }

  it("emits a clickable [path:line](github-blob-url) link when linkContext is threaded (line scope)", () => {
    const body = buildBody(lineFinding, linkContext)
    expect(body).toContain(`[src/lib/foo.ts:42](https://github.com/octo/demo/blob/${headSha}/src/lib/foo.ts#L42)`)
    // No backticked fallback for the anchor itself when linkContext is present.
    expect(body).not.toContain("`src/lib/foo.ts:42`")
  })

  it("uses #L<startLine>-L<line> for ranged line-scope anchors", () => {
    const body = buildBody(rangedLineFinding, linkContext)
    expect(body).toContain(
      `[src/lib/foo.ts:38-42](https://github.com/octo/demo/blob/${headSha}/src/lib/foo.ts#L38-L42)`,
    )
  })

  it("renders file-scope as a bare-path link (no `:line`, no `#L`)", () => {
    const body = buildBody(fileFinding, linkContext)
    expect(body).toContain(`[src/lib/foo.ts](https://github.com/octo/demo/blob/${headSha}/src/lib/foo.ts)`)
    expect(body).not.toContain(`/src/lib/foo.ts#L`)
  })

  it("renders pr-scope as a bare-path link (same as file scope)", () => {
    const body = buildBody(prFinding, linkContext)
    expect(body).toContain(`[src/lib/foo.ts](https://github.com/octo/demo/blob/${headSha}/src/lib/foo.ts)`)
    expect(body).not.toContain(`/src/lib/foo.ts#L`)
  })

  it("falls back to the inline-code anchor when linkContext is omitted (back-compat)", () => {
    const body = buildBody(lineFinding)
    expect(body).toContain("`src/lib/foo.ts:42`")
    // No markdown link form should leak through.
    expect(body).not.toContain("](https://github.com/")
  })

  it("leads with the bold location + trails score in <sub>, no bracketed severity (line scope)", () => {
    const body = buildBody(lineFinding)
    expect(body).toContain("**`src/lib/foo.ts:42`**:")
    expect(body).toContain("score 3")
    expect(body).not.toContain("(medium, score 3)")
    expect(body).not.toContain("Line 42")
    expect(body).not.toContain("Comment-level")
  })

  it("leads with the bold path for pr-scope (no `:line`)", () => {
    const body = buildBody(prFinding)
    expect(body).toContain("**`src/lib/foo.ts`**:")
    expect(body).toContain("score 3")
    // SIG-281 PR B: the body-only explanation copy now legitimately
    // contains the phrase "PR-level scope", so guard against the OLD
    // per-finding "PR-level (severity, score N)" location LABEL format
    // specifically, not the bare substring.
    expect(body).not.toContain("PR-level (")
  })

  it("renders the row as `**<location>**: **<headline>** … <sub>score N</sub>` (Kimi prominence)", () => {
    const body = buildBody(lineFinding)
    // bold location LEADS the row, immediately followed by the bold headline,
    // and the score collapses into a trailing <sub>.
    expect(body).toMatch(/\*\*`src\/lib\/foo\.ts:42`\*\*: \*\*/)
    expect(body).toContain("<sub>score 3")
    // Guard against accidental bullet/asterisk separators in the score meta.
    expect(body).not.toContain(" • score") // • bullet
    expect(body).not.toContain(" * score")
  })
})

// ── SIG-216 fix-up — URL-encode path + escape markdown-special chars ──
//
// CodeRabbit catch on PR #174: the link builder previously interpolated
// `f.path` raw into both the URL and the label. Filenames with spaces,
// parens, or brackets produced broken markdown — a literal space in the
// URL was rejected by GitHub, and a `]` in the label truncated the link
// text. The fix-up URL-encodes each path segment with
// `encodeURIComponent` (preserves `/` separators) and backslash-escapes
// markdown-special chars in the label.

describe("formatBodyFindingAnchor URL encoding + label escaping (SIG-216 fix-up)", () => {
  const headSha = "deadbeefcafe1234567890abcdef1234567890ab"
  const linkContext = { owner: "octo", repo: "demo", headSha } as const

  const buildBody = (f: PrReviewFinding, ctx?: { owner: string; repo: string; headSha: string }): string => {
    const args = {
      verdict: {
        summary: "One body-only finding.",
        confidence: 3,
        confidenceReason: "Fixture.",
        findings: [f],
      },
      prAuthor: "alice",
      headSha,
      ...(ctx ? { linkContext: ctx } : {}),
    }
    return buildReviewSubmission(args).body!
  }

  it("URL-encodes spaces in path segments (space → %20) without encoding the / separator", () => {
    const f: PrReviewFinding = {
      path: "src/with space.ts",
      line: 7,
      scope: "comment",
      score: 4,
      category: "logic",
      headline: "needs attention",
      body: "Reviewer note.",
    }
    const body = buildBody(f, linkContext)
    expect(body).toContain(`(https://github.com/octo/demo/blob/${headSha}/src/with%20space.ts#L7)`)
    // Sanity: the `/` separator stayed literal.
    expect(body).not.toContain("src%2Fwith")
  })

  it("URL-encodes parens in path segments (`(` → %28, `)` → %29)", () => {
    const f: PrReviewFinding = {
      path: "src/(generated)/foo.ts",
      line: 12,
      scope: "comment",
      score: 3,
      category: "logic",
      headline: "h",
      body: "b",
    }
    const body = buildBody(f, linkContext)
    expect(body).toContain(`(https://github.com/octo/demo/blob/${headSha}/src/%28generated%29/foo.ts#L12)`)
  })

  it("backslash-escapes brackets in the label so the markdown link doesn't truncate", () => {
    const f: PrReviewFinding = {
      path: "src/[id]/page.ts",
      line: 3,
      scope: "comment",
      score: 4,
      category: "logic",
      headline: "h",
      body: "b",
    }
    const body = buildBody(f, linkContext)
    // Label-side: `[` and `]` are backslash-escaped so the markdown
    // parser keeps the whole `src/[id]/page.ts:3` as visible text.
    expect(body).toContain("[src/\\[id\\]/page.ts:3](")
    // URL-side: the brackets are percent-encoded by encodeURIComponent.
    expect(body).toContain(`(https://github.com/octo/demo/blob/${headSha}/src/%5Bid%5D/page.ts#L3)`)
  })

  it("backslash-escapes parens in the label so the link-target parser doesn't get confused", () => {
    const f: PrReviewFinding = {
      path: "src/(group)/x.ts",
      line: 5,
      scope: "comment",
      score: 3,
      category: "logic",
      headline: "h",
      body: "b",
    }
    const body = buildBody(f, linkContext)
    // Label-side: `(` and `)` escaped.
    expect(body).toContain("[src/\\(group\\)/x.ts:5](")
  })
})

// ── SIG-164 PR 5: comment-anchor + format-parity helpers ─────────
