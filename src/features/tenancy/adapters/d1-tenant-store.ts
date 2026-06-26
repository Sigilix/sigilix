// SIG-343 PR C Task 2 — tenant + repo registry adapter.
//
// Fail-open by design: any D1 error logs a warn and returns; the caller
// (webhook handler, review admission) must never be blocked by a missing
// or degraded platform DB.  Schema DDL is owned by the migration — no
// ensureSchema here.

import type { Env } from "@/src/shared/types/env"

/**
 * Upsert the tenant record (ON CONFLICT DO UPDATE refreshes account_login and
 * account_type via COALESCE so incoming nulls never overwrite a known value,
 * while operator-tuned concurrency_cap/tier/daily_budget are untouched) then
 * upsert the repo record (ON CONFLICT DO UPDATE refreshes full_name + updated_at).
 * Tenant statement is first in the batch so the repo FK is never orphaned.
 *
 * FAILS OPEN — any error logs a warn and returns void; never throws.
 */
export async function upsertTenantAndRepo(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: {
    installationId: number
    repoId: number
    fullName: string
    nowIso: string
    accountLogin?: string
    accountType?: string
  },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const tenantStmt = db
      .prepare(
        "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT(installation_id) DO UPDATE SET" +
          " account_login = COALESCE(excluded.account_login, tenant.account_login)," +
          " account_type = COALESCE(excluded.account_type, tenant.account_type)," +
          " updated_at = excluded.updated_at",
      )
      .bind(args.installationId, args.accountLogin ?? null, args.accountType ?? null, args.nowIso, args.nowIso)
    const repoStmt = db
      .prepare(
        "INSERT INTO repo (repo_id, installation_id, full_name, updated_at)" +
          " VALUES (?, ?, ?, ?)" +
          " ON CONFLICT(repo_id) DO UPDATE SET full_name = excluded.full_name, updated_at = excluded.updated_at",
      )
      .bind(args.repoId, args.installationId, args.fullName, args.nowIso)
    await db.batch([tenantStmt, repoStmt])
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-tenant-store-upsert-failed",
        installationId: args.installationId,
        repoId: args.repoId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/**
 * Read the per-tenant concurrency_cap and daily_budget from the platform DB.
 * Returns null when the binding is absent, the tenant row is missing, or any
 * D1 error occurs.  Individual fields are null when the column value is NULL
 * (i.e. operator has not set an override yet).
 *
 * FAILS OPEN — never throws.
 */
export async function readTenantConfig(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<{ cap: number | null; dailyBudget: number | null } | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const row = await db
      .prepare("SELECT concurrency_cap, daily_budget FROM tenant WHERE installation_id = ?")
      .bind(installationId)
      .first<{ concurrency_cap: unknown; daily_budget: unknown }>()
    if (row == null) return null
    return {
      cap: typeof row.concurrency_cap === "number" ? row.concurrency_cap : null,
      dailyBudget: typeof row.daily_budget === "number" ? row.daily_budget : null,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-tenant-config-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}
