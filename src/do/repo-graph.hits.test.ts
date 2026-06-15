import { describe, expect, it } from "vitest"
import { RepoGraphDO } from "@/src/do/repo-graph"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

// ─── DO storage stub ─────────────────────────────────────────────
//
// Wires NodeSqliteStorage (real SQLite) into the DurableObjectState shape that
// RepoGraphDO expects. Mirrors the harness in repo-graph.context.test.ts — each
// repo-graph.*.test.ts file is standalone.

function makeSqliteState(name: string = "test-instance") {
  const sqlStorage = new NodeSqliteStorage()

  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T {
        return sqlStorage.transactionSync(fn)
      },
      // KV-style stubs (unused by RepoGraphDO but satisfy DurableObjectState shape)
      async get<T>(key: string): Promise<T | undefined> {
        void key
        return undefined
      },
      async put<T>(key: string, value: T): Promise<void> {
        void key
        void value
      },
      async delete(key: string): Promise<boolean> {
        void key
        return false
      },
      async setAlarm(timestamp: number): Promise<void> {
        void timestamp
      },
      async getAlarm(): Promise<number | null> {
        return null
      },
      async deleteAlarm(): Promise<void> {
        /* no-op */
      },
    },
    id: { toString: () => name, name },
  }

  return state
}

function makeDoInstance(name: string = "o/r") {
  const state = makeSqliteState(name)
  const env = {} as Env
  return new RepoGraphDO(state as unknown as DurableObjectState, env)
}

// ─── enclosingSymbolsForHits tests (SIG-407) ──────────────────────

describe("RepoGraphDO.enclosingSymbolsForHits", () => {
  it("resolves a hit to its enclosing symbol and returns rows + headSha", async () => {
    const do_ = makeDoInstance("o/hit-basic")
    // b.ts: exported `bar` (span 1-3) + same-file `useBar` (5-9) calling bar at line 7.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "abc123",
      path: "src/b.ts",
      symbols: [
        {
          symbolId: "src/b.ts function bar 1 0",
          path: "src/b.ts",
          name: "bar",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 1,
        },
        {
          symbolId: "src/b.ts function useBar 5 0",
          path: "src/b.ts",
          name: "useBar",
          kind: "function",
          exported: false,
          startLine: 5,
          startCol: 0,
          endLine: 9,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [{ sourcePath: "src/b.ts", calleeName: "bar", callKind: "same_file", startLine: 7, startCol: 2 }],
    })
    // a.ts imports + calls bar cross-file (imported_binding resolves at commit).
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "abc123",
      path: "src/a.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./b",
          importedName: "bar",
          localName: "bar",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [
        { sourcePath: "src/a.ts", calleeName: "bar", callKind: "imported_binding", startLine: 4, startCol: 0 },
      ],
    })
    await do_.commitGraphVersion("r")

    // A hit landing inside bar's body (lines 1-2 ⊂ span 1-3).
    const exp = await do_.enclosingSymbolsForHits({
      hits: [{ path: "src/b.ts", lineStart: 1, lineEnd: 2 }],
    })

    expect(exp.graphAvailable).toBe(true)
    expect(exp.headSha).toBe("abc123")
    expect(exp.definitionRows).toHaveLength(1)
    expect(exp.definitionRows[0]).toMatchObject({
      symbolId: "src/b.ts function bar 1 0",
      name: "bar",
      startLine: 1,
      endLine: 3,
    })
    // callers: same-file (b.ts:7) + resolved cross-file imported_binding (a.ts:4).
    expect(exp.callerRows.map((r) => r.sourcePath).sort()).toEqual(["src/a.ts", "src/b.ts"])
    // importer: a.ts imports bar.
    expect(exp.importRows.map((r) => r.sourcePath)).toContain("src/a.ts")
  })

  it("picks the INNERMOST symbol when a hit nests inside an outer span (equal overlap → smallest span)", async () => {
    const do_ = makeDoInstance("o/hit-nested")
    // Outer 1-20 fully contains inner 5-10. A hit at 6-7 overlaps both equally
    // (overlap 2 each) → innermost (inner, span 5) must win over Outer (span 19).
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/c.ts",
      symbols: [
        {
          symbolId: "src/c.ts class Outer 1 0",
          path: "src/c.ts",
          name: "Outer",
          kind: "class",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 20,
          endCol: 1,
        },
        {
          symbolId: "src/c.ts method inner 5 2",
          path: "src/c.ts",
          name: "inner",
          kind: "method",
          exported: false,
          startLine: 5,
          startCol: 2,
          endLine: 10,
          endCol: 3,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const exp = await do_.enclosingSymbolsForHits({ hits: [{ path: "src/c.ts", lineStart: 6, lineEnd: 7 }] })
    expect(exp.definitionRows).toHaveLength(1)
    expect(exp.definitionRows[0]!.name).toBe("inner")
  })

  it("picks the MAX-OVERLAP symbol when a hit straddles two sibling symbols", async () => {
    const do_ = makeDoInstance("o/hit-straddle")
    // fa 1-10, fb 11-20. Hit 8-12: overlap(fa)=3 > overlap(fb)=2 → fa wins.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/d.ts",
      symbols: [
        {
          symbolId: "src/d.ts function fa 1 0",
          path: "src/d.ts",
          name: "fa",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 1,
        },
        {
          symbolId: "src/d.ts function fb 11 0",
          path: "src/d.ts",
          name: "fb",
          kind: "function",
          exported: true,
          startLine: 11,
          startCol: 0,
          endLine: 20,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const exp = await do_.enclosingSymbolsForHits({ hits: [{ path: "src/d.ts", lineStart: 8, lineEnd: 12 }] })
    expect(exp.definitionRows).toHaveLength(1)
    expect(exp.definitionRows[0]!.name).toBe("fa")
  })

  it("dedups multiple hits that land in the same symbol", async () => {
    const do_ = makeDoInstance("o/hit-dedup")
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/e.ts",
      symbols: [
        {
          symbolId: "src/e.ts function big 1 0",
          path: "src/e.ts",
          name: "big",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 30,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const exp = await do_.enclosingSymbolsForHits({
      hits: [
        { path: "src/e.ts", lineStart: 2, lineEnd: 4 },
        { path: "src/e.ts", lineStart: 20, lineEnd: 22 },
      ],
    })
    expect(exp.definitionRows).toHaveLength(1)
    expect(exp.definitionRows[0]!.name).toBe("big")
  })

  it("graphAvailable=false, headSha=null when there is no active version", async () => {
    const do_ = makeDoInstance("o/hit-no-active")
    const exp = await do_.enclosingSymbolsForHits({ hits: [{ path: "src/a.ts", lineStart: 1, lineEnd: 2 }] })
    expect(exp.graphAvailable).toBe(false)
    expect(exp.headSha).toBeNull()
    expect(exp.definitionRows).toEqual([])
    expect(exp.callerRows).toEqual([])
    expect(exp.importRows).toEqual([])
  })

  it("graphAvailable=false when hits is empty", async () => {
    const do_ = makeDoInstance("o/hit-empty")
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/a.ts",
      symbols: [
        {
          symbolId: "src/a.ts function fa 1 0",
          path: "src/a.ts",
          name: "fa",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")
    const exp = await do_.enclosingSymbolsForHits({ hits: [] })
    expect(exp.graphAvailable).toBe(false)
    expect(exp.headSha).toBeNull()
  })

  it("graphAvailable=true with headSha and empty rows when a hit lands in no symbol", async () => {
    const do_ = makeDoInstance("o/hit-no-symbol")
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "zz",
      path: "src/a.ts",
      symbols: [
        {
          symbolId: "src/a.ts function fa 1 0",
          path: "src/a.ts",
          name: "fa",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")
    // Hit at 50-60 — past every symbol span → resolves to nothing.
    const exp = await do_.enclosingSymbolsForHits({ hits: [{ path: "src/a.ts", lineStart: 50, lineEnd: 60 }] })
    expect(exp.graphAvailable).toBe(true)
    expect(exp.headSha).toBe("zz")
    expect(exp.definitionRows).toEqual([])
    expect(exp.callerRows).toEqual([])
    expect(exp.importRows).toEqual([])
  })

  it("caps each row list at maxRows", async () => {
    const do_ = makeDoInstance("o/hit-cap")
    const callEdges = Array.from({ length: 10 }, (_, i) => ({
      sourcePath: "src/b.ts",
      calleeName: "bar",
      callKind: "same_file",
      startLine: 20 + i,
      startCol: 0,
    }))
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/b.ts",
      symbols: [
        {
          symbolId: "src/b.ts function bar 1 0",
          path: "src/b.ts",
          name: "bar",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges,
    })
    await do_.commitGraphVersion("r")
    const exp = await do_.enclosingSymbolsForHits({
      hits: [{ path: "src/b.ts", lineStart: 1, lineEnd: 2 }],
      maxRows: 3,
    })
    expect(exp.callerRows).toHaveLength(3)
  })

  it("resolves a hit that touches a symbol's exact boundary line (inclusive span)", async () => {
    const do_ = makeDoInstance("o/hit-boundary")
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/b.ts",
      symbols: [
        {
          symbolId: "src/b.ts function bar 1 0",
          path: "src/b.ts",
          name: "bar",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")
    // Hit exactly at bar's last line (3-3) — the inclusive end_line >= hitStart must match.
    const exp = await do_.enclosingSymbolsForHits({ hits: [{ path: "src/b.ts", lineStart: 3, lineEnd: 3 }] })
    expect(exp.definitionRows).toHaveLength(1)
    expect(exp.definitionRows[0]!.name).toBe("bar")
  })

  it("a malformed hit range (lineEnd < lineStart) resolves to nothing", async () => {
    const do_ = makeDoInstance("o/hit-malformed")
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/b.ts",
      symbols: [
        {
          symbolId: "src/b.ts function bar 1 0",
          path: "src/b.ts",
          name: "bar",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")
    // Swapped range (8 > 5) must not mis-home onto bar — guarded to no symbol.
    const exp = await do_.enclosingSymbolsForHits({ hits: [{ path: "src/b.ts", lineStart: 8, lineEnd: 5 }] })
    expect(exp.graphAvailable).toBe(true)
    expect(exp.definitionRows).toEqual([])
  })
})
