// SIG-543 PR D Task 2 — usage ledger read adapters (shadow quotas + metrics).
//
// Fail-open by design: D1 errors log a warn and return a degraded sentinel so
// callers can distinguish "genuinely no usage" from "couldn't read the DB".
// Schema DDL is owned by the migration — no ensureSchema here.
//
// created_at ordering invariant: all writes use new Date().toISOString() which
// produces the canonical 24-char ".sssZ" UTC form.  ISO 8601 UTC strings sort
// lexicographically identically to chronologically, so plain string comparison
// `created_at >= ?` is index-safe.  Do NOT wrap in unixepoch() — that would
// defeat the idx_usage_tenant_time index.

import type { Env } from "@/src/shared/types/env"

export type TenantUsageRow = {
  installationId: number
  accountLogin: string | null
  accountType: string | null
  modelCalls: number
  tokens: number
  reviews: number
}

/**
 * Sum usage_ledger rows for a single tenant since `sinceIso` (inclusive).
 *
 * Returns `{ ok: true, modelCalls, tokens, reviews }` on success — including
 * when there are genuinely no rows (COALESCE returns 0s).
 *
 * Returns `{ ok: false }` when the binding is absent OR a D1 error occurs.
 * Callers MUST check `ok` before using the values — `{ ok: false }` is a
 * fault sentinel, not "no usage".
 *
 * FAILS OPEN — never throws.
 */
export async function readTenantUsageSince(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
  sinceIso: string,
): Promise<{ ok: true; modelCalls: number; tokens: number; reviews: number } | { ok: false }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const row = await db
      .prepare(
        "SELECT COALESCE(SUM(model_calls), 0) AS modelCalls," +
          " COALESCE(SUM(tokens), 0) AS tokens," +
          " COUNT(*) AS reviews" +
          " FROM usage_ledger" +
          " WHERE installation_id = ? AND created_at >= ?",
      )
      .bind(installationId, sinceIso)
      .first<{ modelCalls: unknown; tokens: unknown; reviews: unknown }>()
    return {
      ok: true,
      modelCalls: Number(row?.modelCalls) || 0,
      tokens: Number(row?.tokens) || 0,
      reviews: Number(row?.reviews) || 0,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}

/**
 * Aggregate usage_ledger rows since `sinceIso` (inclusive), grouped by tenant,
 * joined to the tenant table for account metadata.
 *
 * When `installationId` is provided, the result is narrowed to that tenant.
 *
 * Returns `{ ok: true, tenants: [] }` when the binding is absent (dark →
 * legitimately empty; indistinguishable from a new deployment with no usage).
 *
 * Returns `{ ok: true, tenants }` on a successful query (may be empty).
 *
 * Returns `{ ok: false }` when a D1 error occurs — callers MUST treat this as
 * a fault, NOT as "no tenants".
 *
 * FAILS OPEN — never throws.
 */
export async function readUsageRollupSince(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  sinceIso: string,
  installationId?: number,
): Promise<{ ok: true; tenants: TenantUsageRow[] } | { ok: false }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: true, tenants: [] }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const hasFilter = installationId !== undefined
    const sql =
      "SELECT u.installation_id AS installationId," +
      " COALESCE(SUM(u.model_calls), 0) AS modelCalls," +
      " COALESCE(SUM(u.tokens), 0) AS tokens," +
      " COUNT(*) AS reviews," +
      " t.account_login AS accountLogin," +
      " t.account_type AS accountType" +
      " FROM usage_ledger u" +
      " LEFT JOIN tenant t ON t.installation_id = u.installation_id" +
      " WHERE u.created_at >= ?" +
      (hasFilter ? " AND u.installation_id = ?" : "") +
      " GROUP BY u.installation_id"

    type RawRow = {
      installationId: unknown
      modelCalls: unknown
      tokens: unknown
      reviews: unknown
      accountLogin: unknown
      accountType: unknown
    }

    const stmt = hasFilter ? db.prepare(sql).bind(sinceIso, installationId) : db.prepare(sql).bind(sinceIso)

    const { results } = await stmt.all<RawRow>()

    const tenants = results.map((r) => ({
      installationId: Number(r.installationId),
      modelCalls: Number(r.modelCalls) || 0,
      tokens: Number(r.tokens) || 0,
      reviews: Number(r.reviews) || 0,
      accountLogin: typeof r.accountLogin === "string" ? r.accountLogin : null,
      accountType: typeof r.accountType === "string" ? r.accountType : null,
    }))
    return { ok: true, tenants }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-usage-rollup-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}
