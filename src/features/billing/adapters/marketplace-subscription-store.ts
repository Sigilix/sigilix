// sig-github-marketplace-billing — D1 persistence for the `marketplace_subscription`
// table (migration 0013). The account-keyed source of record for a GitHub Marketplace
// purchase, and the stash that lets a purchase-before-install be reconciled onto the
// tenant when `installation.created` later fires.
//
// FAILS OPEN on the write (a stash failure logs + returns void, never throws into the
// webhook) — the tenant provisioning is the load-bearing write; this table is a
// reconcile aid + record. The read returns null on any fault so the reconcile treats a
// degraded DB as "nothing pending" (never a spurious tier grant).

import type { Env } from "@/src/shared/types/env"

/** A pending / recorded Marketplace subscription for one GitHub account. */
export interface MarketplaceSubscriptionRow {
  accountId: number
  accountLogin: string
  tier: string
  seats: number | null
  status: string
}

/**
 * Upsert the account's Marketplace subscription record (keyed by immutable account_id).
 * Called on every purchased/changed/cancelled event so the row always reflects the
 * account's current plan. Fail-soft: a D1 fault logs a warn and returns — the tenant
 * provisioning still proceeds (this record is a reconcile aid, not the tier itself).
 */
export async function upsertMarketplaceSubscription(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  row: MarketplaceSubscriptionRow,
  nowIso: string,
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  if (!Number.isInteger(row.accountId) || row.accountId <= 0) return
  try {
    await env.SIGILIX_PLATFORM_DB.prepare(
      "INSERT INTO marketplace_subscription (account_id, account_login, tier, seats, status, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)" +
        " ON CONFLICT(account_id) DO UPDATE SET" +
        " account_login = excluded.account_login," +
        " tier = excluded.tier," +
        " seats = excluded.seats," +
        " status = excluded.status," +
        " updated_at = excluded.updated_at",
    )
      .bind(row.accountId, row.accountLogin, row.tier, row.seats, row.status, nowIso)
      .run()
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "marketplace-subscription-upsert-failed",
        accountId: row.accountId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/**
 * Read the most-recent Marketplace subscription for a GitHub account by its login
 * (case-insensitive). Used by the install-time reconcile, which only carries
 * account.login. Returns null when the binding is absent, no row matches, or any D1
 * fault occurs (never throws). If two rows share a login (an account rename that reused
 * a login), the most-recently-updated wins.
 */
export async function readMarketplaceSubscriptionByLogin(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  accountLogin: string,
): Promise<MarketplaceSubscriptionRow | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  if (typeof accountLogin !== "string" || accountLogin.length === 0) return null
  try {
    const r = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT account_id, account_login, tier, seats, status FROM marketplace_subscription" +
        " WHERE LOWER(account_login) = LOWER(?) ORDER BY updated_at DESC LIMIT 1",
    )
      .bind(accountLogin)
      .first<{ account_id: number; account_login: string; tier: string; seats: number | null; status: string }>()
    if (r == null) return null
    return {
      accountId: r.account_id,
      accountLogin: r.account_login,
      tier: r.tier,
      seats: typeof r.seats === "number" ? r.seats : null,
      status: r.status,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "marketplace-subscription-read-failed",
        accountLogin,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}
