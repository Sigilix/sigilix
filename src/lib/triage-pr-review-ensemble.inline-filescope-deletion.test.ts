// SIG-458: inline file-scope test-deletion findings — close the body-leak.
//
// A `category:"testing"` finding about a DELETED test carries NO usable line, so
// it body-routes at submission.ts:482 (`scope!=="line"`) before any anchor step —
// the "unbearable" leak (probe #35: 4 P0/P1 coverage-gap findings buried in the
// "couldn't be anchored" dropdown). The deleted test's `it(...)` line IS in the
// diff as a LEFT/deleted position. `anchorNoLineDeletionFinding` (run in the
// validation pass right after `normalizeFindingScopeForAnchorability`) gives such
// a finding that LEFT line + scope:"line" — ONLY on a unique, guarded content
// match — so SIG-456's existing LEFT-anchor path
// (`prepareReviewSubmissionFindings` with `allowDeletedLineAnchor:true`, the
// PR-review default) inlines it on side:"LEFT".
//
// These tests drive the REAL path end-to-end: validateForSubmission (which runs
// the helper) → buildReviewSubmissionWithMetadata (the PR payload, which posts
// LEFT). The `reviewable` map and the `deletedLineTextByLine` map are BOTH
// derived from the same unified diff (parseDiffToReviewablePositions +
// buildDeletedLineTextByLine), so the LEFT positions and deleted-line text are
// mutually consistent exactly as in production. Expected line numbers are derived
// from the deleted-line map (not hand-counted) so a test asserts the real
// invariant — "anchored to the deleted `it(` line that contains the quoted
// title" — and fails if the validation-walk wiring or any guard is reverted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validateForSubmission, type SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import {
  buildReviewSubmissionWithMetadata,
  type PrReviewVerdict,
  type PrReviewFinding,
} from "@/src/lib/triage-pr-review"
import { parseDiffToReviewablePositions, type ReviewableMap } from "@/src/shared/util/diff-positions"
import { buildDeletedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import { anchorNoLineDeletionFinding } from "@/src/lib/ensemble/domain/validation-internals"
import { baseFinding, baseVerdict } from "@/src/lib/triage-pr-review-ensemble.test-helpers"

const AUTH_TEST_PATH = "tests/auth.test.ts"
const EXPIRED_TITLE = "rejects an expired session (now past exp)"

// A real "delete one regression test in a modified test file" diff. Every line
// inside the hunk is a real diff line (leading `+`/`-`/space). The deletion sits
// at the hunk TAIL and the string has NO trailing newline, so there is no
// phantom trailing context line whose new-side number would collide with the
// deleted block's old-side numbers — the deleted `it('rejects an expired session
// (now past exp)', …)` block is LEFT-EXCLUSIVE (deriveSide returns LEFT for it).
const DELETE_ONE_TEST_DIFF = `diff --git a/${AUTH_TEST_PATH} b/${AUTH_TEST_PATH}
--- a/${AUTH_TEST_PATH}
+++ b/${AUTH_TEST_PATH}
@@ -8,5 +8,2 @@ describe("auth", () => {
     expect(ok).toBe(true)
   })
-  it('${EXPIRED_TITLE}', () => {
-    expect(verify(expiredToken).ok).toBe(false)
-  })`

const UI_TEST_PATH = "tests/ui.test.ts"
const REDIRECT_TITLE = "redirects when the session cookie is expired"
const CSRF_TITLE = "/auth/callback rejects a mismatched state (CSRF guard)"

// Two deleted `it(...)` regression tests in one file (the tests/ui.test.ts probe
// shape). Tail deletion + no trailing newline → both `it(` lines are LEFT-exclusive.
const DELETE_TWO_TESTS_DIFF = `diff --git a/${UI_TEST_PATH} b/${UI_TEST_PATH}
--- a/${UI_TEST_PATH}
+++ b/${UI_TEST_PATH}
@@ -5,6 +5,2 @@ describe("ui", () => {
     expect(render()).toBeTruthy()
   })
-  it('${REDIRECT_TITLE}', () => { expect(redirected()).toBe(true) })
-  it('${CSRF_TITLE}', () => { expect(callback(badState)).toBe(403) })`

const COMMENT_TEST_PATH = "tests/comment.test.ts"
const COMMENT_TITLE = "restore coverage for the long descriptive scenario here"

// The quoted title appears ONLY in a deleted COMMENT line, never on an `it(` —
// the test-declaration gate must reject this (body, not inline).
const DELETE_COMMENT_DIFF = `diff --git a/${COMMENT_TEST_PATH} b/${COMMENT_TEST_PATH}
--- a/${COMMENT_TEST_PATH}
+++ b/${COMMENT_TEST_PATH}
@@ -3,4 +3,2 @@ describe("comment", () => {
     expect(true).toBe(true)
   })
-  // TODO: ${COMMENT_TITLE}
-  helper.run()`

const COLLISION_TEST_PATH = "tests/collision.test.ts"
const COLLISION_TITLE = "handles the collision edge case cleanly"

// A REPLACE hunk: the `it('...')` line is deleted AND re-added. The deleted
// line's old-side number collides with the added line's new-side number, so
// deriveSide prefers RIGHT on that number → the LEFT-exclusive gate must reject.
const COLLISION_DIFF = `diff --git a/${COLLISION_TEST_PATH} b/${COLLISION_TEST_PATH}
--- a/${COLLISION_TEST_PATH}
+++ b/${COLLISION_TEST_PATH}
@@ -10,1 +10,1 @@ describe("collision", () => {
-  it('${COLLISION_TITLE}', () => {})
+  it('${COLLISION_TITLE} now', () => {})`

const COMMENTED_TEST_PATH = "tests/commented.test.ts"
const COMMENTED_TITLE = "rejects an expired session via the commented path"

// A SINGLE deleted line that CONTAINS `it('…')` but as a COMMENTED-OUT test, not
// a live declaration. Exactly one candidate, so the uniqueness guard does NOT
// mask the regex check: the line-anchored regex is the ONLY thing that keeps this
// in the body (Codex review: an unanchored `\bit\b\s*\(` would false-match `// it(`
// and wrongly anchor it).
const DELETE_COMMENTED_TEST_DIFF = `diff --git a/${COMMENTED_TEST_PATH} b/${COMMENTED_TEST_PATH}
--- a/${COMMENTED_TEST_PATH}
+++ b/${COMMENTED_TEST_PATH}
@@ -4,4 +4,2 @@ describe("commented", () => {
     expect(ok).toBe(true)
   })
-  // it('${COMMENTED_TITLE}', () => {})`

const DUP_TEST_PATH = "tests/dup.test.ts"
const DUP_TITLE = "validates the shared idempotency key across retries"

// TWO deleted `it(...)` declarations carrying the SAME title in one file: a single
// quoted run matches BOTH LEFT-exclusive deleted declarations → matchedLines.length
// > 1 → the uniqueness gate must fire (body, never guess between two equally-valid
// anchors). Same structure as DELETE_TWO_TESTS_DIFF but with a shared title.
const DELETE_DUP_TITLE_DIFF = `diff --git a/${DUP_TEST_PATH} b/${DUP_TEST_PATH}
--- a/${DUP_TEST_PATH}
+++ b/${DUP_TEST_PATH}
@@ -5,6 +5,2 @@ describe("dup", () => {
     expect(setup()).toBeTruthy()
   })
-  it('${DUP_TITLE}', () => { expect(a()).toBe(1) })
-  it('${DUP_TITLE}', () => { expect(b()).toBe(2) })`

// Find the old-side line number of the deleted line whose text contains `needle`
// (used to derive expected anchor lines without hand-counting the diff).
function deletedLineContaining(diff: string, path: string, needle: string): number {
  const byPath = buildDeletedLineTextByLine(diff).get(path)
  if (!byPath) throw new Error(`no deleted lines for ${path}`)
  for (const [line, text] of byPath) {
    if (text.includes(needle)) return line
  }
  throw new Error(`no deleted line containing "${needle}" in ${path}`)
}

function packSynth(finding: PrReviewFinding): {
  verdict: PrReviewVerdict
  provenance: SynthesizerProvenance
} {
  return {
    verdict: { ...baseVerdict, findings: [finding] },
    provenance: {
      findings: [
        {
          sourceSpecialists: ["tests"],
          sourceFindingIds: ["tests-0"],
          action: "kept",
          verifiedViaRetrieval: false,
        },
      ],
      dropped: [],
    },
  }
}

// A specialist verdict so the finding's provenance id (`tests-0`) is a valid
// source — otherwise the hallucination guard drops it before any anchoring runs.
function testsSpecialist(finding: PrReviewFinding) {
  return [
    {
      role: "tests" as const,
      verdict: { ...baseVerdict, findings: [{ ...finding, id: "tests-0" }] },
      elapsedMs: 100,
    },
  ]
}

// A no-line, file-scope testing finding: `line` is a number the schema requires
// but it is NOT a RIGHT diff position, so `normalizeFindingScopeForAnchorability`
// leaves it scope:"file" — only `anchorNoLineDeletionFinding` can anchor it.
function deletionFinding(overrides: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    ...baseFinding,
    category: "testing",
    scope: "file",
    score: 5,
    line: 99999,
    headline: "Deleted regression test reduces coverage",
    body: "A regression test was removed.",
    ...overrides,
  }
}

describe("SIG-458: anchor no-line file-scope testing deletion findings on side:LEFT", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    logSpy.mockRestore()
  })

  function validateAndBuild(args: { finding: PrReviewFinding; diff: string }): {
    validatedFinding: PrReviewFinding | undefined
    submissionComments: ReturnType<typeof buildReviewSubmissionWithMetadata>["submission"]["comments"]
  } {
    const reviewable: ReviewableMap = parseDiffToReviewablePositions(args.diff)
    const deletedLineTextByLine = buildDeletedLineTextByLine(args.diff)
    const validated = validateForSubmission({
      synthOutput: packSynth(args.finding),
      reviewable,
      specialistVerdicts: testsSpecialist(args.finding),
      deletedLineTextByLine,
    })
    const validatedFinding =
      validated.verdict.findings[0] ?? validated.unanchoredFindings.find((f) => f.path === args.finding.path)
    const built = buildReviewSubmissionWithMetadata({
      verdict: validated.verdict,
      prAuthor: null,
      headSha: "deadbeef",
      unanchored: validated.unanchoredFindings,
      reviewable,
    })
    return { validatedFinding, submissionComments: built.submission.comments }
  }

  it("anchors a no-line file-scope testing finding to the deleted it() line on side:LEFT (probe #35 shape)", () => {
    const expectedLine = deletedLineContaining(DELETE_ONE_TEST_DIFF, AUTH_TEST_PATH, `it('${EXPIRED_TITLE}'`)
    const finding = deletionFinding({
      path: AUTH_TEST_PATH,
      body: `The test '${EXPIRED_TITLE}' was deleted, dropping coverage.`,
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: DELETE_ONE_TEST_DIFF })

    // Promoted to a single-line LEFT anchor on the deleted `it(` line.
    expect(validatedFinding?.scope).toBe("line")
    expect(validatedFinding?.line).toBe(expectedLine)
    expect(validatedFinding?.startLine).toBeUndefined()

    // The PR payload posts it inline on the deletion side.
    expect(submissionComments).toHaveLength(1)
    expect(submissionComments?.[0]?.path).toBe(AUTH_TEST_PATH)
    expect(submissionComments?.[0]?.line).toBe(expectedLine)
    expect(submissionComments?.[0]?.side).toBe("LEFT")

    const anchored = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-deletion-finding-anchored-left"))
    expect(anchored).toHaveLength(1)
    expect(JSON.parse(anchored[0]!) as Record<string, unknown>).toMatchObject({
      event: "pr-review-deletion-finding-anchored-left",
      path: AUTH_TEST_PATH,
      line: expectedLine,
      category: "testing",
    })
  })

  it("strips a stale startLine when anchoring (Codex blocker: no accidental range for range-repair to re-home)", () => {
    // A finding that reaches the helper still scope:"file" but carrying a stale
    // model `startLine` would, if the helper kept it, forge an accidental
    // [startLine..deletedLine] range that the downstream `findRangeAwareAnchor`
    // could rewrite onto a RIGHT line inside it — a wrong-line path. Asserted at
    // the helper boundary (the load-bearing guarantee) because once the
    // [startLine, line] range overlaps a RIGHT hunk, `normalizeFindingScopeForAnchorability`
    // legitimately owns the promotion first and the helper never sees it.
    const reviewable = parseDiffToReviewablePositions(DELETE_ONE_TEST_DIFF)
    const deleted = buildDeletedLineTextByLine(DELETE_ONE_TEST_DIFF)
    const expectedLine = deletedLineContaining(DELETE_ONE_TEST_DIFF, AUTH_TEST_PATH, `it('${EXPIRED_TITLE}'`)
    const anchored = anchorNoLineDeletionFinding(
      deletionFinding({
        path: AUTH_TEST_PATH,
        startLine: 40,
        line: 99999,
        body: `The test '${EXPIRED_TITLE}' was deleted.`,
      }),
      reviewable,
      deleted,
    )
    expect(anchored.scope).toBe("line")
    expect(anchored.line).toBe(expectedLine)
    // The promoted finding is single-line: the stale startLine is gone entirely
    // (the property is removed, not merely undefined).
    expect("startLine" in anchored).toBe(false)
    expect(anchored.startLine).toBeUndefined()
  })

  it("with two deleted tests, anchors to the ONE the finding quotes (not the other)", () => {
    const csrfLine = deletedLineContaining(DELETE_TWO_TESTS_DIFF, UI_TEST_PATH, `it('${CSRF_TITLE}'`)
    const redirectLine = deletedLineContaining(DELETE_TWO_TESTS_DIFF, UI_TEST_PATH, `it('${REDIRECT_TITLE}'`)
    expect(csrfLine).not.toBe(redirectLine)
    const finding = deletionFinding({
      path: UI_TEST_PATH,
      body: `The test '${CSRF_TITLE}' was deleted.`,
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: DELETE_TWO_TESTS_DIFF })

    expect(validatedFinding?.scope).toBe("line")
    expect(validatedFinding?.line).toBe(csrfLine)
    expect(submissionComments).toHaveLength(1)
    expect(submissionComments?.[0]?.line).toBe(csrfLine)
    expect(submissionComments?.[0]?.side).toBe("LEFT")
  })

  it("leaves the finding in the body when the only quoted run is shorter than the minimum (10 chars)", () => {
    // `'past'` (4 chars) IS a substring of the deleted `it(...)` title, so the
    // length gate is what holds the line: without it, the short run would match
    // the deleted test declaration and wrongly anchor. The only quoted run here
    // is short, so the finding must stay in the body.
    expect("past".length).toBeLessThan(10)
    const finding = deletionFinding({
      path: AUTH_TEST_PATH,
      body: "The deleted assertion about a 'past' session lowered coverage.",
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: DELETE_ONE_TEST_DIFF })

    expect(validatedFinding?.scope).toBe("file")
    expect(validatedFinding?.line).toBe(99999)
    expect(submissionComments ?? []).toHaveLength(0)
    const anchored = logSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("pr-review-deletion-finding-anchored-left") : false,
    )
    expect(anchored).toHaveLength(0)
  })

  it("leaves the finding in the body when the quoted run is only on a deleted COMMENT, not an it()", () => {
    const finding = deletionFinding({
      path: COMMENT_TEST_PATH,
      body: `The test '${COMMENT_TITLE}' was deleted.`,
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: DELETE_COMMENT_DIFF })

    // The run matches the deleted comment text but the line is not a test
    // declaration → rejected → stays file-scope in the body.
    expect(validatedFinding?.scope).toBe("file")
    expect(submissionComments ?? []).toHaveLength(0)
  })

  it("leaves the finding in the body when the run is on a COMMENTED-OUT it() (anchored regex)", () => {
    // Codex review: the single deleted line contains `it('…')` but as a `// comment`
    // — NOT a live test declaration. It is the only candidate, so the uniqueness
    // guard can't mask this: the line-anchored regex is what keeps it in the body
    // (an unanchored regex would false-match `// it(` and wrongly anchor it).
    const finding = deletionFinding({
      path: COMMENTED_TEST_PATH,
      body: `The test '${COMMENTED_TITLE}' was deleted.`,
    })
    const { validatedFinding, submissionComments } = validateAndBuild({
      finding,
      diff: DELETE_COMMENTED_TEST_DIFF,
    })

    expect(validatedFinding?.scope).toBe("file")
    expect(submissionComments ?? []).toHaveLength(0)
    const anchored = logSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("pr-review-deletion-finding-anchored-left") : false,
    )
    expect(anchored).toHaveLength(0)
  })

  it("leaves the finding in the body when the matched line also exists on RIGHT (collision → LEFT-exclusive gate)", () => {
    const finding = deletionFinding({
      path: COLLISION_TEST_PATH,
      body: `The test '${COLLISION_TITLE}' was deleted.`,
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: COLLISION_DIFF })

    // The quoted run is a substring of BOTH the deleted and the re-added line,
    // and the deleted line's old-side number collides with the added line's
    // new-side number. deriveSide prefers RIGHT → no LEFT anchor → body.
    expect(validatedFinding?.scope).toBe("file")
    expect(submissionComments ?? []).toHaveLength(0)
  })

  it("leaves the finding in the body when one quoted run matches TWO deleted it() declarations (uniqueness gate)", () => {
    // Both deleted lines are LEFT-exclusive test declarations carrying the SAME
    // title, so the single quoted run yields >1 candidate. The uniqueness gate
    // (matchedLines.length > 1 → body) must fire — never guess between two
    // equally-valid anchors. (The "two deleted tests" test above quotes DISTINCT
    // titles, so only one line ever matches there and this branch was untested.)
    const finding = deletionFinding({
      path: DUP_TEST_PATH,
      body: `The test '${DUP_TITLE}' was deleted (it appeared twice), dropping coverage.`,
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: DELETE_DUP_TITLE_DIFF })

    expect(validatedFinding?.scope).toBe("file")
    expect(validatedFinding?.line).toBe(99999)
    expect(submissionComments ?? []).toHaveLength(0)
    const anchored = logSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" ? c[0].includes("pr-review-deletion-finding-anchored-left") : false,
    )
    expect(anchored).toHaveLength(0)
  })

  it("does NOT touch a non-testing pr-scope finding even when it quotes a deleted it() title", () => {
    const finding = deletionFinding({
      path: AUTH_TEST_PATH,
      category: "logic",
      scope: "pr",
      body: `The test '${EXPIRED_TITLE}' was deleted.`,
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: DELETE_ONE_TEST_DIFF })

    // Scope gate: only category:"testing" is eligible. A logic pr-scope finding
    // stays in the body untouched.
    expect(validatedFinding?.scope).toBe("pr")
    expect(submissionComments ?? []).toHaveLength(0)
  })

  it("leaves a testing finding in the body when its quoted title is not in any deleted line", () => {
    const finding = deletionFinding({
      path: AUTH_TEST_PATH,
      scope: "pr",
      body: "The test 'a title that was never deleted in this diff' was removed.",
    })
    const { validatedFinding, submissionComments } = validateAndBuild({ finding, diff: DELETE_ONE_TEST_DIFF })

    expect(validatedFinding?.scope).toBe("pr")
    expect(submissionComments ?? []).toHaveLength(0)
  })
})
