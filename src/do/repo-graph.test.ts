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
import { RepoGraphDO, resolveRelative } from "@/src/do/repo-graph"
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
    storage.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT NOT NULL)")
    const cursor = storage.exec<{ id: number; val: string }>(
      "INSERT INTO t1 (val) VALUES (?) RETURNING id, val",
      "hello",
    )
    const rows = cursor.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.val).toBe("hello")
    expect(typeof rows[0]!.id).toBe("number")
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
    expect(rows[0]!.val).toBe("updated")
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
        {
          sourcePath: "src/x.ts",
          calleeName: "helper",
          callKind: "same_file",
          startLine: 5,
          startCol: 2,
        },
        {
          sourcePath: "src/x.ts",
          calleeName: "external",
          callKind: "imported",
          startLine: 8,
          startCol: 4,
        },
      ],
    }
    await do_.upsertFileGraph(payload)
    const counts = await do_.debugCounts("run1")
    expect(counts).toEqual({ symbols: 0, fileEdges: 0, callEdges: 2, status: "pending" })
  })

  it("replaces rows for a path when retried with updated data (idempotent replace)", async () => {
    const do_ = makeDoInstance("o/r3")
    const v1 = {
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
          endCol: 5,
        },
        {
          symbolId: "src/a.ts function bar 2 0",
          path: "src/a.ts",
          name: "bar",
          kind: "function",
          exported: false,
          startLine: 2,
          startCol: 0,
          endLine: 2,
          endCol: 5,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
    }
    const v2 = {
      runId: "run1",
      headSha: "sha1",
      path: "src/a.ts",
      // Only one symbol now (idempotent replace should remove old bar)
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
    }
    await do_.upsertFileGraph(v1)
    expect((await do_.debugCounts("run1")).symbols).toBe(2)
    await do_.upsertFileGraph(v2)
    expect((await do_.debugCounts("run1")).symbols).toBe(1)
  })

  it("stores exported as 1/0 and status as pending", async () => {
    const do_ = makeDoInstance("o/r4")
    await do_.upsertFileGraph({
      runId: "r",
      headSha: "h",
      path: "src/z.ts",
      symbols: [
        {
          symbolId: "src/z.ts function pub 1 0",
          path: "src/z.ts",
          name: "pub",
          kind: "function",
          exported: true,
          startLine: 1,
          startCol: 0,
          endLine: 1,
          endCol: 1,
        },
        {
          symbolId: "src/z.ts function priv 2 0",
          path: "src/z.ts",
          name: "priv",
          kind: "function",
          exported: false,
          startLine: 2,
          startCol: 0,
          endLine: 2,
          endCol: 1,
        },
      ],
      fileEdgesRaw: [],
      callEdges: [],
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
        runId: "run-dup",
        headSha: "sha-dup",
        path: "src/dup.ts",
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
        runId: "run-sym-dup",
        headSha: "sha-sym",
        path: "src/dup2.ts",
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
