// ARC-181 — diff-filter tests.
//
// Codex MAJOR #6: changedLines counts ONLY new-side `+` lines.
// Replacement hunks contribute the `+` numeric line only, not the
// matching `-` old-side line. Pure-deletion hunks contribute
// nothing.

import { describe, it, expect } from "vitest"
import {
  buildAddedLineTextByLine,
  buildChangedLines,
  buildDeletedLineTextByLine,
  nodeOverlapsChanged,
  findReviewPosition,
} from "@/features/ast-rules/domain/diff-filter"
import { astFindingId, pathHash7 } from "@/features/ast-rules/domain/finding-id"
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

const DIFF_NEW_FILE = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+line1
+line2
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

describe("buildAddedLineTextByLine (SIG-127)", () => {
  it("maps each +-line's new-side number to its text (marker stripped)", () => {
    const m = buildAddedLineTextByLine(DIFF_ADD_BLOCK)
    const fileMap = m.get("src/foo.ts")
    expect(fileMap?.get(13)).toBe('const d = eval("x")')
    expect(fileMap?.get(14)).toBe("const e = 4")
    // Context lines are NOT captured.
    expect(fileMap?.has(10)).toBe(false)
  })

  it("REPLACEMENT HUNK: captures only the new-side +-line text", () => {
    const m = buildAddedLineTextByLine(DIFF_REPLACEMENT)
    const fileMap = m.get("src/r.ts")
    expect(fileMap?.get(6)).toBe("added_line")
    expect(fileMap?.size).toBe(1)
  })

  it("PURE-DELETION HUNK captures nothing on the new side", () => {
    const m = buildAddedLineTextByLine(DIFF_PURE_DELETION)
    expect(m.get("src/del.ts")?.size ?? 0).toBe(0)
  })

  it("FILE DELETED: no entry created for new-side path", () => {
    const m = buildAddedLineTextByLine(DIFF_FILE_DELETED)
    expect(m.has("src/zap.ts")).toBe(false)
  })

  it("preserves leading indentation so structural lines stay classifiable", () => {
    const diff = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,3 @@
 head
+  return batch(ids)
+  }
`
    const fileMap = buildAddedLineTextByLine(diff).get("src/b.ts")
    expect(fileMap?.get(2)).toBe("  return batch(ids)")
    expect(fileMap?.get(3)).toBe("  }")
  })

  it("returns empty map on empty input", () => {
    expect(buildAddedLineTextByLine("").size).toBe(0)
    expect(buildAddedLineTextByLine(undefined as unknown as string).size).toBe(0)
  })
})

describe("buildDeletedLineTextByLine (SIG-349)", () => {
  it("maps each --line's old-side number to its text", () => {
    const m = buildDeletedLineTextByLine(DIFF_PURE_DELETION)
    const fileMap = m.get("src/del.ts")
    expect(fileMap?.get(2)).toBe("gone1")
    expect(fileMap?.get(3)).toBe("gone2")
    expect(fileMap?.has(1)).toBe(false)
  })

  it("FILE DELETED: uses the old-side path", () => {
    const m = buildDeletedLineTextByLine(DIFF_FILE_DELETED)
    const fileMap = m.get("src/zap.ts")
    expect(fileMap?.get(1)).toBe("line1")
    expect(fileMap?.get(2)).toBe("line2")
  })

  it("REPLACEMENT HUNK: captures only old-side deleted text", () => {
    const m = buildDeletedLineTextByLine(DIFF_REPLACEMENT)
    const fileMap = m.get("src/r.ts")
    expect(fileMap?.get(6)).toBe("removed_line")
    expect(fileMap?.size).toBe(1)
  })

  it("resets old-side numbering across multiple hunks in the same file", () => {
    const diff = `diff --git a/src/multi.ts b/src/multi.ts
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -2,2 +2,1 @@
 keep
-removed_first_hunk
@@ -20,1 +19,2 @@
 context
+inserted_second_hunk
@@ -40,2 +40,1 @@
 keep
-removed_third_hunk
`
    const m = buildDeletedLineTextByLine(diff)
    const fileMap = m.get("src/multi.ts")

    expect(fileMap?.get(3)).toBe("removed_first_hunk")
    expect(fileMap?.get(41)).toBe("removed_third_hunk")
    expect(fileMap?.has(20)).toBe(false)
  })

  it("NEW FILE: no old-side deletion map is created", () => {
    const m = buildDeletedLineTextByLine(DIFF_NEW_FILE)

    expect(m.size).toBe(0)
  })

  it("returns empty map on empty input", () => {
    expect(buildDeletedLineTextByLine("").size).toBe(0)
    expect(buildDeletedLineTextByLine(undefined as unknown as string).size).toBe(0)
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
