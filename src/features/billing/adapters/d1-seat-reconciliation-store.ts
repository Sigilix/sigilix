/* eslint-disable max-lines -- Durable seat reconciliation keeps each guarded D1 transition beside its schema reads. */
import {
  decodeOrgSeatBillingOperationRow,
  decodeStripeSeatSubscriptionRow,
  type OrgSeatBillingOperation,
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

const OPERATION_COLUMNS = `operation_id, installation_id, revision, login, target_identity_kind,
  target_github_user_id, actor_login, target_is_admin, requested_assigned, previous_assigned, desired_quantity, state, stripe_subscription_id,
  stripe_subscription_item_id, stripe_observed_quantity, idempotency_key, attempts, error_code,
  next_attempt_at_ms, created_at_ms, updated_at_ms, stripe_applied_at_ms, completed_at_ms`

const ACTIVE_OPERATION_STATES = ["pending", "stripe_applied"] as const
type ActiveOperationState = (typeof ACTIVE_OPERATION_STATES)[number]

type LeaseFence = {
  installationId: number
  leaseToken: string
  leaseAcquiredAtMs: number
  nowMs: number
}

const RETRY_BASE_DELAY_MS = 5_000
const RETRY_MAX_DELAY_MS = 300_000
const MAX_DUE_OPERATIONS = 100

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function normalizeLogin(value: string): string {
  return value.trim().toLowerCase()
}

function validLeaseFence(value: LeaseFence): boolean {
  return (
    validInstallationId(value.installationId) &&
    nonEmpty(value.leaseToken) &&
    nonNegativeInteger(value.leaseAcquiredAtMs) &&
    nonNegativeInteger(value.nowMs)
  )
}

function isActiveOperationState(value: string): value is ActiveOperationState {
  return (ACTIVE_OPERATION_STATES as readonly string[]).includes(value)
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
    if (
      row.billing_source === null ||
      row.billing_source === "github_marketplace" ||
      row.billing_source === "legacy_entitlement"
    ) {
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

async function exactLeaseExists(db: D1Database, fence: LeaseFence): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS matched FROM org_seat_billing_lease
        WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?`,
    )
    .bind(fence.installationId, fence.leaseToken, fence.leaseAcquiredAtMs, fence.nowMs)
    .first<{ matched: unknown }>()
  return row?.matched === 1
}

async function guardedConditionMatches(
  db: D1Database,
  fence: LeaseFence,
  conditionSql: string,
  conditionBindings: readonly unknown[],
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS matched
        WHERE EXISTS (
          SELECT 1 FROM org_seat_billing_lease
           WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
        ) AND (${conditionSql})`,
    )
    .bind(fence.installationId, fence.leaseToken, fence.leaseAcquiredAtMs, fence.nowMs, ...conditionBindings)
    .first<{ matched: unknown }>()
  return row?.matched === 1
}

/**
 * First statement for a caller-composed D1 batch. A false fence or state
 * predicate deliberately selects installation 0, whose schema CHECK aborts
 * the whole transaction. A true predicate selects the already-leased tenant
 * and no-ops on its primary-key conflict.
 */
function exactBatchGuard(
  db: D1Database,
  fence: LeaseFence,
  conditionSql: string,
  conditionBindings: readonly unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO org_seat_billing_lease
         (installation_id, lease_token, acquired_at_ms, expires_at_ms)
       SELECT CASE WHEN EXISTS (
         SELECT 1 FROM org_seat_billing_lease
          WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
       ) AND (${conditionSql}) THEN ? ELSE 0 END,
       '__seat_billing_batch_guard__', 0, 1
       WHERE true
       ON CONFLICT(installation_id) DO NOTHING`,
    )
    .bind(
      fence.installationId,
      fence.leaseToken,
      fence.leaseAcquiredAtMs,
      fence.nowMs,
      ...conditionBindings,
      fence.installationId,
    )
}

const EFFECTIVE_SEAT_CTES = `
  active_logins AS (
    SELECT DISTINCT lower(trim(author_login)) AS login
      FROM usage_ledger
     WHERE installation_id = ? AND author_login IS NOT NULL AND trim(author_login) <> ''
  ), overrides AS (
    SELECT lower(trim(login)) AS login, MIN(assigned) AS assigned, MIN(is_admin) AS is_admin,
           COUNT(*) AS row_count,
           SUM(CASE WHEN assigned IN (0, 1) AND is_admin IN (0, 1) THEN 0 ELSE 1 END) AS invalid_count
      FROM org_seat_assignment
     WHERE installation_id = ? AND trim(login) <> ''
     GROUP BY lower(trim(login))
  ), candidates AS (
    SELECT login FROM active_logins
    UNION
    SELECT login FROM overrides
  ), effective AS (
    SELECT candidates.login,
           CASE WHEN overrides.login IS NOT NULL THEN overrides.assigned ELSE 1 END AS assigned,
           CASE WHEN overrides.login IS NOT NULL THEN overrides.is_admin ELSE 0 END AS is_admin
      FROM candidates
      LEFT JOIN overrides ON overrides.login = candidates.login
  )`

export type EffectiveOrgSeatAssignment = {
  installationId: number
  login: string
  assigned: boolean
  isAdmin: boolean
  source: "override" | "activity" | "none"
  assignedQuantity: number
}

export async function readEffectiveOrgSeatAssignment(
  env: DbEnv,
  args: LeaseFence & { login: string },
): Promise<
  | { kind: "ok"; assignment: EffectiveOrgSeatAssignment }
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  const login = normalizeLogin(args.login)
  if (!validLeaseFence(args) || !nonEmpty(login)) return { kind: "error", reason: "invalid_input" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      `WITH ${EFFECTIVE_SEAT_CTES}
       SELECT
         (SELECT COUNT(*) FROM tenant WHERE installation_id = ?) AS tenant_count,
         (SELECT COUNT(*) FROM org_seat_billing_lease
           WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?) AS lease_count,
         COALESCE((SELECT assigned FROM effective WHERE login = ?), 0) AS target_assigned,
         COALESCE((SELECT is_admin FROM effective WHERE login = ?), 0) AS target_is_admin,
         CASE WHEN EXISTS (SELECT 1 FROM overrides WHERE login = ?) THEN 'override'
              WHEN EXISTS (SELECT 1 FROM active_logins WHERE login = ?) THEN 'activity'
              ELSE 'none' END AS source,
         COALESCE((SELECT SUM(assigned) FROM effective), 0) AS assigned_quantity,
         (SELECT COUNT(*) FROM overrides WHERE row_count > 1) AS duplicate_count,
         (SELECT COALESCE(SUM(invalid_count), 0) FROM overrides) AS invalid_count`,
    )
      .bind(
        args.installationId,
        args.installationId,
        args.installationId,
        args.installationId,
        args.leaseToken,
        args.leaseAcquiredAtMs,
        args.nowMs,
        login,
        login,
        login,
        login,
      )
      .first<{
        tenant_count: unknown
        lease_count: unknown
        target_assigned: unknown
        target_is_admin: unknown
        source: unknown
        assigned_quantity: unknown
        duplicate_count: unknown
        invalid_count: unknown
      }>()
    if (row === null) return { kind: "error", reason: "invalid_row" }
    if (Number(row.lease_count) !== 1) return { kind: "conflict" }
    if (Number(row.tenant_count) === 0) return { kind: "missing" }
    const assignedQuantity = Number(row.assigned_quantity)
    if (
      Number(row.duplicate_count) !== 0 ||
      Number(row.invalid_count) !== 0 ||
      (row.target_assigned !== 0 && row.target_assigned !== 1) ||
      (row.target_is_admin !== 0 && row.target_is_admin !== 1) ||
      (row.source !== "override" && row.source !== "activity" && row.source !== "none") ||
      !nonNegativeInteger(assignedQuantity)
    ) {
      return { kind: "error", reason: "invalid_row" }
    }
    return {
      kind: "ok",
      assignment: {
        installationId: args.installationId,
        login,
        assigned: row.target_assigned === 1,
        isAdmin: row.target_is_admin === 1,
        source: row.source,
        assignedQuantity,
      },
    }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export type LocalSeatCapacityGuard =
  | { kind: "local-only" }
  | {
      kind: "snapshot"
      expectedRevision: number
      subscriptionId: string
      subscriptionItemId: string
      minimumQuantity: number
    }
  | {
      kind: "live"
      expectedRevision: number
      subscriptionId: string
      subscriptionItemId: string
      minimumQuantity: number
      liveQuantity: number
    }

type WriteLocalOrgSeatAssignmentArgs = LeaseFence & {
  login: string
  assigned: boolean
  targetIsAdmin: boolean
  actorLogin: string
  nowIso: string
  capacity: LocalSeatCapacityGuard
}

function validCapacityGuard(value: LocalSeatCapacityGuard): boolean {
  if (value.kind === "local-only") return true
  return (
    nonNegativeInteger(value.expectedRevision) &&
    nonEmpty(value.subscriptionId) &&
    nonEmpty(value.subscriptionItemId) &&
    nonNegativeInteger(value.minimumQuantity) &&
    (value.kind !== "live" || nonNegativeInteger(value.liveQuantity))
  )
}

function localSeatWriteCondition(value: WriteLocalOrgSeatAssignmentArgs): {
  sql: string
  bindings: readonly unknown[]
} {
  const noActiveOperation = `NOT EXISTS (
    SELECT 1 FROM org_seat_billing_operation
     WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')
  )`
  if (value.capacity.kind === "local-only") {
    return { sql: noActiveOperation, bindings: [value.installationId] }
  }
  const snapshotState = value.capacity.kind === "live" ? "('ready', 'review_required')" : "('ready')"
  const livePredicate =
    value.capacity.kind === "live"
      ? "AND ? >= observed_quantity AND ? >= ?"
      : "AND observed_quantity = derived_quantity AND observed_quantity >= ?"
  const liveBindings =
    value.capacity.kind === "live"
      ? [value.capacity.liveQuantity, value.capacity.liveQuantity, value.capacity.minimumQuantity]
      : [value.capacity.minimumQuantity]
  return {
    sql: `${noActiveOperation} AND EXISTS (
      SELECT 1 FROM stripe_seat_subscription
       WHERE installation_id = ? AND revision = ?
         AND stripe_subscription_id = ? AND stripe_subscription_item_id = ?
         AND subscription_status IN ('active', 'trialing')
         AND snapshot_state IN ${snapshotState} AND observed_quantity IS NOT NULL
         ${livePredicate}
    )`,
    bindings: [
      value.installationId,
      value.installationId,
      value.capacity.expectedRevision,
      value.capacity.subscriptionId,
      value.capacity.subscriptionItemId,
      ...liveBindings,
    ],
  }
}

export async function writeLocalOrgSeatAssignment(
  env: DbEnv,
  args: WriteLocalOrgSeatAssignmentArgs,
): Promise<
  | { kind: "written"; snapshotRevision: number | null }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "unavailable" }
> {
  const login = normalizeLogin(args.login)
  const actorLogin = normalizeLogin(args.actorLogin)
  if (
    !validLeaseFence(args) ||
    !nonEmpty(login) ||
    !nonEmpty(actorLogin) ||
    !nonEmpty(args.nowIso) ||
    !validCapacityGuard(args.capacity)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  const condition = localSeatWriteCondition(args)
  try {
    if (!(await guardedConditionMatches(db, args, condition.sql, condition.bindings))) {
      return { kind: "conflict" }
    }
    const statements: D1PreparedStatement[] = [exactBatchGuard(db, args, condition.sql, condition.bindings)]
    statements.push(
      db
        .prepare(
          `INSERT INTO org_seat_assignment
             (installation_id, login, assigned, is_admin, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(installation_id, login) DO UPDATE SET
             assigned = excluded.assigned,
             is_admin = MAX(org_seat_assignment.is_admin, excluded.is_admin),
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(args.installationId, login, args.assigned ? 1 : 0, args.targetIsAdmin ? 1 : 0, args.nowIso, actorLogin),
    )
    if (args.capacity.kind === "live") {
      statements.push(
        db
          .prepare(
            `UPDATE stripe_seat_subscription SET
               observed_quantity = ?, derived_quantity = ?, revision = ?, snapshot_state = 'ready',
               block_reason = NULL, last_refreshed_at_ms = ?, updated_at_ms = ?
             WHERE installation_id = ? AND revision = ?
               AND stripe_subscription_id = ? AND stripe_subscription_item_id = ?
               AND subscription_status IN ('active', 'trialing')
               AND snapshot_state IN ('ready', 'review_required')
               AND observed_quantity IS NOT NULL AND ? >= observed_quantity AND ? >= ?`,
          )
          .bind(
            args.capacity.liveQuantity,
            args.capacity.liveQuantity,
            args.capacity.expectedRevision + 1,
            args.nowMs,
            args.nowMs,
            args.installationId,
            args.capacity.expectedRevision,
            args.capacity.subscriptionId,
            args.capacity.subscriptionItemId,
            args.capacity.liveQuantity,
            args.capacity.liveQuantity,
            args.capacity.minimumQuantity,
          ),
      )
    }
    const results = await db.batch(statements)
    if (results.slice(1).some((result) => (result.meta.changes ?? 0) !== 1)) return { kind: "conflict" }
    return {
      kind: "written",
      snapshotRevision:
        args.capacity.kind === "local-only"
          ? null
          : args.capacity.expectedRevision + (args.capacity.kind === "live" ? 1 : 0),
    }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

type CreatePendingOrgSeatExpansionArgs = LeaseFence & {
  operationId: string
  idempotencyKey: string
  login: string
  actorLogin: string
  targetIsAdmin: boolean
  expectedAssignedQuantity: number
  desiredQuantity: number
  expectedSnapshotRevision: number
  subscriptionId: string
  subscriptionItemId: string
  nextAttemptAtMs: number
}

function exactExpansionRetry(operation: OrgSeatBillingOperation, args: CreatePendingOrgSeatExpansionArgs): boolean {
  return (
    operation.operationId === args.operationId &&
    operation.installationId === args.installationId &&
    operation.login === normalizeLogin(args.login) &&
    operation.actorLogin === normalizeLogin(args.actorLogin) &&
    operation.targetIsAdmin === args.targetIsAdmin &&
    operation.requestedAssigned &&
    !operation.previousAssigned &&
    operation.desiredQuantity === args.desiredQuantity &&
    operation.stripeSubscriptionId === args.subscriptionId &&
    operation.stripeSubscriptionItemId === args.subscriptionItemId &&
    operation.idempotencyKey === args.idempotencyKey
  )
}

async function readOperationByIdentity(
  db: D1Database,
  operationId: string,
  idempotencyKey: string,
): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "ok"; operation: OrgSeatBillingOperation }> {
  const rows = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS} FROM org_seat_billing_operation
        WHERE operation_id = ? OR idempotency_key = ?`,
    )
    .bind(operationId, idempotencyKey)
    .all<Record<string, unknown>>()
  if (rows.results.length === 0) return { kind: "missing" }
  if (rows.results.length !== 1) return { kind: "invalid" }
  const operation = decodeOrgSeatBillingOperationRow(rows.results[0])
  return operation ? { kind: "ok", operation } : { kind: "invalid" }
}

export async function createPendingOrgSeatExpansion(
  env: DbEnv,
  args: CreatePendingOrgSeatExpansionArgs,
): Promise<
  | { kind: "created" | "existing"; operation: OrgSeatBillingOperation }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  const login = normalizeLogin(args.login)
  const actorLogin = normalizeLogin(args.actorLogin)
  if (
    !validLeaseFence(args) ||
    !nonEmpty(args.operationId) ||
    !nonEmpty(args.idempotencyKey) ||
    !nonEmpty(login) ||
    !nonEmpty(actorLogin) ||
    !nonNegativeInteger(args.expectedAssignedQuantity) ||
    !nonNegativeInteger(args.desiredQuantity) ||
    args.desiredQuantity <= args.expectedAssignedQuantity ||
    !nonNegativeInteger(args.expectedSnapshotRevision) ||
    !nonEmpty(args.subscriptionId) ||
    !nonEmpty(args.subscriptionItemId) ||
    !nonNegativeInteger(args.nextAttemptAtMs)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    if (!(await exactLeaseExists(db, args))) return { kind: "conflict" }
    const prior = await readOperationByIdentity(db, args.operationId, args.idempotencyKey)
    if (prior.kind === "invalid") return { kind: "error", reason: "invalid_row" }
    if (prior.kind === "ok") {
      return exactExpansionRetry(prior.operation, args)
        ? { kind: "existing", operation: prior.operation }
        : { kind: "conflict" }
    }

    // Snapshot and operation revisions intentionally share one installation-
    // scoped generation. Allocating above BOTH clocks lets the eventual atomic
    // commit invalidate any provider snapshot read that predated this intent.
    const result = await db
      .prepare(
        `WITH ${EFFECTIVE_SEAT_CTES}, seat_state AS (
           SELECT COALESCE(SUM(assigned), 0) AS assigned_quantity,
                  COALESCE(MAX(CASE WHEN login = ? THEN assigned END), 0) AS target_assigned,
                  (SELECT COUNT(*) FROM overrides WHERE row_count > 1) AS duplicate_count,
                  (SELECT COALESCE(SUM(invalid_count), 0) FROM overrides) AS invalid_count
             FROM effective
         )
         INSERT OR IGNORE INTO org_seat_billing_operation
           (operation_id, installation_id, revision, login, actor_login, target_is_admin,
            requested_assigned, previous_assigned, desired_quantity, state,
            stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
            idempotency_key, attempts, error_code, next_attempt_at_ms, created_at_ms,
            updated_at_ms, stripe_applied_at_ms, completed_at_ms)
         SELECT ?, ?, MAX(snapshot.revision, COALESCE((
                    SELECT MAX(revision) FROM org_seat_billing_operation WHERE installation_id = ?
                  ), 0)) + 1,
                ?, ?, ?, 1, 0, ?, 'pending', ?, ?, snapshot.observed_quantity,
                ?, 0, NULL, ?, ?, ?, NULL, NULL
           FROM stripe_seat_subscription AS snapshot CROSS JOIN seat_state
          WHERE snapshot.installation_id = ? AND snapshot.revision = ?
            AND snapshot.stripe_subscription_id = ? AND snapshot.stripe_subscription_item_id = ?
            AND snapshot.subscription_status IN ('active', 'trialing')
            AND snapshot.snapshot_state = 'ready'
            AND snapshot.observed_quantity IS NOT NULL
            AND snapshot.observed_quantity = snapshot.derived_quantity
            AND seat_state.assigned_quantity = ? AND seat_state.target_assigned = 0
            AND seat_state.duplicate_count = 0 AND seat_state.invalid_count = 0
            AND ? > snapshot.observed_quantity AND ? >= seat_state.assigned_quantity + 1
            AND NOT EXISTS (
              SELECT 1 FROM org_seat_billing_operation
               WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')
            )
            AND EXISTS (
              SELECT 1 FROM org_seat_billing_lease
               WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
            )`,
      )
      .bind(
        args.installationId,
        args.installationId,
        login,
        args.operationId,
        args.installationId,
        args.installationId,
        login,
        actorLogin,
        args.targetIsAdmin ? 1 : 0,
        args.desiredQuantity,
        args.subscriptionId,
        args.subscriptionItemId,
        args.idempotencyKey,
        args.nextAttemptAtMs,
        args.nowMs,
        args.nowMs,
        args.installationId,
        args.expectedSnapshotRevision,
        args.subscriptionId,
        args.subscriptionItemId,
        args.expectedAssignedQuantity,
        args.desiredQuantity,
        args.desiredQuantity,
        args.installationId,
        args.installationId,
        args.leaseToken,
        args.leaseAcquiredAtMs,
        args.nowMs,
      )
      .run()
    const stored = await readOperationByIdentity(db, args.operationId, args.idempotencyKey)
    if (stored.kind === "invalid") return { kind: "error", reason: "invalid_row" }
    if (stored.kind === "missing" || !exactExpansionRetry(stored.operation, args)) return { kind: "conflict" }
    return (result.meta.changes ?? 0) === 1
      ? { kind: "created", operation: stored.operation }
      : { kind: "existing", operation: stored.operation }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function markOrgSeatExpansionStripeApplied(
  env: DbEnv,
  args: LeaseFence & {
    operationId: string
    revision: number
    stripeObservedQuantity: number
    nextAttemptAtMs: number
  },
): Promise<{ kind: "written" } | { kind: "conflict" } | { kind: "error"; reason: "invalid_input" | "unavailable" }> {
  if (
    !validLeaseFence(args) ||
    !nonEmpty(args.operationId) ||
    !Number.isSafeInteger(args.revision) ||
    args.revision <= 0 ||
    !nonNegativeInteger(args.stripeObservedQuantity) ||
    !nonNegativeInteger(args.nextAttemptAtMs)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const result = await env.SIGILIX_PLATFORM_DB.prepare(
      `UPDATE org_seat_billing_operation SET
         state = 'stripe_applied', stripe_observed_quantity = desired_quantity, attempts = attempts + 1,
         error_code = NULL, next_attempt_at_ms = ?, updated_at_ms = ?, stripe_applied_at_ms = ?
       WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = 'pending'
         AND desired_quantity <= ? AND actor_login IS NOT NULL AND target_is_admin IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM org_seat_billing_lease
            WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
         )`,
    )
      .bind(
        args.nextAttemptAtMs,
        args.nowMs,
        args.nowMs,
        args.installationId,
        args.operationId,
        args.revision,
        args.stripeObservedQuantity,
        args.installationId,
        args.leaseToken,
        args.leaseAcquiredAtMs,
        args.nowMs,
      )
      .run()
    return (result.meta.changes ?? 0) === 1 ? { kind: "written" } : { kind: "conflict" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

function commitExpansionCondition(args: {
  installationId: number
  operationId: string
  revision: number
  providerQuantity: number
}): {
  sql: string
  bindings: readonly unknown[]
} {
  return {
    sql: `EXISTS (
      SELECT 1
        FROM org_seat_billing_operation AS operation
        JOIN stripe_seat_subscription AS snapshot
          ON snapshot.installation_id = operation.installation_id
       WHERE operation.installation_id = ? AND operation.operation_id = ? AND operation.revision = ?
         AND operation.state = 'stripe_applied'
         AND operation.requested_assigned = 1 AND operation.previous_assigned = 0
         AND operation.stripe_observed_quantity = operation.desired_quantity
         AND ? >= operation.desired_quantity
         AND operation.actor_login IS NOT NULL AND operation.target_is_admin IS NOT NULL
         AND snapshot.stripe_subscription_id = operation.stripe_subscription_id
         AND snapshot.stripe_subscription_item_id = operation.stripe_subscription_item_id
         AND snapshot.subscription_status IN ('active', 'trialing')
         AND snapshot.snapshot_state IN ('ready', 'review_required')
         AND snapshot.observed_quantity IS NOT NULL
    )`,
    bindings: [args.installationId, args.operationId, args.revision, args.providerQuantity],
  }
}

export async function commitOrgSeatExpansion(
  env: DbEnv,
  args: LeaseFence & { operationId: string; revision: number; providerQuantity: number; nowIso: string },
): Promise<
  | { kind: "committed"; snapshotRevision: number; quantity: number }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (
    !validLeaseFence(args) ||
    !nonEmpty(args.operationId) ||
    !Number.isSafeInteger(args.revision) ||
    args.revision <= 0 ||
    !nonNegativeInteger(args.providerQuantity) ||
    !nonEmpty(args.nowIso)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  const condition = commitExpansionCondition(args)
  try {
    if (!(await guardedConditionMatches(db, args, condition.sql, condition.bindings))) {
      return { kind: "conflict" }
    }
    // The operation revision was allocated above both the snapshot revision
    // and prior operation history. Promoting the snapshot to that generation
    // is a real snapshot mutation, not a mix of independent revision clocks.
    const results = await db.batch([
      exactBatchGuard(db, args, condition.sql, condition.bindings),
      db
        .prepare(
          `INSERT INTO org_seat_assignment
             (installation_id, login, assigned, is_admin, updated_at, updated_by)
           SELECT installation_id, login, 1, target_is_admin, ?, actor_login
             FROM org_seat_billing_operation
            WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = 'stripe_applied'
           ON CONFLICT(installation_id, login) DO UPDATE SET
             assigned = 1,
             is_admin = MAX(org_seat_assignment.is_admin, excluded.is_admin),
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(args.nowIso, args.installationId, args.operationId, args.revision),
      db
        .prepare(
          `UPDATE stripe_seat_subscription SET
             observed_quantity = MAX(observed_quantity, ?),
             derived_quantity = MAX(observed_quantity, ?),
             revision = MAX(revision, ?), snapshot_state = 'ready', block_reason = NULL,
             last_refreshed_at_ms = MAX(COALESCE(last_refreshed_at_ms, 0), ?),
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE installation_id = ? AND EXISTS (
             SELECT 1 FROM org_seat_billing_operation
              WHERE installation_id = ? AND operation_id = ? AND revision = ?
                AND state = 'stripe_applied'
                AND stripe_subscription_id = stripe_seat_subscription.stripe_subscription_id
                AND stripe_subscription_item_id = stripe_seat_subscription.stripe_subscription_item_id
           )`,
        )
        .bind(
          args.providerQuantity,
          args.providerQuantity,
          args.revision,
          args.nowMs,
          args.nowMs,
          args.installationId,
          args.installationId,
          args.operationId,
          args.revision,
        ),
      db
        .prepare(
          `UPDATE org_seat_billing_operation SET
             state = 'committed', error_code = NULL, next_attempt_at_ms = NULL,
             updated_at_ms = ?, completed_at_ms = ?
           WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = 'stripe_applied'`,
        )
        .bind(args.nowMs, args.nowMs, args.installationId, args.operationId, args.revision),
    ])
    if (results.slice(1).some((result) => (result.meta.changes ?? 0) !== 1)) return { kind: "conflict" }
    const snapshotResult = await readStripeSeatSubscription(env, args.installationId)
    if (snapshotResult.kind !== "ok") {
      return snapshotResult.kind === "error"
        ? { kind: "error", reason: snapshotResult.reason === "unavailable" ? "unavailable" : "invalid_row" }
        : { kind: "error", reason: "invalid_row" }
    }
    return {
      kind: "committed",
      snapshotRevision: snapshotResult.snapshot.revision,
      quantity: snapshotResult.snapshot.derivedQuantity,
    }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export type CancelActiveOrgSeatBillingOperationArgs = LeaseFence & {
  operationId: string
  revision: number
  expectedState: ActiveOperationState
  errorCode: string
  actorLogin: string
  nowIso: string
}

function cancelOperationCondition(args: CancelActiveOrgSeatBillingOperationArgs): {
  sql: string
  bindings: readonly unknown[]
} {
  const snapshotPredicate =
    args.expectedState === "stripe_applied"
      ? `AND EXISTS (
          SELECT 1 FROM stripe_seat_subscription AS snapshot
           WHERE snapshot.installation_id = operation.installation_id
             AND snapshot.stripe_subscription_id = operation.stripe_subscription_id
             AND snapshot.stripe_subscription_item_id = operation.stripe_subscription_item_id
             AND snapshot.subscription_status IN ('active', 'trialing')
             AND snapshot.snapshot_state IN ('ready', 'review_required')
             AND snapshot.observed_quantity IS NOT NULL
        )`
      : ""
  return {
    sql: `EXISTS (
      SELECT 1 FROM org_seat_billing_operation AS operation
       WHERE operation.installation_id = ? AND operation.operation_id = ? AND operation.revision = ?
         AND operation.state = ? AND operation.requested_assigned = 1 AND operation.previous_assigned = 0
         AND operation.actor_login IS NOT NULL AND operation.target_is_admin IS NOT NULL
         ${snapshotPredicate}
    )`,
    bindings: [args.installationId, args.operationId, args.revision, args.expectedState],
  }
}

export function prepareCancelActiveOrgSeatBillingOperation(
  db: D1Database,
  args: CancelActiveOrgSeatBillingOperationArgs,
):
  | { kind: "prepared"; terminalState: "canceled" | "committed"; statements: D1PreparedStatement[] }
  | { kind: "error"; reason: "invalid_input" } {
  const actorLogin = normalizeLogin(args.actorLogin)
  if (
    !validLeaseFence(args) ||
    !nonEmpty(args.operationId) ||
    !Number.isSafeInteger(args.revision) ||
    args.revision <= 0 ||
    !isActiveOperationState(args.expectedState) ||
    !nonEmpty(args.errorCode) ||
    !nonEmpty(actorLogin) ||
    !nonEmpty(args.nowIso)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  const condition = cancelOperationCondition(args)
  const statements: D1PreparedStatement[] = [exactBatchGuard(db, args, condition.sql, condition.bindings)]
  statements.push(
    db
      .prepare(
        `INSERT INTO org_seat_assignment
           (installation_id, login, assigned, is_admin, updated_at, updated_by)
         SELECT installation_id, login, 0, 0, ?, ?
           FROM org_seat_billing_operation
          WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = ?
         ON CONFLICT(installation_id, login) DO UPDATE SET
           assigned = 0, is_admin = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(args.nowIso, actorLogin, args.installationId, args.operationId, args.revision, args.expectedState),
  )
  if (args.expectedState === "stripe_applied") {
    // See commitOrgSeatExpansion: the operation revision is the next shared
    // snapshot/operation generation and invalidates stale provider reads.
    statements.push(
      db
        .prepare(
          `UPDATE stripe_seat_subscription SET
             observed_quantity = MAX(observed_quantity, (
               SELECT desired_quantity FROM org_seat_billing_operation
                WHERE installation_id = ? AND operation_id = ? AND revision = ?
             )),
             derived_quantity = MAX(observed_quantity, (
               SELECT desired_quantity FROM org_seat_billing_operation
                WHERE installation_id = ? AND operation_id = ? AND revision = ?
             )),
             revision = MAX(revision, ?), snapshot_state = 'ready', block_reason = NULL,
             last_refreshed_at_ms = MAX(COALESCE(last_refreshed_at_ms, 0), ?),
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE installation_id = ? AND EXISTS (
             SELECT 1 FROM org_seat_billing_operation
              WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = 'stripe_applied'
                AND stripe_subscription_id = stripe_seat_subscription.stripe_subscription_id
                AND stripe_subscription_item_id = stripe_seat_subscription.stripe_subscription_item_id
           )`,
        )
        .bind(
          args.installationId,
          args.operationId,
          args.revision,
          args.installationId,
          args.operationId,
          args.revision,
          args.revision,
          args.nowMs,
          args.nowMs,
          args.installationId,
          args.installationId,
          args.operationId,
          args.revision,
        ),
    )
  }
  statements.push(
    args.expectedState === "pending"
      ? db
          .prepare(
            `UPDATE org_seat_billing_operation SET
               state = 'canceled', error_code = ?, next_attempt_at_ms = NULL,
               updated_at_ms = ?, completed_at_ms = ?
             WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = 'pending'`,
          )
          .bind(args.errorCode.trim(), args.nowMs, args.nowMs, args.installationId, args.operationId, args.revision)
      : db
          .prepare(
            `UPDATE org_seat_billing_operation SET
               state = 'committed', error_code = NULL, next_attempt_at_ms = NULL,
               updated_at_ms = ?, completed_at_ms = ?
             WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = 'stripe_applied'`,
          )
          .bind(args.nowMs, args.nowMs, args.installationId, args.operationId, args.revision),
  )
  return {
    kind: "prepared",
    terminalState: args.expectedState === "pending" ? "canceled" : "committed",
    statements,
  }
}

export async function cancelActiveOrgSeatBillingOperation(
  env: DbEnv,
  args: CancelActiveOrgSeatBillingOperationArgs,
): Promise<
  | { kind: "settled"; terminalState: "canceled" | "committed" }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "unavailable" }
> {
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const prepared = prepareCancelActiveOrgSeatBillingOperation(env.SIGILIX_PLATFORM_DB, args)
  if (prepared.kind === "error") return prepared
  const condition = cancelOperationCondition(args)
  try {
    if (!(await guardedConditionMatches(env.SIGILIX_PLATFORM_DB, args, condition.sql, condition.bindings))) {
      return { kind: "conflict" }
    }
    const results = await env.SIGILIX_PLATFORM_DB.batch(prepared.statements)
    if (results.slice(1).some((result) => (result.meta.changes ?? 0) !== 1)) return { kind: "conflict" }
    return { kind: "settled", terminalState: prepared.terminalState }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function deferOrgSeatBillingOperation(
  env: DbEnv,
  args: LeaseFence & {
    operationId: string
    revision: number
    expectedState: ActiveOperationState
    errorCode: string
  },
): Promise<
  | { kind: "deferred"; attempts: number; nextAttemptAtMs: number }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (
    !validLeaseFence(args) ||
    !nonEmpty(args.operationId) ||
    !Number.isSafeInteger(args.revision) ||
    args.revision <= 0 ||
    !isActiveOperationState(args.expectedState) ||
    !nonEmpty(args.errorCode)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    if (!(await exactLeaseExists(db, args))) return { kind: "conflict" }
    const row = await db
      .prepare(
        `SELECT ${OPERATION_COLUMNS} FROM org_seat_billing_operation
          WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = ?
            AND actor_login IS NOT NULL AND target_is_admin IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM org_seat_billing_lease
               WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
            )`,
      )
      .bind(
        args.installationId,
        args.operationId,
        args.revision,
        args.expectedState,
        args.installationId,
        args.leaseToken,
        args.leaseAcquiredAtMs,
        args.nowMs,
      )
      .first<Record<string, unknown>>()
    if (row === null) return { kind: "conflict" }
    const operation = decodeOrgSeatBillingOperationRow(row)
    if (!operation) return { kind: "error", reason: "invalid_row" }
    const attempts = operation.attempts + 1
    if (!Number.isSafeInteger(attempts)) return { kind: "error", reason: "invalid_row" }
    const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(operation.attempts, 30))
    const nextAttemptAtMs = args.nowMs + delay
    if (!Number.isSafeInteger(nextAttemptAtMs)) return { kind: "error", reason: "invalid_input" }
    const result = await db
      .prepare(
        `UPDATE org_seat_billing_operation SET
           attempts = ?, error_code = ?, next_attempt_at_ms = ?, updated_at_ms = ?
         WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = ? AND attempts = ?
           AND actor_login IS NOT NULL AND target_is_admin IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM org_seat_billing_lease
              WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
           )`,
      )
      .bind(
        attempts,
        args.errorCode.trim(),
        nextAttemptAtMs,
        args.nowMs,
        args.installationId,
        args.operationId,
        args.revision,
        args.expectedState,
        operation.attempts,
        args.installationId,
        args.leaseToken,
        args.leaseAcquiredAtMs,
        args.nowMs,
      )
      .run()
    return (result.meta.changes ?? 0) === 1 ? { kind: "deferred", attempts, nextAttemptAtMs } : { kind: "conflict" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function listDueOrgSeatBillingOperations(
  env: DbEnv,
  args: { nowMs: number; limit: number },
): Promise<
  | { kind: "ok"; operations: OrgSeatBillingOperation[] }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (!nonNegativeInteger(args.nowMs) || !Number.isSafeInteger(args.limit) || args.limit <= 0) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const rows = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT ${OPERATION_COLUMNS} FROM org_seat_billing_operation
        WHERE state IN ('pending', 'stripe_applied') AND next_attempt_at_ms <= ?
        ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, operation_id ASC
        LIMIT ?`,
    )
      .bind(args.nowMs, Math.min(args.limit, MAX_DUE_OPERATIONS))
      .all<Record<string, unknown>>()
    const operations = rows.results.map(decodeOrgSeatBillingOperationRow)
    return operations.some((operation) => operation === null)
      ? { kind: "error", reason: "invalid_row" }
      : { kind: "ok", operations: operations as OrgSeatBillingOperation[] }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}
