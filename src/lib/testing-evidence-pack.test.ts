// SIG-113: testing-specialist evidence-pack unit tests.

import { describe, it, expect } from "vitest"
import { buildDeletedLineTextByLine } from "@/features/ast-rules/domain/diff-filter"
import {
  applyTestFileContentCaps,
  buildTestingEvidencePack,
  fetchTestFileContentsWithBudget,
  filterTestingEvidenceForSuppressedMissingCoverage,
  MAX_TESTING_FOCUS_HINTS_PER_SOURCE,
  mergeHelperCoverage,
  mergeInspectedTestFileContents,
  mergeTestingFocusHints,
  pickFence,
  renderTestingEvidenceBlock,
  TEST_FILE_CONTENT_CHAR_CAP,
  TEST_FILE_CONTENT_TOTAL_CHAR_CAP,
  type InspectedTestFileFetchResult,
  type TestingEvidencePack,
} from "@/lib/testing-evidence-pack"

describe("buildTestingEvidencePack", () => {
  it("returns empty arrays when the diff has no source AND no test files", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["package.json", "README.md"],
      reviewedFilePaths: ["package.json", "README.md"],
    })
    expect(pack.sourceFilesChanged).toEqual([])
    expect(pack.testFilesChanged).toEqual([])
    expect(pack.siblingMappings).toEqual([])
    expect(pack.inspectedTestFiles).toEqual([])
  })

  it("classifies source files + finds sibling test pairs from the full diff", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: [
        "src/lib/foo.ts",
        "src/lib/bar.ts",
        "tests/foo.test.ts",
      ],
      reviewedFilePaths: [
        "src/lib/foo.ts",
        "src/lib/bar.ts",
        "tests/foo.test.ts",
      ],
    })
    expect(pack.sourceFilesChanged).toEqual(["src/lib/foo.ts", "src/lib/bar.ts"])
    expect(pack.testFilesChanged).toEqual(["tests/foo.test.ts"])
    expect(pack.testFilesInPromptDiff).toEqual(["tests/foo.test.ts"])
    expect(pack.testFilesNotInPromptDiff).toEqual([])
    expect(pack.siblingMappings).toEqual([
      { source: "src/lib/foo.ts", test: "tests/foo.test.ts" },
      { source: "src/lib/bar.ts", test: null }, // no sibling test in this PR
    ])
  })

  // CRITICAL: this test pins the PR #110 / PR #111 fix. Pre-SIG-113,
  // the classifier was fed `reviewedFiles.map(...)` (first batch
  // only); when test files lived in a later batch, the bot
  // hallucinated "missing tests." The new pack uses splitFiles (full
  // inventory) so the sibling pair is found regardless of batch.
  it("SIG-113: finds sibling tests EVEN WHEN they're dropped from the prompt diff by the batcher", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: [
        "src/lib/foo.ts",
        "tests/foo.test.ts", // ← in full diff
      ],
      reviewedFilePaths: [
        "src/lib/foo.ts",
        // tests/foo.test.ts is NOT in reviewedFiles (batcher dropped it)
      ],
    })
    expect(pack.testFilesInPromptDiff).toEqual([])
    expect(pack.testFilesNotInPromptDiff).toEqual(["tests/foo.test.ts"])
    expect(pack.siblingMappings).toEqual([
      { source: "src/lib/foo.ts", test: "tests/foo.test.ts" },
    ])
  })

  it("annotates test files in-prompt-diff vs not-in-prompt-diff correctly", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: [
        "src/lib/foo.ts",
        "src/lib/bar.ts",
        "tests/foo.test.ts",
        "tests/bar.test.ts",
      ],
      reviewedFilePaths: [
        "src/lib/foo.ts",
        "tests/foo.test.ts", // in prompt diff
      ],
    })
    expect(pack.testFilesInPromptDiff).toEqual(["tests/foo.test.ts"])
    expect(pack.testFilesNotInPromptDiff).toEqual(["tests/bar.test.ts"])
  })

  it("flags source files with no sibling test as test: null in siblingMappings", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: [
        "src/api/unnoticed.ts",
        "tests/foo.test.ts",
        "src/lib/foo.ts",
      ],
      reviewedFilePaths: [
        "src/api/unnoticed.ts",
        "tests/foo.test.ts",
        "src/lib/foo.ts",
      ],
    })
    const unnoticed = pack.siblingMappings.find((m) => m.source === "src/api/unnoticed.ts")
    expect(unnoticed?.test).toBeNull()
    const foo = pack.siblingMappings.find((m) => m.source === "src/lib/foo.ts")
    expect(foo?.test).toBe("tests/foo.test.ts")
  })

  it("initializes inspectedTestFiles as empty (orchestrator fills in via merge)", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo.ts", "tests/foo.test.ts"],
      reviewedFilePaths: ["src/lib/foo.ts", "tests/foo.test.ts"],
    })
    expect(pack.inspectedTestFiles).toEqual([])
  })
})

describe("filterTestingEvidenceForSuppressedMissingCoverage", () => {
  it("suppresses a ->NONE source when a repo-wide test sibling already exists", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo.ts"],
      reviewedFilePaths: ["src/lib/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([["src/lib/foo.ts", ["export function foo() { return 1 }"]]]),
      repoPaths: ["src/lib/foo.ts", "tests/foo.test.ts"],
    })

    expect(result.suppressions).toEqual([{
      source: "src/lib/foo.ts",
      reason: "repo-sibling-exists",
      test: "tests/foo.test.ts",
    }])
    expect(result.pack.sourceFilesChanged).toEqual([])
    expect(result.pack.siblingMappings).toEqual([])
    expect(renderTestingEvidenceBlock(result.pack, {
      contentByPath: {},
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    })).toBe("")
  })

  it("normalizes repo-tree paths before matching existing siblings", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo.ts"],
      reviewedFilePaths: ["src/lib/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([["src/lib/foo.ts", ["export function foo() { return 1 }"]]]),
      repoPaths: [".\\tests\\foo.test.ts"],
    })

    expect(result.suppressions).toEqual([{
      source: "src/lib/foo.ts",
      reason: "repo-sibling-exists",
      test: "tests/foo.test.ts",
    }])
  })

  it("does not let a package-scoped repo sibling suppress an unrelated root source", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo.ts"],
      reviewedFilePaths: ["src/lib/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([["src/lib/foo.ts", ["export function foo() { return 1 }"]]]),
      repoPaths: ["packages/app/tests/foo.test.ts"],
    })

    expect(result.suppressions).toEqual([])
    expect(result.pack.siblingMappings).toEqual([{ source: "src/lib/foo.ts", test: null }])
  })

  it("suppresses package-local repo siblings within the same package root", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["packages/app/src/foo.ts"],
      reviewedFilePaths: ["packages/app/src/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([["packages/app/src/foo.ts", ["export function foo() { return 1 }"]]]),
      repoPaths: ["packages/app/tests/foo.test.ts"],
    })

    expect(result.suppressions).toEqual([{
      source: "packages/app/src/foo.ts",
      reason: "repo-sibling-exists",
      test: "packages/app/tests/foo.test.ts",
    }])
  })

  it("does not let a prefixed __tests__ file suppress package source-root variants", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["packages/app/src/foo.ts"],
      reviewedFilePaths: ["packages/app/src/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([["packages/app/src/foo.ts", ["export function foo() { return 1 }"]]]),
      repoPaths: ["packages/app/__tests__/foo.test.ts"],
    })

    expect(result.suppressions).toEqual([])
    expect(result.pack.siblingMappings).toEqual([{ source: "packages/app/src/foo.ts", test: null }])
  })

  it("suppresses a prefixed __tests__ file only for its direct parent sibling", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["packages/app/foo.ts"],
      reviewedFilePaths: ["packages/app/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([["packages/app/foo.ts", ["export function foo() { return 1 }"]]]),
      repoPaths: ["packages/app/__tests__/foo.test.ts"],
    })

    expect(result.suppressions).toEqual([{
      source: "packages/app/foo.ts",
      reason: "repo-sibling-exists",
      test: "packages/app/__tests__/foo.test.ts",
    }])
  })

  it("fails open when repo-wide sibling matching is ambiguous", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo-bar.ts"],
      reviewedFilePaths: ["src/lib/foo-bar.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([["src/lib/foo-bar.ts", ["export function fooBar() { return 1 }"]]]),
      repoPaths: ["tests/foo-bar.test.ts", "src/lib/foo-bar.test.ts"],
    })

    expect(result.suppressions).toEqual([])
    expect(result.pack.siblingMappings).toEqual([{ source: "src/lib/foo-bar.ts", test: null }])
  })

  it("suppresses comment-only source changes even without repo tree evidence", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo.ts"],
      reviewedFilePaths: ["src/lib/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([
        ["src/lib/foo.ts", [
          "import { bar } from './bar'",
          "// clarify why the branch is safe",
          "export type Foo = { id: string }",
          "}",
        ]],
      ]),
    })

    expect(result.suppressions).toEqual([{
      source: "src/lib/foo.ts",
      reason: "no-substantive-change",
    }])
    expect(result.pack.sourceFilesChanged).toEqual([])
    expect(result.pack.siblingMappings).toEqual([])
  })

  it("suppresses raw-prefixed comment-only source changes", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo.ts"],
      reviewedFilePaths: ["src/lib/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([
        ["src/lib/foo.ts", [
          "-// old explanation",
          "+// clearer explanation",
        ]],
      ]),
    })

    expect(result.suppressions).toEqual([{
      source: "src/lib/foo.ts",
      reason: "no-substantive-change",
    }])
  })

  it("does not suppress when the changed-line evidence includes a substantive deletion", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/foo.ts"],
      reviewedFilePaths: ["src/lib/foo.ts"],
    })

    const result = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([
        ["src/lib/foo.ts", [
          "-if (!user) return null",
          "// explain why the remaining branch is safe",
        ]],
      ]),
    })

    expect(result.suppressions).toEqual([])
    expect(result.pack.siblingMappings).toEqual([{ source: "src/lib/foo.ts", test: null }])
  })
})

describe("applyTestFileContentCaps", () => {
  it("returns empty result when no content was fetched", () => {
    const out = applyTestFileContentCaps({}, ["tests/foo.test.ts"])
    expect(out.contentByPath).toEqual({})
    expect(out.totalChars).toBe(0)
    expect(out.truncatedPaths).toEqual([])
  })

  it("includes content under the per-file cap unchanged", () => {
    const short = "describe('foo', () => { it('works', () => {}) })"
    const out = applyTestFileContentCaps(
      { "tests/foo.test.ts": short },
      ["tests/foo.test.ts"],
    )
    expect(out.contentByPath["tests/foo.test.ts"]).toBe(short)
    expect(out.truncatedPaths).toEqual([])
    expect(out.totalChars).toBe(short.length)
  })

  it("truncates content over TEST_FILE_CONTENT_CHAR_CAP and flags it", () => {
    const huge = "a".repeat(TEST_FILE_CONTENT_CHAR_CAP + 5000)
    const out = applyTestFileContentCaps(
      { "tests/huge.test.ts": huge },
      ["tests/huge.test.ts"],
    )
    expect(out.contentByPath["tests/huge.test.ts"]).toContain("[…truncated at")
    expect(out.truncatedPaths).toEqual(["tests/huge.test.ts"])
    expect(out.contentByPath["tests/huge.test.ts"]!.length)
      .toBeLessThan(huge.length)
  })

  it("stops including files once total budget is exceeded", () => {
    // 30K per file × 4 files = 120K which is over TOTAL_CAP (60K).
    // Per-file cap (20K) applies first → each file is 20K + truncation
    // marker. ~3 files fit under 60K total cap.
    const oneFile = "x".repeat(30_000)
    const out = applyTestFileContentCaps(
      {
        "tests/a.test.ts": oneFile,
        "tests/b.test.ts": oneFile,
        "tests/c.test.ts": oneFile,
        "tests/d.test.ts": oneFile,
      },
      ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"],
    )
    expect(Object.keys(out.contentByPath).length).toBeLessThan(4)
    expect(out.totalChars).toBeLessThanOrEqual(TEST_FILE_CONTENT_TOTAL_CHAR_CAP + 200)
  })

  it("processes paths in the order hint (deterministic)", () => {
    const oneFile = "x".repeat(20_000)
    const out = applyTestFileContentCaps(
      {
        "tests/z.test.ts": oneFile,
        "tests/a.test.ts": oneFile,
      },
      ["tests/a.test.ts", "tests/z.test.ts"], // a should be processed first
    )
    const keys = Object.keys(out.contentByPath)
    expect(keys[0]).toBe("tests/a.test.ts")
  })

  it("skips paths in the order hint that aren't in the fetched-content map", () => {
    const out = applyTestFileContentCaps(
      { "tests/foo.test.ts": "content" },
      ["tests/foo.test.ts", "tests/missing.test.ts"],
    )
    expect(out.contentByPath).toEqual({ "tests/foo.test.ts": "content" })
  })
})

describe("fetchTestFileContentsWithBudget", () => {
  it("fetches all files in the common small-PR case", async () => {
    const paths = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]
    const fetched: string[] = []
    const out = await fetchTestFileContentsWithBudget({
      paths,
      concurrency: 2,
      fetchContent: async (path) => {
        fetched.push(path)
        return `content for ${path}`
      },
    })

    expect(fetched).toEqual(paths)
    expect(Object.keys(out.contentByPath)).toEqual(paths)
    expect(out.failedPaths).toEqual([])
    expect(out.budgetOmittedPaths).toEqual([])
    expect(out.fetchedCount).toBe(3)
    expect(out.skippedForBudgetCount).toBe(0)
  })

  it("stops scheduling once the total evidence budget is full", async () => {
    const paths = Array.from({ length: 60 }, (_unused, i) => `tests/file-${i}.test.ts`)
    const fetched: string[] = []
    const out = await fetchTestFileContentsWithBudget({
      paths,
      concurrency: 5,
      fetchContent: async (path) => {
        fetched.push(path)
        return "x".repeat(TEST_FILE_CONTENT_CHAR_CAP)
      },
    })

    expect(Object.keys(out.contentByPath)).toHaveLength(3)
    expect(fetched.length).toBe(5)
    expect(out.fetchedCount).toBe(5)
    expect(out.budgetOmittedPaths).toHaveLength(57)
    expect(out.skippedForBudgetCount).toBe(57)
    expect(out.failedPaths).toEqual([])
    expect(out.totalChars).toBe(TEST_FILE_CONTENT_TOTAL_CHAR_CAP)
  })

  it("keeps fetch failures distinct from budget omissions", async () => {
    const out = await fetchTestFileContentsWithBudget({
      paths: ["tests/a.test.ts", "tests/missing.test.ts", "tests/b.test.ts"],
      concurrency: 2,
      fetchContent: async (path) => {
        if (path.includes("missing")) throw new Error("404")
        return "small"
      },
    })

    expect(Object.keys(out.contentByPath)).toEqual(["tests/a.test.ts", "tests/b.test.ts"])
    expect(out.failedPaths).toEqual(["tests/missing.test.ts"])
    expect(out.budgetOmittedPaths).toEqual([])
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "normalizes non-finite concurrency %s without breaking fetch accounting",
    async (concurrency) => {
      const paths = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]
      const out = await fetchTestFileContentsWithBudget({
        paths,
        concurrency,
        fetchContent: async (path) => `content for ${path}`,
      })

      expect(Number.isInteger(out.fetchedCount)).toBe(true)
      expect(out.fetchedCount).toBeGreaterThanOrEqual(0)
      expect(out.fetchedCount).toBeLessThanOrEqual(paths.length)
      expect(out.fetchedCount + out.skippedForBudgetCount).toBe(paths.length)
      expect(out.failedPaths).toEqual([])
      expect(Object.keys(out.contentByPath).every((path) => paths.includes(path))).toBe(true)
    },
  )
})

describe("mergeInspectedTestFileContents", () => {
  const basePack: TestingEvidencePack = {
    sourceFilesChanged: ["src/lib/foo.ts"],
    testFilesChanged: ["tests/foo.test.ts"],
    testFilesInPromptDiff: ["tests/foo.test.ts"],
    testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: "src/lib/foo.ts", test: "tests/foo.test.ts" }],
    inspectedTestFiles: [],
    helperCoverageBySource: {},
  }

  it("populates inspectedTestFiles from the fetch result", () => {
    const merged = mergeInspectedTestFileContents(basePack, {
      contentByPath: { "tests/foo.test.ts": "content" },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 7,
    })
    expect(merged.inspectedTestFiles).toEqual(["tests/foo.test.ts"])
  })

  it("SIG-347: attaches the fetched bodies as inspectedTestContentByPath (for the cross-check)", () => {
    const merged = mergeInspectedTestFileContents(basePack, {
      contentByPath: { "tests/foo.test.ts": "expect(parseConfig(x)).toBe(y)" },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 30,
    })
    expect(merged.inspectedTestContentByPath).toEqual({
      "tests/foo.test.ts": "expect(parseConfig(x)).toBe(y)",
    })
    // same key set as inspectedTestFiles
    expect(Object.keys(merged.inspectedTestContentByPath ?? {})).toEqual(merged.inspectedTestFiles)
  })

  it("returns a new object (immutability)", () => {
    const merged = mergeInspectedTestFileContents(basePack, {
      contentByPath: {},
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    })
    expect(merged).not.toBe(basePack)
  })
})

describe("SIG-349 testing focus hints", () => {
  it("extracts branch, parser/coercion, and error-path hints from added source lines", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/retry.ts", "tests/retry.test.ts"],
      reviewedFilePaths: ["src/lib/retry.ts", "tests/retry.test.ts"],
    })

    const merged = mergeTestingFocusHints(pack, new Map([
      ["src/lib/retry.ts", new Map([
        [2, "  if (signal?.aborted) {"],
        [3, "    throw new Error(\"timeout\")"],
        [4, "  if (signal?.aborted) throw new Error(\"timeout\")"],
        [5, "  if (raw) return JSON.parse(raw)"],
        [7, "  const kind = String(raw ?? \"task\").toLowerCase()"],
        [8, "  return kind"],
      ])],
      // Added test-file lines are still ignored; deleted test assertions have
      // their own old-side input map below.
      ["tests/retry.test.ts", new Map([[4, "it(\"rejects on timeout\", () => {})"]])],
    ]))

    expect(merged.testingFocusHints).toEqual([
      { source: "src/lib/retry.ts", line: 2, kind: "branch", token: "if (signal?.aborted) {" },
      { source: "src/lib/retry.ts", line: 3, kind: "error-path", token: "throw new Error(\"timeout\")" },
      // Error-path tokens intentionally outrank branch tokens when both appear on one line.
      { source: "src/lib/retry.ts", line: 4, kind: "error-path", token: "if (signal?.aborted) throw new Error(\"timeout\")" },
      { source: "src/lib/retry.ts", line: 5, kind: "parser-coercion", token: "if (raw) return JSON.parse(raw)" },
      {
        source: "src/lib/retry.ts",
        line: 7,
        kind: "parser-coercion",
        token: "const kind = String(raw ?? \"task\").toLowerCase()",
      },
    ])
  })

  it("extracts deleted-test hints from old-side test assertions", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["tests/refunds.test.ts"],
      reviewedFilePaths: ["tests/refunds.test.ts"],
    })

    const merged = mergeTestingFocusHints(
      pack,
      new Map(),
      new Map([
        ["tests/refunds.test.ts", new Map([
          [1, "import { describe, expect, it } from \"vitest\""],
          [4, "it(\"rejects negative refund amounts\", () => {"],
          [5, "  expect(() => refund({ amount: -1 })).toThrow(\"amount\")"],
        ])],
      ]),
    )

    expect(merged.testingFocusHints).toEqual([
      {
        source: "tests/refunds.test.ts",
        line: 4,
        kind: "deleted-test",
        token: "it(\"rejects negative refund amounts\", () => {",
      },
      {
        source: "tests/refunds.test.ts",
        line: 5,
        kind: "deleted-test",
        token: "expect(() => refund({ amount: -1 })).toThrow(\"amount\")",
      },
    ])
  })

  it("caps focus hints per source in deterministic line order", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/routes.ts"],
      reviewedFilePaths: ["src/lib/routes.ts"],
    })
    const addedLines = new Map<number, string>()
    for (let i = 1; i <= MAX_TESTING_FOCUS_HINTS_PER_SOURCE + 3; i++) {
      addedLines.set(i, `if (branch${i}) return ${i}`)
    }

    const merged = mergeTestingFocusHints(pack, new Map([["src/lib/routes.ts", addedLines]]))

    expect(merged.testingFocusHints).toHaveLength(MAX_TESTING_FOCUS_HINTS_PER_SOURCE)
    expect(merged.testingFocusHints?.map((h) => h.line)).toEqual(
      Array.from({ length: MAX_TESTING_FOCUS_HINTS_PER_SOURCE }, (_unused, i) => i + 1),
    )
  })

  it("does not treat standalone string normalization as parser/coercion focus", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/slug.ts", "tests/slug.test.ts"],
      reviewedFilePaths: ["src/lib/slug.ts", "tests/slug.test.ts"],
    })

    const merged = mergeTestingFocusHints(pack, new Map([
      ["src/lib/slug.ts", new Map([
        [2, "  const normalized = input.trim().toLowerCase()"],
      ])],
    ]))

    expect(merged.testingFocusHints).toEqual([])
  })

  it("renders focus hints as advisory pointers while keeping citation requirements", () => {
    const base = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/parse-kind.ts"],
      reviewedFilePaths: ["src/lib/parse-kind.ts"],
    })
    const pack = mergeTestingFocusHints(base, new Map([
      ["src/lib/parse-kind.ts", new Map([
        [3, "  const kind = String(raw ?? \"task\").toLowerCase()"],
        [4, "  const fallback = String(raw ?? `task`).toLowerCase()"],
      ])],
    ]))

    const block = renderTestingEvidenceBlock(pack, {
      contentByPath: {},
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    })

    expect(block).toContain("Testing focus hints")
    expect(block).toContain("pointers only, not findings")
    expect(block).toContain("src/lib/parse-kind.ts:3")
    expect(block).toContain("parser-coercion")
    expect(block).toContain("`` const fallback = String(raw ?? `task`).toLowerCase() ``")
    expect(block).toContain("A customer-visible testing finding still needs the citation fields below")
    expect(block).toContain("Citation requirements")
    expect(block).toContain("siblingMapping:src/lib/parse-kind.ts->NONE")
  })

  it("renders deleted-test hints before citation requirements", () => {
    const base = buildTestingEvidencePack({
      splitFilePaths: ["tests/refunds.test.ts"],
      reviewedFilePaths: ["tests/refunds.test.ts"],
    })
    const diff = `diff --git a/tests/refunds.test.ts b/tests/refunds.test.ts
--- a/tests/refunds.test.ts
+++ b/tests/refunds.test.ts
@@ -4,3 +4,0 @@
-  it("rejects negative amounts", () => {
-    expect(() => refund({ amount: -1 })).toThrow("amount")
-  })`
    const pack = mergeTestingFocusHints(
      base,
      new Map(),
      buildDeletedLineTextByLine(diff),
    )

    const block = renderTestingEvidenceBlock(pack, {
      contentByPath: {},
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    })

    expect(block).toContain("changed source lines and deleted test assertions")
    // The deletion-only hunk starts on old-side line 4.
    expect(block).toContain("tests/refunds.test.ts:4")
    expect(block).toContain("tests/refunds.test.ts:5")
    expect(block).not.toContain("tests/refunds.test.ts:6")
    expect(block).toContain("deleted-test")
    expect(block).toContain("testFileChanged:<path>")
  })

  it("keeps focus hints in the production filter/inspect/focus/coverage/render order", () => {
    const initial = buildTestingEvidencePack({
      splitFilePaths: [
        "src/lib/comment-only.ts",
        "src/lib/parse-kind.ts",
        "tests/parse-kind.test.ts",
      ],
      reviewedFilePaths: [
        "src/lib/comment-only.ts",
        "src/lib/parse-kind.ts",
        "tests/parse-kind.test.ts",
      ],
    })
    const filtered = filterTestingEvidenceForSuppressedMissingCoverage(initial, {
      changedLineTextByPath: new Map([
        ["src/lib/comment-only.ts", ["// update comment"]],
        ["src/lib/parse-kind.ts", ["const kind = String(raw ?? \"task\").toLowerCase()"]],
      ]),
    }).pack
    const inspected = mergeInspectedTestFileContents(filtered, {
      contentByPath: {
        "tests/parse-kind.test.ts": "it('keeps known kinds', () => expect(parseKind('task')).toBe('task'))",
      },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 70,
    })
    const withFocus = mergeTestingFocusHints(inspected, new Map([
      ["src/lib/comment-only.ts", new Map([[1, "if (commentOnly) return"]])],
      ["src/lib/parse-kind.ts", new Map([[4, "const kind = String(raw ?? \"task\").toLowerCase()"]])],
    ]))
    expect(withFocus.testingFocusHints).toEqual([{
      source: "src/lib/parse-kind.ts",
      line: 4,
      kind: "parser-coercion",
      token: "const kind = String(raw ?? \"task\").toLowerCase()",
    }])
    const withCoverage = mergeHelperCoverage(withFocus, {})
    const block = renderTestingEvidenceBlock(withCoverage, {
      contentByPath: {
        "tests/parse-kind.test.ts": "it('keeps known kinds', () => expect(parseKind('task')).toBe('task'))",
      },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 70,
    })

    expect(block).toContain("Testing focus hints")
    expect(block).toContain("src/lib/parse-kind.ts:4")
    expect(block).toContain("parser-coercion")
    expect(block).toContain("Inspected test files")
    expect(block).toContain("tests/parse-kind.test.ts")
    expect(block).not.toContain("src/lib/comment-only.ts")
  })
})

describe("renderTestingEvidenceBlock", () => {
  const emptyFetch: InspectedTestFileFetchResult = {
    contentByPath: {},
    failedPaths: [],
    truncatedPaths: [],
    totalChars: 0,
  }

  it("returns '' for a pure docs/config PR (no source, no test files)", () => {
    const pack: TestingEvidencePack = {
      sourceFilesChanged: [],
      testFilesChanged: [],
      testFilesInPromptDiff: [],
      testFilesNotInPromptDiff: [],
      siblingMappings: [],
      inspectedTestFiles: [],
      helperCoverageBySource: {},
    }
    expect(renderTestingEvidenceBlock(pack, emptyFetch)).toBe("")
  })

  it("renders source files + their sibling-test mappings", () => {
    const pack: TestingEvidencePack = {
      sourceFilesChanged: ["src/lib/foo.ts", "src/lib/bar.ts"],
      testFilesChanged: ["tests/foo.test.ts"],
      testFilesInPromptDiff: ["tests/foo.test.ts"],
      testFilesNotInPromptDiff: [],
      siblingMappings: [
        { source: "src/lib/foo.ts", test: "tests/foo.test.ts" },
        { source: "src/lib/bar.ts", test: null },
      ],
      inspectedTestFiles: ["tests/foo.test.ts"],
      helperCoverageBySource: {},
    }
    const block = renderTestingEvidenceBlock(pack, {
      contentByPath: { "tests/foo.test.ts": "describe('foo', () => {})" },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 25,
    })
    expect(block).toContain("[TESTING EVIDENCE")
    expect(block).toContain("Source files changed in this PR (2)")
    expect(block).toContain("`src/lib/foo.ts`")
    expect(block).toContain("covered by test in this PR: `tests/foo.test.ts`")
    expect(block).toContain("`src/lib/bar.ts`")
    expect(block).toContain("no sibling test file in this PR")
  })

  it("annotates test files NOT in the prompt [DIFF] block", () => {
    const pack: TestingEvidencePack = {
      sourceFilesChanged: ["src/lib/foo.ts"],
      testFilesChanged: ["tests/foo.test.ts"],
      testFilesInPromptDiff: [],
      testFilesNotInPromptDiff: ["tests/foo.test.ts"],
      siblingMappings: [{ source: "src/lib/foo.ts", test: "tests/foo.test.ts" }],
      inspectedTestFiles: ["tests/foo.test.ts"],
      helperCoverageBySource: {},
    }
    const block = renderTestingEvidenceBlock(pack, {
      contentByPath: { "tests/foo.test.ts": "describe('foo', () => {})" },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 25,
    })
    expect(block).toContain("NOT in [DIFF] block")
    expect(block).toContain("batcher dropped")
  })

  it("includes the citation instructions for the specialist", () => {
    const pack: TestingEvidencePack = {
      sourceFilesChanged: ["src/lib/foo.ts"],
      testFilesChanged: [],
      testFilesInPromptDiff: [],
      testFilesNotInPromptDiff: [],
      siblingMappings: [{ source: "src/lib/foo.ts", test: null }],
      inspectedTestFiles: [],
      helperCoverageBySource: {},
    }
    const block = renderTestingEvidenceBlock(pack, emptyFetch)
    expect(block).toContain("Citation requirements")
    expect(block).toContain("evidenceRefs")
    expect(block).toContain("inspectedTestFiles")
    expect(block).toContain("evaluateTestingFindingCitation")
  })

  it("embeds full content of inspected test files in fenced blocks", () => {
    const pack: TestingEvidencePack = {
      sourceFilesChanged: [],
      testFilesChanged: ["tests/foo.test.ts"],
      testFilesInPromptDiff: ["tests/foo.test.ts"],
      testFilesNotInPromptDiff: [],
      siblingMappings: [],
      inspectedTestFiles: ["tests/foo.test.ts"],
      helperCoverageBySource: {},
    }
    const block = renderTestingEvidenceBlock(pack, {
      contentByPath: { "tests/foo.test.ts": "describe('foo', () => {})" },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 25,
    })
    expect(block).toContain("[TEST FILE CONTENT — `tests/foo.test.ts`]")
    expect(block).toContain("describe('foo', () => {})")
    expect(block).toContain("[END `tests/foo.test.ts`]")
  })

  it("renders the truncation annotation when a file was capped", () => {
    const pack: TestingEvidencePack = {
      sourceFilesChanged: [],
      testFilesChanged: ["tests/huge.test.ts"],
      testFilesInPromptDiff: ["tests/huge.test.ts"],
      testFilesNotInPromptDiff: [],
      siblingMappings: [],
      inspectedTestFiles: ["tests/huge.test.ts"],
      helperCoverageBySource: {},
    }
    const block = renderTestingEvidenceBlock(pack, {
      contentByPath: { "tests/huge.test.ts": "x".repeat(20_000) + "[…truncated…]" },
      failedPaths: [],
      truncatedPaths: ["tests/huge.test.ts"],
      totalChars: 20_000,
    })
    expect(block).toContain("content included below (truncated)")
  })
})

describe("pickFence (SIG-113 M2 — fence collision)", () => {
  it("returns the standard 3-backtick fence for content with no backticks", () => {
    expect(pickFence("describe('foo', () => {})")).toBe("```")
  })

  it("returns the standard fence for content with backtick runs < 3", () => {
    expect(pickFence("const x = `template`")).toBe("```") // single backtick run
    expect(pickFence("a `` b")).toBe("```") // double backtick run
  })

  it("grows the fence to maxRun+1 when content has a triple-backtick", () => {
    // A test file asserting markdown fences contains ``` — the outer
    // fence must be longer (4 backticks).
    expect(pickFence("expect(md).toContain('```mermaid')")).toBe("````")
  })

  it("grows past longer runs (quad-backtick in body → 5-backtick fence)", () => {
    expect(pickFence("a ```` b")).toBe("`````")
  })

  it("handles backticks at the very start / end of the body", () => {
    expect(pickFence("```start")).toBe("````")
    expect(pickFence("end```")).toBe("````")
  })
})

describe("renderTestingEvidenceBlock — M2 fence collision in embedded content", () => {
  it("wraps a test file containing triple-backticks in a longer fence so the block stays intact", () => {
    const pack: TestingEvidencePack = {
      sourceFilesChanged: [],
      testFilesChanged: ["tests/markdown.test.ts"],
      testFilesInPromptDiff: ["tests/markdown.test.ts"],
      testFilesNotInPromptDiff: [],
      siblingMappings: [],
      inspectedTestFiles: ["tests/markdown.test.ts"],
      helperCoverageBySource: {},
    }
    // A real-world test body that asserts markdown-fence rendering.
    const bodyWithFence = "it('renders mermaid', () => {\n  expect(out).toContain('```mermaid')\n})"
    const block = renderTestingEvidenceBlock(pack, {
      contentByPath: { "tests/markdown.test.ts": bodyWithFence },
      failedPaths: [],
      truncatedPaths: [],
      totalChars: bodyWithFence.length,
    })
    // The outer fence must be 4 backticks (one more than the embedded
    // triple). The embedded ```mermaid stays intact inside it.
    expect(block).toContain("````")
    expect(block).toContain("```mermaid")
    // The content + END sentinel both present (block not corrupted).
    expect(block).toContain("[TEST FILE CONTENT — `tests/markdown.test.ts`]")
    expect(block).toContain("[END `tests/markdown.test.ts`]")
  })
})

describe("SIG-128 helper-coverage annotation", () => {
  const emptyFetch = { contentByPath: {}, failedPaths: [], truncatedPaths: [], totalChars: 0 }
  function packWith(coverage: Record<string, { status: "all" | "partial" | "none"; helpers: string[] }>) {
    const base = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/ensemble.ts", "src/lib/branch-retrieval.ts", "tests/branch-retrieval.test.ts"],
      reviewedFilePaths: ["src/lib/ensemble.ts", "src/lib/branch-retrieval.ts", "tests/branch-retrieval.test.ts"],
    })
    return mergeHelperCoverage(base, coverage)
  }
  it("renders an 'all delegates' note for an all-status ->NONE source", () => {
    const pack = packWith({ "src/lib/ensemble.ts": { status: "all", helpers: ["src/lib/branch-retrieval.ts"] } })
    const block = renderTestingEvidenceBlock(pack, emptyFetch)
    expect(block).toContain("ALL changed logic here delegates to helpers unit-tested in this PR")
    expect(block).toContain("src/lib/branch-retrieval.ts")
  })
  it("renders a 'partial' note without suppressing", () => {
    const pack = packWith({ "src/lib/ensemble.ts": { status: "partial", helpers: ["src/lib/branch-retrieval.ts"] } })
    expect(renderTestingEvidenceBlock(pack, emptyFetch)).toContain("SOME changed lines call tested helpers")
  })
  it("leaves a none-status ->NONE source with the original wording", () => {
    const pack = packWith({ "src/lib/ensemble.ts": { status: "none", helpers: [] } })
    expect(renderTestingEvidenceBlock(pack, emptyFetch)).toContain("no sibling test file in this PR")
  })
  it("mergeHelperCoverage is immutable and defaults to {}", () => {
    const base = buildTestingEvidencePack({ splitFilePaths: ["src/lib/ensemble.ts"], reviewedFilePaths: ["src/lib/ensemble.ts"] })
    expect(base.helperCoverageBySource).toEqual({})
    const merged = mergeHelperCoverage(base, { "src/lib/ensemble.ts": { status: "all", helpers: [] } })
    expect(base.helperCoverageBySource).toEqual({})
    expect(merged.helperCoverageBySource["src/lib/ensemble.ts"]?.status).toBe("all")
  })
})
