import { describe, expect, it } from "vitest"
import { RepoGraphDO } from "@/src/do/repo-graph"
import { MAX_REPO_MAP_ROWS } from "@/src/do/repo-graph-repo-map"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

// ─── DO storage stub ─────────────────────────────────────────────
//
// Wires NodeSqliteStorage (real SQLite) into the DurableObjectState shape that
// RepoGraphDO expects. Mirrors the harness in repo-graph.hits.test.ts — each
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

// ─── repoMap tests (SIG-527) ──────────────────────────────────────

describe("RepoGraphDO.repoMap", () => {
  it("ranks by caller + importer centrality (most-depended-on first)", async () => {
    const do_ = makeDoInstance("o/map-rank")
    // util.ts exports `hot` (called from a.ts + b.ts) and `cold` (uncalled). Both
    // files import util.ts. `hot` must outrank `cold` on callerCount.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/util.ts",
      symbols: [
        {
          symbolId: "src/util.ts function hot 1 0",
          path: "src/util.ts",
          name: "hot",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 1,
        },
        {
          symbolId: "src/util.ts function cold 5 0",
          path: "src/util.ts",
          name: "cold",
          kind: "function",
          exported: true,
          startLine: 5,
          startCol: 0,
          endLine: 7,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    for (const src of ["src/a.ts", "src/b.ts"]) {
      await do_.upsertFileGraph({
        runId: "r",
        headSha: "h",
        path: src,
        symbols: [],
        fileEdgesRaw: [
          {
            sourcePath: src,
            edgeKind: "import",
            specifier: "./util",
            importedName: "hot",
            localName: "hot",
            exportedName: null,
            startLine: 1,
            startCol: 0,
          },
        ],
        callEdges: [{ sourcePath: src, calleeName: "hot", callKind: "imported_binding", startLine: 4, startCol: 0 }],
      })
    }
    await do_.commitGraphVersion("r")

    const map = await do_.repoMap({ biasPaths: [] })
    const hot = map.find((e) => e.name === "hot")
    const cold = map.find((e) => e.name === "cold")
    expect(hot).toBeDefined()
    expect(cold).toBeDefined()
    // hot is called by 2 distinct files; cold by none.
    expect(hot!.callerCount).toBe(2)
    expect(cold!.callerCount).toBe(0)
    // both live in util.ts, imported by a.ts + b.ts → file-level importerCount = 2.
    expect(hot!.importerCount).toBe(2)
    // hot (score: 2 callers + counts) ranks ahead of cold.
    expect(map.findIndex((e) => e.name === "hot")).toBeLessThan(map.findIndex((e) => e.name === "cold"))
  })

  it("counts callers DISTINCT by source file (two calls from one file = 1 caller)", async () => {
    const do_ = makeDoInstance("o/map-distinct")
    // b.ts calls bar TWICE (lines 7 and 8) — same-file → distinct source_path = 1.
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
      callEdges: [
        { sourcePath: "src/b.ts", calleeName: "bar", callKind: "same_file", startLine: 7, startCol: 2 },
        { sourcePath: "src/b.ts", calleeName: "bar", callKind: "same_file", startLine: 8, startCol: 2 },
      ],
    })
    await do_.commitGraphVersion("r")

    const map = await do_.repoMap({ biasPaths: [] })
    const bar = map.find((e) => e.name === "bar")
    expect(bar).toBeDefined()
    expect(bar!.callerCount).toBe(1) // DISTINCT source_path, not 2 call sites
  })

  it("applies the bias boost so a biased-path symbol can outrank a slightly-more-central one", async () => {
    const do_ = makeDoInstance("o/map-bias")
    // central.ts/star: called by 2 files. biased.ts/local: called by 1 file. Without
    // bias, star outranks local. With biasPaths=[biased.ts], local's +5 boost wins.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/central.ts",
      symbols: [
        {
          symbolId: "src/central.ts function star 1 0",
          path: "src/central.ts",
          name: "star",
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
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/biased.ts",
      symbols: [
        {
          symbolId: "src/biased.ts function local 1 0",
          path: "src/biased.ts",
          name: "local",
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
    // two callers of star, one caller of local.
    for (const src of ["src/c1.ts", "src/c2.ts"]) {
      await do_.upsertFileGraph({
        runId: "r",
        headSha: "h",
        path: src,
        symbols: [],
        fileEdgesRaw: [
          {
            sourcePath: src,
            edgeKind: "import",
            specifier: "./central",
            importedName: "star",
            localName: "star",
            exportedName: null,
            startLine: 1,
            startCol: 0,
          },
        ],
        callEdges: [{ sourcePath: src, calleeName: "star", callKind: "imported_binding", startLine: 4, startCol: 0 }],
      })
    }
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/l1.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/l1.ts",
          edgeKind: "import",
          specifier: "./biased",
          importedName: "local",
          localName: "local",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [
        { sourcePath: "src/l1.ts", calleeName: "local", callKind: "imported_binding", startLine: 4, startCol: 0 },
      ],
    })
    await do_.commitGraphVersion("r")

    // No bias: star (more callers) ranks first.
    const unbiased = await do_.repoMap({ biasPaths: [] })
    expect(unbiased.findIndex((e) => e.name === "star")).toBeLessThan(unbiased.findIndex((e) => e.name === "local"))

    // Bias toward biased.ts: local's +5 boost lifts it above star.
    const biased = await do_.repoMap({ biasPaths: ["src/biased.ts"] })
    expect(biased.findIndex((e) => e.name === "local")).toBeLessThan(biased.findIndex((e) => e.name === "star"))
  })

  it("includes private (non-exported) symbols; exported only breaks ties", async () => {
    const do_ = makeDoInstance("o/map-private")
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/p.ts",
      symbols: [
        {
          symbolId: "src/p.ts function secret 1 0",
          path: "src/p.ts",
          name: "secret",
          kind: "function",
          exported: false,
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
    const map = await do_.repoMap({ biasPaths: [] })
    const secret = map.find((e) => e.name === "secret")
    expect(secret).toBeDefined()
    expect(secret!.exported).toBe(false)
  })

  it("respects the limit", async () => {
    const do_ = makeDoInstance("o/map-limit")
    const symbols = Array.from({ length: 10 }, (_, i) => ({
      symbolId: `src/m.ts function f${i} ${i + 1} 0`,
      path: "src/m.ts",
      name: `f${i}`,
      kind: "function",
      exported: true,
      startLine: i + 1,
      startCol: 0,
      endLine: i + 1,
      endCol: 1,
    }))
    await do_.upsertFileGraph({ runId: "r", headSha: "h", path: "src/m.ts", symbols, fileEdgesRaw: [], callEdges: [] })
    await do_.commitGraphVersion("r")
    const map = await do_.repoMap({ biasPaths: [], limit: 3 })
    expect(map).toHaveLength(3)
  })

  it("clamps a hostile/oversized limit to MAX_REPO_MAP_ROWS", async () => {
    const do_ = makeDoInstance("o/map-clamp")
    // MAX_REPO_MAP_ROWS + 50 symbols; a limit far above the cap must not return them all.
    const n = MAX_REPO_MAP_ROWS + 50
    const symbols = Array.from({ length: n }, (_, i) => ({
      symbolId: `src/m.ts function f${i} ${i + 1} 0`,
      path: "src/m.ts",
      name: `f${i}`,
      kind: "function",
      exported: true,
      startLine: i + 1,
      startCol: 0,
      endLine: i + 1,
      endCol: 1,
    }))
    await do_.upsertFileGraph({ runId: "r", headSha: "h", path: "src/m.ts", symbols, fileEdgesRaw: [], callEdges: [] })
    await do_.commitGraphVersion("r")
    const map = await do_.repoMap({ biasPaths: [], limit: 100000 })
    expect(map).toHaveLength(MAX_REPO_MAP_ROWS)
  })

  it("uses the symbol-level (direct) importer count to break a caller/file-importer tie", async () => {
    const do_ = makeDoInstance("o/map-direct-importer")
    // a.ts and b.ts each export one symbol, neither is called, both files imported by
    // ONE file (equal file-level importerCount). But the importer of a.ts resolves the
    // import to `aSym` (direct symbol import), while the importer of b.ts is a bare
    // file edge with no resolved target_symbol_id. So aSym's direct-importer count
    // breaks the tie and ranks it ahead of bSym.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/a.ts",
      symbols: [
        {
          symbolId: "src/a.ts function aSym 1 0",
          path: "src/a.ts",
          name: "aSym",
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
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/b.ts",
      symbols: [
        {
          symbolId: "src/b.ts function bSym 1 0",
          path: "src/b.ts",
          name: "bSym",
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
    // importer of a.ts: a named import of aSym → resolves to target_symbol_id at commit.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/ia.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/ia.ts",
          edgeKind: "import",
          specifier: "./a",
          importedName: "aSym",
          localName: "aSym",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    // importer of b.ts: a namespace import (no specific named symbol) → resolves to a
    // file-level edge only (target_path set, target_symbol_id null).
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/ib.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/ib.ts",
          edgeKind: "import",
          specifier: "./b",
          importedName: null,
          localName: "b",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const map = await do_.repoMap({ biasPaths: [] })
    const aSym = map.find((e) => e.name === "aSym")
    const bSym = map.find((e) => e.name === "bSym")
    expect(aSym).toBeDefined()
    expect(bSym).toBeDefined()
    // Tie on caller (0/0) and on the file-level importer count (both imported by 1 file)…
    expect(aSym!.callerCount).toBe(0)
    expect(bSym!.callerCount).toBe(0)
    expect(aSym!.importerCount).toBe(1)
    expect(bSym!.importerCount).toBe(1)
    // …broken by the symbol-level direct-importer count → aSym ranks ahead of bSym.
    expect(map.findIndex((e) => e.name === "aSym")).toBeLessThan(map.findIndex((e) => e.name === "bSym"))
  })

  it("returns [] when there is no active graph version", async () => {
    const do_ = makeDoInstance("o/map-no-active")
    const map = await do_.repoMap({ biasPaths: [] })
    expect(map).toEqual([])
  })
})
