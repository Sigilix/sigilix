import { describe, expect, it } from "vitest"
import { RepoGraphDO, DEFAULT_EXPANSION_ROWS } from "@/src/do/repo-graph"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

// ─── DO storage stub ─────────────────────────────────────────────
//
// Wires NodeSqliteStorage (real SQLite) into the DurableObjectState
// shape that RepoGraphDO expects.

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

describe("RepoGraphDO.contextForVectorHits", () => {
  // Helper: upsert a file with one exported symbol and optionally one import edge.
  // The import edge is constructed so that it resolves: importedName matches the
  // target's exported symbol name, so after commitGraphVersion target_path IS NOT NULL
  // (either resolved or ambiguous — both work for BFS traversal).
  async function mkFile(
    do_: InstanceType<typeof RepoGraphDO>,
    runId: string,
    path: string,
    symName: string,
    importSpec: { specifier: string; importedName: string } | null,
  ) {
    await do_.upsertFileGraph({
      runId,
      headSha: "h",
      path,
      symbols: [
        {
          symbolId: `${path} function ${symName} 1 0`,
          path,
          name: symName,
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: importSpec
        ? [
            {
              sourcePath: path,
              edgeKind: "import",
              specifier: importSpec.specifier,
              importedName: importSpec.importedName,
              localName: importSpec.importedName,
              exportedName: null,
              startLine: 1,
              startCol: 0,
            },
          ]
        : [],
      callEdges: [],
    })
  }

  it("returns hop1 and hop2 neighbors; excludes hop3", async () => {
    // Chain: a.ts → b.ts (hop1) → c.ts (hop2) → d.ts (hop3, must be excluded).
    // Each file exports a symbol and imports from the next.
    // importedName matches the target's exported symbol so the edge resolves
    // to target_path (either resolved or ambiguous — both have target_path set).
    const do_ = makeDoInstance("o/ctx-chain")
    const r = "r"
    // d.ts: only defines fd, no outgoing edges
    await mkFile(do_, r, "src/d.ts", "fd", null)
    // c.ts: imports fc_from_d from d.ts (importedName matches fd? No — let's use the
    // actual exported name of the target so edge resolves cleanly)
    await mkFile(do_, r, "src/c.ts", "fc", { specifier: "./d", importedName: "fd" })
    await mkFile(do_, r, "src/b.ts", "fb", { specifier: "./c", importedName: "fc" })
    await mkFile(do_, r, "src/a.ts", "fa", { specifier: "./b", importedName: "fb" })
    await do_.commitGraphVersion(r)

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })

    const paths = ctx.nodes.map((n) => n.path)

    // hop1: a.ts → b.ts
    expect(paths).toContain("src/b.ts")
    expect(ctx.nodes.find((n) => n.path === "src/b.ts")!.hop).toBe(1)

    // hop2: b.ts → c.ts
    expect(paths).toContain("src/c.ts")
    expect(ctx.nodes.find((n) => n.path === "src/c.ts")!.hop).toBe(2)

    // hop3: c.ts → d.ts — must NOT appear (K=2 cap)
    expect(paths).not.toContain("src/d.ts")
  })

  it("returns edgeKind, symbolId=null, name=null on every node (v1 file-level)", async () => {
    const do_ = makeDoInstance("o/ctx-node-shape")
    await mkFile(do_, "r", "src/a.ts", "fa", null)
    await mkFile(do_, "r", "src/b.ts", "fb", null)
    // a.ts imports from b.ts — edge lands resolved because importedName=fb matches export
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./b",
          importedName: "fb",
          localName: "fb",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })

    expect(ctx.nodes).toHaveLength(1)
    const node = ctx.nodes[0]
    expect(node.path).toBe("src/b.ts")
    expect(node.symbolId).toBeNull()
    expect(node.name).toBeNull()
    expect(node.hop).toBe(1)
    expect(node.edgeKind).toBe("import")
  })

  it("returns empty nodes when seedPaths is empty", async () => {
    const do_ = makeDoInstance("o/ctx-empty-seeds")
    await mkFile(do_, "r", "src/a.ts", "fa", null)
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: [],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })
    expect(ctx.nodes).toEqual([])
  })

  it("returns empty nodes when there is no active version", async () => {
    const do_ = makeDoInstance("o/ctx-no-active")
    // No commitGraphVersion call
    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })
    expect(ctx.nodes).toEqual([])
  })

  it("respects maxFiles cap — stops adding nodes at the cap", async () => {
    // a.ts → b.ts (would be hop1), a.ts → c.ts (would be hop1 too), etc.
    // With maxFiles=1, only the first neighbor is returned (deterministic order).
    const do_ = makeDoInstance("o/ctx-maxfiles")
    await mkFile(do_, "r", "src/b.ts", "fb", null)
    await mkFile(do_, "r", "src/c.ts", "fc", null)
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./b",
          importedName: "fb",
          localName: "fb",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./c",
          importedName: "fc",
          localName: "fc",
          exportedName: null,
          startLine: 2,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 1,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })
    // Must be exactly 1 (stops immediately when cap is reached)
    expect(ctx.nodes).toHaveLength(1)
  })

  it("respects maxEdgesPerSymbol fan-out limit per node", async () => {
    // a.ts has 3 outgoing edges to 3 distinct files (b.ts, c.ts, d.ts).
    // With maxEdgesPerSymbol=2, only 2 hop-1 neighbors are returned (b.ts and c.ts,
    // deterministically ordered by target_path).
    const do_ = makeDoInstance("o/ctx-max-edges")
    await mkFile(do_, "r", "src/b.ts", "fb", null)
    await mkFile(do_, "r", "src/c.ts", "fc", null)
    await mkFile(do_, "r", "src/d.ts", "fd", null)
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./b",
          importedName: "fb",
          localName: "fb",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./c",
          importedName: "fc",
          localName: "fc",
          exportedName: null,
          startLine: 2,
          startCol: 0,
        },
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./d",
          importedName: "fd",
          localName: "fd",
          exportedName: null,
          startLine: 3,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 2, // Only 2 edges per source file allowed
    })

    // Should have at most 2 hop-1 neighbors (b.ts and c.ts, in alphabetical order)
    const paths = ctx.nodes.map((n) => n.path)
    expect(paths.length).toBeLessThanOrEqual(2)
    // d.ts should be excluded due to maxEdgesPerSymbol=2
    expect(paths).not.toContain("src/d.ts")
  })

  it("cycle safety: two-file cycle (a→b→a) does not duplicate or infinite loop", async () => {
    // a.ts imports b; b.ts imports a (cycle).
    // Seed from a.ts; output should contain b.ts exactly once (no a.ts since it's a seed).
    const do_ = makeDoInstance("o/ctx-cycle")
    await mkFile(do_, "r", "src/b.ts", "fb", { specifier: "./a", importedName: "fa" })
    await mkFile(do_, "r", "src/a.ts", "fa", { specifier: "./b", importedName: "fb" })
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })

    const paths = ctx.nodes.map((n) => n.path)
    // b.ts should appear exactly once (hop1 from a.ts)
    expect(paths).toContain("src/b.ts")
    const bCount = paths.filter((p) => p === "src/b.ts").length
    expect(bCount).toBe(1)
    // a.ts must NOT appear in output (it's a seed)
    expect(paths).not.toContain("src/a.ts")
  })

  // Fix 4a: seed path with NO outgoing resolved edges → nodes: []
  it("Fix 4a: seed file with no outgoing edges returns no nodes", async () => {
    const do_ = makeDoInstance("o/ctx-no-edges")
    // a.ts exists in the graph but has no import or call edges.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/a.ts",
      symbols: [
        {
          symbolId: "src/a.ts function leaf 1 0",
          path: "src/a.ts",
          name: "leaf",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })
    expect(ctx.nodes).toEqual([])
  })

  // Fix 4b: maxEdgesPerSymbol=0 → no edges fetched from any seed → no nodes
  it("Fix 4b: maxEdgesPerSymbol=0 returns no nodes even when edges exist", async () => {
    const do_ = makeDoInstance("o/ctx-max-edges-zero")
    await mkFile(do_, "r", "src/b.ts", "fb", null)
    await mkFile(do_, "r", "src/a.ts", "fa", { specifier: "./b", importedName: "fb" })
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 0,
    })
    expect(ctx.nodes).toEqual([])
  })

  // Fix 4c: maxFiles=0 → the outer loop condition (nodes.length < maxFiles) is
  // immediately false → no nodes returned even when edges exist
  it("Fix 4c: maxFiles=0 returns no nodes even when edges exist", async () => {
    const do_ = makeDoInstance("o/ctx-max-files-zero")
    await mkFile(do_, "r", "src/b.ts", "fb", null)
    await mkFile(do_, "r", "src/a.ts", "fa", { specifier: "./b", importedName: "fb" })
    await do_.commitGraphVersion("r")

    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 0,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })
    expect(ctx.nodes).toEqual([])
  })

  // Fix 4d: an UNRESOLVED edge (target_path is null) is NOT traversed or returned.
  // The SQL query filters with `AND target_path IS NOT NULL`, so unresolved edges
  // must never appear as nodes in the output.
  it("Fix 4d: unresolved edge (target_path=null) is not traversed or returned", async () => {
    const do_ = makeDoInstance("o/ctx-unresolved-edge")

    // a.ts: imports './ghost' — ghost.ts is not in the graph, so the edge
    // stays unresolved (target_path = null) after commitGraphVersion.
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./ghost",
          importedName: "ghost",
          localName: "ghost",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    // Sanity: confirm the edge is unresolved (target_path = null).
    const edges = await do_.debugResolvedEdges("src/a.ts")
    const ghostEdge = edges.find((e) => e.resolutionStatus === "unresolved")
    expect(ghostEdge).toBeDefined()
    expect(ghostEdge!.targetPath).toBeNull()

    // contextForVectorHits must return no nodes — the unresolved edge is excluded.
    const ctx = await do_.contextForVectorHits({
      seedPaths: ["src/a.ts"],
      maxFiles: 8,
      maxSymbolsPerHit: 12,
      maxEdgesPerSymbol: 6,
    })
    expect(ctx.nodes).toEqual([])
  })
})

// ─── deleteRepoGraph tests ────────────────────────────────────────

describe("RepoGraphDO.deleteRepoGraph", () => {
  it("wipes all tables: activeVersion is null and counts are 0 after delete", async () => {
    const do_ = makeDoInstance("o/delete-test")

    // Upsert a file and commit a version so the DO has real data.
    await do_.upsertFileGraph({
      runId: "run-del",
      headSha: "sha-del",
      path: "src/a.ts",
      symbols: [
        {
          symbolId: "src/a.ts function foo 1 0",
          path: "src/a.ts",
          name: "foo",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 1,
          endCol: 10,
        },
      ],
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
        {
          sourcePath: "src/a.ts",
          calleeName: "helper",
          callKind: "same_file",
          startLine: 5,
          startCol: 2,
        },
      ],
    })
    await do_.commitGraphVersion("run-del")

    // Sanity-check: data is present before delete.
    expect(await do_.debugActiveVersion()).toBe("run-del")

    // Delete everything.
    await do_.deleteRepoGraph()

    // Active version must be null.
    expect(await do_.debugActiveVersion()).toBeNull()

    // All counts for the deleted version must be 0 and status null.
    const counts = await do_.debugCounts("run-del")
    expect(counts.symbols).toBe(0)
    expect(counts.fileEdges).toBe(0)
    expect(counts.callEdges).toBe(0)
    expect(counts.status).toBeNull()
  })
})

// ─── contextExpansionForChangedSymbols tests (SIG-286) ────────────
//
// Row-level context expansion: definition spans, same-file call sites
// (callee_symbol_id-matched, with the caller span joined), and import
// reference lines — all scoped to the active version and the changed files.

describe("RepoGraphDO.contextExpansionForChangedSymbols", () => {
  it("returns definition spans, import lines, and same-file caller lines", async () => {
    const do_ = makeDoInstance("o/exp")

    // b.ts defines exported `bar` (the changed symbol) AND a same-file
    // function `useBar` that calls bar() — that same-file call resolves a
    // callee_symbol_id at commit, so it surfaces as a caller row at line 7.
    // (caller_symbol_id is not populated by the v1 write/commit path, so the
    // joined caller span is null — the LEFT JOIN is forward-compat for when
    // the indexer starts writing caller_symbol_id.)
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
      callEdges: [
        // same-file call to bar → gets callee_symbol_id at commit
        {
          sourcePath: "src/b.ts",
          calleeName: "bar",
          callKind: "same_file",
          startLine: 7,
          startCol: 2,
        },
      ],
    })

    // a.ts imports bar from './b' (an import edge → import row) AND calls bar
    // via an imported binding. SIG-286: commit now resolves the imported_binding
    // callee_symbol_id from the import binding, so this CROSS-FILE call surfaces
    // as a caller row too (it was excluded before).
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
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
        {
          sourcePath: "src/a.ts",
          calleeName: "bar",
          callKind: "imported_binding",
          startLine: 4,
          startCol: 0,
        },
      ],
    })

    await do_.commitGraphVersion("r")

    const exp = await do_.contextExpansionForChangedSymbols({
      changedNames: ["bar"],
      changedPaths: ["src/b.ts"],
    })

    expect(exp.graphAvailable).toBe(true)

    // definition: bar's span 1-3 in src/b.ts
    expect(exp.definitionRows).toHaveLength(1)
    expect(exp.definitionRows[0]).toMatchObject({
      symbolId: "src/b.ts function bar 1 0",
      path: "src/b.ts",
      name: "bar",
      kind: "function",
      startLine: 1,
      endLine: 3,
    })

    // callers: the same-file call in b.ts (line 7) AND — NEW with SIG-286 — the
    // CROSS-FILE imported_binding call in a.ts (line 4), now that its
    // callee_symbol_id resolves from the import binding at commit. (caller_symbol_id
    // is null in v1 → the joined caller span is null.)
    expect(exp.callerRows).toHaveLength(2)
    const bCaller = exp.callerRows.find((r) => r.sourcePath === "src/b.ts")
    expect(bCaller).toMatchObject({
      sourcePath: "src/b.ts",
      calleeName: "bar",
      callKind: "same_file",
      startLine: 7,
      callerSymbolId: null,
      callerStartLine: null,
      callerEndLine: null,
    })
    const aCaller = exp.callerRows.find((r) => r.sourcePath === "src/a.ts")
    expect(aCaller).toMatchObject({
      sourcePath: "src/a.ts",
      calleeName: "bar",
      callKind: "imported_binding",
      startLine: 4,
      callerSymbolId: null,
    })

    // import: a.ts imports bar (resolved target_symbol_id) at line 1.
    const importPaths = exp.importRows.map((r) => r.sourcePath)
    expect(importPaths).toContain("src/a.ts")
    const aImport = exp.importRows.find((r) => r.sourcePath === "src/a.ts")
    expect(aImport).toMatchObject({ importedName: "bar", startLine: 1 })
  })

  it("returns graphAvailable=false with empty rows when there is no active version", async () => {
    const do_ = makeDoInstance("o/exp-no-active")
    // No commitGraphVersion call — no active version exists.
    const exp = await do_.contextExpansionForChangedSymbols({
      changedNames: ["bar"],
      changedPaths: ["src/b.ts"],
    })
    expect(exp.graphAvailable).toBe(false)
    expect(exp.definitionRows).toEqual([])
    expect(exp.callerRows).toEqual([])
    expect(exp.importRows).toEqual([])
  })

  it("returns graphAvailable=false when changedNames or changedPaths is empty", async () => {
    const do_ = makeDoInstance("o/exp-empty-input")
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

    const noNames = await do_.contextExpansionForChangedSymbols({
      changedNames: [],
      changedPaths: ["src/b.ts"],
    })
    expect(noNames.graphAvailable).toBe(false)
    const noPaths = await do_.contextExpansionForChangedSymbols({
      changedNames: ["bar"],
      changedPaths: [],
    })
    expect(noPaths.graphAvailable).toBe(false)
  })

  it("graphAvailable=true with empty rows when a changed name resolves to no symbol in changed files", async () => {
    const do_ = makeDoInstance("o/exp-no-resolve")
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

    // `ghost` is not declared in src/b.ts → resolves to no id, but the active
    // version exists, so graphAvailable stays true with empty rows.
    const exp = await do_.contextExpansionForChangedSymbols({
      changedNames: ["ghost"],
      changedPaths: ["src/b.ts"],
    })
    expect(exp.graphAvailable).toBe(true)
    expect(exp.definitionRows).toEqual([])
    expect(exp.callerRows).toEqual([])
    expect(exp.importRows).toEqual([])
  })

  it("caps each row list at maxRows", async () => {
    const do_ = makeDoInstance("o/exp-cap")
    // One changed symbol `bar` with many same-file callers.
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

    const exp = await do_.contextExpansionForChangedSymbols({
      changedNames: ["bar"],
      changedPaths: ["src/b.ts"],
      maxRows: 3,
    })
    expect(exp.callerRows.length).toBeLessThanOrEqual(3)
    expect(exp.callerRows).toHaveLength(3)
  })

  it("DEFAULT_EXPANSION_ROWS is the per-list default cap", () => {
    expect(DEFAULT_EXPANSION_ROWS).toBe(40)
  })
})
