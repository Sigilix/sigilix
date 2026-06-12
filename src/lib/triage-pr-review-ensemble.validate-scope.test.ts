import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validateForSubmission, type SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import {
  buildReviewSubmissionWithMetadata,
  type PrReviewVerdict,
  type PrReviewFinding,
} from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import { baseFinding, baseVerdict } from "@/src/lib/triage-pr-review-ensemble.test-helpers"

describe("validateForSubmission — SIG-216 scope normalization (file → line when anchorable)", () => {
  const reviewable: ReviewableMap = new Map([
    [
      "src/lib/foo.ts",
      [
        { line: 42, side: "RIGHT" },
        { line: 50, side: "RIGHT" },
      ],
    ],
  ])

  const specialistVerdicts = [
    {
      role: "logic" as const,
      verdict: {
        ...baseVerdict,
        findings: [{ ...baseFinding, id: "logic-0", line: 42, score: 4 }],
      },
      elapsedMs: 100,
    },
  ]

  function packSynth(finding: PrReviewFinding): {
    verdict: PrReviewVerdict
    provenance: SynthesizerProvenance
  } {
    return {
      verdict: {
        summary: "ok",
        confidence: 4,
        confidenceReason: "...",
        findings: [finding],
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
    }
  }

  let logSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    logSpy.mockRestore()
  })

  it("flips file → line when finding has (path, line) and line is in a hunk", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "file" }),
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.scope).toBe("line")
    expect(out.unanchoredFindings).toHaveLength(0)

    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
    const payload = JSON.parse(flips[0]!) as Record<string, unknown>
    expect(payload).toMatchObject({
      event: "pr-review-scope-normalized-to-line",
      fromScope: "file",
      path: "src/lib/foo.ts",
      line: 42,
      category: "logic",
    })
  })

  it("SIG-392 (runner#25): flips pr → line when an anchorable line is in a hunk (inline-first)", () => {
    // The runner#25 incident: the synth scoped a line-specific testing
    // finding (run_pylint.sh:60-67) as `pr`, routing it to the body. The
    // founder's inline-first rule promotes any anchorable finding inline.
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "pr" }),
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.scope).toBe("line")
    expect(out.unanchoredFindings).toHaveLength(0)
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
    expect(JSON.parse(flips[0]!) as Record<string, unknown>).toMatchObject({
      event: "pr-review-scope-normalized-to-line",
      fromScope: "pr",
      line: 42,
    })
  })

  it("SIG-392: leaves a GENUINE pr-level finding alone when its line is NOT in any hunk", () => {
    // A real PR-level finding (line doesn't resolve to a RIGHT-side hunk)
    // still routes to the body — promotion is anchorability-gated, not blanket.
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 999, score: 4, scope: "pr" }),
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings.find((f) => f.scope === "line")).toBeUndefined()
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves comment scope alone even when line is in a hunk", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "comment" }),
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings.find((f) => f.scope === "line")).toBeUndefined()
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves file scope alone when line is not in any hunk (LLM's file-scope choice was right)", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 999, score: 4, scope: "file" }),
      reviewable,
      specialistVerdicts,
    })
    // Not anchorable to a hunk; the renderer's body-finding path is
    // correct here. The scope stays "file" so the body section keeps
    // it.
    const unanchored = out.unanchoredFindings.find((f) => f.line === 999)
    expect(unanchored?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves file scope alone when path is not in the reviewable map", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/not-in-diff.ts",
        line: 42,
        score: 4,
        scope: "file",
      }),
      reviewable,
      specialistVerdicts,
    })
    const unanchored = out.unanchoredFindings.find((f) => f.path === "src/lib/not-in-diff.ts")
    expect(unanchored?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves file scope alone when line is missing/invalid", () => {
    // `line` typed as number, so simulate "missing" by feeding NaN
    // (which the normalizer rejects via Number.isFinite). Cast through
    // unknown to satisfy the typed-input surface used by callers that
    // bypass schema validation.
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: Number.NaN,
        score: 4,
        scope: "file",
      } as unknown as PrReviewFinding),
      reviewable,
      specialistVerdicts,
    })
    // The downstream line-validity check drops the finding into
    // unanchoredFindings; the scope must remain "file" because the
    // normalizer should not have flipped it.
    const unanchored = out.unanchoredFindings[0]
    expect(unanchored?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("is idempotent — applying normalization twice produces the same result", () => {
    const first = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "file" }),
      reviewable,
      specialistVerdicts,
    })
    const flippedOnce = first.verdict.findings[0]
    expect(flippedOnce?.scope).toBe("line")

    // Re-pack the once-flipped finding (now scope: "line") and run it
    // through the validator again. The normalizer's early return on
    // already-line scope must leave it untouched and emit no flip
    // telemetry the second time.
    logSpy.mockClear()
    const second = validateForSubmission({
      synthOutput: packSynth({ ...flippedOnce! }),
      reviewable,
      specialistVerdicts,
    })
    const flippedTwice = second.verdict.findings[0]
    expect(flippedTwice?.scope).toBe("line")
    expect(flippedTwice).toEqual(flippedOnce)
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  // SIG-216 fix-up: the scope-normalization predicate now requires a
  // RIGHT-side anchor. A LEFT-only diff position (deleted line) was
  // previously flipping the scope, then `buildReviewSubmission` would
  // always emit `side: "RIGHT"` → primary submit 422'd. The downstream
  // `deriveSide` still finds LEFT and treats the finding as line-valid
  // (so it lands in `verdict.findings`, not `unanchoredFindings`), but
  // the scope MUST remain "file" so the renderer routes it to the body
  // section rather than emitting an inline comment that would 422.
  it("leaves file scope alone when the matching anchor is LEFT-only (deleted-line position)", () => {
    const leftOnlyReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          { line: 42, side: "LEFT" }, // deleted line — anchorable but not on RIGHT
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "file" }),
      reviewable: leftOnlyReviewable,
      specialistVerdicts,
    })
    // Find the finding in EITHER bucket — scope must remain "file"
    // wherever it ends up, because flipping to "line" would route it
    // through the inline-comment path which always emits side=RIGHT.
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  // SIG-216 follow-up: multi-line findings now flip when ANY line in
  // the inclusive [startLine, line] range is in a RIGHT-side hunk.
  // GitHub accepts multi-line inline comments via start_line + line
  // even when only the middle of the range is in the diff. The prior
  // strict-bounds check over-suppressed (PR #175 dogfood: a 15-line
  // finding range with the diff in the middle got routed to body).
  it("flips file → line for multi-line findings when only `line` is in a RIGHT-side hunk (relaxed any-line-in-range)", () => {
    const partialReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          // `line: 42` is RIGHT-anchorable, but `startLine: 38` is not.
          { line: 42, side: "RIGHT" },
          { line: 50, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: partialReviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.scope).toBe("line")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
  })

  it("flips file → line for multi-line findings when BOTH startLine AND line are in RIGHT-side hunks", () => {
    const bothRightReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          { line: 38, side: "RIGHT" },
          { line: 42, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: bothRightReviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.scope).toBe("line")
  })

  // SIG-216 follow-up regression: PR #175 dogfood case — a 15-line
  // finding (`src/lib/index-delete.ts:429-444`) where the PR added
  // lines 432-438 in the middle of the range. Neither endpoint is in
  // the diff, but the middle is. Must flip inline.
  it("flips file → line for multi-line findings when only middle lines are in RIGHT-side hunks (PR #175 case)", () => {
    const middleOnlyReviewable: ReviewableMap = new Map([
      [
        "src/lib/index-delete.ts",
        [
          { line: 432, side: "RIGHT" },
          { line: 433, side: "RIGHT" },
          { line: 434, side: "RIGHT" },
          { line: 435, side: "RIGHT" },
          { line: 436, side: "RIGHT" },
          { line: 437, side: "RIGHT" },
          { line: 438, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/index-delete.ts",
        line: 444,
        startLine: 429,
        score: 4,
        scope: "file",
      }),
      reviewable: middleOnlyReviewable,
      specialistVerdicts,
    })
    // Option A (SIG-216 follow-up): the normalizer flipped scope to
    // "line" because the middle of the [429, 444] range overlaps the
    // diff, AND the line-validity check now uses `findRangeAwareAnchor`
    // to rewrite f.line/f.startLine to the actually-anchorable subrange
    // ([432, 438]) so the inline POST won't 422. The finding MUST land
    // in `verdict.findings` with scope:"line" and MUST NOT appear in
    // `unanchoredFindings`.
    expect(out.unanchoredFindings.find((f) => f.path === "src/lib/index-delete.ts")).toBeUndefined()
    const matching = out.verdict.findings.find((f) => f.path === "src/lib/index-delete.ts")
    expect(matching).toBeDefined()
    expect(matching?.scope).toBe("line")
    // Endpoints rewritten to the in-diff subrange: last RIGHT anchor
    // (438) is the new `line` (bottom of underline); first RIGHT anchor
    // (432) is the new `start_line` (top).
    expect(matching?.line).toBe(438)
    expect(matching?.startLine).toBe(432)
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
  })

  // PR #176 CR follow-up: the range-aware rewrite must run BEFORE
  // `deriveSide` so that the rewritten endpoints (not the stale
  // originals) drive subsequent validation. Same PR #175 dogfood
  // shape — neither endpoint is anchorable, only middle lines are —
  // but this case asserts the rewrite happens up-front (the finding
  // lands in `verdict.findings` with rewritten endpoints AND
  // `remappedInvalidLineToInline` increments) rather than slipping
  // through `deriveSide` against the stale `startLine: 429`.
  it("rewrites multi-line endpoints BEFORE deriveSide so unanchorable startLine can't slip through (PR #176 CR follow-up)", () => {
    const middleOnlyReviewable: ReviewableMap = new Map([
      [
        "src/lib/index-delete.ts",
        [
          { line: 432, side: "RIGHT" },
          { line: 433, side: "RIGHT" },
          { line: 434, side: "RIGHT" },
          { line: 435, side: "RIGHT" },
          { line: 436, side: "RIGHT" },
          { line: 437, side: "RIGHT" },
          { line: 438, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/index-delete.ts",
        line: 444,
        startLine: 429,
        score: 4,
        scope: "line",
      }),
      reviewable: middleOnlyReviewable,
      specialistVerdicts,
    })
    expect(out.unanchoredFindings.find((f) => f.path === "src/lib/index-delete.ts")).toBeUndefined()
    const matching = out.verdict.findings.find((f) => f.path === "src/lib/index-delete.ts")
    expect(matching).toBeDefined()
    // Rewritten to the in-diff subrange — NOT the stale originals
    // (line: 444, startLine: 429), which would 422 on `start_line`.
    expect(matching?.line).toBe(438)
    expect(matching?.startLine).toBe(432)
    expect(matching?.line).not.toBe(444)
    expect(matching?.startLine).not.toBe(429)
    // The rewrite happened, so the counter increments exactly once.
    expect(out.remappedInvalidLineToInline).toBe(1)
  })

  it("flips file → line for multi-line findings when only `startLine` is in a RIGHT-side hunk", () => {
    const startOnlyReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          // `startLine: 38` is RIGHT-anchorable, but `line: 42` is not.
          { line: 38, side: "RIGHT" },
          { line: 50, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: startOnlyReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("line")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
  })

  it("leaves file scope alone for multi-line findings when NEITHER endpoint NOR any middle line is in a RIGHT-side hunk", () => {
    const noOverlapReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          // Range [38, 42] has nothing overlapping the reviewable lines.
          { line: 100, side: "RIGHT" },
          { line: 101, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: noOverlapReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  // CR MAJOR (PR #176): the predicate previously walked the numeric
  // [startLine, line] range, which is O(N*M) and unbounded — a finding
  // with `startLine: 1, line: 999999` would loop a million times per
  // anchor check. Pivoted to a single-pass scan over the (small)
  // anchorLines array. These tests pin the post-fix behaviour AND act
  // as a regression guard against any future revert that would
  // reintroduce the quadratic walk.
  it("flips file → line for an extreme-range finding (startLine: 1, line: 999999) when one anchor lands inside the range", () => {
    const sparseReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          // One RIGHT anchor at line 500 inside the giant [1, 999999] range.
          { line: 500, side: "RIGHT" },
        ],
      ],
    ])
    const start = performance.now()
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 999999,
        startLine: 1,
        score: 4,
        scope: "file",
      }),
      reviewable: sparseReviewable,
      specialistVerdicts,
    })
    const elapsedMs = performance.now() - start
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("line")
    // Generous bound — the post-fix single-pass scan finishes in well
    // under a millisecond. The prior numeric-range walk would have
    // iterated ~1M times per finding and taken hundreds of ms.
    expect(elapsedMs).toBeLessThan(500)
  })

  it("returns false when the path has no anchor entries (empty anchorLines map miss)", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/unreviewed.ts",
        line: 42,
        score: 4,
        scope: "file",
      }),
      reviewable, // map keyed by "src/lib/foo.ts" — no entry for unreviewed.ts
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/unreviewed.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/unreviewed.ts")
    expect(matching?.scope).toBe("file")
  })

  it("returns false when every anchor is LEFT-side (RIGHT-side filter holds)", () => {
    const leftOnlyReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          { line: 40, side: "LEFT" },
          { line: 41, side: "LEFT" },
          { line: 42, side: "LEFT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 40,
        score: 4,
        scope: "file",
      }),
      reviewable: leftOnlyReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
  })

  it("returns false when every RIGHT anchor sits outside the range", () => {
    const outsideRangeReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          { line: 10, side: "RIGHT" },
          { line: 100, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: outsideRangeReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
  })

  it("returns true when a single RIGHT anchor sits inside the range", () => {
    const insideRangeReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          { line: 5, side: "LEFT" },
          { line: 40, side: "RIGHT" }, // inside [38, 42]
          { line: 100, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: insideRangeReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("line")
  })
})

// SIG-216 fix-up: the production review path now threads `linkContext`
// through `buildReviewSubmissionWithMetadata` (was test-only previously).
// This invariant pins the call-shape so real PR reviews render the
// clickable GitHub blob URL for body-only finding anchors instead of
// the back-compat inline-code shape.
describe("buildReviewSubmissionWithMetadata — SIG-216 linkContext threading from ensemble", () => {
  it("emits a clickable [path:line](https://github.com/...) link when linkContext is supplied", () => {
    const headSha = "deadbeefcafe1234567890abcdef1234567890ab"
    const bodyFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 42,
      // scope=comment routes to the body-only renderer regardless of
      // reviewable-map presence (matches the test pattern in
      // tests/triage-pr-review.test.ts:1986).
      scope: "comment",
      // SIG-281 PR B (Rec 6): score 3 keeps this in the "Review Body
      // Findings" section so the clickable-link assertion isn't confounded
      // by a Fix Plan table row (score>=4 body-only blockers also render
      // in the table, which uses the compact `path:line` form).
      // linkContext threading is severity-independent.
      score: 3,
      category: "logic",
      headline: "missing null guard",
      body: "Wrap with a guard before deref.",
    }
    const result = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "One body-only finding.",
        confidence: 3,
        confidenceReason: "Fixture.",
        findings: [bodyFinding],
      },
      prAuthor: "alice",
      headSha,
      // Exact shape the ensemble now threads at the call site in
      // src/lib/triage-pr-review-ensemble.ts (search for "linkContext:"
      // inside the buildReviewSubmissionWithMetadata call).
      linkContext: { owner: "octo", repo: "demo", headSha },
    })
    const body = result.submission.body ?? ""
    // The body anchor MUST be a clickable markdown link to a GitHub
    // blob URL at the reviewed SHA — NOT the back-compat
    // `\`path:line\`` inline-code shape.
    expect(body).toMatch(
      /\[[^\]]*src\/lib\/foo\.ts:42[^\]]*\]\(https:\/\/github\.com\/octo\/demo\/blob\/[0-9a-f]+\/src\/lib\/foo\.ts#L42\)/,
    )
    expect(body).not.toContain("`src/lib/foo.ts:42`")
  })
})
