import {
  decodeOrgSeatBillingOperationRow,
  decodeStripeSeatSubscriptionRow,
  type TenantBillingState,
} from "@/src/features/billing/domain/seat-reconciliation"
import type { Env } from "@/src/shared/types/env"

type DbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

const SNAPSHOT_COLUMNS = `installation_id, stripe_customer_id, stripe_subscription_id,
  stripe_subscription_item_id, stripe_price_id, subscription_status, observed_quantity,
  derived_quantity, revision, snapshot_state, block_reason, last_stripe_event_id,
  last_stripe_event_created_at_ms, last_stripe_event_received_at_ms, last_refreshed_at_ms,
  refresh_due_at_ms, created_at_ms, updated_at_ms`

const OPERATION_COLUMNS = `operation_id, installation_id, revision, login, requested_assigned,
  previous_assigned, desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
  stripe_observed_quantity, idempotency_key, attempts, error_code, next_attempt_at_ms,
  created_at_ms, updated_at_ms, stripe_applied_at_ms, completed_at_ms`

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

export async function readTenantBillingState(env: DbEnv, installationId: number): Promise<TenantBillingState> {
  if (!validInstallationId(installationId)) return { kind: "error", reason: "invalid_installation" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT billing_source, subscription_status FROM tenant WHERE installation_id = ?",
    )
      .bind(installationId)
      .first<{ billing_source: unknown; subscription_status: unknown }>()
    if (row === null) return { kind: "missing" }
    const status = row.subscription_status
    if (status !== null && typeof status !== "string") return { kind: "error", reason: "invalid_row" }
    if (row.billing_source === "stripe") {
      if (status === "active" || status === "trialing") {
        return { kind: "stripe-active", installationId, subscriptionStatus: status }
      }
      return { kind: "error", reason: "stripe_inactive" }
    }
    if (row.billing_source === null || row.billing_source === "github_marketplace") {
      return {
        kind: "non-stripe",
        installationId,
        billingSource: row.billing_source,
        subscriptionStatus: status,
      }
    }
    return { kind: "error", reason: "invalid_row" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function readStripeSeatSubscription(
  env: DbEnv,
  installationId: number,
): Promise<
  | { kind: "ok"; snapshot: NonNullable<ReturnType<typeof decodeStripeSeatSubscriptionRow>> }
  | { kind: "missing" }
  | { kind: "error"; reason: "invalid_installation" | "invalid_row" | "unavailable" }
> {
  if (!validInstallationId(installationId)) return { kind: "error", reason: "invalid_installation" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM stripe_seat_subscription WHERE installation_id = ?`,
    )
      .bind(installationId)
      .first<Record<string, unknown>>()
    if (row === null) return { kind: "missing" }
    const snapshot = decodeStripeSeatSubscriptionRow(row)
    return snapshot ? { kind: "ok", snapshot } : { kind: "error", reason: "invalid_row" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function readActiveOrgSeatBillingOperation(
  env: DbEnv,
  installationId: number,
): Promise<
  | { kind: "ok"; operation: NonNullable<ReturnType<typeof decodeOrgSeatBillingOperationRow>> }
  | { kind: "missing" }
  | { kind: "error"; reason: "invalid_installation" | "invalid_row" | "unavailable" }
> {
  if (!validInstallationId(installationId)) return { kind: "error", reason: "invalid_installation" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT ${OPERATION_COLUMNS} FROM org_seat_billing_operation
        WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')`,
    )
      .bind(installationId)
      .first<Record<string, unknown>>()
    if (row === null) return { kind: "missing" }
    const operation = decodeOrgSeatBillingOperationRow(row)
    return operation ? { kind: "ok", operation } : { kind: "error", reason: "invalid_row" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function deriveBillableSeatQuantity(
  env: DbEnv,
  installationId: number,
): Promise<
  | { kind: "ok"; quantity: number }
  | { kind: "missing" }
  | { kind: "error"; reason: "invalid_installation" | "invalid_row" | "unavailable" }
> {
  if (!validInstallationId(installationId)) return { kind: "error", reason: "invalid_installation" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      `WITH tenant_scope AS (
         SELECT 1 AS present FROM tenant WHERE installation_id = ?
       ), active_logins AS (
         SELECT DISTINCT lower(trim(author_login)) AS login
           FROM usage_ledger
          WHERE installation_id = ? AND author_login IS NOT NULL AND trim(author_login) <> ''
       ), overrides AS (
         SELECT lower(trim(login)) AS login, MIN(assigned) AS assigned, COUNT(*) AS row_count,
                SUM(CASE WHEN assigned IN (0, 1) THEN 0 ELSE 1 END) AS invalid_count
           FROM org_seat_assignment
          WHERE installation_id = ? AND trim(login) <> ''
          GROUP BY lower(trim(login))
       ), candidates AS (
         SELECT login FROM active_logins
         UNION
         SELECT login FROM overrides
       )
       SELECT COALESCE(SUM(
         CASE WHEN overrides.assigned IS NOT NULL THEN overrides.assigned
              WHEN active_logins.login IS NOT NULL THEN 1 ELSE 0 END
       ), 0) AS quantity,
       (SELECT COUNT(*) FROM overrides WHERE row_count > 1) AS duplicateOverrideCount,
       (SELECT COALESCE(SUM(invalid_count), 0) FROM overrides) AS invalidOverrideCount,
       (SELECT COUNT(*) FROM tenant_scope) AS tenantCount
         FROM candidates
         LEFT JOIN active_logins ON active_logins.login = candidates.login
         LEFT JOIN overrides ON overrides.login = candidates.login`,
    )
      .bind(installationId, installationId, installationId)
      .first<{
        quantity: unknown
        duplicateOverrideCount: unknown
        invalidOverrideCount: unknown
        tenantCount: unknown
      }>()
    if (Number(row?.tenantCount) === 0) return { kind: "missing" }
    if (Number(row?.duplicateOverrideCount) !== 0 || Number(row?.invalidOverrideCount) !== 0) {
      return { kind: "error", reason: "invalid_row" }
    }
    const quantity = Number(row?.quantity)
    return Number.isSafeInteger(quantity) && quantity >= 0
      ? { kind: "ok", quantity }
      : { kind: "error", reason: "invalid_row" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function acquireOrgSeatBillingLease(
  env: DbEnv,
  args: { installationId: number; token: string; nowMs: number; ttlMs: number },
): Promise<
  | { kind: "acquired"; expiresAtMs: number }
  | { kind: "busy" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  const expiresAtMs = args.nowMs + args.ttlMs
  if (
    !validInstallationId(args.installationId) ||
    args.token.length === 0 ||
    !Number.isSafeInteger(args.nowMs) ||
    args.nowMs < 0 ||
    !Number.isSafeInteger(args.ttlMs) ||
    args.ttlMs <= 0 ||
    !Number.isSafeInteger(expiresAtMs)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const result = await db
      .prepare(
        `INSERT INTO org_seat_billing_lease (installation_id, lease_token, acquired_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET
           lease_token = excluded.lease_token,
           acquired_at_ms = excluded.acquired_at_ms,
           expires_at_ms = excluded.expires_at_ms
         WHERE org_seat_billing_lease.expires_at_ms <= ?`,
      )
      .bind(args.installationId, args.token, args.nowMs, expiresAtMs, args.nowMs)
      .run()
    if ((result.meta.changes ?? 0) === 1) return { kind: "acquired", expiresAtMs }
    return { kind: "busy" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function releaseOrgSeatBillingLease(
  env: DbEnv,
  args: { installationId: number; token: string; acquiredAtMs: number },
): Promise<{ kind: "released" } | { kind: "not_owner" } | { kind: "error"; reason: "invalid_input" | "unavailable" }> {
  if (
    !validInstallationId(args.installationId) ||
    args.token.length === 0 ||
    !Number.isSafeInteger(args.acquiredAtMs) ||
    args.acquiredAtMs < 0
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const result = await env.SIGILIX_PLATFORM_DB.prepare(
      "DELETE FROM org_seat_billing_lease WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ?",
    )
      .bind(args.installationId, args.token, args.acquiredAtMs)
      .run()
    return (result.meta.changes ?? 0) === 1 ? { kind: "released" } : { kind: "not_owner" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}
