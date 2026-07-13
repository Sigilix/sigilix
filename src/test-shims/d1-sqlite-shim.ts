// Test-only D1Database shim backed by Node's built-in `node:sqlite`.
//
// Cloudflare's D1 binding is only resolvable at Workers runtime; in vitest
// (Node) we implement the subset of the D1 surface that SIG-45's
// lexical-index module uses — prepare/bind/run/all/first, batch, exec — over
// the real SQLite engine (which ships FTS5, verified on Node 22+). Mirrors
// the existing `cloudflare-workers-shim.ts` approach for DurableObjects.

import { DatabaseSync } from "node:sqlite"

type Params = ReadonlyArray<unknown>

class D1StmtShim {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Params = [],
  ) {}

  /** True when this statement is a SELECT (read) statement. */
  get isSelect(): boolean {
    return /^\s*SELECT\b/i.test(this.sql)
  }

  bind(...args: unknown[]): D1StmtShim {
    return new D1StmtShim(this.db, this.sql, args)
  }

  runSync(): D1Result {
    const stmt = this.db.prepare(this.sql)
    const info = stmt.run(...(this.params as Parameters<typeof stmt.run>))
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    } as unknown as D1Result
  }

  async run(): Promise<D1Result> {
    return this.runSync()
  }

  allSync<T = Record<string, unknown>>(): D1Result<T> {
    const stmt = this.db.prepare(this.sql)
    const rows = stmt.all(...(this.params as Parameters<typeof stmt.all>)) as T[]
    return {
      success: true,
      results: rows,
      meta: { changes: 0, last_row_id: 0 },
    } as unknown as D1Result<T>
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.allSync<T>()
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql)
    const row = stmt.get(...(this.params as Parameters<typeof stmt.get>)) as Record<string, unknown> | undefined
    if (row == null) return null
    if (colName) return (row[colName] ?? null) as T
    return row as T
  }
}

export class D1DatabaseShim {
  private readonly db: DatabaseSync

  constructor() {
    this.db = new DatabaseSync(":memory:")
  }

  prepare(sql: string): D1StmtShim {
    return new D1StmtShim(this.db, sql)
  }

  async batch<T = unknown>(stmts: D1StmtShim[]): Promise<D1Result<T>[]> {
    const out: D1Result<T>[] = []
    this.db.exec("BEGIN")
    try {
      for (const s of stmts) {
        // SELECT statements need all() to return rows; writes use run() for meta.
        if (s.isSelect) {
          out.push(s.allSync<T>())
        } else {
          const runResult = s.runSync()
          out.push({ ...runResult, results: [] as T[] } as D1Result<T>)
        }
      }
      this.db.exec("COMMIT")
      return out
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Preserve the original statement/commit failure if rollback also fails.
      }
      throw error
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql)
    return { count: 0, duration: 0 }
  }
}

/** Construct a fresh in-memory D1 shim typed as the real binding. */
export function makeD1(): D1Database {
  return new D1DatabaseShim() as unknown as D1Database
}

/**
 * Whether THIS Node build's `node:sqlite` includes the FTS5 extension. The
 * lexical index is FTS5/BM25; a Node build compiled WITHOUT FTS5 throws
 * `no such module: fts5` on the virtual-table create, so the FTS5 round-trip
 * tests cannot run there. They `describe.skipIf(!FTS5_AVAILABLE)` on this flag
 * so the suite stays green on a no-FTS5 local Node while CI (whose Node ships
 * FTS5) still exercises them. Probed once at import.
 */
export const FTS5_AVAILABLE: boolean = (() => {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(":memory:")
    db.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)")
    return true
  } catch {
    return false
  } finally {
    db?.close() // close in all paths (CodeRabbit #317) — even when the probe throws
  }
})()
