import { describe, expect, it } from "vitest"
import { resolveImportToRepoPath } from "../src/lib/helper-coverage"

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
