// ARC-192 — diff-packing helpers: split + estimate + pack.

import { describe, it, expect } from "vitest"

import {
  splitDiffByFile,
  estimateTokens,
  packFilesIntoBatches,
  batchToDiff,
  riskOrderFiles,
  isLowReviewPriority,
  DEFAULT_MAX_DIFF_TOKENS_PER_CALL,
} from "@/src/lib/diff-packing"

describe("riskOrderFiles (SIG-414)", () => {
  const f = (path: string) => ({ path, body: `// ${path}`, charCount: path.length + 3 })
  const isRisky = (p: string) => p.includes("auth") || p.includes("secret")

  it("moves high-risk files to the front so they land in batch[0]", () => {
    const ordered = riskOrderFiles([f("a.ts"), f("auth.ts"), f("b.ts")], isRisky)
    expect(ordered.map((x) => x.path)).toEqual(["auth.ts", "a.ts", "b.ts"])
  })

  it("is stable — preserves original order within each tier", () => {
    const ordered = riskOrderFiles([f("a.ts"), f("auth.ts"), f("b.ts"), f("secret.ts")], isRisky)
    expect(ordered.map((x) => x.path)).toEqual(["auth.ts", "secret.ts", "a.ts", "b.ts"])
  })

  it("returns the input UNCHANGED (same ref) when no file is high-risk — byte-identical common case", () => {
    const input = [f("a.ts"), f("b.ts")]
    expect(riskOrderFiles(input, isRisky)).toBe(input)
  })

  it("returns the input UNCHANGED (same ref) when every file is high-risk", () => {
    const input = [f("auth.ts"), f("secret.ts")]
    expect(riskOrderFiles(input, isRisky)).toBe(input)
  })

  it("handles empty input", () => {
    expect(riskOrderFiles([], isRisky)).toEqual([])
  })

  it("returns a single file unchanged (same ref)", () => {
    const input = [f("auth.ts")]
    expect(riskOrderFiles(input, isRisky)).toBe(input)
  })

  // SIG-440 follow-up: sink low-priority (test/golden) files to the BACK so
  // production source fills batch[0] first on a big PR.
  it("sinks test/golden files to the back, behind production source", () => {
    const ordered = riskOrderFiles(
      [f("a.test.ts"), f("src/validation-walk.ts"), f("auth.ts"), f("e2e/validation-matrix/x.json")],
      isRisky,
    )
    expect(ordered.map((x) => x.path)).toEqual([
      "auth.ts", // high-risk source
      "src/validation-walk.ts", // ordinary source
      "a.test.ts", // low-priority (test) → back
      "e2e/validation-matrix/x.json", // low-priority (golden) → back
    ])
  })

  it("reorders even with NO high-risk file — production source ahead of test churn (the #579 case)", () => {
    const ordered = riskOrderFiles([f("a.test.ts"), f("src/foo.ts"), f("b.test.ts")], isRisky)
    expect(ordered.map((x) => x.path)).toEqual(["src/foo.ts", "a.test.ts", "b.test.ts"])
  })

  it("a high-risk-keyword TEST file still sinks to the back (a test of a risky file is a test)", () => {
    const ordered = riskOrderFiles([f("auth.test.ts"), f("src/foo.ts")], isRisky)
    expect(ordered.map((x) => x.path)).toEqual(["src/foo.ts", "auth.test.ts"])
  })

  it("returns the input UNCHANGED (same ref) when every file is low-priority", () => {
    const input = [f("a.test.ts"), f("b.test.ts")]
    expect(riskOrderFiles(input, isRisky)).toBe(input)
  })
})

describe("isLowReviewPriority (SIG-440 follow-up)", () => {
  it.each([
    "src/lib/foo.test.ts",
    "src/lib/foo.spec.ts",
    "e2e/index-webhook.test.ts",
    "src/lib/foo.test-helpers.ts",
    "e2e/validation-matrix/never-drop-p1.json",
    "e2e/_golden/ensemble-fixtures/case.json",
    "src/__fixtures__/sample.ts",
    "test/fixtures/payload.json",
    "components/Button.test.tsx",
    "src/render.snap",
  ])("is low-priority: %s", (p) => {
    expect(isLowReviewPriority(p)).toBe(true)
  })

  it.each([
    "src/lib/diff-packing.ts",
    "src/lib/ensemble/domain/validation-walk.ts",
    "src/lib/auth.ts",
    "src/lib/latest.ts", // contains "test" substring but not a .test. file
    "README.md",
  ])("is NOT low-priority (production source / docs): %s", (p) => {
    expect(isLowReviewPriority(p)).toBe(false)
  })
})

describe("estimateTokens", () => {
  it("uses the chars/4 heuristic", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("a")).toBe(1)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    expect(estimateTokens("a".repeat(40_000))).toBe(10_000)
  })
})

describe("splitDiffByFile", () => {
  it("returns empty for empty input", () => {
    expect(splitDiffByFile("")).toEqual([])
  })

  it("splits a single-file diff", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "index 1234..5678 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      " line a",
      "-line b",
      "+line B",
      " line c",
    ].join("\n")
    const blocks = splitDiffByFile(diff)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.path).toBe("foo.ts")
    expect(blocks[0]?.body).toContain("@@ -1,3 +1,3 @@")
    expect(blocks[0]?.charCount).toBe(blocks[0]?.body.length)
  })

  it("splits a two-file diff at the diff --git boundary", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/bar.ts b/bar.ts",
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -1 +1 @@",
      "-baz",
      "+qux",
    ].join("\n")
    const blocks = splitDiffByFile(diff)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.path).toBe("foo.ts")
    expect(blocks[1]?.path).toBe("bar.ts")
    // Each body contains its OWN diff --git line — and only its own.
    expect(blocks[0]?.body).toContain("foo.ts")
    expect(blocks[0]?.body).not.toContain("bar.ts")
    expect(blocks[1]?.body).toContain("bar.ts")
    expect(blocks[1]?.body).not.toContain("foo.ts")
  })

  it("falls back to old path for pure deletions (newPath = /dev/null)", () => {
    const diff = [
      "diff --git a/deleted.ts b/deleted.ts",
      "deleted file mode 100644",
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-line a",
      "-line b",
      "-line c",
    ].join("\n")
    const blocks = splitDiffByFile(diff)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.path).toBe("deleted.ts")
  })

  it("strips the leading b/ prefix from new paths", () => {
    const diff = ["diff --git a/foo.ts b/foo.ts", "+++ b/foo.ts", "@@ -1 +1 @@", "+x"].join("\n")
    const blocks = splitDiffByFile(diff)
    expect(blocks[0]?.path).toBe("foo.ts") // not "b/foo.ts"
  })

  it("drops leading lines that aren't part of any file block", () => {
    // Some GitHub-flavored diffs prepend metadata lines before the
    // first `diff --git`. Those don't belong to any file — they're
    // either header metadata or a malformed input. Skip them.
    const diff = [
      "Some prologue line",
      "Another prologue line",
      "diff --git a/real.ts b/real.ts",
      "+++ b/real.ts",
      "@@ -1 +1 @@",
      "+x",
    ].join("\n")
    const blocks = splitDiffByFile(diff)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.body).not.toContain("prologue")
  })

  it("preserves file order across the input", () => {
    const diff = [
      "diff --git a/c.ts b/c.ts",
      "+++ b/c.ts",
      "@@ -1 +1 @@",
      "+c",
      "diff --git a/a.ts b/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "+a",
      "diff --git a/b.ts b/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "+b",
    ].join("\n")
    const blocks = splitDiffByFile(diff)
    expect(blocks.map((b) => b.path)).toEqual(["c.ts", "a.ts", "b.ts"])
  })
})

describe("packFilesIntoBatches", () => {
  // Token budget = 100; chars/token = 4 → ~400 chars per batch.
  const SMALL_CAP = 100
  const mkFile = (path: string, chars: number) => ({
    path,
    body: "x".repeat(chars),
    charCount: chars,
  })

  it("returns one batch when total fits", () => {
    const files = [mkFile("a", 100), mkFile("b", 100)] // ~25 + ~25 = 50 tokens
    const result = packFilesIntoBatches(files, SMALL_CAP)
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0]?.map((f) => f.path)).toEqual(["a", "b"])
    expect(result.droppedTooLarge).toEqual([])
  })

  it("splits into multiple batches when total exceeds cap", () => {
    // Each file: 200 chars = 50 tokens. Cap = 100 tokens = 2 files/batch.
    const files = [mkFile("a", 200), mkFile("b", 200), mkFile("c", 200), mkFile("d", 200)]
    const result = packFilesIntoBatches(files, SMALL_CAP)
    expect(result.batches).toHaveLength(2)
    expect(result.batches[0]?.map((f) => f.path)).toEqual(["a", "b"])
    expect(result.batches[1]?.map((f) => f.path)).toEqual(["c", "d"])
    expect(result.droppedTooLarge).toEqual([])
  })

  it("drops files whose individual size exceeds the cap", () => {
    const files = [mkFile("small", 100), mkFile("huge", 1000), mkFile("normal", 200)]
    const result = packFilesIntoBatches(files, SMALL_CAP)
    expect(result.droppedTooLarge).toEqual(["huge"])
    // small + normal = 75 tokens; both fit in one batch under cap=100
    expect(result.batches).toHaveLength(1)
    expect(result.batches[0]?.map((f) => f.path)).toEqual(["small", "normal"])
  })

  it("handles an empty file list", () => {
    expect(packFilesIntoBatches([], SMALL_CAP)).toEqual({ batches: [], droppedTooLarge: [] })
  })

  it("starts a new batch only when adding a file would exceed cap", () => {
    // Greedy: a (50t) + b (50t) = 100t exactly fits (no >); c (1t) → new batch
    const files = [mkFile("a", 200), mkFile("b", 200), mkFile("c", 4)]
    const result = packFilesIntoBatches(files, SMALL_CAP)
    expect(result.batches).toHaveLength(2)
    expect(result.batches[0]?.map((f) => f.path)).toEqual(["a", "b"])
    expect(result.batches[1]?.map((f) => f.path)).toEqual(["c"])
  })

  it("uses DEFAULT_MAX_DIFF_TOKENS_PER_CALL when no cap provided", () => {
    expect(DEFAULT_MAX_DIFF_TOKENS_PER_CALL).toBeGreaterThan(1000)
    // A small-ish diff fits in one batch under the default cap.
    const files = [mkFile("a", 1000), mkFile("b", 1000)] // 250 + 250 = 500t
    const result = packFilesIntoBatches(files)
    expect(result.batches).toHaveLength(1)
  })
})

describe("batchToDiff", () => {
  it("joins file bodies with a newline separator", () => {
    const batch = [
      { path: "a", body: "diff a\n+x", charCount: 10 },
      { path: "b", body: "diff b\n+y", charCount: 10 },
    ]
    expect(batchToDiff(batch)).toBe("diff a\n+x\ndiff b\n+y")
  })

  it("returns empty string for empty batch", () => {
    expect(batchToDiff([])).toBe("")
  })
})
