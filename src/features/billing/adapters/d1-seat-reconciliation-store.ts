import {
  decodeOrgSeatBillingOperationRow,
  decodeStripeSeatSubscriptionRow,
  type TenantBillingState,
} from "@/src/features/billing/domain/seat-reconciliation"
import type { Env } from "@/src/shared/types/env"

type DbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

type SnapshotAudit = {
  installationId: number
  expectedRevision: number | null
  customerId: string
  eventId: string
  eventCreatedAtMs: number
  eventReceivedAtMs: number
  nowMs: number
}

export type StripeSeatSubscriptionSnapshotWrite =
  | (SnapshotAudit & {
      state: "ready"
      subscriptionId: string
      subscriptionItemId: string
      priceId: string
      subscriptionStatus: "active" | "trialing"
      quantity: number
    })
  | (SnapshotAudit & { state: "blocked"; reason: string })
  | (SnapshotAudit & { state: "not_applicable" })

export type StripeSeatSubscriptionSnapshotWriteResult =
  | { kind: "written"; revision: number }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "unavailable" }

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

function nonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validSnapshotWrite(value: StripeSeatSubscriptionSnapshotWrite): boolean {
  if (
    !validInstallationId(value.installationId) ||
    (value.expectedRevision !== null && !nonNegativeInteger(value.expectedRevision)) ||
    !nonEmpty(value.customerId) ||
    !nonEmpty(value.eventId) ||
    !nonNegativeInteger(value.eventCreatedAtMs) ||
    !nonNegativeInteger(value.eventReceivedAtMs) ||
    !nonNegativeInteger(value.nowMs)
  ) {
    return false
  }
  if (value.state === "blocked") return nonEmpty(value.reason)
  if (value.state === "not_applicable") return true
  return (
    nonEmpty(value.subscriptionId) &&
    nonEmpty(value.subscriptionItemId) &&
    nonEmpty(value.priceId) &&
    Number.isSafeInteger(value.quantity) &&
    value.quantity > 0
  )
}

function snapshotWriteColumns(value: StripeSeatSubscriptionSnapshotWrite): {
  subscriptionId: string | null
  subscriptionItemId: string | null
  priceId: string | null
  subscriptionStatus: "active" | "trialing" | null
  observedQuantity: number | null
  derivedQuantity: number
  blockReason: string | null
} {
  if (value.state !== "ready") {
    return {
      subscriptionId: null,
      subscriptionItemId: null,
      priceId: null,
      subscriptionStatus: null,
      observedQuantity: null,
      derivedQuantity: 0,
      blockReason: value.state === "blocked" ? value.reason.trim() : null,
    }
  }
  return {
    subscriptionId: value.subscriptionId,
    subscriptionItemId: value.subscriptionItemId,
    priceId: value.priceId,
    subscriptionStatus: value.subscriptionStatus,
    observedQuantity: value.quantity,
    derivedQuantity: value.quantity,
    blockReason: null,
  }
}

export async function readStripeCustomerBinding(
  env: DbEnv,
  installationId: number,
): Promise<
  | { kind: "hit"; customerId: string }
  | { kind: "miss" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (!validInstallationId(installationId)) return { kind: "error", reason: "invalid_input" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT stripe_customer_id FROM stripe_seat_subscription WHERE installation_id = ?",
    )
      .bind(installationId)
      .first<{ stripe_customer_id: unknown }>()
    if (row === null || row.stripe_customer_id === null) return { kind: "miss" }
    return typeof row.stripe_customer_id === "string" && nonEmpty(row.stripe_customer_id)
      ? { kind: "hit", customerId: row.stripe_customer_id }
      : { kind: "error", reason: "invalid_row" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function readStripeInstallationBinding(
  env: DbEnv,
  customerId: string,
): Promise<
  | { kind: "hit"; installationId: number }
  | { kind: "miss" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (!nonEmpty(customerId)) return { kind: "error", reason: "invalid_input" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT installation_id FROM stripe_seat_subscription WHERE stripe_customer_id = ?",
    )
      .bind(customerId)
      .first<{ installation_id: unknown }>()
    if (row === null) return { kind: "miss" }
    return typeof row.installation_id === "number" && validInstallationId(row.installation_id)
      ? { kind: "hit", installationId: row.installation_id }
      : { kind: "error", reason: "invalid_row" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

/**
 * Persist one provider-only Stripe seat-capacity snapshot. The caller reads the
 * revision before its live Stripe refresh; this write succeeds only if that
 * exact revision still owns the row, so stale provider reads cannot overwrite a
 * concurrent webhook or future seat operation.
 */
export async function writeStripeSeatSubscriptionSnapshot(
  env: DbEnv,
  value: StripeSeatSubscriptionSnapshotWrite,
): Promise<StripeSeatSubscriptionSnapshotWriteResult> {
  if (!validSnapshotWrite(value)) return { kind: "error", reason: "invalid_input" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const row = snapshotWriteColumns(value)
  const revision = (value.expectedRevision ?? 0) + 1
  if (!Number.isSafeInteger(revision)) return { kind: "error", reason: "invalid_input" }
  try {
    if (value.expectedRevision === null) {
      const result = await env.SIGILIX_PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO stripe_seat_subscription
          (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
           stripe_price_id, subscription_status, observed_quantity, derived_quantity, revision,
           snapshot_state, block_reason, last_stripe_event_id, last_stripe_event_created_at_ms,
           last_stripe_event_received_at_ms, last_refreshed_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          value.installationId,
          value.customerId,
          row.subscriptionId,
          row.subscriptionItemId,
          row.priceId,
          row.subscriptionStatus,
          row.observedQuantity,
          row.derivedQuantity,
          revision,
          value.state,
          row.blockReason,
          value.eventId,
          value.eventCreatedAtMs,
          value.eventReceivedAtMs,
          value.nowMs,
          value.nowMs,
          value.nowMs,
        )
        .run()
      return (result.meta.changes ?? 0) === 1 ? { kind: "written", revision } : { kind: "conflict" }
    }

    const result = await env.SIGILIX_PLATFORM_DB.prepare(
      `UPDATE OR IGNORE stripe_seat_subscription SET
         stripe_customer_id = ?, stripe_subscription_id = ?, stripe_subscription_item_id = ?,
         stripe_price_id = ?, subscription_status = ?, observed_quantity = ?, derived_quantity = ?,
         revision = ?, snapshot_state = ?, block_reason = ?,
         last_stripe_event_id = CASE
           WHEN last_stripe_event_created_at_ms IS NULL OR ? >= last_stripe_event_created_at_ms THEN ?
           ELSE last_stripe_event_id END,
         last_stripe_event_created_at_ms = CASE
           WHEN last_stripe_event_created_at_ms IS NULL OR ? >= last_stripe_event_created_at_ms THEN ?
           ELSE last_stripe_event_created_at_ms END,
         last_stripe_event_received_at_ms = CASE
           WHEN last_stripe_event_received_at_ms IS NULL OR ? >= last_stripe_event_received_at_ms THEN ?
           ELSE last_stripe_event_received_at_ms END,
         last_refreshed_at_ms = ?, updated_at_ms = ?
       WHERE installation_id = ? AND revision = ?
         AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)`,
    )
      .bind(
        value.customerId,
        row.subscriptionId,
        row.subscriptionItemId,
        row.priceId,
        row.subscriptionStatus,
        row.observedQuantity,
        row.derivedQuantity,
        revision,
        value.state,
        row.blockReason,
        value.eventCreatedAtMs,
        value.eventId,
        value.eventCreatedAtMs,
        value.eventCreatedAtMs,
        value.eventReceivedAtMs,
        value.eventReceivedAtMs,
        value.nowMs,
        value.nowMs,
        value.installationId,
        value.expectedRevision,
        value.customerId,
      )
      .run()
    return (result.meta.changes ?? 0) === 1 ? { kind: "written", revision } : { kind: "conflict" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
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

/**
 * Ensure the lease/snapshot foreign-key parent exists without changing any
 * existing tenant entitlement. Stripe webhooks historically created the tenant
 * only at the final tier UPSERT; reconciliation needs the parent earlier so the
 * per-installation lease can serialize the live provider refresh.
 */
export async function ensureSeatReconciliationTenant(
  env: DbEnv,
  installationId: number,
  nowIso: string,
): Promise<{ kind: "ready" } | { kind: "error"; reason: "invalid_input" | "unavailable" }> {
  if (!validInstallationId(installationId) || nowIso.trim().length === 0) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    await env.SIGILIX_PLATFORM_DB.prepare(
      `INSERT OR IGNORE INTO tenant (installation_id, tier, created_at, updated_at)
       VALUES (?, 'free', ?, ?)`,
    )
      .bind(installationId, nowIso, nowIso)
      .run()
    return { kind: "ready" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

/**
 * Establish the immutable customer↔installation ownership claim before any paid
 * tier is written. The schema's installation PK + unique customer index resolve
 * concurrent first webhooks without relying on the non-transactional KV pair.
 */
export async function claimStripeSeatSubscriptionBinding(
  env: DbEnv,
  args: { installationId: number; customerId: string; nowMs: number },
): Promise<
  | { kind: "claimed"; revision: number }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (!validInstallationId(args.installationId) || !nonEmpty(args.customerId) || !nonNegativeInteger(args.nowMs)) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO stripe_seat_subscription
          (installation_id, stripe_customer_id, derived_quantity, revision, snapshot_state,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, 0, 0, 'discovering', ?, ?)`,
      )
      .bind(args.installationId, args.customerId, args.nowMs, args.nowMs)
      .run()
    // A pre-writer dark row may exist without its customer identity. Bind it only
    // while still unclaimed; UPDATE OR IGNORE preserves the unique-customer guard.
    await db
      .prepare(
        `UPDATE OR IGNORE stripe_seat_subscription
            SET stripe_customer_id = ?, updated_at_ms = ?
          WHERE installation_id = ? AND stripe_customer_id IS NULL`,
      )
      .bind(args.customerId, args.nowMs, args.installationId)
      .run()
    const row = await db
      .prepare("SELECT stripe_customer_id, revision FROM stripe_seat_subscription WHERE installation_id = ?")
      .bind(args.installationId)
      .first<{ stripe_customer_id: unknown; revision: unknown }>()
    if (row === null || row.stripe_customer_id !== args.customerId) return { kind: "conflict" }
    if (typeof row.revision !== "number" || !nonNegativeInteger(row.revision)) {
      return { kind: "error", reason: "invalid_row" }
    }
    return { kind: "claimed", revision: row.revision }
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
