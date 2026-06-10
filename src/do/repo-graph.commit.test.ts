import { describe, expect, it } from "vitest"
import { RepoGraphDO } from "@/do/repo-graph"
import type { Env } from "@/shared/types/env"
import { NodeSqliteStorage } from "@/test-shims/cloudflare-workers-shim"

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
        void key; void value
      },
      async delete(key: string): Promise<boolean> {
        void key; return false
      },
      async setAlarm(timestamp: number): Promise<void> { void timestamp },
      async getAlarm(): Promise<number | null> { return null },
      async deleteAlarm(): Promise<void> { /* no-op */ },
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

// ─── commitGraphVersion tests ────────────────────────────────────

describe("RepoGraphDO.commitGraphVersion", () => {
  it("resolves relative imports to target symbols, flips active, GCs old version", async () => {
    const do_ = makeDoInstance("o/commit-test")

    // b.ts defines `bar`; a.ts imports `bar` from './b'
    await do_.upsertFileGraph({
      runId: "run1",
      headSha: "sha1",
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.upsertFileGraph({
      runId: "run1",
      headSha: "sha1",
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
      callEdges: [],
    })

    await do_.commitGraphVersion("run1")

    const resolved = await do_.debugResolvedEdges("src/a.ts")
    expect(resolved).toContainEqual(
      expect.objectContaining({
        targetPath: "src/b.ts",
        targetSymbolId: "src/b.ts function bar 1 0",
        resolutionStatus: "resolved",
      }),
    )
    expect(await do_.debugActiveVersion()).toBe("run1")

    // Second run supersedes run1 and GCs it.
    await do_.upsertFileGraph({
      runId: "run2",
      headSha: "sha2",
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("run2")

    expect(await do_.debugActiveVersion()).toBe("run2")
    expect((await do_.debugCounts("run1")).symbols).toBe(0) // GC'd
  })

  it("commits an empty active version (clears stale graph) for an empty repo", async () => {
    const do_ = makeDoInstance("o/empty-commit")
    // No upsertFileGraph calls — empty repo path.
    await do_.commitGraphVersion("runE")
    expect(await do_.debugActiveVersion()).toBe("runE")
  })

  // ── Resolution-matrix tests (Fix 6) ────────────────────────────────
  //
  // These cover the branchy resolution logic in Step 3 / Step 4 that the
  // happy-path test above doesn't reach.

  it("ambiguous: import resolves path but imported_name has no matching symbol", async () => {
    const do_ = makeDoInstance("o/ambiguous")

    // c.ts defines 'baz', but NOT 'missing'.
    await do_.upsertFileGraph({
      runId: "r-amb", headSha: "sha", path: "src/c.ts",
      symbols: [
        {
          symbolId: "src/c.ts function baz 1 0",
          path: "src/c.ts",
          name: "baz",
          kind: "function",
          exported: true,
          startLine: 1, startCol: 0, endLine: 1, endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

    // importer.ts imports 'missing' from './c' — path resolves but symbol does not.
    await do_.upsertFileGraph({
      runId: "r-amb", headSha: "sha", path: "src/importer.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/importer.ts",
          edgeKind: "import",
          specifier: "./c",
          importedName: "missing",
          localName: "missing",
          exportedName: null,
          startLine: 1, startCol: 0,
        },
      ],
      callEdges: [],
    })

    await do_.commitGraphVersion("r-amb")

    const edges = await do_.debugResolvedEdges("src/importer.ts")
    expect(edges).toContainEqual(
      expect.objectContaining({
        resolutionStatus: "ambiguous",
        targetPath: "src/c.ts",
        targetSymbolId: null,
      }),
    )
  })

  it("unresolved: import target path has no symbols (file unknown to graph)", async () => {
    const do_ = makeDoInstance("o/unresolved")

    // Only register importer.ts — no file at the specifier target.
    await do_.upsertFileGraph({
      runId: "r-unres", headSha: "sha", path: "src/importer.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/importer.ts",
          edgeKind: "import",
          specifier: "./ghost",
          importedName: "ghost",
          localName: "ghost",
          exportedName: null,
          startLine: 1, startCol: 0,
        },
      ],
      callEdges: [],
    })

    await do_.commitGraphVersion("r-unres")

    const edges = await do_.debugResolvedEdges("src/importer.ts")
    expect(edges).toContainEqual(
      expect.objectContaining({
        resolutionStatus: "unresolved",
        targetPath: null,
        targetSymbolId: null,
      }),
    )
  })

  it("reexport resolved: named reexport edge is fully resolved like an import", async () => {
    const do_ = makeDoInstance("o/reexport")

    // y.ts defines 'X'; barrel.ts re-exports 'X' from './y'.
    await do_.upsertFileGraph({
      runId: "r-reex", headSha: "sha", path: "src/y.ts",
      symbols: [
        {
          symbolId: "src/y.ts class X 1 0",
          path: "src/y.ts",
          name: "X",
          kind: "class",
          exported: true,
          startLine: 1, startCol: 0, endLine: 10, endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

    await do_.upsertFileGraph({
      runId: "r-reex", headSha: "sha", path: "src/barrel.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/barrel.ts",
          edgeKind: "reexport",
          specifier: "./y",
          importedName: "X",
          localName: null,
          exportedName: "X",
          startLine: 1, startCol: 0,
        },
      ],
      callEdges: [],
    })

    await do_.commitGraphVersion("r-reex")

    const edges = await do_.debugResolvedEdges("src/barrel.ts")
    expect(edges).toContainEqual(
      expect.objectContaining({
        resolutionStatus: "resolved",
        targetPath: "src/y.ts",
        targetSymbolId: "src/y.ts class X 1 0",
      }),
    )
  })

  it("star_reexport stays raw: export * from '…' edge is NOT resolved in v1", async () => {
    const do_ = makeDoInstance("o/star-reexport")

    // all.ts defines 'thing'; reexporter.ts does 'export * from ./all'.
    await do_.upsertFileGraph({
      runId: "r-star", headSha: "sha", path: "src/all.ts",
      symbols: [
        {
          symbolId: "src/all.ts function thing 1 0",
          path: "src/all.ts",
          name: "thing",
          kind: "function",
          exported: true,
          startLine: 1, startCol: 0, endLine: 1, endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

    await do_.upsertFileGraph({
      runId: "r-star", headSha: "sha", path: "src/reexporter.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/reexporter.ts",
          edgeKind: "star_reexport",
          specifier: "./all",
          importedName: null,
          localName: null,
          exportedName: null,
          startLine: 1, startCol: 0,
        },
      ],
      callEdges: [],
    })

    await do_.commitGraphVersion("r-star")

    const edges = await do_.debugResolvedEdges("src/reexporter.ts")
    // star_reexport must remain 'raw' — commitGraphVersion only processes
    // 'import' and 'reexport' (named), never 'star_reexport'.
    expect(edges).toContainEqual(
      expect.objectContaining({
        resolutionStatus: "raw",
      }),
    )
  })

  // ── Fix A: GC stale PENDING versions on commit ──────────────────────────
  //
  // A run that upserted files but never committed (superseded, aborted, or
  // retried with a new runId) must have its pending rows wiped when a later
  // run commits.  Pre-fix, the GC only targeted status='active' versions, so
  // a never-committed pending run would accumulate forever.
  it("Fix A: uncommitted pending run is GC'd when a later run commits", async () => {
    const do_ = makeDoInstance("o/gc-pending")

    // run1: upsert a file but NEVER commit it — leaves run1 in pending state.
    await do_.upsertFileGraph({
      runId: "run1",
      headSha: "sha1",
      path: "src/stale.ts",
      symbols: [
        {
          symbolId: "src/stale.ts function stale 1 0",
          path: "src/stale.ts",
          name: "stale",
          kind: "function",
          exported: true,
          startLine: 1, startCol: 0, endLine: 1, endCol: 10,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

    // Sanity: run1 is pending with one symbol.
    const before = await do_.debugCounts("run1")
    expect(before.status).toBe("pending")
    expect(before.symbols).toBe(1)

    // run2: upsert + commit a different file.
    await do_.upsertFileGraph({
      runId: "run2",
      headSha: "sha2",
      path: "src/fresh.ts",
      symbols: [
        {
          symbolId: "src/fresh.ts function fresh 1 0",
          path: "src/fresh.ts",
          name: "fresh",
          kind: "function",
          exported: true,
          startLine: 1, startCol: 0, endLine: 1, endCol: 10,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("run2")

    // run1 pending rows must all be gone.
    const run1Counts = await do_.debugCounts("run1")
    expect(run1Counts.symbols).toBe(0)
    expect(run1Counts.fileEdges).toBe(0)
    expect(run1Counts.callEdges).toBe(0)
    expect(run1Counts.status).toBeNull()

    // run2 is the active version.
    expect(await do_.debugActiveVersion()).toBe("run2")
  })

  // ── Fix B: import/reexport resolution must use exported symbols only ─────
  //
  // A non-exported private function in the target file must NOT be resolved
  // as the target of an import edge (prefer-missing-over-false).
  it("Fix B: importing a NON-exported symbol yields ambiguous, not resolved", async () => {
    const do_ = makeDoInstance("o/export-only")

    // a.ts: private 'helper' (exported=false) + exported 'bar' (exported=true).
    await do_.upsertFileGraph({
      runId: "r-fixb",
      headSha: "sha",
      path: "src/a.ts",
      symbols: [
        {
          symbolId: "src/a.ts function helper 1 0",
          path: "src/a.ts",
          name: "helper",
          kind: "function",
          exported: false,
          startLine: 1, startCol: 0, endLine: 3, endCol: 1,
        },
        {
          symbolId: "src/a.ts function bar 5 0",
          path: "src/a.ts",
          name: "bar",
          kind: "function",
          exported: true,
          startLine: 5, startCol: 0, endLine: 7, endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

    // b.ts: imports 'helper' (private) and 'bar' (exported) from './a'.
    await do_.upsertFileGraph({
      runId: "r-fixb",
      headSha: "sha",
      path: "src/b.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/b.ts",
          edgeKind: "import",
          specifier: "./a",
          importedName: "helper",
          localName: "helper",
          exportedName: null,
          startLine: 1, startCol: 0,
        },
        {
          sourcePath: "src/b.ts",
          edgeKind: "import",
          specifier: "./a",
          importedName: "bar",
          localName: "bar",
          exportedName: null,
          startLine: 2, startCol: 0,
        },
      ],
      callEdges: [],
    })

    await do_.commitGraphVersion("r-fixb")

    const edges = await do_.debugResolvedEdges("src/b.ts")

    // Importing the private 'helper': path resolves but symbol must NOT →
    // resolution_status must be 'ambiguous', NOT 'resolved'.
    const helperEdge = edges.find((e) => e.targetPath === "src/a.ts" && e.targetSymbolId === null)
    expect(helperEdge).toBeDefined()
    expect(helperEdge?.resolutionStatus).toBe("ambiguous")

    // Contrasting case: importing the exported 'bar' resolves fully.
    const barEdge = edges.find((e) => e.targetSymbolId === "src/a.ts function bar 5 0")
    expect(barEdge).toBeDefined()
    expect(barEdge?.resolutionStatus).toBe("resolved")
  })

  // ── Fix C: .mjs target resolves via CANDIDATE_EXTS probe ────────────────
  //
  // CANDIDATE_EXTS previously omitted .mjs, so imports to .mjs files stayed
  // unresolved even though INDEXED_EXTENSIONS ingests .mjs files.
  it("Fix C: import specifier resolves to .mjs target when probing CANDIDATE_EXTS", async () => {
    const do_ = makeDoInstance("o/mjs-ext")

    // src/x.mjs defines an exported symbol 'y'.
    await do_.upsertFileGraph({
      runId: "r-fixc",
      headSha: "sha",
      path: "src/x.mjs",
      symbols: [
        {
          symbolId: "src/x.mjs function y 1 0",
          path: "src/x.mjs",
          name: "y",
          kind: "function",
          exported: true,
          startLine: 1, startCol: 0, endLine: 3, endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

    // src/a.ts imports 'y' from './x' (no extension in specifier).
    await do_.upsertFileGraph({
      runId: "r-fixc",
      headSha: "sha",
      path: "src/a.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./x",
          importedName: "y",
          localName: "y",
          exportedName: null,
          startLine: 1, startCol: 0,
        },
      ],
      callEdges: [],
    })

    await do_.commitGraphVersion("r-fixc")

    const edges = await do_.debugResolvedEdges("src/a.ts")
    // The .mjs probe must find src/x.mjs and fully resolve 'y'.
    expect(edges).toContainEqual(
      expect.objectContaining({
        targetPath: "src/x.mjs",
        targetSymbolId: "src/x.mjs function y 1 0",
        resolutionStatus: "resolved",
      }),
    )
  })

  it("Fix #1: barrel file (edges only, no symbols) is a valid resolution target (pathExists union)", async () => {
    // Pre-fix: pathExists was built from symbols only. A barrel file that has a
    // re-export edge but NO symbols would never appear in pathExists, so any
    // import targeting it would resolve to 'unresolved'. Post-fix: pathExists is
    // the union of symbols.path ∪ file_edges.source_path ∪ call_edges.source_path,
    // so the barrel IS a known path. The import resolves to 'ambiguous' (target
    // path set, no pinnable symbol) rather than 'unresolved'.
    const do_ = makeDoInstance("o/barrel-fix1")

    // barrel.ts: no symbols, only a re-export edge (side-effect barrel pattern).
    await do_.upsertFileGraph({
      runId: "r-barrel", headSha: "sha", path: "src/barrel.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/barrel.ts",
          edgeKind: "star_reexport",
          specifier: "./impl",
          importedName: null,
          localName: null,
          exportedName: null,
          startLine: 1, startCol: 0,
        },
      ],
      callEdges: [],
    })

    // consumer.ts imports from './barrel' (which has NO symbols).
    await do_.upsertFileGraph({
      runId: "r-barrel", headSha: "sha", path: "src/consumer.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/consumer.ts",
          edgeKind: "import",
          specifier: "./barrel",
          importedName: "something",
          localName: "something",
          exportedName: null,
          startLine: 1, startCol: 0,
        },
      ],
      callEdges: [],
    })

    await do_.commitGraphVersion("r-barrel")

    const edges = await do_.debugResolvedEdges("src/consumer.ts")
    // target_path MUST be set (barrel is in pathExists via file_edges union).
    // target_symbol_id is null (no symbol named 'something' in barrel).
    // resolution_status must be 'ambiguous', NOT 'unresolved'.
    expect(edges).toContainEqual(
      expect.objectContaining({
        targetPath: "src/barrel.ts",
        targetSymbolId: null,
        resolutionStatus: "ambiguous",
      }),
    )
  })

  it("same_file call resolution: local function callee gets callee_symbol_id set", async () => {
    const do_ = makeDoInstance("o/same-file-call")

    // helper.ts defines 'localFn'; inside that file a call edge references it.
    await do_.upsertFileGraph({
      runId: "r-call", headSha: "sha", path: "src/helper.ts",
      symbols: [
        {
          symbolId: "src/helper.ts function localFn 1 0",
          path: "src/helper.ts",
          name: "localFn",
          kind: "function",
          exported: false,
          startLine: 1, startCol: 0, endLine: 5, endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [
        {
          sourcePath: "src/helper.ts",
          calleeName: "localFn",
          callKind: "same_file",
          startLine: 10, startCol: 2,
        },
        // imported_binding with NO resolvable import binding stays null — a
        // same-file lookup must never resolve a cross-file callee (SIG-286
        // resolves these only via a matching resolved import edge, below).
        {
          sourcePath: "src/helper.ts",
          calleeName: "externalFn",
          callKind: "imported_binding",
          startLine: 11, startCol: 2,
        },
      ],
    })

    await do_.commitGraphVersion("r-call")

    const callEdges = await do_.debugCallEdges("src/helper.ts")

    const sameFileEdge = callEdges.find((e) => e.calleeName === "localFn")
    expect(sameFileEdge).toBeDefined()
    expect(sameFileEdge?.calleeSymbolId).toBe("src/helper.ts function localFn 1 0")

    const importedEdge = callEdges.find((e) => e.calleeName === "externalFn")
    expect(importedEdge).toBeDefined()
    expect(importedEdge?.calleeSymbolId).toBeNull()
  })

  it("SIG-286: imported_binding call resolves callee_symbol_id from the import binding (cross-file)", async () => {
    const do_ = makeDoInstance("o/cross-file-call")

    // b.ts exports `bar`; c.ts exports `baz`. a.ts imports `bar` (direct) and
    // `baz as qux` (aliased), and calls both via imported bindings. a.ts also
    // calls `missing` with no import edge → stays null.
    await do_.upsertFileGraph({
      runId: "rx", headSha: "h", path: "src/b.ts",
      symbols: [
        { symbolId: "src/b.ts function bar 1 0", path: "src/b.ts", name: "bar", kind: "function", exported: true, startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
      ],
      fileEdgesRaw: [], callEdges: [],
    })
    await do_.upsertFileGraph({
      runId: "rx", headSha: "h", path: "src/c.ts",
      symbols: [
        { symbolId: "src/c.ts function baz 1 0", path: "src/c.ts", name: "baz", kind: "function", exported: true, startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
      ],
      fileEdgesRaw: [], callEdges: [],
    })
    await do_.upsertFileGraph({
      runId: "rx", headSha: "h", path: "src/a.ts",
      symbols: [],
      fileEdgesRaw: [
        { sourcePath: "src/a.ts", edgeKind: "import", specifier: "./b", importedName: "bar", localName: "bar", exportedName: null, startLine: 1, startCol: 0 },
        // aliased: `import { baz as qux } from "./c"` — local name is `qux`.
        { sourcePath: "src/a.ts", edgeKind: "import", specifier: "./c", importedName: "baz", localName: "qux", exportedName: null, startLine: 2, startCol: 0 },
      ],
      callEdges: [
        { sourcePath: "src/a.ts", calleeName: "bar", callKind: "imported_binding", startLine: 5, startCol: 0 },
        { sourcePath: "src/a.ts", calleeName: "qux", callKind: "imported_binding", startLine: 6, startCol: 0 },
        // no import edge for `missing` → unresolved → stays null.
        { sourcePath: "src/a.ts", calleeName: "missing", callKind: "imported_binding", startLine: 7, startCol: 0 },
      ],
    })

    await do_.commitGraphVersion("rx")

    const callEdges = await do_.debugCallEdges("src/a.ts")
    expect(callEdges.find((e) => e.calleeName === "bar")?.calleeSymbolId).toBe("src/b.ts function bar 1 0")
    // alias resolves by LOCAL name (qux) to the imported symbol (baz).
    expect(callEdges.find((e) => e.calleeName === "qux")?.calleeSymbolId).toBe("src/c.ts function baz 1 0")
    // no resolvable import → stays null (prefer-missing-over-false).
    expect(callEdges.find((e) => e.calleeName === "missing")?.calleeSymbolId).toBeNull()
  })

  it("SIG-286: imported_binding to an UNRESOLVED import (target file absent) stays null", async () => {
    const do_ = makeDoInstance("o/cross-file-unresolved")
    // a.ts imports from './ghost' which has no symbols in the graph → the import
    // edge is unresolved (target_symbol_id null) → the call stays null.
    await do_.upsertFileGraph({
      runId: "rg", headSha: "h", path: "src/a.ts",
      symbols: [],
      fileEdgesRaw: [
        { sourcePath: "src/a.ts", edgeKind: "import", specifier: "./ghost", importedName: "gone", localName: "gone", exportedName: null, startLine: 1, startCol: 0 },
      ],
      callEdges: [
        { sourcePath: "src/a.ts", calleeName: "gone", callKind: "imported_binding", startLine: 4, startCol: 0 },
      ],
    })
    await do_.commitGraphVersion("rg")
    const callEdges = await do_.debugCallEdges("src/a.ts")
    expect(callEdges.find((e) => e.calleeName === "gone")?.calleeSymbolId).toBeNull()
  })
})

// ─── blastRadius tests ───────────────────────────────────────────

