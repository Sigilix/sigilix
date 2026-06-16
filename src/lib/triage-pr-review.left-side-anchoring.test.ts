import { describe, expect, it } from "vitest"
import { buildReviewSubmissionWithMetadata, type PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

// SIG-456: findings about DELETED code anchor on the LEFT (deletion) side of the diff
// instead of routing to the review body. The diff parser already records deleted lines
// as `{ side: "LEFT" }`; before this change the inline gate + payload only accepted
// RIGHT, so every deleted-line finding (4 of 5 body-leaks in the sigilix-monitor
// #29/#34 re-probe) was bodied. RIGHT behavior is unchanged; LEFT is opt-in via the
// PR-review payload path (the CI-synth consumer stays RIGHT-only).
describe("SIG-456 — deleted-line findings anchor on the LEFT (deletion) side, not the body", () => {
  const path = "src/auth/session.ts"
  const deletedGuard: PrReviewFinding = {
    path,
    line: 71,
    scope: "line",
    score: 5,
    category: "logic",
    headline: "Deleted expiration check accepts expired sessions",
    body: "The removed `nowMs > payload.exp` guard let expired tokens through.",
    evidenceRefs: [],
  }

  it("posts a single deleted line INLINE on side:LEFT (was always body-routed)", () => {
    const reviewable: ReviewableMap = new Map([[path, [{ line: 71, side: "LEFT" }]]])
    const out = buildReviewSubmissionWithMetadata({
      verdict: { summary: "s", confidence: 5, confidenceReason: "c", findings: [deletedGuard] },
      prAuthor: null,
      headSha: "abc",
      reviewable,
    })
    expect(out.submission.comments).toHaveLength(1)
    expect(out.submission.comments?.[0]?.side).toBe("LEFT")
    expect(out.submission.comments?.[0]?.line).toBe(71)
    expect(out.submission.comments?.[0]?.start_side).toBeUndefined()
    expect(out.bodyOnlyFindings).toEqual([])
  })

  it("posts a deleted RANGE with start_side:LEFT when both endpoints are LEFT-reviewable", () => {
    const reviewable: ReviewableMap = new Map([
      [path, [68, 69, 70, 71].map((line) => ({ line, side: "LEFT" as const }))],
    ])
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "s",
        confidence: 5,
        confidenceReason: "c",
        findings: [{ ...deletedGuard, startLine: 68, line: 71 }],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
    })
    expect(out.submission.comments?.[0]?.side).toBe("LEFT")
    expect(out.submission.comments?.[0]?.start_side).toBe("LEFT")
    expect(out.submission.comments?.[0]?.start_line).toBe(68)
  })

  it("falls back to a single-line LEFT comment when the start endpoint is not LEFT-reviewable", () => {
    const reviewable: ReviewableMap = new Map([[path, [{ line: 71, side: "LEFT" }]]])
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "s",
        confidence: 5,
        confidenceReason: "c",
        findings: [{ ...deletedGuard, startLine: 68, line: 71 }],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
    })
    expect(out.submission.comments?.[0]?.side).toBe("LEFT")
    expect(out.submission.comments?.[0]?.start_line).toBeUndefined()
    expect(out.submission.comments?.[0]?.start_side).toBeUndefined()
  })

  it("body-routes (never posts a broken LEFT comment) when the line is in neither side of the diff", () => {
    const reviewable: ReviewableMap = new Map([[path, [{ line: 99, side: "RIGHT" }]]])
    const addedLineTextByLine = new Map<string, Map<number, string>>([[path, new Map()]])
    const out = buildReviewSubmissionWithMetadata({
      verdict: { summary: "s", confidence: 5, confidenceReason: "c", findings: [deletedGuard] },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })
    expect(out.submission.comments ?? []).toHaveLength(0)
    expect(out.bodyOnlyFindings.some((f) => f.headline === deletedGuard.headline)).toBe(true)
  })

  it("keeps RIGHT findings on side:RIGHT and posts mixed LEFT+RIGHT on the correct sides", () => {
    const reviewable: ReviewableMap = new Map([
      [
        path,
        [
          { line: 71, side: "LEFT" as const },
          { line: 80, side: "RIGHT" as const },
        ],
      ],
    ])
    const addedLineTextByLine = new Map<string, Map<number, string>>([[path, new Map([[80, "const x = compute()"]])]])
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "s",
        confidence: 5,
        confidenceReason: "c",
        findings: [deletedGuard, { ...deletedGuard, line: 80, headline: "Added-line bug" }],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })
    expect(out.submission.comments).toHaveLength(2)
    const sideByLine = new Map(out.submission.comments?.map((c) => [c.line, c.side]))
    expect(sideByLine.get(71)).toBe("LEFT")
    expect(sideByLine.get(80)).toBe("RIGHT")
  })

  it("keeps a both-sides (replaced) line on RIGHT — a collision is anchor-exactness, not a body-leak", () => {
    // Line 71 exists on BOTH sides (a replaced-in-place line). deriveSide prefers RIGHT, so the
    // finding stays RIGHT — it already posts inline today and was never bodied, so it is out of
    // scope for this body-leak fix. Documents the conservative LEFT trigger (Codex review).
    const reviewable: ReviewableMap = new Map([
      [
        path,
        [
          { line: 71, side: "LEFT" as const },
          { line: 71, side: "RIGHT" as const },
        ],
      ],
    ])
    const addedLineTextByLine = new Map<string, Map<number, string>>([[path, new Map([[71, "const replaced = true"]])]])
    const out = buildReviewSubmissionWithMetadata({
      verdict: { summary: "s", confidence: 5, confidenceReason: "c", findings: [deletedGuard] },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })
    expect(out.submission.comments).toHaveLength(1)
    expect(out.submission.comments?.[0]?.side).toBe("RIGHT")
  })

  it("body-routes a file-scoped finding even when its line is LEFT-reviewable (scope gate precedes the LEFT gate)", () => {
    const reviewable: ReviewableMap = new Map([[path, [{ line: 71, side: "LEFT" }]]])
    const fileScoped: PrReviewFinding = { ...deletedGuard, scope: "file" }
    const out = buildReviewSubmissionWithMetadata({
      verdict: { summary: "s", confidence: 5, confidenceReason: "c", findings: [fileScoped] },
      prAuthor: null,
      headSha: "abc",
      reviewable,
    })
    expect(out.submission.comments ?? []).toHaveLength(0)
    expect(out.bodyOnlyFindings.some((f) => f.headline === deletedGuard.headline)).toBe(true)
  })

  it("never emits a committable suggestion block on a LEFT (deleted) line — GitHub would reject it", () => {
    // A deleted-line finding carrying a structured fix: the committable ```suggestion is RIGHT-gated,
    // so a LEFT comment must never render one (the highest-consequence whole-review-reject path).
    const reviewable: ReviewableMap = new Map([[path, [{ line: 71, side: "LEFT" }]]])
    const withFix: PrReviewFinding = { ...deletedGuard, suggestedReplacement: "const restored = guard()" }
    const out = buildReviewSubmissionWithMetadata({
      verdict: { summary: "s", confidence: 5, confidenceReason: "c", findings: [withFix] },
      prAuthor: null,
      headSha: "abc",
      reviewable,
    })
    for (const c of out.submission.comments ?? []) expect(c.body).not.toContain("```suggestion")
  })
})
