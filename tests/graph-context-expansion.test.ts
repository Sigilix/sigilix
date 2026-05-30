// SIG-286 PR1 — graph-context-expansion module tests.
//
// buildGraphContextExpansion turns the LOCATION rows from
// RepoGraphDO.contextExpansionForChangedSymbols into bounded body snippets,
// sourcing text from filesByPath (free) or an OPTIONAL bounded fetcher. PR1
// passes no fetcher; cross-file rows then count under bodiesSource.missing.

import { describe, expect, it } from "vitest"
import { buildGraphContextExpansion } from "../src/lib/graph-context-expansion"
import type {
  GraphContextExpansion,
  GraphDefinitionRow,
  GraphCallerRow,
  GraphImportRow,
} from "../src/do/repo-graph"

function expansion(over: Partial<GraphContextExpansion> = {}): GraphContextExpansion {
  return {
    graphAvailable: true,
    definitionRows: [],
    callerRows: [],
    importRows: [],
    ...over,
  }
}

function defRow(over: Partial<GraphDefinitionRow> = {}): GraphDefinitionRow {
  return { symbolId: "src/b.ts function bar 1 0", path: "src/b.ts", name: "bar", kind: "function", startLine: 1, endLine: 3, ...over }
}

function callerRow(over: Partial<GraphCallerRow> = {}): GraphCallerRow {
  return {
    sourcePath: "src/b.ts", calleeName: "bar", callKind: "same_file",
    startLine: 7, startCol: 2,
    callerSymbolId: null, callerStartLine: null, callerEndLine: null,
    ...over,
  }
}

function importRow(over: Partial<GraphImportRow> = {}): GraphImportRow {
  return { sourcePath: "src/a.ts", importedName: "bar", startLine: 5, ...over }
}

// A 20-line source so windows / spans have room.
const SRC_B = Array.from({ length: 20 }, (_, i) => `// b line ${i + 1}`).join("\n")
const SRC_A = Array.from({ length: 20 }, (_, i) => `// a line ${i + 1}`).join("\n")

describe("buildGraphContextExpansion — source precedence", () => {
  it("prefers filesByPath; counts a row as filesByPath-sourced", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ definitionRows: [defRow()] }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
    })
    expect(result.definitionBodies).toHaveLength(1)
    expect(result.definitionBodies[0]?.source).toBe("filesByPath")
    expect(result.bodiesSource.filesByPath).toBe(1)
    expect(result.bodiesSource.github).toBe(0)
    expect(result.bodiesSource.missing).toBe(0)
  })

  it("uses the bounded fetcher for cross-file rows not in filesByPath and counts them as github", async () => {
    const fetched: string[] = []
    const result = await buildGraphContextExpansion({
      expansion: expansion({ importRows: [importRow()] }),
      filesByPath: new Map(), // src/a.ts NOT present
      fetchFileContent: async (p) => { fetched.push(p); return SRC_A },
    })
    expect(fetched).toEqual(["src/a.ts"])
    expect(result.dependentBodies).toHaveLength(1)
    expect(result.dependentBodies[0]?.source).toBe("github")
    expect(result.bodiesSource.github).toBe(1)
    expect(result.bodiesSource.missing).toBe(0)
  })

  it("PR1 (no fetcher): cross-file rows count under missing + dropped.sourceMissing and are skipped", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({
        definitionRows: [defRow()],                 // in filesByPath
        importRows: [importRow({ sourcePath: "src/a.ts" })], // NOT in filesByPath
      }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
      // no fetchFileContent → PR1 shape
    })
    expect(result.definitionBodies).toHaveLength(1)
    expect(result.dependentBodies).toHaveLength(0)
    expect(result.bodiesSource.filesByPath).toBe(1)
    expect(result.bodiesSource.missing).toBe(1)
    expect(result.dropped.sourceMissing).toBe(1)
  })

  it("fetcher returning null also counts as missing", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ importRows: [importRow()] }),
      filesByPath: new Map(),
      fetchFileContent: async () => null,
    })
    expect(result.dependentBodies).toHaveLength(0)
    expect(result.bodiesSource.missing).toBe(1)
    expect(result.dropped.sourceMissing).toBe(1)
  })

  it("reads each cross-file path once even with multiple rows on it", async () => {
    let calls = 0
    const result = await buildGraphContextExpansion({
      expansion: expansion({
        importRows: [importRow({ startLine: 3 }), importRow({ startLine: 9 })],
      }),
      filesByPath: new Map(),
      fetchFileContent: async () => { calls++; return SRC_A },
    })
    expect(calls).toBe(1)
    expect(result.dependentBodies).toHaveLength(2)
  })
})

describe("buildGraphContextExpansion — snippet windows", () => {
  it("definition body slices the symbol span (startLine..endLine)", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ definitionRows: [defRow({ startLine: 2, endLine: 4 })] }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
    })
    const body = result.definitionBodies[0]!
    expect(body.startLine).toBe(2)
    expect(body.endLine).toBe(4)
    expect(body.text).toContain("// b line 2")
    expect(body.text).toContain("// b line 4")
    expect(body.text).not.toContain("// b line 5")
  })

  it("caller body without a resolved caller span uses a ±8 window around the call line", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ callerRows: [callerRow({ startLine: 10 })] }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
    })
    const body = result.callerBodies[0]!
    expect(body.startLine).toBe(2)  // 10 - 8
    expect(body.endLine).toBe(18)   // 10 + 8
  })

  it("caller body WITH a resolved caller span uses the whole caller body", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({
        callerRows: [callerRow({ startLine: 12, callerSymbolId: "src/b.ts function useBar 5 0", callerStartLine: 5, callerEndLine: 9 })],
      }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
    })
    const body = result.callerBodies[0]!
    expect(body.startLine).toBe(5)
    expect(body.endLine).toBe(9)
  })

  it("import body uses a ±8 window around the import line", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ importRows: [importRow({ startLine: 12 })] }),
      filesByPath: new Map([["src/a.ts", SRC_A]]),
    })
    const body = result.dependentBodies[0]!
    expect(body.startLine).toBe(4)   // 12 - 8
    expect(body.endLine).toBe(20)    // 12 + 8 → clamped to file length 20
  })

  it("clamps windows to file bounds (no out-of-range lines)", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ importRows: [importRow({ startLine: 1 })] }),
      filesByPath: new Map([["src/a.ts", SRC_A]]),
    })
    const body = result.dependentBodies[0]!
    expect(body.startLine).toBe(1)   // 1 - 8 → clamped to 1
    expect(body.endLine).toBe(9)     // 1 + 8
  })
})

describe("buildGraphContextExpansion — cap + drop order", () => {
  it("drops import dependents before callers before definitions when the byte cap is tight", async () => {
    const files = new Map([["src/b.ts", SRC_B], ["src/a.ts", SRC_A]])
    // A maxBytes tight enough to fit ~1 small snippet: definition (highest
    // value) survives, the caller + import (lower value) are dropped.
    const result = await buildGraphContextExpansion({
      expansion: expansion({
        definitionRows: [defRow({ startLine: 1, endLine: 1 })],
        callerRows: [callerRow({ sourcePath: "src/b.ts", startLine: 10 })],
        importRows: [importRow({ sourcePath: "src/a.ts", startLine: 10 })],
      }),
      filesByPath: files,
      maxBytes: 60, // only the single-line definition fits
    })
    expect(result.definitionBodies).toHaveLength(1)
    expect(result.callerBodies).toHaveLength(0)
    expect(result.dependentBodies).toHaveLength(0)
    expect(result.dropped.cap).toBe(2)
    expect(result.cappedAt).toBe(60)
  })

  it("totalTokens = ceil(renderedChars / 4) and is 0 when everything is dropped/missing", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ importRows: [importRow()] }),
      filesByPath: new Map(), // missing, no fetcher
    })
    expect(result.totalTokens).toBe(0)
  })

  it("totalTokens scales with rendered payload", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ definitionRows: [defRow({ startLine: 1, endLine: 10 })] }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
    })
    expect(result.totalTokens).toBeGreaterThan(0)
  })
})

describe("buildGraphContextExpansion — telemetry shape + invariants", () => {
  it("returns the full EnrichedGraphContext shape", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ definitionRows: [defRow()] }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
    })
    expect(result).toMatchObject({
      graphAvailable: true,
      bodiesSource: { filesByPath: expect.any(Number), github: expect.any(Number), retrievalChunk: expect.any(Number), missing: expect.any(Number) },
      dropped: { cap: expect.any(Number), sourceMissing: expect.any(Number), graphRowsCapped: expect.any(Number) },
    })
    expect(typeof result.totalTokens).toBe("number")
    expect(typeof result.cappedAt).toBe("number")
    expect(typeof result.elapsedMs).toBe("number")
    expect(Array.isArray(result.definitionBodies)).toBe(true)
    expect(Array.isArray(result.callerBodies)).toBe(true)
    expect(Array.isArray(result.dependentBodies)).toBe(true)
  })

  it("preserves graphAvailable=false from the expansion (zeroed bodies)", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ graphAvailable: false }),
      filesByPath: new Map(),
    })
    expect(result.graphAvailable).toBe(false)
    expect(result.definitionBodies).toEqual([])
    expect(result.totalTokens).toBe(0)
  })

  it("returns a zeroed result immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await buildGraphContextExpansion({
      expansion: expansion({ definitionRows: [defRow()] }),
      filesByPath: new Map([["src/b.ts", SRC_B]]),
      signal: ctrl.signal,
    })
    expect(result.definitionBodies).toEqual([])
    expect(result.totalTokens).toBe(0)
  })

  it("never throws — a fetcher that throws yields a zeroed result", async () => {
    const result = await buildGraphContextExpansion({
      expansion: expansion({ importRows: [importRow()] }),
      filesByPath: new Map(),
      fetchFileContent: async () => { throw new Error("boom") },
    })
    // Internal error → zeroed result, graphAvailable preserved, no throw.
    expect(result.graphAvailable).toBe(true)
    expect(result.dependentBodies).toEqual([])
    expect(result.totalTokens).toBe(0)
  })
})
