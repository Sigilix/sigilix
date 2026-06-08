// SIG-333: CI-triage inline suggestion anchoring + rendering (pure helpers).

import { describe, expect, it } from "vitest"
import { parseDiffToReviewablePositions } from "../src/lib/diff-positions"
import type { CiTriagePatch } from "../src/lib/triage-ci"
import {
  parseCiSuggestionsMode,
  partitionCiPatches,
  renderCiSuggestionBody,
  buildCiSuggestionReview,
  renderUnanchorableCiPatches,
  hasExistingCiSuggestion,
  planCiSuggestions,
  submitCiSuggestionReview,
  CI_SUGGESTION_MARKER,
  type CiSuggestionClient,
} from "../src/lib/ci-suggestions"
import { GitHubHttpError, type SubmitReviewBody } from "../src/lib/github"

// A small unified diff: line 2 is added; lines 1 and 3 are context. All
// three are RIGHT-reviewable in the new file.
const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1
+const y = 2
 const z = 3
`

const patch = (path: string, line: number, replacement = "const y = 2;"): CiTriagePatch => ({
  path,
  line,
  replacement,
})

describe("parseCiSuggestionsMode", () => {
  it("defaults to shadow for unset / unknown values", () => {
    expect(parseCiSuggestionsMode(undefined)).toBe("shadow")
    expect(parseCiSuggestionsMode("")).toBe("shadow")
    expect(parseCiSuggestionsMode("on")).toBe("shadow")
    expect(parseCiSuggestionsMode("enforced")).toBe("shadow")
  })
  it("returns enforce only for the literal 'enforce' (trim + case-insensitive)", () => {
    expect(parseCiSuggestionsMode("enforce")).toBe("enforce")
    expect(parseCiSuggestionsMode("  ENFORCE ")).toBe("enforce")
  })
})

describe("partitionCiPatches", () => {
  const reviewable = parseDiffToReviewablePositions(DIFF)

  it("anchors a patch on a RIGHT-reviewable diff line", () => {
    const { anchorable, unanchorable } = partitionCiPatches([patch("src/a.ts", 2)], reviewable)
    expect(anchorable).toHaveLength(1)
    expect(unanchorable).toHaveLength(0)
  })

  it("falls back a patch whose line is not in the diff", () => {
    const { anchorable, unanchorable } = partitionCiPatches([patch("src/a.ts", 99)], reviewable)
    expect(anchorable).toHaveLength(0)
    expect(unanchorable).toHaveLength(1)
  })

  it("falls back a patch whose file is not in the diff", () => {
    const { anchorable, unanchorable } = partitionCiPatches([patch("src/other.ts", 1)], reviewable)
    expect(anchorable).toHaveLength(0)
    expect(unanchorable).toHaveLength(1)
  })

  it("dedupes by path:line — first wins, later duplicates are dropped entirely", () => {
    const { anchorable, unanchorable } = partitionCiPatches(
      [patch("src/a.ts", 2, "first"), patch("src/a.ts", 2, "second")],
      reviewable,
    )
    expect(anchorable).toHaveLength(1)
    expect(anchorable[0]?.replacement).toBe("first")
    expect(unanchorable).toHaveLength(0) // the duplicate is dropped, not re-shown in the sticky
  })

  it("partitions a mix, preserving order within each bucket", () => {
    const { anchorable, unanchorable } = partitionCiPatches(
      [patch("src/a.ts", 1), patch("src/a.ts", 99), patch("src/a.ts", 3)],
      reviewable,
    )
    expect(anchorable.map((p) => p.line)).toEqual([1, 3])
    expect(unanchorable.map((p) => p.line)).toEqual([99])
  })

  it("first-wins is strict: an un-anchorable first patch claims the line; a later anchorable duplicate is dropped, not posted", () => {
    const { anchorable, unanchorable } = partitionCiPatches(
      [patch("src/a.ts", 2, "x ``` y"), patch("src/a.ts", 2, "clean")],
      reviewable,
    )
    expect(anchorable).toHaveLength(0) // the second (anchorable) does NOT post inline
    expect(unanchorable).toHaveLength(1) // only the first; the duplicate is dropped
  })
})

describe("renderCiSuggestionBody", () => {
  it("wraps the replacement in a committable suggestion block with the dedup marker", () => {
    const body = renderCiSuggestionBody(patch("src/a.ts", 2, "const y = 2;"))
    expect(body).toContain(CI_SUGGESTION_MARKER)
    expect(body).toContain("```suggestion\nconst y = 2;\n```")
  })
})

describe("buildCiSuggestionReview", () => {
  it("returns null when there are no anchorable patches", () => {
    expect(buildCiSuggestionReview([], "abc123")).toBeNull()
  })

  it("builds a COMMENT review with one RIGHT-side suggestion comment per patch", () => {
    const review = buildCiSuggestionReview([patch("src/a.ts", 2), patch("src/a.ts", 3)], "deadbeef")
    expect(review).not.toBeNull()
    expect(review?.event).toBe("COMMENT")
    expect(review?.commit_id).toBe("deadbeef")
    expect(review?.comments).toHaveLength(2)
    expect(review?.comments?.[0]).toMatchObject({ path: "src/a.ts", line: 2, side: "RIGHT" })
    expect(review?.comments?.[0]?.body).toContain("```suggestion")
    expect(review?.body).toContain("2 apply-able fixes")
  })

  it("singularizes the header for a single fix", () => {
    const review = buildCiSuggestionReview([patch("src/a.ts", 2)], "x")
    expect(review?.body).toContain("1 apply-able fix.")
  })
})

describe("renderUnanchorableCiPatches", () => {
  it("returns the empty string when there are none", () => {
    expect(renderUnanchorableCiPatches([])).toBe("")
  })
  it("lists each patch with path:line and a fenced replacement", () => {
    const out = renderUnanchorableCiPatches([patch("src/x.ts", 7, "fix me")])
    expect(out).toContain("`src/x.ts:7`")
    expect(out).toContain("```\nfix me\n```")
    expect(out).toContain("apply manually")
  })
})

describe("hasExistingCiSuggestion", () => {
  it("detects the marker in any body", () => {
    expect(hasExistingCiSuggestion(["nope", null, `x ${CI_SUGGESTION_MARKER} y`])).toBe(true)
  })
  it("returns false when no body carries the marker", () => {
    expect(hasExistingCiSuggestion(["a", "b", null, undefined])).toBe(false)
  })
})

describe("planCiSuggestions", () => {
  const reviewable = parseDiffToReviewablePositions(DIFF)

  it("shadow: no inline review and no sticky suffix (sticky stays byte-identical), but still counts", () => {
    const plan = planCiSuggestions({
      patches: [patch("src/a.ts", 2), patch("src/a.ts", 99)],
      reviewable,
      mode: "shadow",
      sensitive: false,
      headSha: "h",
    })
    expect(plan.review).toBeNull()
    expect(plan.stickySuffix).toBe("")
    expect(plan.anchorableCount).toBe(1)
    expect(plan.unanchorableCount).toBe(1)
  })

  it("enforce + anchorable: builds the inline review, no sticky suffix", () => {
    const plan = planCiSuggestions({
      patches: [patch("src/a.ts", 2)],
      reviewable,
      mode: "enforce",
      sensitive: false,
      headSha: "h",
    })
    expect(plan.review).not.toBeNull()
    expect(plan.review?.comments).toHaveLength(1)
    expect(plan.stickySuffix).toBe("")
  })

  it("enforce + off-diff patch: no inline review, the patch shows in the sticky suffix", () => {
    const plan = planCiSuggestions({
      patches: [patch("src/a.ts", 99, "fix off-diff")],
      reviewable,
      mode: "enforce",
      sensitive: false,
      headSha: "h",
    })
    expect(plan.review).toBeNull()
    expect(plan.stickySuffix).toContain("`src/a.ts:99`")
    expect(plan.stickySuffix).toContain("fix off-diff")
  })

  it("enforce + sensitive repo: gated — no inline review, no sticky suffix", () => {
    const plan = planCiSuggestions({
      patches: [patch("src/a.ts", 2)],
      reviewable,
      mode: "enforce",
      sensitive: true,
      headSha: "h",
    })
    expect(plan.review).toBeNull()
    expect(plan.stickySuffix).toBe("")
  })

  it("enforce + mix: inline review for the anchorable patch, sticky suffix for the rest", () => {
    const plan = planCiSuggestions({
      patches: [patch("src/a.ts", 2, "inline me"), patch("src/a.ts", 99, "manual me")],
      reviewable,
      mode: "enforce",
      sensitive: false,
      headSha: "h",
    })
    expect(plan.review?.comments).toHaveLength(1)
    expect(plan.review?.comments?.[0]?.body).toContain("inline me")
    expect(plan.stickySuffix).toContain("manual me")
    expect(plan.anchorableCount).toBe(1)
    expect(plan.unanchorableCount).toBe(1)
  })
})

describe("fence safety", () => {
  const reviewable = parseDiffToReviewablePositions(DIFF)

  it("routes a patch whose replacement contains ``` to the un-anchorable fallback", () => {
    const { anchorable, unanchorable } = partitionCiPatches(
      [patch("src/a.ts", 2, "before ``` after")],
      reviewable,
    )
    expect(anchorable).toHaveLength(0)
    expect(unanchorable).toHaveLength(1)
  })

  it("renders the sticky fallback with a fence longer than any backtick run", () => {
    const out = renderUnanchorableCiPatches([patch("src/a.ts", 9, "a ``` b")])
    // 4-backtick fence so the inner ``` can't close the block early.
    expect(out).toContain("````")
  })
})

function fakeClient(opts: {
  prior?: Array<{ body: string }>
  listThrows?: boolean
  bulkError?: unknown
  perCommentThrows?: (i: number) => boolean
}): { client: CiSuggestionClient; calls: SubmitReviewBody[] } {
  const calls: SubmitReviewBody[] = []
  const client: CiSuggestionClient = {
    listPullRequestReviewComments() {
      if (opts.listThrows) return Promise.reject(new Error("list boom"))
      return Promise.resolve(opts.prior ?? [])
    },
    submitReview(_owner, _repo, _pr, review) {
      const index = calls.length // 0 = bulk, 1.. = per-comment retries
      calls.push(review)
      if (index === 0 && opts.bulkError !== undefined) return Promise.reject(opts.bulkError)
      if (index > 0 && opts.perCommentThrows?.(index - 1)) {
        return Promise.reject(new GitHubHttpError(422, "Validation Failed: bad anchor"))
      }
      return Promise.resolve({ id: index + 1, state: "COMMENTED" })
    },
  }
  return { client, calls }
}

const http422 = (): GitHubHttpError => new GitHubHttpError(422, "Validation Failed: pull_request_review_thread.line")

describe("submitCiSuggestionReview", () => {
  const review = buildCiSuggestionReview(
    [patch("src/a.ts", 1), patch("src/a.ts", 2), patch("src/a.ts", 3)],
    "head",
  ) as SubmitReviewBody

  it("dedup: skips entirely when a CI suggestion already exists on the PR", async () => {
    const { client, calls } = fakeClient({ prior: [{ body: `prior ${CI_SUGGESTION_MARKER}` }] })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 0, skip: "already-posted" })
    expect(calls).toHaveLength(0)
  })

  it("skips when the dedup listing fails (can't verify → don't risk a duplicate)", async () => {
    const { client, calls } = fakeClient({ listThrows: true })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 0, skip: "dedup-check-failed" })
    expect(calls).toHaveLength(0)
  })

  it("happy path: posts the bulk review in a single call", async () => {
    const { client, calls } = fakeClient({})
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 3, skip: null })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.comments).toHaveLength(3)
  })

  it("split-on-422: bulk rejected, every comment recovered individually", async () => {
    const { client, calls } = fakeClient({ bulkError: http422() })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 3, skip: "split-recovered" })
    expect(calls).toHaveLength(4) // 1 failed bulk + 3 per-comment
    expect(calls[1]?.comments).toHaveLength(1)
  })

  it("split-on-422: one bad anchor only drops itself (partial)", async () => {
    const { client } = fakeClient({ bulkError: http422(), perCommentThrows: (i) => i === 1 })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r.posted).toBe(2)
    expect(r.skip).toBe("partial")
  })

  it("reports submit-failed when nothing posts", async () => {
    const { client } = fakeClient({ bulkError: http422(), perCommentThrows: () => true })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 0, skip: "submit-failed" })
  })

  it("does NOT split-retry on a non-422 HTTP failure — fails fast without amplifying", async () => {
    const { client, calls } = fakeClient({ bulkError: new GitHubHttpError(500, "server error") })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 0, skip: "submit-failed" })
    expect(calls).toHaveLength(1) // only the bulk attempt; no per-comment retries
  })

  it("does NOT split-retry on a non-HTTP error (network/unknown)", async () => {
    const { client, calls } = fakeClient({ bulkError: new Error("socket hang up") })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 0, skip: "submit-failed" })
    expect(calls).toHaveLength(1)
  })

  it("does NOT split-retry on a 422 that is not a validation failure (e.g. secondary rate limit)", async () => {
    const { client, calls } = fakeClient({
      bulkError: new GitHubHttpError(422, "You have exceeded a secondary rate limit"),
    })
    const r = await submitCiSuggestionReview(client, "o", "r", 1, review)
    expect(r).toEqual({ posted: 0, skip: "submit-failed" })
    expect(calls).toHaveLength(1) // no amplification — single bulk attempt only
  })
})
