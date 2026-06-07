// SIG-336: parse-once AST cache tests.
//
// The cache's contract is (1) parse each path at most once — proven by reference
// identity, since `parseSource` returns a fresh object per call, so an identical
// reference on the second `get` means no re-parse happened; (2) memoize failures
// and large-file skips too; (3) apply the shared LARGE_FILE_BYTES ceiling.

import { describe, it, expect } from "vitest"
import { createAstCache, LARGE_FILE_SKIP_PREFIX } from "../src/lib/ast-rules/parse-cache"
import { LARGE_FILE_BYTES } from "../src/lib/ast-rules/parser"

const SRC = "export function f(a: number): number { return a + 1 }\n"

describe("createAstCache", () => {
  it("parses a valid source once and returns the SAME result on repeat (no re-parse)", () => {
    const cache = createAstCache()
    const r1 = cache.get("src/a.ts", SRC, ".ts")
    const r2 = cache.get("src/a.ts", SRC, ".ts")

    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.ast).toBeTruthy()
    expect(r2).toBe(r1) // identical reference ⇒ memoized, not re-parsed
    expect(cache.size).toBe(1)
  })

  it("memoizes a PARSE FAILURE — a known-bad file is never re-attempted", () => {
    const cache = createAstCache()
    const bad = "function ( { syntactically broken"
    const r1 = cache.get("src/bad.ts", bad, ".ts")
    const r2 = cache.get("src/bad.ts", bad, ".ts")

    expect(r1.ok).toBe(false)
    expect(r2).toBe(r1) // same failure object ⇒ not re-parsed
    expect(cache.size).toBe(1)
  })

  it("SKIPS a source over LARGE_FILE_BYTES without parsing (the missing guard on the gate path)", () => {
    const cache = createAstCache()
    // A valid-but-huge source: padded with a long comment so it parses fine if
    // it were ever sent to acorn — proving the skip is by SIZE, not syntax.
    const huge = `${SRC}// ${"x".repeat(LARGE_FILE_BYTES + 1)}\n`
    const r = cache.get("src/huge.ts", huge, ".ts")

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.startsWith(LARGE_FILE_SKIP_PREFIX)).toBe(true)
  })

  it("uses BYTE length, not UTF-16 code-unit length, for the size guard", () => {
    const cache = createAstCache()
    // Each "🔒" is 1 string char but 4 UTF-8 bytes. Just over the byte ceiling
    // while well under it by code-unit count → must still be skipped.
    const padBytes = LARGE_FILE_BYTES + 4
    const emoji = "🔒".repeat(Math.ceil(padBytes / 4))
    const huge = `${SRC}// ${emoji}\n`
    const r = cache.get("src/emoji.ts", huge, ".ts")

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.startsWith(LARGE_FILE_SKIP_PREFIX)).toBe(true)
  })

  it("parses distinct paths independently and grows size per unique path", () => {
    const cache = createAstCache()
    const a = cache.get("src/a.ts", SRC, ".ts")
    const b = cache.get("src/b.ts", SRC, ".ts")

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(b).not.toBe(a) // different paths → separately parsed
    expect(cache.size).toBe(2)
  })
})
