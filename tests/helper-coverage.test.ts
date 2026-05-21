import { describe, expect, it } from "vitest"
import {
  detectHelperCoverage,
  extractTestedHelperBindings,
  isSubstantiveAddedLine,
  resolveImportToRepoPath,
} from "../src/lib/helper-coverage"
import type { TestingSiblingMapping } from "../src/lib/testing-evidence-pack"

describe("resolveImportToRepoPath", () => {
  const tested = new Set(["src/lib/branch-retrieval.ts", "src/lib/foo.ts", "src/lib/widget/index.ts"])
  it("resolves a relative extensionless specifier to a tested source", () => {
    expect(resolveImportToRepoPath("src/lib/triage-pr-review-ensemble.ts", "./branch-retrieval", tested))
      .toBe("src/lib/branch-retrieval.ts")
  })
  it("resolves a .js specifier to the .ts source (TS ESM convention)", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "./foo.js", tested)).toBe("src/lib/foo.ts")
  })
  it("resolves a directory import to index.ts", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "./widget", tested)).toBe("src/lib/widget/index.ts")
  })
  it("returns null for a bare package specifier", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "acorn", tested)).toBeNull()
  })
  it("returns null when the resolved path is not a tested source", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "./untested", tested)).toBeNull()
  })
  it("resolves a parent-relative specifier", () => {
    expect(resolveImportToRepoPath("src/lib/sub/x.ts", "../foo", tested)).toBe("src/lib/foo.ts")
  })
})

describe("extractTestedHelperBindings", () => {
  const tested = new Map<string, string>([["src/lib/branch-retrieval.ts", "tests/branch-retrieval.test.ts"]])
  it("returns local+imported names bound from a tested helper, skipping type-only", () => {
    const src = [
      `import { mergeBranchAware, retrieveBranchChunks as rbc } from "./branch-retrieval"`,
      `import type { BranchVector } from "./branch-retrieval"`,
      `import { foo } from "./untested"`,
      `const x = mergeBranchAware([], [], new Set())`,
    ].join("\n")
    const out = extractTestedHelperBindings("src/lib/ensemble.ts", src, ".ts", tested)
    const byLocal = Object.fromEntries(out.map((b) => [b.local, b]))
    expect(byLocal["mergeBranchAware"]).toMatchObject({ imported: "mergeBranchAware", helperSource: "src/lib/branch-retrieval.ts" })
    expect(byLocal["rbc"]).toMatchObject({ imported: "retrieveBranchChunks", helperSource: "src/lib/branch-retrieval.ts" })
    expect(byLocal["BranchVector"]).toBeUndefined()
    expect(byLocal["foo"]).toBeUndefined()
  })
  it("returns [] when the file does not parse", () => {
    expect(extractTestedHelperBindings("src/lib/x.ts", "const = = =", ".ts", tested)).toEqual([])
  })
})

describe("isSubstantiveAddedLine", () => {
  it("treats executable lines as substantive", () => {
    expect(isSubstantiveAddedLine("  const x = mergeBranchAware(a, b)")).toBe(true)
    expect(isSubstantiveAddedLine("  return foo()")).toBe(true)
    expect(isSubstantiveAddedLine("export const TOP_K = 6")).toBe(true)
  })
  it("treats imports/types/comments/blank/punctuation as NOT substantive", () => {
    expect(isSubstantiveAddedLine(`import { x } from "./y"`)).toBe(false)
    expect(isSubstantiveAddedLine("export type Foo = string")).toBe(false)
    expect(isSubstantiveAddedLine("export interface Foo {")).toBe(false)
    expect(isSubstantiveAddedLine("  type Local = number")).toBe(false)
    expect(isSubstantiveAddedLine("  // a comment")).toBe(false)
    expect(isSubstantiveAddedLine("   * jsdoc")).toBe(false)
    expect(isSubstantiveAddedLine("")).toBe(false)
    expect(isSubstantiveAddedLine("   }")).toBe(false)
    expect(isSubstantiveAddedLine("  })")).toBe(false)
    expect(isSubstantiveAddedLine(`export { foo } from "./y"`)).toBe(false)
  })
})

const ORCH = "src/lib/ensemble.ts"
const mappings: TestingSiblingMapping[] = [
  { source: ORCH, test: null },
  { source: "src/lib/branch-retrieval.ts", test: "tests/branch-retrieval.test.ts" },
]
const testContent = { "tests/branch-retrieval.test.ts": `it("mergeBranchAware", () => { mergeBranchAware([],[],new Set()) })` }

function lineMap(lines: Record<number, string>): Map<string, Map<number, string>> {
  const inner = new Map<number, string>()
  for (const [k, v] of Object.entries(lines)) inner.set(Number(k), v)
  return new Map([[ORCH, inner]])
}

describe("detectHelperCoverage", () => {
  it("status=all when every substantive added line delegates to a tested helper exercised by its test", () => {
    const code = `import { mergeBranchAware } from "./branch-retrieval"\nconst merged = mergeBranchAware(a, b, paths)\n}`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `import { mergeBranchAware } from "./branch-retrieval"`, 2: `const merged = mergeBranchAware(a, b, paths)`, 3: `}` }),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]).toEqual({ status: "all", helpers: ["src/lib/branch-retrieval.ts"] })
  })
  it("status=partial when only some substantive lines delegate", () => {
    const code = `import { mergeBranchAware } from "./branch-retrieval"\nconst merged = mergeBranchAware(a, b, p)\nif (x > threshold) doInlineThing(x)`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `import { mergeBranchAware } from "./branch-retrieval"`, 2: `const merged = mergeBranchAware(a, b, p)`, 3: `if (x > threshold) doInlineThing(x)` }),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("partial")
  })
  it("status=none when no substantive line delegates (true positive preserved)", () => {
    const code = `const y = computeInline(x)\nreturn y * 2`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `const y = computeInline(x)`, 2: `return y * 2` }),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("none")
  })
  it("status=none (fail closed) when the helper test does NOT reference the delegated symbol", () => {
    const code = `import { mergeBranchAware } from "./branch-retrieval"\nconst m = mergeBranchAware(a, b, p)`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `import { mergeBranchAware } from "./branch-retrieval"`, 2: `const m = mergeBranchAware(a, b, p)` }),
      siblingMappings: mappings,
      testContentByPath: { "tests/branch-retrieval.test.ts": `it("something else", () => {})` },
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("none")
  })
  it("status=none (fail closed) when the source has no added-line text available", () => {
    const code = `import { mergeBranchAware } from "./branch-retrieval"\nconst m = mergeBranchAware(a, b, p)`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: new Map(),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("none")
  })
  it("only considers ->NONE sources (covered sources are skipped)", () => {
    const out = detectHelperCoverage({
      filesByPath: new Map([["src/lib/branch-retrieval.ts", "export const x = 1"]]),
      addedLineTextByPath: lineMap({}),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource["src/lib/branch-retrieval.ts"]).toBeUndefined()
  })
})
