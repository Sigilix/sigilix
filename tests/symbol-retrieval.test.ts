import { describe, expect, it } from "vitest"
import {
  extractChangedSymbols,
  buildSymbolRetrievalQuery,
  computeChunkOverlap,
  shouldRunSymbolRetrieval,
  mergeLogicSnapshot,
} from "../src/lib/symbol-retrieval"
import { buildChangedLines } from "../src/lib/ast-rules/diff-filter"
import type { RetrievedChunk } from "../src/lib/retrieval"

function chunk(path: string, a: number, b: number): RetrievedChunk {
  return { path, lineStart: a, lineEnd: b, content: "x", score: 0.5 }
}

describe("extractChangedSymbols", () => {
  it("extracts a function whose BODY intersects an added line (decl line unchanged)", () => {
    // file: function f spans lines 1-4; only line 3 (inside the body) is added.
    const src = "function loadOrders(ids) {\n  const a = 1\n  return batch(ids)\n}\n"
    const files = new Map([["src/a.ts", src]])
    const changed = buildChangedLines(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,0 +3,1 @@\n+  return batch(ids)\n",
    )
    expect(extractChangedSymbols(files, changed)).toEqual(["loadOrders"])
  })
  it("extracts class + method + exported const when their range intersects added lines", () => {
    const src = [
      "export class Orders {",          // 1
      "  process(items) {",             // 2
      "    return items.map(x => x)",    // 3
      "  }",                             // 4
      "}",                               // 5
      "export const TOTAL = compute()",  // 6
    ].join("\n")
    const files = new Map([["src/o.ts", src]])
    const changed = buildChangedLines(
      "diff --git a/src/o.ts b/src/o.ts\n--- a/src/o.ts\n+++ b/src/o.ts\n@@ -3,0 +3,1 @@\n+    return items.map(x => x)\n@@ -6,0 +6,1 @@\n+export const TOTAL = compute()\n",
    )
    const out = extractChangedSymbols(files, changed)
    expect(out).toContain("Orders")
    expect(out).toContain("process")
    expect(out).toContain("TOTAL")
  })
  it("ignores a symbol whose range does NOT intersect any added line", () => {
    const src = "function untouched() {\n  return 1\n}\nfunction changed() {\n  return 2\n}\n"
    const files = new Map([["src/a.ts", src]])
    // only line 5 (inside `changed`) is added
    const changed = buildChangedLines(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5,0 +5,1 @@\n+  return 2\n",
    )
    expect(extractChangedSymbols(files, changed)).toEqual(["changed"])
  })
  it("falls back to a regex over added lines when the file fails to parse", () => {
    const src = "function broken( {\n  this is not valid js\n}\n" // parse error
    const files = new Map([["src/a.ts", src]])
    const changed = buildChangedLines(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+function broken( {\n",
    )
    // regex fallback still recovers the declared name from the added line
    expect(extractChangedSymbols(files, changed)).toContain("broken")
  })
  it("dedupes and caps", () => {
    const files = new Map<string, string>()
    const diffParts: string[] = []
    for (let i = 0; i < 40; i++) {
      files.set(`src/f${i}.ts`, `function fn${i}() {\n  return ${i}\n}\n`)
      diffParts.push(`diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,0 +1,1 @@\n+function fn${i}() {\n`)
    }
    const out = extractChangedSymbols(files, buildChangedLines(diffParts.join("")))
    expect(out.length).toBeLessThanOrEqual(30)
    expect(new Set(out).size).toBe(out.length)
  })
  it("returns empty for no files / no changed lines", () => {
    expect(extractChangedSymbols(new Map(), buildChangedLines(""))).toEqual([])
  })
})

describe("buildSymbolRetrievalQuery", () => {
  it("includes the symbols and is non-empty", () => {
    const q = buildSymbolRetrievalQuery(["loadOrders", "Orders"])
    expect(q).toContain("loadOrders")
    expect(q).toContain("Orders")
    expect(q.length).toBeGreaterThan(0)
  })
  it("returns empty string for no symbols (caller skips retrieval)", () => {
    expect(buildSymbolRetrievalQuery([])).toBe("")
  })
})

describe("computeChunkOverlap", () => {
  it("computes intersection + Jaccard over chunk ids", () => {
    const shared = [chunk("a.ts", 1, 5), chunk("b.ts", 1, 5)]
    const symbol = [chunk("b.ts", 1, 5), chunk("c.ts", 1, 5)]
    const o = computeChunkOverlap(shared, symbol)
    expect(o.sharedCount).toBe(2)
    expect(o.symbolCount).toBe(2)
    expect(o.intersectionCount).toBe(1) // b.ts:1-5
    expect(o.jaccard).toBeCloseTo(1 / 3) // |∩|=1, |∪|=3
  })
  it("jaccard is 0 when either side is empty", () => {
    expect(computeChunkOverlap([], [chunk("a.ts", 1, 2)]).jaccard).toBe(0)
    expect(computeChunkOverlap([chunk("a.ts", 1, 2)], []).jaccard).toBe(0)
  })
})

describe("shouldRunSymbolRetrieval", () => {
  it("fires only when flag on, logic in lineup, and budget > 2", () => {
    expect(shouldRunSymbolRetrieval("on", ["logic", "security"], 3)).toBe(true)
  })
  it("skips when flag is not 'on'", () => {
    expect(shouldRunSymbolRetrieval("off", ["logic"], 3)).toBe(false)
    expect(shouldRunSymbolRetrieval(undefined, ["logic"], 3)).toBe(false)
  })
  it("skips when logic not in lineup or budget too low", () => {
    expect(shouldRunSymbolRetrieval("on", ["security"], 3)).toBe(false)
    expect(shouldRunSymbolRetrieval("on", ["logic"], 2)).toBe(false)
  })
})

describe("mergeLogicSnapshot", () => {
  it("AUGMENTS: shared first, then symbol block (both present)", () => {
    const out = mergeLogicSnapshot("SHARED", "SYMBOL")
    expect(out.indexOf("SHARED")).toBeLessThan(out.indexOf("SYMBOL"))
  })
  it("returns shared alone when symbol snapshot empty", () => {
    expect(mergeLogicSnapshot("SHARED", "")).toBe("SHARED")
  })
  it("returns symbol alone when shared empty", () => {
    expect(mergeLogicSnapshot("", "SYMBOL")).toBe("SYMBOL")
  })
})
