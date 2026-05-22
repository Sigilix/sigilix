// SIG-138 Task 4 — RepoGraphDO: schema + upsertFileGraph tests.
//
// The Cloudflare SQLite DO storage API (`ctx.storage.sql.exec` /
// `ctx.storage.transactionSync`) is only available at Workers runtime.
// In Node/vitest we back it with NodeSqliteStorage — a real in-memory
// SQLite engine via Node 22's built-in `node:sqlite` (`DatabaseSync`).
//
// Pattern mirrors the existing PrReviewRunDO tests: construct the DO
// in-process with a hand-built storage stub; call public methods
// directly (no HTTP fetch).

import { describe, expect, it } from "vitest"
import { RepoGraphDO, resolveRelative } from "../src/do/repo-graph"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

// ─── Adapter-level regression tests ──────────────────────────────
//
// These tests exercise NodeSqliteStorage directly so they don't
// depend on the DO — they test the shim primitives that every DO
// relies on.

describe("NodeSqliteStorage adapter", () => {
  // Fix 1: INSERT … RETURNING must surface rows instead of being
  // silently discarded by the .run() path.
  it("Fix 1: INSERT … RETURNING yields the inserted row(s)", () => {
    const storage = new NodeSqliteStorage()
    storage.exec(
      "CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT NOT NULL)",
    )
    const cursor = storage.exec<{ id: number; val: string }>(
      "INSERT INTO t1 (val) VALUES (?) RETURNING id, val",
      "hello",
    )
    const rows = cursor.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].val).toBe("hello")
    expect(typeof rows[0].id).toBe("number")
  })

  it("Fix 1: UPDATE … RETURNING yields updated rows", () => {
    const storage = new NodeSqliteStorage()
    storage.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, val TEXT NOT NULL)")
    storage.exec("INSERT INTO t2 VALUES (1, 'original')")
    const cursor = storage.exec<{ id: number; val: string }>(
      "UPDATE t2 SET val = ? WHERE id = 1 RETURNING id, val",
      "updated",
    )
    const rows = cursor.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].val).toBe("updated")
  })

  // Fix 2: nested transactionSync must not throw "cannot start a
  // transaction within a transaction".  Inner and outer both commit;
  // an inner throw rolls back only the inner savepoint.
  it("Fix 2: nested transactionSync commits both outer and inner writes", () => {
    const storage = new NodeSqliteStorage()
    storage.exec("CREATE TABLE t3 (id INTEGER PRIMARY KEY, val TEXT NOT NULL)")

    storage.transactionSync(() => {
      storage.exec("INSERT INTO t3 VALUES (1, 'outer')")
      storage.transactionSync(() => {
        storage.exec("INSERT INTO t3 VALUES (2, 'inner')")
      })
    })

    const rows = storage.exec<{ id: number }>("SELECT id FROM t3 ORDER BY id").toArray()
    expect(rows.map((r) => r.id)).toEqual([1, 2])
  })

  it("Fix 2: inner throw rolls back inner savepoint; outer can still commit", () => {
    const storage = new NodeSqliteStorage()
    storage.exec("CREATE TABLE t4 (id INTEGER PRIMARY KEY, val TEXT NOT NULL)")

    storage.transactionSync(() => {
      storage.exec("INSERT INTO t4 VALUES (1, 'outer')")
      // Inner throws — should roll back only the inner savepoint.
      try {
        storage.transactionSync(() => {
          storage.exec("INSERT INTO t4 VALUES (2, 'inner-will-rollback')")
          throw new Error("inner failure")
        })
      } catch {
        // swallow — outer continues
      }
      // Outer adds a third row after the inner rollback.
      storage.exec("INSERT INTO t4 VALUES (3, 'outer-after-inner-fail')")
    })

    const rows = storage.exec<{ id: number }>("SELECT id FROM t4 ORDER BY id").toArray()
    // Row 2 was rolled back with the inner savepoint; rows 1 and 3 committed.
    expect(rows.map((r) => r.id)).toEqual([1, 3])
  })
})

// ─── DO-level regression tests ───────────────────────────────────

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

// ─── DO factory ──────────────────────────────────────────────────

function makeDoInstance(name: string = "o/r") {
  const state = makeSqliteState(name)
  const env = {} as Env
  return new RepoGraphDO(state as unknown as DurableObjectState, env)
}

// ─── Tests ───────────────────────────────────────────────────────

describe("RepoGraphDO.upsertFileGraph", () => {
  it("inserts pending symbol/edge rows and is idempotent on retry", async () => {
    const do_ = makeDoInstance("o/r")
    const payload = {
      runId: "run1",
      headSha: "sha1",
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
      callEdges: [],
    }

    await do_.upsertFileGraph(payload)
    await do_.upsertFileGraph(payload) // retry → same rows, no duplicates

    const counts = await do_.debugCounts("run1")
    expect(counts).toEqual({ symbols: 1, fileEdges: 1, callEdges: 0, status: "pending" })
  })

  it("inserts call edges correctly", async () => {
    const do_ = makeDoInstance("o/r2")
    const payload = {
      runId: "run1",
      headSha: "sha1",
      path: "src/x.ts",
      symbols: [],
      fileEdgesRaw: [],
      callEdges: [
        { sourcePath: "src/x.ts", calleeName: "helper", callKind: "same_file", startLine: 5, startCol: 2 },
        { sourcePath: "src/x.ts", calleeName: "external", callKind: "imported", startLine: 8, startCol: 4 },
      ],
    }
    await do_.upsertFileGraph(payload)
    const counts = await do_.debugCounts("run1")
    expect(counts).toEqual({ symbols: 0, fileEdges: 0, callEdges: 2, status: "pending" })
  })

  it("replaces rows for a path when retried with updated data (idempotent replace)", async () => {
    const do_ = makeDoInstance("o/r3")
    const v1 = {
      runId: "run1", headSha: "sha1", path: "src/a.ts",
      symbols: [
        { symbolId: "src/a.ts function foo 1 0", path: "src/a.ts", name: "foo", kind: "function", exported: true, startLine: 1, startCol: 0, endLine: 1, endCol: 5 },
        { symbolId: "src/a.ts function bar 2 0", path: "src/a.ts", name: "bar", kind: "function", exported: false, startLine: 2, startCol: 0, endLine: 2, endCol: 5 },
      ],
      fileEdgesRaw: [], callEdges: [],
    }
    const v2 = {
      runId: "run1", headSha: "sha1", path: "src/a.ts",
      // Only one symbol now (idempotent replace should remove old bar)
      symbols: [
        { symbolId: "src/a.ts function foo 1 0", path: "src/a.ts", name: "foo", kind: "function", exported: true, startLine: 1, startCol: 0, endLine: 1, endCol: 5 },
      ],
      fileEdgesRaw: [], callEdges: [],
    }
    await do_.upsertFileGraph(v1)
    expect((await do_.debugCounts("run1")).symbols).toBe(2)
    await do_.upsertFileGraph(v2)
    expect((await do_.debugCounts("run1")).symbols).toBe(1)
  })

  it("stores exported as 1/0 and status as pending", async () => {
    const do_ = makeDoInstance("o/r4")
    await do_.upsertFileGraph({
      runId: "r", headSha: "h", path: "src/z.ts",
      symbols: [
        { symbolId: "src/z.ts function pub 1 0", path: "src/z.ts", name: "pub", kind: "function", exported: true, startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
        { symbolId: "src/z.ts function priv 2 0", path: "src/z.ts", name: "priv", kind: "function", exported: false, startLine: 2, startCol: 0, endLine: 2, endCol: 1 },
      ],
      fileEdgesRaw: [], callEdges: [],
    })
    const counts = await do_.debugCounts("r")
    expect(counts.symbols).toBe(2)
    expect(counts.status).toBe("pending")
  })

  // Fix 3: two call edges with the same edge_id in one payload must not
  // throw UNIQUE constraint failed — the duplicate is silently ignored
  // and the row lands exactly once.
  it("Fix 3: duplicate call edge_id in one payload does NOT throw and lands once", async () => {
    const do_ = makeDoInstance("o/r5")
    // Both edges share the same sourcePath/startLine/startCol/calleeName
    // → same edgeId → would previously throw UNIQUE constraint failed.
    const dupCallEdge = {
      sourcePath: "src/dup.ts",
      calleeName: "helper",
      callKind: "same_file",
      startLine: 10,
      startCol: 4,
    }
    await expect(
      do_.upsertFileGraph({
        runId: "run-dup", headSha: "sha-dup", path: "src/dup.ts",
        symbols: [],
        fileEdgesRaw: [],
        callEdges: [dupCallEdge, dupCallEdge], // identical → same edge_id
      }),
    ).resolves.toBeUndefined()

    const counts = await do_.debugCounts("run-dup")
    expect(counts.callEdges).toBe(1) // lands exactly once
  })

  // Fix 3: duplicate symbolId in one payload is similarly silenced.
  it("Fix 3: duplicate symbolId in one payload does NOT throw and lands once", async () => {
    const do_ = makeDoInstance("o/r6")
    const dupSymbol = {
      symbolId: "src/dup2.ts function foo 1 0",
      path: "src/dup2.ts",
      name: "foo",
      kind: "function",
      exported: true,
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 5,
    }
    await expect(
      do_.upsertFileGraph({
        runId: "run-sym-dup", headSha: "sha-sym", path: "src/dup2.ts",
        symbols: [dupSymbol, dupSymbol], // identical → same symbol_id
        fileEdgesRaw: [],
        callEdges: [],
      }),
    ).resolves.toBeUndefined()

    const counts = await do_.debugCounts("run-sym-dup")
    expect(counts.symbols).toBe(1) // lands exactly once
  })
})

// ─── resolveRelative unit tests ──────────────────────────────────

describe("resolveRelative (pure helper)", () => {
  it("resolves same-dir relative specifier", () => {
    expect(resolveRelative("src/a.ts", "./b")).toBe("src/b")
  })

  it("resolves parent-dir relative specifier", () => {
    expect(resolveRelative("src/x/a.ts", "../b")).toBe("src/b")
  })

  it("returns null for bare (non-relative) specifiers", () => {
    expect(resolveRelative("src/a.ts", "left-pad")).toBeNull()
  })

  it("returns null for node: protocol specifiers", () => {
    expect(resolveRelative("src/a.ts", "node:path")).toBeNull()
  })

  // Fix 1: specifiers that merely start with "." but are NOT relative paths
  // must return null.
  it("returns null for dotfile-style specifier like '.hidden'", () => {
    expect(resolveRelative("src/a.ts", ".hidden")).toBeNull()
  })

  it("returns null for '..b' (double-dot without slash)", () => {
    expect(resolveRelative("src/a.ts", "..b")).toBeNull()
  })

  it("resolves exactly '.' as the source directory", () => {
    expect(resolveRelative("src/x/a.ts", ".")).toBe("src/x")
  })

  it("resolves exactly '..' as the parent directory", () => {
    expect(resolveRelative("src/x/a.ts", "..")).toBe("src")
  })

  // Fix 2: escaping beyond the repo root must return null.
  it("returns null when '../../../b' escapes the repo root from src/x/a.ts", () => {
    expect(resolveRelative("src/x/a.ts", "../../../b")).toBeNull()
  })

  it("still resolves valid '../b' correctly (src/x/a.ts → src/b)", () => {
    expect(resolveRelative("src/x/a.ts", "../b")).toBe("src/b")
  })
})

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
        // imported_binding calls must NOT get callee_symbol_id from same file
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
})

// ─── blastRadius tests ───────────────────────────────────────────

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
})

// ─── contextForVectorHits tests ──────────────────────────────────

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
