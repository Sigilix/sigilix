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
  CI_SUGGESTION_MARKER,
} from "../src/lib/ci-suggestions"

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

  it("dedupes by path:line — first wins, the rest fall back", () => {
    const { anchorable, unanchorable } = partitionCiPatches(
      [patch("src/a.ts", 2, "first"), patch("src/a.ts", 2, "second")],
      reviewable,
    )
    expect(anchorable).toHaveLength(1)
    expect(anchorable[0]?.replacement).toBe("first")
    expect(unanchorable).toHaveLength(1)
  })

  it("partitions a mix, preserving order within each bucket", () => {
    const { anchorable, unanchorable } = partitionCiPatches(
      [patch("src/a.ts", 1), patch("src/a.ts", 99), patch("src/a.ts", 3)],
      reviewable,
    )
    expect(anchorable.map((p) => p.line)).toEqual([1, 3])
    expect(unanchorable.map((p) => p.line)).toEqual([99])
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
