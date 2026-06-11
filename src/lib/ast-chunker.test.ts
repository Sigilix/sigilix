import { describe, expect, it } from "vitest"
import { chunkFileAst, jsTsExtOf } from "@/src/lib/ast-chunker"
import type { Chunk } from "@/src/lib/chunk-core"

// Coverage invariant: every NON-blank line covered by exactly one chunk, no
// overlap, no whitespace-only chunk (embedder throws on blank).
function assertCoverage(content: string, chunks: Chunk[] | null) {
  expect(chunks).not.toBeNull()
  const lines = content.split("\n")
  const covered = new Map<number, number>()
  for (const c of chunks!) {
    expect(c.content.trim().length).toBeGreaterThan(0)
    expect(c.lineEnd).toBeLessThanOrEqual(lines.length)
    expect(c.lineStart).toBeGreaterThanOrEqual(1)
    for (let ln = c.lineStart; ln <= c.lineEnd; ln++) covered.set(ln, (covered.get(ln) ?? 0) + 1)
  }
  for (let ln = 1; ln <= lines.length; ln++) {
    const isBlank = (lines[ln - 1] ?? "").trim().length === 0
    const times = covered.get(ln) ?? 0
    if (isBlank) expect(times).toBeLessThanOrEqual(1)
    else expect(times).toBe(1)
  }
}

describe("jsTsExtOf", () => {
  it("recognizes JS/TS, rejects others", () => {
    expect(jsTsExtOf("a/b.ts")).toBe(".ts")
    expect(jsTsExtOf("a/b.tsx")).toBe(".tsx")
    expect(jsTsExtOf("a/b.mjs")).toBe(".mjs")
    expect(jsTsExtOf("a/b.py")).toBeNull()
    expect(jsTsExtOf("a/b.rs")).toBeNull()
    expect(jsTsExtOf("Makefile")).toBeNull()
  })
})

describe("chunkFileAst", () => {
  it("returns null on parse failure", () => {
    expect(chunkFileAst("x.ts", "const = = =", ".ts")).toBeNull()
  })
  it("keeps a small function signature + body together", () => {
    const content = [
      `import { z } from "./z"`,
      ``,
      `export function compute(width: number) {`,
      `  return width * 0.0144`,
      `}`,
    ].join("\n")
    const chunks = chunkFileAst("x.ts", content, ".ts")
    assertCoverage(content, chunks)
    const fn = chunks!.find((c) => c.content.includes("function compute"))!
    expect(fn.content).toContain("export function compute")
    expect(fn.content).toContain("return width * 0.0144")
  })
  it("covers multiple declarations, imports, blank gaps", () => {
    const content = [
      `import a from "a"`,
      `import b from "b"`,
      ``,
      `export const K = 6`,
      ``,
      `function f() {`,
      `  return K`,
      `}`,
      `class C {`,
      `  m() { return 1 }`,
      `}`,
    ].join("\n")
    assertCoverage(content, chunkFileAst("x.ts", content, ".ts"))
  })
  it("line-splits an oversized declaration, still exact coverage, no blank chunks", () => {
    const bigBody = Array.from({ length: 400 }, (_, i) => `  const x${i} = ${i} // ${"y".repeat(20)}`).join("\n")
    const content = `function big() {\n${bigBody}\n}`
    const chunks = chunkFileAst("x.ts", content, ".ts")
    assertCoverage(content, chunks)
    expect(chunks!.length).toBeGreaterThan(1)
    for (const c of chunks!) expect(c.content.length).toBeLessThanOrEqual(1400)
  })
  it("empty + comment-only files: no crash, no blank chunk", () => {
    expect(chunkFileAst("x.ts", "", ".ts")).toEqual([])
    const onlyComments = "// a\n// b\n"
    assertCoverage(onlyComments, chunkFileAst("x.ts", onlyComments, ".ts"))
  })
})
