import { describe, expect, it } from "vitest"
import { RepoGraphDO, MAX_BLAST_IDS } from "@/src/do/repo-graph"
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

describe("RepoGraphDO.blastRadius", () => {
  it("returns import dependents and callers of changed symbols", async () => {
    const do_ = makeDoInstance("o/blast")

    // b.ts defines exported bar; a.ts imports bar from './b' AND calls bar()
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

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
          startLine: 2,
          startCol: 0,
        },
      ],
    })

    await do_.commitGraphVersion("r")

    const br = await do_.blastRadius({ changedSymbolIds: ["src/b.ts function bar 1 0"] })
    expect(br.importDependents).toContain("src/a.ts")
    expect(br.callerPaths).toContain("src/a.ts")
  })

  it("returns empty arrays when changedSymbolIds is empty", async () => {
    const do_ = makeDoInstance("o/blast-empty-ids")

    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
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
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const br = await do_.blastRadius({ changedSymbolIds: [] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })

  it("returns empty arrays when there is no active version", async () => {
    const do_ = makeDoInstance("o/blast-no-active")
    // No commitGraphVersion call — no active version exists
    const br = await do_.blastRadius({ changedSymbolIds: ["src/a.ts function foo 1 0"] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })

  it("dedup: same file imported/called via multiple edges yields no duplicates", async () => {
    const do_ = makeDoInstance("o/blast-dedup")

    // b.ts defines exported bar
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

    // a.ts imports bar TWICE (two import edges) AND calls bar() TWICE (two call edges)
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
        {
          sourcePath: "src/a.ts",
          edgeKind: "import",
          specifier: "./b",
          importedName: "bar",
          localName: "bar",
          exportedName: null,
          startLine: 3,
          startCol: 0,
        },
      ],
      callEdges: [
        {
          sourcePath: "src/a.ts",
          calleeName: "bar",
          callKind: "imported_binding",
          startLine: 5,
          startCol: 0,
        },
        {
          sourcePath: "src/a.ts",
          calleeName: "bar",
          callKind: "imported_binding",
          startLine: 7,
          startCol: 0,
        },
      ],
    })

    await do_.commitGraphVersion("r")

    const br = await do_.blastRadius({ changedSymbolIds: ["src/b.ts function bar 1 0"] })

    // Both importDependents and callerPaths must contain src/a.ts exactly once
    expect(br.importDependents).toContain("src/a.ts")
    expect(new Set(br.importDependents).size).toBe(br.importDependents.length)

    expect(br.callerPaths).toContain("src/a.ts")
    expect(new Set(br.callerPaths).size).toBe(br.callerPaths.length)
  })

  it("same-file caller: file with same_file call edge to changed symbol includes callerPaths", async () => {
    const do_ = makeDoInstance("o/blast-same-file")

    // helper.ts defines both localFn (the callee) and an exported main
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/helper.ts",
      symbols: [
        {
          symbolId: "src/helper.ts function localFn 1 0",
          path: "src/helper.ts",
          name: "localFn",
          kind: "function",
          exported: false,
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 1,
        },
        {
          symbolId: "src/helper.ts function main 10 0",
          path: "src/helper.ts",
          name: "main",
          kind: "function",
          exported: true,
          startLine: 10,
          startCol: 0,
          endLine: 15,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [
        {
          sourcePath: "src/helper.ts",
          calleeName: "localFn",
          callKind: "same_file",
          startLine: 12,
          startCol: 2,
        },
      ],
    })

    await do_.commitGraphVersion("r")

    // Query blastRadius for the localFn symbol change
    const br = await do_.blastRadius({ changedSymbolIds: ["src/helper.ts function localFn 1 0"] })

    // callerPaths must include src/helper.ts (the same file that has the same_file call edge)
    expect(br.callerPaths).toContain("src/helper.ts")
  })

  // Fix 3a: changedSymbolId that does NOT exist in the graph
  it("Fix 3a: changedSymbolId absent from graph returns empty arrays", async () => {
    const do_ = makeDoInstance("o/blast-absent-id")

    // Graph has one known symbol; we query with a different, nonexistent id.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
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
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    // "src/a.ts function ghost 99 0" does not exist in the graph.
    const br = await do_.blastRadius({ changedSymbolIds: ["src/a.ts function ghost 99 0"] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })

  // Fix 3b: symbol exists but has no callers and no import dependents
  it("Fix 3b: isolated symbol (no callers, no import dependents) returns empty arrays", async () => {
    const do_ = makeDoInstance("o/blast-isolated")

    // a.ts defines 'standalone'; nobody imports or calls it.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/a.ts",
      symbols: [
        {
          symbolId: "src/a.ts function standalone 1 0",
          path: "src/a.ts",
          name: "standalone",
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

    const br = await do_.blastRadius({ changedSymbolIds: ["src/a.ts function standalone 1 0"] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })
})

// ─── blastRadiusByNames tests (SIG-143) ──────────────────────────
//
// blastRadiusByNames resolves changed symbol NAMES to symbol_ids in the
// active version, then reuses the blastRadius logic. This is the name-based
// entry point the ensemble uses (it has changed symbol names, not ids).

describe("RepoGraphDO.blastRadiusByNames", () => {
  it("resolves changed names to ids and returns import dependents and callers", async () => {
    const do_ = makeDoInstance("o/blast-names")

    // b.ts defines exported bar; a.ts imports bar from './b' AND calls bar()
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
          endLine: 1,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })

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
          startLine: 2,
          startCol: 0,
        },
      ],
    })

    await do_.commitGraphVersion("r")

    const br = await do_.blastRadiusByNames({ changedNames: ["bar"], changedPaths: ["src/b.ts"] })
    expect(br.importDependents).toContain("src/a.ts")
    expect(br.callerPaths).toContain("src/a.ts")
  })

  it("returns empty arrays when changedNames is empty", async () => {
    const do_ = makeDoInstance("o/blast-names-empty")

    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
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
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const br = await do_.blastRadiusByNames({ changedNames: [], changedPaths: ["src/a.ts"] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })

  it("returns empty arrays when changedPaths is empty", async () => {
    const do_ = makeDoInstance("o/blast-names-empty-paths")

    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
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
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    const br = await do_.blastRadiusByNames({ changedNames: ["foo"], changedPaths: [] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })

  it("returns empty arrays when there is no active version", async () => {
    const do_ = makeDoInstance("o/blast-names-no-active")
    // No commitGraphVersion call — no active version exists
    const br = await do_.blastRadiusByNames({ changedNames: ["foo"], changedPaths: ["src/a.ts"] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })

  it("name absent from graph returns empty arrays", async () => {
    const do_ = makeDoInstance("o/blast-names-absent")

    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
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
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    // "ghost" is not a symbol name in the graph.
    const br = await do_.blastRadiusByNames({ changedNames: ["ghost"], changedPaths: ["src/a.ts"] })
    expect(br.callerPaths).toEqual([])
    expect(br.importDependents).toEqual([])
  })

  it("collision guard: a name shared across files resolves ONLY in the changed file", async () => {
    const do_ = makeDoInstance("o/blast-names-collision")

    // Two distinct files each export a 'shared' symbol (same name, different ids).
    // Only src/one.ts is "changed" — src/two.ts's same-named symbol must NOT
    // contribute to the blast radius.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/one.ts",
      symbols: [
        {
          symbolId: "src/one.ts function shared 1 0",
          path: "src/one.ts",
          name: "shared",
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
      runId: "r",
      headSha: "h",
      path: "src/two.ts",
      symbols: [
        {
          symbolId: "src/two.ts function shared 1 0",
          path: "src/two.ts",
          name: "shared",
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
    // consumerOne imports shared from ./one; consumerTwo imports shared from ./two
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/consumer-one.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/consumer-one.ts",
          edgeKind: "import",
          specifier: "./one",
          importedName: "shared",
          localName: "shared",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/consumer-two.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/consumer-two.ts",
          edgeKind: "import",
          specifier: "./two",
          importedName: "shared",
          localName: "shared",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
      ],
      callEdges: [],
    })
    await do_.commitGraphVersion("r")

    // Only src/one.ts changed → only consumer-one is an import dependent.
    const br = await do_.blastRadiusByNames({
      changedNames: ["shared"],
      changedPaths: ["src/one.ts"],
    })
    expect(br.importDependents).toEqual(["src/consumer-one.ts"])
  })

  it("dedup: same caller for multiple changed names appears once", async () => {
    const do_ = makeDoInstance("o/blast-names-dedup")

    // lib.ts exports foo and bar; app.ts imports BOTH and calls BOTH.
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/lib.ts",
      symbols: [
        {
          symbolId: "src/lib.ts function foo 1 0",
          path: "src/lib.ts",
          name: "foo",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 1,
          endCol: 5,
        },
        {
          symbolId: "src/lib.ts function bar 3 0",
          path: "src/lib.ts",
          name: "bar",
          kind: "function",
          exported: true,
          startLine: 3,
          startCol: 0,
          endLine: 3,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    })
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/app.ts",
      symbols: [],
      fileEdgesRaw: [
        {
          sourcePath: "src/app.ts",
          edgeKind: "import",
          specifier: "./lib",
          importedName: "foo",
          localName: "foo",
          exportedName: null,
          startLine: 1,
          startCol: 0,
        },
        {
          sourcePath: "src/app.ts",
          edgeKind: "import",
          specifier: "./lib",
          importedName: "bar",
          localName: "bar",
          exportedName: null,
          startLine: 1,
          startCol: 20,
        },
      ],
      callEdges: [
        {
          sourcePath: "src/app.ts",
          calleeName: "foo",
          callKind: "imported_binding",
          startLine: 5,
          startCol: 0,
        },
        {
          sourcePath: "src/app.ts",
          calleeName: "bar",
          callKind: "imported_binding",
          startLine: 6,
          startCol: 0,
        },
      ],
    })
    await do_.commitGraphVersion("r")

    const br = await do_.blastRadiusByNames({
      changedNames: ["foo", "bar"],
      changedPaths: ["src/lib.ts"],
    })
    expect(br.importDependents).toEqual(["src/app.ts"])
    expect(br.callerPaths).toEqual(["src/app.ts"])
  })

  it("caps resolved ids at MAX_BLAST_IDS when a changed file matches more names", async () => {
    const do_ = makeDoInstance("o/blast-names-cap")

    // src/a.ts declares MAX_BLAST_IDS + 1 distinctly-named exported symbols.
    const overCap = MAX_BLAST_IDS + 1
    const names = Array.from({ length: overCap }, (_, i) => `dup${i}`)
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/a.ts",
      symbols: names.map((name, i) => ({
        symbolId: `src/a.ts function ${name} ${i + 1} 0`,
        path: "src/a.ts",
        name,
        kind: "function",
        exported: true,
        startLine: i + 1,
        startCol: 0,
        endLine: i + 1,
        endCol: 5,
      })),
      fileEdgesRaw: [],
      callEdges: [],
    })
    // Each importer imports exactly one distinct name from ./a, so each
    // resolves to a distinct target_symbol_id (no key collision).
    for (let i = 0; i < overCap; i++) {
      await do_.upsertFileGraph({
        runId: "r",
        headSha: "h",
        path: `src/imp${i}.ts`,
        symbols: [],
        fileEdgesRaw: [
          {
            sourcePath: `src/imp${i}.ts`,
            edgeKind: "import",
            specifier: "./a",
            importedName: names[i]!,
            localName: names[i]!,
            exportedName: null,
            startLine: 1,
            startCol: 0,
          },
        ],
        callEdges: [],
      })
    }
    await do_.commitGraphVersion("r")

    // All overCap names changed in src/a.ts → resolution caps to MAX_BLAST_IDS
    // ids, so at most MAX_BLAST_IDS importers appear (one name is dropped).
    const br = await do_.blastRadiusByNames({ changedNames: names, changedPaths: ["src/a.ts"] })
    expect(br.importDependents.length).toBe(MAX_BLAST_IDS)
    expect(br.importDependents.length).toBeLessThan(overCap)
    expect(new Set(br.importDependents).size).toBe(br.importDependents.length)
  })
})

// ─── contextForVectorHits tests ──────────────────────────────────
