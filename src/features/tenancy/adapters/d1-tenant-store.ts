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
 * SIG-41 (Stripe paid tier): set an installation's plan tier. This is the ONE write
 * site the billing seam (`src/lib/resolve-plan.ts`) + the entitlements gate
 * (`readInstallationPlan`) read back through `tenant.tier`. UPSERT by installation_id:
 * a brand-new tenant (its first PR webhook hasn't run yet) is inserted with the tier;
 * an existing row has only its tier + updated_at touched (account_login/type,
 * concurrency_cap, daily_budget are left intact).
 *
 * Unlike the fail-OPEN `upsertTenantAndRepo` above, this returns `{ ok }` and does NOT
 * swallow a genuine D1 fault into a silent success: billing correctness beats
 * availability here, so the webhook route surfaces a 5xx on `ok:false` and lets Stripe
 * redeliver. Returns `{ ok: false }` (never throws) when the binding is absent or the
 * write fails. `installationId` is validated positive-integer.
 *
 * sig-trial-cap: `subscriptionStatus` (Stripe's normalized status — 'active' /
 * 'trialing' / a terminal status / null) is written in the SAME UPSERT so the tier and
 * the state that decides FULL-vs-HALF usage volume (see resolveRateLimitCap) can never
 * drift apart. It is ALWAYS written alongside the tier: converting a trial→active
 * overwrites the column to 'active', so no lingering half-cap survives the conversion.
 *
 * ENTERPRISE PROTECTION (contract tier): `enterprise` is set manually on `tenant.tier`
 * when a team signs a contract — never via self-serve Stripe. This is the ONLY Stripe
 * tier-write site, and Stripe only ever produces free/pro/teams/max/ultra. The
 * `ON CONFLICT ... WHERE` guard makes the UPDATE a no-op when the EXISTING row is already
 * `enterprise`, so a stray/late Stripe event (e.g. a `subscription.deleted` for a
 * previously-linked sub, or a `payment_failed`) can never downgrade a contract tenant and
 * strip its entitlements / top cap. A skipped no-op still succeeds (`ok:true` → the
 * webhook acks 200, no redelivery). An INSERT for a brand-new tenant is unaffected
 * (Stripe never inserts `enterprise`), and an operator downgrade of an ended contract is
 * a direct manual D1 write that bypasses this function entirely.
 */
export async function upsertTenantTier(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
  tier: string,
  nowIso: string,
  subscriptionStatus: string | null = null,
): Promise<{ ok: boolean }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false }
  if (!Number.isInteger(installationId) || installationId <= 0) return { ok: false }
  try {
    await env.SIGILIX_PLATFORM_DB.prepare(
      "INSERT INTO tenant (installation_id, tier, subscription_status, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT(installation_id) DO UPDATE SET" +
        " tier = excluded.tier," +
        " subscription_status = excluded.subscription_status," +
        " updated_at = excluded.updated_at" +
        // Contract-tier guard: never let a Stripe event overwrite a manually-set
        // `enterprise` tenant (case/space-insensitive match mirrors resolveRateLimitCap).
        " WHERE LOWER(TRIM(tenant.tier)) != 'enterprise'",
    )
      .bind(installationId, tier, subscriptionStatus, nowIso, nowIso)
      .run()
    return { ok: true }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-tenant-tier-upsert-failed",
        installationId,
        tier,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}

/**
 * sig-trial-cap: read the tenant's Stripe `subscription_status` (migration 0011) — the
 * signal that decides FULL (active) vs HALF (trialing/unknown) usage volume. Returns the
 * raw status string, or null when the binding is absent, the row/column is NULL, or a D1
 * fault occurs.
 *
 * FAIL-SAFE RESTRICTIVE (never throws): a null return is interpreted by
 * `isFullPaidStatus` as NOT fully paid → the trial (half) cap — so a read fault, a
 * missing row, or a pre-migration NULL can never silently grant full paid volume.
 */
export async function readTenantSubscriptionStatus(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<string | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  if (!Number.isInteger(installationId) || installationId <= 0) return null
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT subscription_status FROM tenant WHERE installation_id = ?",
    )
      .bind(installationId)
      .first<{ subscription_status: unknown }>()
    if (row == null) return null
    return typeof row.subscription_status === "string" ? row.subscription_status : null
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-tenant-subscription-status-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

/**
 * Look up the repo_id + installation_id for a GitHub `owner/repo` full name.
 * Returns null when the platform DB binding is absent, the repo has no row
 * yet (a benign race — the PR webhook upserts this table asynchronously, so
 * a repo picked in the onboarding wizard before its first PR has none), or
 * any D1 error occurs. Never throws — callers (e.g. onboarding-memory-capture.ts)
 * treat null as "skip this repo".
 */
export async function lookupRepoByFullName(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  fullName: string,
): Promise<{ repoId: number; installationId: number } | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const row = await db
      .prepare("SELECT repo_id, installation_id FROM repo WHERE full_name = ?")
      .bind(fullName)
      .first<{ repo_id: number; installation_id: number }>()
    if (row == null) return null
    return { repoId: row.repo_id, installationId: row.installation_id }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-tenant-store-lookup-repo-failed",
        fullName,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
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
