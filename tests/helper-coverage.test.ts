import { describe, expect, it } from "vitest"
import { extractTestedHelperBindings, isSubstantiveAddedLine, resolveImportToRepoPath } from "../src/lib/helper-coverage"

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
