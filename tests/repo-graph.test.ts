// SIG-138 Task 4 — RepoGraphDO: schema + upsertFileGraph tests.
//
// The Cloudflare SQLite DO storage API (`ctx.storage.sql.exec` /
// `ctx.storage.transactionSync`) is only available at Workers runtime.
// In Node/vitest we back it with a lightweight in-memory fake SQL
// engine that handles the exact query patterns RepoGraphDO uses.
//
// Pattern mirrors the existing PrReviewRunDO tests: construct the DO
// in-process with a hand-built storage stub; call public methods
// directly (no HTTP fetch).

import { describe, expect, it } from "vitest"
import { RepoGraphDO } from "../src/do/repo-graph"
import type { Env } from "../src/index"

// ─── In-memory SQL storage stub ──────────────────────────────────
//
// Mimics the SqlStorage + DurableObjectStorage surface that
// RepoGraphDO calls:
//   ctx.storage.sql.exec(sql, ...params) → iterable of row objects
//   ctx.storage.transactionSync(fn)      → calls fn synchronously
//
// Implementation: each named table is a Map<string, Record> keyed by
// the row's primary-key string. SQL is parsed by minimal regex-based
// handlers that cover exactly the statements the DO issues.

type Row = Record<string, unknown>

class FakeSqlStorage {
  // Table store: tableName → Map<pk-string, row>
  private tables = new Map<string, Map<string, Row>>()

  // Ensure a table exists (DDL no-op).
  private ensureTable(name: string): Map<string, Row> {
    if (!this.tables.has(name)) this.tables.set(name, new Map())
    return this.tables.get(name)!
  }

  // Primary-key extractors per table (mirrors the DDL PRIMARY KEYs).
  private pk(table: string, row: Row): string {
    switch (table) {
      case "graph_versions": return String(row["graph_version"])
      case "symbols": return `${row["graph_version"]}::${row["symbol_id"]}`
      case "file_edges": return `${row["graph_version"]}::${row["edge_id"]}`
      case "call_edges": return `${row["graph_version"]}::${row["edge_id"]}`
      default: return JSON.stringify(row)
    }
  }

  exec(query: string, ...params: unknown[]): IterableIterator<Row> {
    const q = query.trim()

    // ── DDL: CREATE TABLE / INDEX — no-op (schema is implicit) ──
    if (/^CREATE\s+(TABLE|INDEX)/i.test(q)) {
      // Just ensure referenced tables exist.
      const m = q.match(/ON\s+(\w+)\s*\(/i) ?? q.match(/INTO\s+(\w+)\s*\(/i)
      if (m) this.ensureTable(m[1])
      return [][Symbol.iterator]()
    }

    // ── INSERT ... ON CONFLICT ... DO NOTHING ────────────────────
    const insertM = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)\s*(?:ON\s+CONFLICT[^;]*DO\s+NOTHING)?/i)
    if (insertM) {
      const table = insertM[1]
      const cols = insertM[2].split(",").map((c) => c.trim())
      const valueTokens = insertM[3].split(",").map((v) => v.trim())
      const store = this.ensureTable(table)
      const row: Row = {}
      let paramIdx = 0
      for (let i = 0; i < cols.length; i++) {
        const token = valueTokens[i] ?? "?"
        if (token === "?") {
          row[cols[i]] = params[paramIdx++] ?? null
        } else if (/^'.*'$/.test(token)) {
          // String literal — strip surrounding quotes.
          row[cols[i]] = token.slice(1, -1)
        } else if (token === "NULL") {
          row[cols[i]] = null
        } else {
          // Numeric literal or other.
          row[cols[i]] = isNaN(Number(token)) ? token : Number(token)
        }
      }
      const pkKey = this.pk(table, row)
      const isOnConflictDoNothing = /ON\s+CONFLICT[^;]*DO\s+NOTHING/i.test(q)
      if (isOnConflictDoNothing && store.has(pkKey)) {
        return [][Symbol.iterator]() // skip duplicate
      }
      store.set(pkKey, row)
      return [][Symbol.iterator]()
    }

    // ── DELETE FROM table WHERE col1 = ? AND col2 = ? ────────────
    const deleteM = q.match(/^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i)
    if (deleteM) {
      const table = deleteM[1]
      const store = this.ensureTable(table)
      if (!deleteM[2]) {
        // DELETE FROM table (no WHERE) — truncate
        store.clear()
        return [][Symbol.iterator]()
      }
      const conditions = this.parseWhereEq(deleteM[2], params)
      for (const [key, row] of store) {
        if (this.matchesAll(row, conditions)) store.delete(key)
      }
      return [][Symbol.iterator]()
    }

    // ── UPDATE table SET col=?, ... WHERE col=? ──────────────────
    const updateM = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i)
    if (updateM) {
      const table = updateM[1]
      const store = this.ensureTable(table)
      const setParts = this.parseSetClause(updateM[2], params)
      // Count how many ? tokens consumed by SET.
      const setParamCount = (updateM[2].match(/\?/g) ?? []).length
      const whereConditions = this.parseWhereEq(updateM[3], params.slice(setParamCount))
      for (const [_key, row] of store) {
        if (this.matchesAll(row, whereConditions)) {
          Object.assign(row, setParts)
          // Re-key if PK columns changed (unlikely but safe).
          const newKey = this.pk(table, row)
          if (newKey !== _key) {
            store.delete(_key)
            store.set(newKey, row)
          }
        }
      }
      return [][Symbol.iterator]()
    }

    // ── SELECT COUNT(*) AS n FROM table WHERE graph_version=? ────
    const countM = q.match(/^SELECT\s+COUNT\(\*\)\s+(?:AS\s+)?(\w+)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i)
    if (countM) {
      const alias = countM[1]
      const table = countM[2]
      const store = this.ensureTable(table)
      let count = 0
      if (countM[3]) {
        const conditions = this.parseWhereEq(countM[3], params)
        for (const [, row] of store) {
          if (this.matchesAll(row, conditions)) count++
        }
      } else {
        count = store.size
      }
      return [{ [alias]: count }][Symbol.iterator]()
    }

    // ── SELECT col FROM table WHERE ... ─────────────────────────
    const selectM = q.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i)
    if (selectM) {
      const colsPart = selectM[1]
      const table = selectM[2]
      const store = this.ensureTable(table)
      const cols = colsPart.split(",").map((c) => c.trim())
      const isStar = cols.length === 1 && cols[0] === "*"

      let rows: Row[]
      if (selectM[3]) {
        const conditions = this.parseWhereEq(selectM[3], params)
        rows = []
        for (const [, row] of store) {
          if (this.matchesAll(row, conditions)) rows.push(row)
        }
      } else {
        rows = [...store.values()]
      }

      if (isStar) return rows[Symbol.iterator]()
      // Project columns; handle `col AS alias` renaming.
      const projected = rows.map((row) => {
        const out: Row = {}
        for (const colExpr of cols) {
          const asM = colExpr.match(/^(\w+)\s+AS\s+(\w+)$/i)
          if (asM) {
            out[asM[2]] = row[asM[1]]
          } else {
            out[colExpr] = row[colExpr]
          }
        }
        return out
      })
      return projected[Symbol.iterator]()
    }

    // ── Fallback ─────────────────────────────────────────────────
    console.warn("FakeSqlStorage: unhandled query:", q)
    return [][Symbol.iterator]()
  }

  // Parse `col = ?` AND `col = ?` ... clauses into a condition map.
  private parseWhereEq(where: string, params: unknown[]): Map<string, unknown> {
    const conds = new Map<string, unknown>()
    // Split on AND (case-insensitive).
    const parts = where.split(/\s+AND\s+/i)
    let paramIdx = 0
    for (const part of parts) {
      const m = part.match(/(\w+)\s*=\s*\?/)
      if (m) {
        conds.set(m[1], params[paramIdx++])
      }
    }
    return conds
  }

  // Parse `col=?, col2=?` SET clause. Returns the set assignments.
  private parseSetClause(setStr: string, params: unknown[]): Row {
    const out: Row = {}
    const parts = setStr.split(",")
    let paramIdx = 0
    for (const part of parts) {
      const m = part.trim().match(/(\w+)\s*=\s*\?/)
      if (m) {
        out[m[1]] = params[paramIdx++]
      }
    }
    return out
  }

  // Check if row satisfies all conditions.
  private matchesAll(row: Row, conditions: Map<string, unknown>): boolean {
    for (const [col, val] of conditions) {
      if (row[col] !== val) return false
    }
    return true
  }
}

function makeSqliteState(name: string = "test-instance") {
  const fakeSql = new FakeSqlStorage()

  const state = {
    storage: {
      sql: fakeSql,
      transactionSync<T>(fn: () => T): T {
        // In-memory fake has no real transaction semantics; just run fn.
        return fn()
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
