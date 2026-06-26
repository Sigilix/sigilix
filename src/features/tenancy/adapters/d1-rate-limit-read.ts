// SIG-38 Task 2 — rolling per-developer review count for rate-limit enforcement.
//
// Fail-open by design: D1 errors log a warn and return {ok:false} so callers
// can distinguish "couldn't read the DB" from "genuinely zero reviews".
// Schema DDL is owned by the migration — no ensureSchema here.
//
// created_at ordering invariant: all writes use new Date().toISOString() which
// produces the canonical 24-char ".sssZ" UTC form.  ISO 8601 UTC strings sort
// lexicographically identically to chronologically, so plain string comparison
// `created_at >= ?` is index-safe.  Do NOT wrap in unixepoch() — that would
// defeat the idx_usage_tenant_time index.

import type { Env } from "@/src/shared/types/env"

/**
 * Fetch the TRUE in-window review count and a bounded slice of oldest
 * timestamps for an author's rolling review window.
 *
 * Uses one `db.batch([countStmt, rowsStmt])` round-trip:
 *   - countStmt: `SELECT COUNT(*) AS n` — the TRUE total in-window count
 *     regardless of how many rows are needed for reset math.
 *   - rowsStmt: `SELECT created_at … ORDER BY … ASC LIMIT ?` — the oldest
 *     `limit` rows (limit = cap+burst+1) for `computeResetMs`.
 *
 * Returns `{ ok: true, count, windowRowsAscMs }` on success:
 *   - `count` is the TRUE total (not bounded by `limit`).
 *   - `windowRowsAscMs` is bounded by `limit` (enough oldest rows for reset
 *     math; `computeResetMs` falls back to `windowMs` when the needed index
 *     exceeds what was fetched — that conservative fallback is correct, never
 *     an optimistic reset).
 *
 * Returns `{ ok: false }` when the binding is absent OR a D1 error occurs.
 * Callers MUST check `ok` before using the values — `{ ok: false }` is a
 * fault sentinel, NOT "zero reviews".  The caller must distinguish the two.
 *
 * FAILS OPEN — never throws.
 */
export async function readRollingReviewCount(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { installationId: number; authorLogin: string; sinceIso: string; limit: number },
): Promise<{ ok: true; count: number; windowRowsAscMs: number[] } | { ok: false }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false }
  const db = env.SIGILIX_PLATFORM_DB
  const { installationId, authorLogin, sinceIso, limit } = args
  try {
    const countStmt = db
      .prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger" +
          " WHERE installation_id = ? AND author_login = ? AND created_at >= ?",
      )
      .bind(installationId, authorLogin, sinceIso)
    const rowsStmt = db
      .prepare(
        "SELECT created_at FROM usage_ledger" +
          " WHERE installation_id = ? AND author_login = ? AND created_at >= ?" +
          " ORDER BY created_at ASC LIMIT ?",
      )
      .bind(installationId, authorLogin, sinceIso, limit)
    const batchRes = await db.batch([countStmt, rowsStmt])
    const countRes = batchRes[0]
    const rowsRes = batchRes[1]
    if (!countRes || !rowsRes) return { ok: false }
    const firstRow = countRes.results[0] as { n?: number } | undefined
    const count = typeof firstRow?.n === "number" ? firstRow.n : 0
    const windowRowsAscMs = (rowsRes.results as Array<{ created_at?: unknown }>)
      .map((r) => Date.parse(typeof r.created_at === "string" ? r.created_at : ""))
      .filter(Number.isFinite)
    return { ok: true, count, windowRowsAscMs }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-rate-limit-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}
