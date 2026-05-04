// Phase 4a: validate the diff parser that powers the orchestrator's
// post-synthesis line-validity check. Pure parser tests, no I/O.

import { describe, expect, it } from "vitest"
import {
  parseDiffToReviewablePositions,
  isPositionReviewable,
  deriveSide,
} from "../src/lib/diff-positions"

describe("parseDiffToReviewablePositions", () => {
  it("parses a simple added-line hunk", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,3 +10,4 @@",
      " unchanged context",
      "+added line",
      " more context",
      " and more",
    ].join("\n")
    const map = parseDiffToReviewablePositions(diff)
    const pos = map.get("src/foo.ts")
    expect(pos).toBeDefined()
    // Context at line 10 (RIGHT), added at 11 (RIGHT), context at 12 + 13 (RIGHT)
    expect(pos).toEqual([
      { line: 10, side: "RIGHT" },
      { line: 11, side: "RIGHT" },
      { line: 12, side: "RIGHT" },
      { line: 13, side: "RIGHT" },
    ])
  })

  it("parses a deletion-only hunk", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,3 +10,2 @@",
      " context",
      "-deleted line",
      " more context",
    ].join("\n")
    const pos = parseDiffToReviewablePositions(diff).get("src/foo.ts")
    expect(pos).toEqual([
      { line: 10, side: "RIGHT" }, // context line at new line 10
      { line: 11, side: "LEFT" },  // deleted line at OLD line 11
      { line: 11, side: "RIGHT" }, // context line at new line 11
    ])
  })

  it("disambiguates same-line-number across sides in a modified hunk", () => {
    // The exact case Codex flagged: deletion + addition at same numeric
    // line. Map<line, side> can't represent both — the {path, line, side}
    // shape makes them distinct positions.
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -42,1 +42,1 @@",
      "-old",
      "+new",
    ].join("\n")
    const pos = parseDiffToReviewablePositions(diff).get("src/foo.ts")
    expect(pos).toContainEqual({ line: 42, side: "LEFT" })
    expect(pos).toContainEqual({ line: 42, side: "RIGHT" })
    expect(pos).toHaveLength(2)
  })

  it("handles multiple hunks in the same file", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,3 @@",
      " a",
      "+b",
      " c",
      "@@ -50,1 +51,2 @@",
      " x",
      "+y",
    ].join("\n")
    const pos = parseDiffToReviewablePositions(diff).get("src/foo.ts")
    // First hunk: lines 1, 2, 3 on RIGHT
    expect(pos).toContainEqual({ line: 1, side: "RIGHT" })
    expect(pos).toContainEqual({ line: 2, side: "RIGHT" })
    expect(pos).toContainEqual({ line: 3, side: "RIGHT" })
    // Second hunk: lines 51, 52 on RIGHT
    expect(pos).toContainEqual({ line: 51, side: "RIGHT" })
    expect(pos).toContainEqual({ line: 52, side: "RIGHT" })
  })

  it("handles multiple files in one diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      " x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -10,1 +10,2 @@",
      " p",
      "+q",
    ].join("\n")
    const map = parseDiffToReviewablePositions(diff)
    expect(map.get("a.ts")).toEqual([
      { line: 1, side: "RIGHT" },
      { line: 2, side: "RIGHT" },
    ])
    expect(map.get("b.ts")).toEqual([
      { line: 10, side: "RIGHT" },
      { line: 11, side: "RIGHT" },
    ])
  })

  it("handles new-file diffs (--- /dev/null)", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,3 @@",
      "+line a",
      "+line b",
      "+line c",
    ].join("\n")
    const pos = parseDiffToReviewablePositions(diff).get("new.ts")
    expect(pos).toEqual([
      { line: 1, side: "RIGHT" },
      { line: 2, side: "RIGHT" },
      { line: 3, side: "RIGHT" },
    ])
  })

  it("skips fully-deleted files (+++ /dev/null)", () => {
    const diff = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line a",
      "-line b",
    ].join("\n")
    const map = parseDiffToReviewablePositions(diff)
    // No path tracked for fully-deleted files (Phase 4a doesn't anchor
    // comments on them).
    expect(map.has("old.ts")).toBe(false)
  })

  it("strips the leading 'b/' from new-side paths", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
    ].join("\n")
    const map = parseDiffToReviewablePositions(diff)
    // Path should be 'src/foo.ts', NOT 'b/src/foo.ts'.
    expect(map.has("src/foo.ts")).toBe(true)
    expect(map.has("b/src/foo.ts")).toBe(false)
  })

  it("returns an empty map for empty / undefined / non-string input", () => {
    expect(parseDiffToReviewablePositions("").size).toBe(0)
    expect(parseDiffToReviewablePositions(undefined as unknown as string).size).toBe(0)
    expect(parseDiffToReviewablePositions(null as unknown as string).size).toBe(0)
  })

  it("returns empty positions when only headers are present (binary diffs)", () => {
    const diff = [
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n")
    const map = parseDiffToReviewablePositions(diff)
    // No `+++ b/...` line → no path tracked.
    expect(map.size).toBe(0)
  })

  it("tolerates malformed hunk headers (no crash, just skips the hunk)", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ THIS IS NOT A VALID HUNK HEADER @@",
      "+x",  // would-be addition, but no hunk context
      "@@ -10,1 +10,1 @@",
      "+y",
    ].join("\n")
    const pos = parseDiffToReviewablePositions(diff).get("foo.ts")
    // Only the well-formed hunk's content gets recorded.
    expect(pos).toEqual([{ line: 10, side: "RIGHT" }])
  })
})

describe("isPositionReviewable", () => {
  const map = new Map([
    ["a.ts", [
      { line: 5, side: "RIGHT" as const },
      { line: 10, side: "LEFT" as const },
    ]],
  ])

  it("returns true for an exact match", () => {
    expect(isPositionReviewable(map, "a.ts", 5, "RIGHT")).toBe(true)
    expect(isPositionReviewable(map, "a.ts", 10, "LEFT")).toBe(true)
  })

  it("returns false when the side is wrong", () => {
    expect(isPositionReviewable(map, "a.ts", 5, "LEFT")).toBe(false)
    expect(isPositionReviewable(map, "a.ts", 10, "RIGHT")).toBe(false)
  })

  it("returns false for unknown path or line", () => {
    expect(isPositionReviewable(map, "missing.ts", 5, "RIGHT")).toBe(false)
    expect(isPositionReviewable(map, "a.ts", 999, "RIGHT")).toBe(false)
  })
})

describe("deriveSide", () => {
  it("prefers RIGHT when both sides exist at the same line", () => {
    const map = new Map([
      ["a.ts", [
        { line: 42, side: "LEFT" as const },
        { line: 42, side: "RIGHT" as const },
      ]],
    ])
    // Most findings comment on added/changed code; RIGHT is the
    // default unless only LEFT is reviewable.
    expect(deriveSide(map, "a.ts", 42)).toBe("RIGHT")
  })

  it("returns LEFT when only LEFT is reviewable", () => {
    const map = new Map([
      ["a.ts", [{ line: 42, side: "LEFT" as const }]],
    ])
    expect(deriveSide(map, "a.ts", 42)).toBe("LEFT")
  })

  it("returns null when no match at all", () => {
    const map = new Map([
      ["a.ts", [{ line: 5, side: "RIGHT" as const }]],
    ])
    expect(deriveSide(map, "a.ts", 999)).toBeNull()
    expect(deriveSide(map, "missing.ts", 5)).toBeNull()
  })
})
