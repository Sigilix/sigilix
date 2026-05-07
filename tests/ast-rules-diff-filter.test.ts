// ARC-181 — diff-filter tests.
//
// Codex MAJOR #6: changedLines counts ONLY new-side `+` lines.
// Replacement hunks contribute the `+` numeric line only, not the
// matching `-` old-side line. Pure-deletion hunks contribute
// nothing.

import { describe, it, expect } from "vitest"
import {
  buildChangedLines,
  nodeOverlapsChanged,
  findReviewPosition,
} from "../src/lib/ast-rules/diff-filter"
import { astFindingId, pathHash7 } from "../src/lib/ast-rules/finding-id"
import type { ReviewableMap } from "../src/lib/diff-positions"

const DIFF_ADD_BLOCK = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@
 const a = 1
 const b = 2
 const c = 3
+const d = eval("x")
+const e = 4
`

const DIFF_REPLACEMENT = `diff --git a/src/r.ts b/src/r.ts
--- a/src/r.ts
+++ b/src/r.ts
@@ -5,3 +5,3 @@
 first
-removed_line
+added_line
 last
`

const DIFF_PURE_DELETION = `diff --git a/src/del.ts b/src/del.ts
--- a/src/del.ts
+++ b/src/del.ts
@@ -1,3 +1,1 @@
 keep
-gone1
-gone2
`

const DIFF_FILE_DELETED = `diff --git a/src/zap.ts b/src/zap.ts
--- a/src/zap.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`

describe("buildChangedLines", () => {
  it("collects + lines from a simple add hunk", () => {
    const m = buildChangedLines(DIFF_ADD_BLOCK)
    expect(m.get("src/foo.ts")).toEqual(new Set([13, 14]))
  })

  it("REPLACEMENT HUNK: new-side line counted, old-side NOT (Codex MAJOR #6)", () => {
    const m = buildChangedLines(DIFF_REPLACEMENT)
    // The `-removed_line` is at old-side line 6, the `+added_line`
    // is at new-side line 6. Only the `+` line is in the set.
    expect(m.get("src/r.ts")).toEqual(new Set([6]))
  })

  it("PURE-DELETION HUNK contributes nothing on the new side", () => {
    const m = buildChangedLines(DIFF_PURE_DELETION)
    expect(m.get("src/del.ts")?.size ?? 0).toBe(0)
  })

  it("FILE DELETED: no entry created for new-side path", () => {
    const m = buildChangedLines(DIFF_FILE_DELETED)
    // The `+++ /dev/null` line means no new-side path; we don't
    // create an entry for `src/zap.ts` from the `--- a/src/zap.ts`
    // alone (we always trust the `+++ b/...` for the new path).
    expect(m.has("src/zap.ts")).toBe(false)
  })

  it("returns empty map on empty input", () => {
    expect(buildChangedLines("").size).toBe(0)
    expect(buildChangedLines(undefined as unknown as string).size).toBe(0)
  })
})

describe("nodeOverlapsChanged", () => {
  const m = new Map([["src/foo.ts", new Set([10, 12, 13])]])

  it("single-line node, line in set → true", () => {
    expect(nodeOverlapsChanged(m, "src/foo.ts", 10, 10)).toBe(true)
  })

  it("single-line node, line not in set → false", () => {
    expect(nodeOverlapsChanged(m, "src/foo.ts", 11, 11)).toBe(false)
  })

  it("multi-line node [10..15], partial overlap → true", () => {
    expect(nodeOverlapsChanged(m, "src/foo.ts", 10, 15)).toBe(true)
  })

  it("multi-line node entirely outside → false", () => {
    expect(nodeOverlapsChanged(m, "src/foo.ts", 20, 30)).toBe(false)
  })

  it("path not in map → false", () => {
    expect(nodeOverlapsChanged(m, "src/other.ts", 10, 10)).toBe(false)
  })
})

describe("findReviewPosition", () => {
  const reviewable: ReviewableMap = new Map([
    ["src/foo.ts", [{ line: 10, side: "RIGHT" }, { line: 11, side: "RIGHT" }]],
    ["src/old.ts", [{ line: 5, side: "LEFT" }]],
  ])

  it("returns RIGHT-side position when present", () => {
    expect(findReviewPosition(reviewable, "src/foo.ts", 10)).toEqual({ line: 10, side: "RIGHT" })
  })

  it("returns null when path missing", () => {
    expect(findReviewPosition(reviewable, "src/missing.ts", 10)).toBeNull()
  })

  it("returns null when line missing", () => {
    expect(findReviewPosition(reviewable, "src/foo.ts", 99)).toBeNull()
  })

  it("returns null when only LEFT-side position exists", () => {
    expect(findReviewPosition(reviewable, "src/old.ts", 5)).toBeNull()
  })
})

describe("astFindingId + pathHash7", () => {
  it("pathHash7 returns 7 hex chars", async () => {
    const h = await pathHash7("src/foo.ts")
    expect(h).toMatch(/^[0-9a-f]{7}$/)
  })

  it("different paths produce different hashes", async () => {
    const a = await pathHash7("a/foo.ts")
    const b = await pathHash7("b/foo.ts")
    expect(a).not.toBe(b)
  })

  it("astFindingId composes ruleId + pathHash7 + line", async () => {
    const id = await astFindingId("no-eval-call", "src/foo.ts", 42)
    expect(id).toMatch(/^ast\/no-eval-call\/[0-9a-f]{7}\/42$/)
  })

  it("astFindingId is stable for the same inputs", async () => {
    const a = await astFindingId("no-eval-call", "src/foo.ts", 42)
    const b = await astFindingId("no-eval-call", "src/foo.ts", 42)
    expect(a).toBe(b)
  })
})
