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
 * Fetch the `created_at` timestamps (ascending) for an author's reviews in a
 * rolling window, bounded by `limit` rows.
 *
 * Returns `{ ok: true, count, windowRowsAscMs }` on success — including when
 * there are genuinely no rows in the window (`count === 0`, `windowRowsAscMs`
 * is `[]`).
 *
 * Returns `{ ok: false }` when the binding is absent OR a D1 error occurs.
 * Callers MUST check `ok` before using the values — `{ ok: false }` is a
 * fault sentinel, NOT "zero reviews".  The caller must distinguish the two.
 *
 * `limit` is the caller's `cap + burst + 1` — enough rows for the reset math;
 * we only need the oldest `cap+burst+1` timestamps.  `count` is therefore
 * bounded by `limit`, NOT the full window total.
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
    const { results } = await db
      .prepare(
        "SELECT created_at FROM usage_ledger" +
          " WHERE installation_id = ? AND author_login = ? AND created_at >= ?" +
          " ORDER BY created_at ASC LIMIT ?",
      )
      .bind(installationId, authorLogin, sinceIso, limit)
      .all<{ created_at: unknown }>()
    const windowRowsAscMs = results
      .map((r) => Date.parse(typeof r.created_at === "string" ? r.created_at : ""))
      .filter(Number.isFinite)
    return { ok: true, count: windowRowsAscMs.length, windowRowsAscMs }
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
