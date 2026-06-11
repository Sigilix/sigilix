// ARC-190 vitest shim for Cloudflare Workers' `cloudflare:workers`
// virtual module. The real module is provided by the Workers runtime
// at execution time and exports `DurableObject` (the base class for
// DO implementations). In Node test runtime that module isn't
// resolvable, so we ship a minimal stand-in.
//
// Tests that actually exercise DO behavior provide their own
// `state.storage` / `env` mocks; the base class just needs a callable
// constructor that accepts the standard `(state, env)` shape.

export class DurableObject<EnvT = unknown> {
  protected readonly ctx: DurableObjectState
  protected readonly env: EnvT

  constructor(ctx: DurableObjectState, env: EnvT) {
    this.ctx = ctx
    this.env = env
  }

  // Subclasses override this. Default implementation 404s so a stray
  // construct-without-override surfaces in tests instead of silently
  // returning undefined.

  async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented in shim", { status: 501 })
  }

  // Cloudflare's DurableObject runtime calls this on alarm fire. The
  // shim default no-ops so tests that don't care about alarms don't
  // need to override.
  async alarm(): Promise<void> {
    // no-op
  }
}

// Minimal DurableObjectState shape — tests provide a real Map-backed
// stub via `makeDoStub()` per the spec §4.2 contract.
interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<boolean>
    setAlarm(timestamp: number): Promise<void>
    getAlarm(): Promise<number | null>
    deleteAlarm(): Promise<void>
    // SIG-138: SQLite storage surface. Tests back this with
    // NodeSqliteStorage — a real node:sqlite-backed adapter.
    sql: {
      exec<T extends Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<T>
    }
    transactionSync<T>(closure: () => T): T
  }
  id: { toString(): string; name?: string }
}

// ─── SqlCursor ──────────────────────────────────────────────────────
//
// Mirrors the Cloudflare SqlStorageCursor contract so DO code that
// spreads ([...cursor]) or iterates (for…of) works identically in
// Node vitest and at Workers runtime.

interface SqlCursor<T extends Record<string, unknown>> {
  [Symbol.iterator](): Iterator<T>
  toArray(): T[]
  one(): T
  raw(): IterableIterator<unknown[]>
  readonly rowsRead: number
  readonly rowsWritten: number
}

// ─── NodeSqliteStorage ──────────────────────────────────────────────
//
// SIG-138: Real in-process SQLite via Node 22's built-in `node:sqlite`
// (`DatabaseSync`). Replaces the prior regex-based FakeSqlStorage.
//
// Contract implemented (mirrors Cloudflare SqlStorage):
//   sql.exec(query, ...bindings) → SqlCursor
//     - Multi-statement DDL (no bindings, multiple semicolons) →
//       db.exec() — runs all statements, returns empty cursor.
//     - Single statements → db.prepare() + .all() for SELECTs /
//       .run() for writes.
//     - Transaction-control keywords (BEGIN/COMMIT/ROLLBACK/…) via
//       sql.exec() are rejected (Cloudflare disallows them; use
//       transactionSync instead).
//   transactionSync(cb) → BEGIN / cb() / COMMIT; ROLLBACK on throw.
//
// One DatabaseSync(":memory:") per NodeSqliteStorage instance →
// each DO instance gets its own isolated database.

import { DatabaseSync, type StatementSync } from "node:sqlite"

type AnyRow = Record<string, unknown>

// Statement-level re-use: node:sqlite StatementSync instances are
// safe to reuse with different bindings.
const READ_RE = /^\s*(?:SELECT|WITH|PRAGMA)\b/i
// Fix 1: DML with a RETURNING clause must also use .all() to surface
// the returned rows (plain INSERT/UPDATE/DELETE … RETURNING …).
const RETURNING_RE = /\bRETURNING\b/i
// Statements that Cloudflare forbids through sql.exec() — these must
// go through transactionSync() instead.
const TX_CTRL_RE = /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i

/** Build an empty-but-valid SqlCursor (for DDL / writes). */
function emptyCursor(written = 0): SqlCursor<AnyRow> {
  const rows: AnyRow[] = []
  return {
    [Symbol.iterator]: () => rows[Symbol.iterator](),
    toArray: () => [],
    one(): AnyRow {
      throw new Error("SqlCursor.one(): no rows returned (empty cursor)")
    },
    raw: function* () {
      /* no rows */
    },
    rowsRead: 0,
    rowsWritten: written,
  }
}

/** Build a populated SqlCursor over an array of rows. */
function rowsCursor<T extends AnyRow>(rows: T[], read = rows.length): SqlCursor<T> {
  return {
    [Symbol.iterator]: () => rows[Symbol.iterator](),
    toArray: () => [...rows],
    one(): T {
      if (rows.length !== 1) {
        throw new Error(`SqlCursor.one(): expected exactly 1 row, got ${rows.length}`)
      }
      return rows[0]!
    },
    raw: function* () {
      for (const row of rows) yield Object.values(row)
    },
    rowsRead: read,
    rowsWritten: 0,
  }
}

/** Coerce a null-prototype node:sqlite row to a plain object. */
function toPlain(row: object): AnyRow {
  return Object.assign(Object.create(null), row) as AnyRow
}

export class NodeSqliteStorage {
  private readonly db: DatabaseSync
  private readonly stmtCache = new Map<string, StatementSync>()
  // Fix 2: depth counter for re-entrant transactionSync via SAVEPOINT.
  private txDepth = 0

  constructor() {
    this.db = new DatabaseSync(":memory:")
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.stmtCache.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.stmtCache.set(sql, stmt)
    }
    return stmt
  }

  exec<T extends AnyRow>(query: string, ...bindings: unknown[]): SqlCursor<T> {
    const q = query.trim()

    // Reject transaction-control keywords — Cloudflare forbids these
    // through sql.exec(); they must go through transactionSync().
    if (TX_CTRL_RE.test(q)) {
      throw new Error(`sql.exec(): transaction-control statement not allowed: "${q.slice(0, 40)}"`)
    }

    // Multi-statement DDL path: no bindings + query contains at least
    // two non-empty statements (heuristic: >1 semicolon, or has a
    // newline + another statement keyword after the first one).
    // Use db.exec() which accepts the whole string but returns nothing.
    if (bindings.length === 0 && looksMultiStatement(q)) {
      this.db.exec(q)
      return emptyCursor() as SqlCursor<T>
    }

    // Single-statement path.
    const stmt = this.prepare(q)

    if (READ_RE.test(q) || RETURNING_RE.test(q)) {
      // SELECT / WITH / PRAGMA and DML … RETURNING — use .all() which
      // returns every row.  For RETURNING statements rowsWritten is not
      // directly observable from .all(); we leave it as 0 to match the
      // Cloudflare cursor contract (callers care about the returned rows).
      const raw = stmt.all(...(bindings as Parameters<typeof stmt.all>)) as object[]
      const rows = raw.map(toPlain) as T[]
      return rowsCursor(rows)
    } else {
      // INSERT / UPDATE / DELETE / CREATE … (single statement, no
      // semicolons — node:sqlite prepare rejects multi-statement).
      const result = stmt.run(...(bindings as Parameters<typeof stmt.run>))
      return emptyCursor(Number(result.changes)) as SqlCursor<T>
    }
  }

  transactionSync<R>(cb: () => R): R {
    // Fix 2: re-entrant transactionSync via SAVEPOINTs.
    // Depth 0 → real BEGIN/COMMIT/ROLLBACK (outermost transaction).
    // Depth > 0 → SAVEPOINT sp_<n> / RELEASE / ROLLBACK TO + RELEASE.
    // Issue all transaction-control SQL directly against the DB handle —
    // NOT through the public sql.exec() which rejects those keywords.
    const depth = this.txDepth
    this.txDepth++
    const spName = `sp_${depth}`
    try {
      if (depth === 0) {
        this.db.exec("BEGIN")
      } else {
        this.db.exec(`SAVEPOINT ${spName}`)
      }
      const result = cb()
      if (depth === 0) {
        this.db.exec("COMMIT")
      } else {
        this.db.exec(`RELEASE ${spName}`)
      }
      return result
    } catch (err) {
      try {
        if (depth === 0) {
          this.db.exec("ROLLBACK")
        } else {
          this.db.exec(`ROLLBACK TO ${spName}`)
          this.db.exec(`RELEASE ${spName}`)
        }
      } catch {
        /* best-effort */
      }
      throw err
    } finally {
      this.txDepth--
    }
  }
}

/**
 * Heuristic: does the trimmed query string look like multiple SQL
 * statements?  We only see this for the SCHEMA string (CREATE TABLE /
 * CREATE INDEX blocks separated by semicolons).  Bindings are always
 * absent in that call, so this path is safe.
 *
 * Strategy: split on `;`, strip whitespace + comments, count non-empty
 * fragments.  Guard against trailing empties so `"SELECT 1;"` is still
 * treated as single-statement.
 */
function looksMultiStatement(q: string): boolean {
  // Simple: split on semicolons, drop empty/whitespace-only fragments.
  const parts = q
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 1
}
