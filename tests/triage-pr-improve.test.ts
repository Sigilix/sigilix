// ARC-179: `/sigilix improve` parser + suggestion filter.

import { describe, it, expect } from "vitest"

import {
  parsePrImproveResponse,
  filterAnchorableSuggestions,
  hasSuggestionBlock,
  isContiguousRightRange,
  renderInlineFallbackBody,
  type PrImproveSuggestion,
} from "../src/lib/triage-pr-improve"
import type { ReviewableMap } from "../src/lib/diff-positions"

describe("hasSuggestionBlock", () => {
  it("recognizes a basic suggestion block", () => {
    const body = "Use a clearer name.\n\n```suggestion\nconst userName = ...\n```"
    expect(hasSuggestionBlock(body)).toBe(true)
  })

  it("rejects an empty suggestion block", () => {
    const body = "Use a clearer name.\n\n```suggestion\n\n```"
    expect(hasSuggestionBlock(body)).toBe(false)
  })

  it("rejects a body with no fenced suggestion block", () => {
    expect(hasSuggestionBlock("Just prose, no code.")).toBe(false)
  })

  it("ignores fenced blocks with non-`suggestion` tags", () => {
    expect(hasSuggestionBlock("```ts\nconst x = 1\n```")).toBe(false)
  })

  it("returns false on non-string input", () => {
    // @ts-expect-error — runtime guard
    expect(hasSuggestionBlock(undefined)).toBe(false)
  })
})

describe("parsePrImproveResponse", () => {
  it("parses a clean verdict with one suggestion", () => {
    const json = JSON.stringify({
      summary: "One naming improvement found.",
      suggestions: [
        {
          path: "src/foo.ts",
          line: 42,
          category: "naming",
          headline: "Rename `x` to `count`",
          body: "Clearer intent.\n\n```suggestion\nconst count = items.length\n```",
        },
      ],
    })
    const v = parsePrImproveResponse(json)
    expect(v).not.toBeNull()
    expect(v!.summary).toBe("One naming improvement found.")
    expect(v!.suggestions).toHaveLength(1)
    expect(v!.suggestions[0]!.path).toBe("src/foo.ts")
    expect(v!.suggestions[0]!.line).toBe(42)
    expect(v!.suggestions[0]!.category).toBe("naming")
  })

  it("returns null for missing summary", () => {
    expect(parsePrImproveResponse('{"suggestions": []}')).toBeNull()
  })

  it("returns null for unparseable text", () => {
    expect(parsePrImproveResponse("not json at all")).toBeNull()
  })

  it("falls back to `clarity` when category is unknown", () => {
    const json = JSON.stringify({
      summary: "x",
      suggestions: [
        {
          path: "a.ts", line: 1, category: "blorp",
          headline: "h", body: "b\n```suggestion\nfoo\n```",
        },
      ],
    })
    expect(parsePrImproveResponse(json)!.suggestions[0]!.category).toBe("clarity")
  })

  it("drops malformed suggestions but keeps good ones", () => {
    const json = JSON.stringify({
      summary: "x",
      suggestions: [
        { path: "", line: 1, category: "naming", headline: "h", body: "b" }, // empty path
        { path: "a.ts", line: 0, category: "naming", headline: "h", body: "b" }, // bad line
        { path: "a.ts", line: 5, category: "naming", headline: "h", body: "b" }, // valid
      ],
    })
    const v = parsePrImproveResponse(json)
    expect(v!.suggestions).toHaveLength(1)
    expect(v!.suggestions[0]!.line).toBe(5)
  })

  it("caps suggestions at 5 even when the model returns more", () => {
    const tooMany = Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}.ts`, line: i + 1, category: "naming",
      headline: "h", body: "b\n```suggestion\nx\n```",
    }))
    const json = JSON.stringify({ summary: "x", suggestions: tooMany })
    expect(parsePrImproveResponse(json)!.suggestions).toHaveLength(5)
  })

  it("preserves valid startLine and drops invalid ones", () => {
    const json = JSON.stringify({
      summary: "x",
      suggestions: [
        { path: "a.ts", line: 10, startLine: 8, category: "naming", headline: "h", body: "b" },
        { path: "b.ts", line: 5, startLine: 5, category: "naming", headline: "h", body: "b" }, // equal — drop startLine
        { path: "c.ts", line: 5, startLine: 9, category: "naming", headline: "h", body: "b" }, // > line — drop startLine
      ],
    })
    const v = parsePrImproveResponse(json)!
    expect(v.suggestions[0]!.startLine).toBe(8)
    expect(v.suggestions[1]!.startLine).toBeUndefined()
    expect(v.suggestions[2]!.startLine).toBeUndefined()
  })
})

describe("filterAnchorableSuggestions", () => {
  function makeReviewable(entries: Array<{ path: string; line: number; side: "LEFT" | "RIGHT" }>): ReviewableMap {
    const m: ReviewableMap = new Map()
    for (const e of entries) {
      const arr = m.get(e.path) ?? []
      arr.push({ line: e.line, side: e.side })
      m.set(e.path, arr)
    }
    return m
  }

  const okSuggestion = (overrides: Partial<PrImproveSuggestion> = {}): PrImproveSuggestion => ({
    path: "src/foo.ts",
    line: 10,
    category: "naming",
    headline: "h",
    body: "Reason.\n\n```suggestion\nnew code\n```",
    ...overrides,
  })

  it("keeps suggestions whose anchor exists in the diff", () => {
    const reviewable = makeReviewable([{ path: "src/foo.ts", line: 10, side: "RIGHT" }])
    const out = filterAnchorableSuggestions([okSuggestion()], reviewable)
    expect(out).toHaveLength(1)
  })

  it("drops suggestions whose anchor isn't in the diff", () => {
    const reviewable = makeReviewable([{ path: "src/foo.ts", line: 99, side: "RIGHT" }])
    const out = filterAnchorableSuggestions([okSuggestion({ line: 10 })], reviewable)
    expect(out).toHaveLength(0)
  })

  it("drops suggestions with no `\\`\\`\\`suggestion` block", () => {
    const reviewable = makeReviewable([{ path: "src/foo.ts", line: 10, side: "RIGHT" }])
    const out = filterAnchorableSuggestions(
      [okSuggestion({ body: "Just prose, no patch." })],
      reviewable,
    )
    expect(out).toHaveLength(0)
  })

  it("dedupes suggestions targeting the same anchor", () => {
    const reviewable = makeReviewable([{ path: "src/foo.ts", line: 10, side: "RIGHT" }])
    const out = filterAnchorableSuggestions(
      [okSuggestion(), okSuggestion({ headline: "duplicate" })],
      reviewable,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.headline).toBe("h")
  })

  it("treats single-line and multi-line ranges as distinct anchors", () => {
    const reviewable = makeReviewable([
      { path: "src/foo.ts", line: 10, side: "RIGHT" },
      { path: "src/foo.ts", line: 11, side: "RIGHT" },
    ])
    const out = filterAnchorableSuggestions(
      [
        okSuggestion({ line: 10 }),
        okSuggestion({ line: 11, startLine: 10 }),
      ],
      reviewable,
    )
    expect(out).toHaveLength(2)
  })

  it("returns empty when input is empty", () => {
    expect(filterAnchorableSuggestions([], new Map())).toEqual([])
  })

  it("drops LEFT-side anchors (suggestions only apply to added/changed lines)", () => {
    // The diff has line 10 as LEFT (deleted line) and no RIGHT for it.
    const reviewable = makeReviewable([{ path: "src/foo.ts", line: 10, side: "LEFT" }])
    const out = filterAnchorableSuggestions([okSuggestion({ line: 10 })], reviewable)
    expect(out).toHaveLength(0)
  })

  it("drops suggestions whose startLine isn't in-diff", () => {
    // line 10 is a valid RIGHT anchor, but startLine 5 is NOT in the
    // diff at all — would 422 the whole review.
    const reviewable = makeReviewable([
      { path: "src/foo.ts", line: 10, side: "RIGHT" },
    ])
    const out = filterAnchorableSuggestions(
      [okSuggestion({ line: 10, startLine: 5 })],
      reviewable,
    )
    expect(out).toHaveLength(0)
  })

  it("drops suggestions whose startLine resolves to LEFT side", () => {
    // line 10 is RIGHT (good), startLine 8 exists but only on LEFT.
    // GitHub requires both ends of a multi-line range to be on the
    // same side, so drop.
    const reviewable = makeReviewable([
      { path: "src/foo.ts", line: 10, side: "RIGHT" },
      { path: "src/foo.ts", line: 8, side: "LEFT" },
    ])
    const out = filterAnchorableSuggestions(
      [okSuggestion({ line: 10, startLine: 8 })],
      reviewable,
    )
    expect(out).toHaveLength(0)
  })

  it("keeps multi-line suggestions when both ends anchor RIGHT", () => {
    const reviewable = makeReviewable([
      { path: "src/foo.ts", line: 10, side: "RIGHT" },
      { path: "src/foo.ts", line: 8, side: "RIGHT" },
      { path: "src/foo.ts", line: 9, side: "RIGHT" },
    ])
    const out = filterAnchorableSuggestions(
      [okSuggestion({ line: 10, startLine: 8 })],
      reviewable,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.startLine).toBe(8)
  })

  it("drops multi-line suggestions whose range spans a missing intermediate line (CR PR #61)", () => {
    // Line 10 + line 13 are RIGHT-reviewable, but lines 11-12 are
    // NOT in the diff at all. This is the multi-hunk case CodeRabbit
    // flagged: validating only the endpoints would let this through
    // and GitHub would 422 the whole batch.
    const reviewable = makeReviewable([
      { path: "src/foo.ts", line: 10, side: "RIGHT" },
      { path: "src/foo.ts", line: 13, side: "RIGHT" },
    ])
    const out = filterAnchorableSuggestions(
      [okSuggestion({ line: 13, startLine: 10 })],
      reviewable,
    )
    expect(out).toHaveLength(0)
  })
})

describe("isContiguousRightRange (CR PR #61 — multi-hunk guard)", () => {
  function makeReviewable(entries: Array<{ path: string; line: number; side: "LEFT" | "RIGHT" }>): ReviewableMap {
    const m: ReviewableMap = new Map()
    for (const e of entries) {
      const arr = m.get(e.path) ?? []
      arr.push({ line: e.line, side: e.side })
      m.set(e.path, arr)
    }
    return m
  }

  it("accepts a fully-contiguous RIGHT range", () => {
    const r = makeReviewable([
      { path: "f.ts", line: 5, side: "RIGHT" },
      { path: "f.ts", line: 6, side: "RIGHT" },
      { path: "f.ts", line: 7, side: "RIGHT" },
    ])
    expect(isContiguousRightRange(r, "f.ts", 5, 7)).toBe(true)
  })

  it("rejects a range with a gap", () => {
    const r = makeReviewable([
      { path: "f.ts", line: 5, side: "RIGHT" },
      { path: "f.ts", line: 7, side: "RIGHT" },
    ])
    expect(isContiguousRightRange(r, "f.ts", 5, 7)).toBe(false)
  })

  it("rejects a range where an intermediate line is LEFT-only", () => {
    // Line 6 is a deleted line (LEFT) — `\`\`\`suggestion` block can't
    // span it; treat as not-contiguous on RIGHT.
    const r = makeReviewable([
      { path: "f.ts", line: 5, side: "RIGHT" },
      { path: "f.ts", line: 6, side: "LEFT" },
      { path: "f.ts", line: 7, side: "RIGHT" },
    ])
    expect(isContiguousRightRange(r, "f.ts", 5, 7)).toBe(false)
  })

  it("accepts a single-line range (startLine === line)", () => {
    const r = makeReviewable([{ path: "f.ts", line: 5, side: "RIGHT" }])
    expect(isContiguousRightRange(r, "f.ts", 5, 5)).toBe(true)
  })

  it("rejects an inverted range (startLine > line)", () => {
    const r = makeReviewable([
      { path: "f.ts", line: 5, side: "RIGHT" },
      { path: "f.ts", line: 6, side: "RIGHT" },
    ])
    expect(isContiguousRightRange(r, "f.ts", 6, 5)).toBe(false)
  })

  it("rejects when path isn't in the map", () => {
    const r = makeReviewable([{ path: "f.ts", line: 5, side: "RIGHT" }])
    expect(isContiguousRightRange(r, "g.ts", 5, 5)).toBe(false)
  })
})

describe("renderInlineFallbackBody (ARC-179 422 fallback)", () => {
  it("renders the summary, anchor, and body for each suggestion", () => {
    const out = renderInlineFallbackBody(
      "Two naming wins.",
      [
        {
          path: "src/foo.ts",
          line: 10,
          category: "naming",
          headline: "Rename `x` → `count`",
          body: "Reason.\n\n```suggestion\nconst count = items.length\n```",
        },
        {
          path: "src/bar.ts",
          line: 25,
          startLine: 23,
          category: "clarity",
          headline: "Flatten ternary",
          body: "Easier to scan.\n\n```suggestion\nif (cond) return a\nreturn b\n```",
        },
      ],
      "abcdef1234567890",
    )
    expect(out).toContain("Two naming wins.")
    expect(out).toContain("`naming`: Rename `x` → `count`")
    expect(out).toContain("src/foo.ts:10")
    expect(out).toContain("src/bar.ts:23-25")
    expect(out).toContain("`abcdef1`")
  })

  it("works with an empty suggestions list (defensive)", () => {
    const out = renderInlineFallbackBody("Nothing.", [], "deadbeefcafe")
    expect(typeof out).toBe("string")
    expect(out).toContain("Nothing.")
    expect(out).toContain("`deadbee`")
  })
})
