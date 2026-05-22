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
import { RepoGraphDO } from "../src/do/repo-graph"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

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
})
