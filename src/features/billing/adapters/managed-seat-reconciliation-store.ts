import {
  decodeOrgSeatBillingOperationRow,
  type OrgSeatBillingOperation,
} from "@/src/features/billing/domain/seat-reconciliation"
import type { Env } from "@/src/shared/types/env"
import { readStripeSeatSubscription, type LocalSeatCapacityGuard } from "./d1-seat-reconciliation-store"

type DbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

type LeaseFence = {
  installationId: number
  leaseToken: string
  leaseAcquiredAtMs: number
  nowMs: number
}

type ActiveOperationState = "pending" | "stripe_applied"

const OPERATION_COLUMNS = `operation_id, installation_id, revision, login, target_identity_kind,
  target_github_user_id, activity_actor_github_user_id, actor_login, target_is_admin,
  requested_assigned, previous_assigned,
  desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
  stripe_observed_quantity, idempotency_key, attempts, error_code, next_attempt_at_ms,
  created_at_ms, updated_at_ms, stripe_applied_at_ms, completed_at_ms`

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0")
}

function validGithubUserId(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

function normalizeActorLogin(value: string): string {
  return value.trim().toLowerCase()
}

function displayLogin(value: string): string {
  return value.trim()
}

function validLeaseFence(value: LeaseFence): boolean {
  return (
    validInstallationId(value.installationId) &&
    nonEmpty(value.leaseToken) &&
    nonNegativeInteger(value.leaseAcquiredAtMs) &&
    nonNegativeInteger(value.nowMs)
  )
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

function exactManagedBatchGuard(
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
       '__managed_seat_batch_guard__', 0, 1
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

export type ManagedOrgSeatAssignment = {
  installationId: number
  githubUserId: string
  assigned: boolean
  role: "admin" | "member"
  lastKnownLogin: string | null
  source: "canonical" | "missing"
  assignedQuantity: number
}

export async function readManagedOrgSeatAssignment(
  env: DbEnv,
  args: LeaseFence & { githubUserId: string },
): Promise<
  | { kind: "ok"; assignment: ManagedOrgSeatAssignment }
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (!validLeaseFence(args) || !validGithubUserId(args.githubUserId)) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      `WITH target_access AS (
         SELECT role FROM org_workspace_access
          WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NULL
       ), assigned_active AS (
         SELECT assignment.github_user_id
           FROM org_workspace_seat_assignment AS assignment
           JOIN org_workspace_access AS access
             ON access.installation_id = assignment.installation_id
            AND access.github_user_id = assignment.github_user_id
          WHERE assignment.installation_id = ? AND assignment.assigned = 1
            AND access.revoked_at IS NULL
       )
       SELECT
         (SELECT COUNT(*) FROM tenant WHERE installation_id = ?) AS tenant_count,
         (SELECT COUNT(*) FROM org_seat_billing_lease
           WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?) AS lease_count,
         (SELECT COUNT(*) FROM target_access) AS access_count,
         (SELECT role FROM target_access) AS role,
         COALESCE((SELECT assigned FROM org_workspace_seat_assignment
           WHERE installation_id = ? AND github_user_id = ?), 0) AS assigned,
         (SELECT last_known_login FROM org_workspace_seat_assignment
           WHERE installation_id = ? AND github_user_id = ?) AS last_known_login,
         CASE WHEN EXISTS (
           SELECT 1 FROM org_workspace_seat_assignment
            WHERE installation_id = ? AND github_user_id = ?
         ) THEN 'canonical' ELSE 'missing' END AS source,
         (SELECT COUNT(*) FROM assigned_active) AS assigned_quantity`,
    )
      .bind(
        args.installationId,
        args.githubUserId,
        args.installationId,
        args.installationId,
        args.installationId,
        args.leaseToken,
        args.leaseAcquiredAtMs,
        args.nowMs,
        args.installationId,
        args.githubUserId,
        args.installationId,
        args.githubUserId,
        args.installationId,
        args.githubUserId,
      )
      .first<{
        tenant_count: unknown
        lease_count: unknown
        access_count: unknown
        role: unknown
        assigned: unknown
        last_known_login: unknown
        source: unknown
        assigned_quantity: unknown
      }>()
    if (row === null) return { kind: "error", reason: "invalid_row" }
    if (Number(row.lease_count) !== 1) return { kind: "conflict" }
    if (Number(row.tenant_count) === 0 || Number(row.access_count) === 0) return { kind: "missing" }
    const assignedQuantity = Number(row.assigned_quantity)
    if (
      Number(row.access_count) !== 1 ||
      (row.role !== "admin" && row.role !== "member") ||
      (row.assigned !== 0 && row.assigned !== 1) ||
      (row.source !== "canonical" && row.source !== "missing") ||
      (row.last_known_login !== null &&
        (typeof row.last_known_login !== "string" || !nonEmpty(row.last_known_login))) ||
      !nonNegativeInteger(assignedQuantity)
    ) {
      return { kind: "error", reason: "invalid_row" }
    }
    return {
      kind: "ok",
      assignment: {
        installationId: args.installationId,
        githubUserId: args.githubUserId,
        assigned: row.assigned === 1,
        role: row.role,
        lastKnownLogin: row.last_known_login as string | null,
        source: row.source,
        assignedQuantity,
      },
    }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export async function deriveManagedBillableSeatQuantity(
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
      `SELECT
         (SELECT COUNT(*) FROM tenant WHERE installation_id = ?) AS tenant_count,
         COUNT(*) AS quantity
       FROM org_workspace_seat_assignment AS assignment
       JOIN org_workspace_access AS access
         ON access.installation_id = assignment.installation_id
        AND access.github_user_id = assignment.github_user_id
       WHERE assignment.installation_id = ? AND assignment.assigned = 1
         AND access.revoked_at IS NULL`,
    )
      .bind(installationId, installationId)
      .first<{ tenant_count: unknown; quantity: unknown }>()
    if (Number(row?.tenant_count) === 0) return { kind: "missing" }
    const quantity = Number(row?.quantity)
    return nonNegativeInteger(quantity) ? { kind: "ok", quantity } : { kind: "error", reason: "invalid_row" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

type WriteLocalManagedOrgSeatAssignmentArgs = LeaseFence & {
  githubUserId: string
  lastKnownLogin: string
  assigned: boolean
  actorLogin: string
  nowIso: string
  capacity: LocalSeatCapacityGuard
}

function managedLocalWriteCondition(value: WriteLocalManagedOrgSeatAssignmentArgs): {
  sql: string
  bindings: readonly unknown[]
} {
  const baseSql = `NOT EXISTS (
    SELECT 1 FROM org_seat_billing_operation
     WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')
  ) AND EXISTS (
    SELECT 1 FROM org_workspace_access AS target
     WHERE target.installation_id = ? AND target.github_user_id = ? AND target.revoked_at IS NULL
       AND (
         ? = 1 OR target.role <> 'admin'
         OR COALESCE((SELECT assigned FROM org_workspace_seat_assignment
                       WHERE installation_id = ? AND github_user_id = ?), 0) = 0
         OR EXISTS (
           SELECT 1 FROM org_workspace_seat_assignment AS other_assignment
           JOIN org_workspace_access AS other_access
             ON other_access.installation_id = other_assignment.installation_id
            AND other_access.github_user_id = other_assignment.github_user_id
          WHERE other_assignment.installation_id = ? AND other_assignment.assigned = 1
            AND other_access.revoked_at IS NULL AND other_access.role = 'admin'
            AND other_assignment.github_user_id <> ?
         )
       )
  )`
  const baseBindings = [
    value.installationId,
    value.installationId,
    value.githubUserId,
    value.assigned ? 1 : 0,
    value.installationId,
    value.githubUserId,
    value.installationId,
    value.githubUserId,
  ]
  if (value.capacity.kind === "local-only") return { sql: baseSql, bindings: baseBindings }
  const snapshotState = value.capacity.kind === "live" ? "('ready', 'review_required')" : "('ready')"
  const capacitySql =
    value.capacity.kind === "live"
      ? "AND ? >= observed_quantity AND ? >= ?"
      : "AND observed_quantity = derived_quantity AND observed_quantity >= ?"
  const capacityBindings =
    value.capacity.kind === "live"
      ? [value.capacity.liveQuantity, value.capacity.liveQuantity, value.capacity.minimumQuantity]
      : [value.capacity.minimumQuantity]
  return {
    sql: `${baseSql} AND EXISTS (
      SELECT 1 FROM stripe_seat_subscription
       WHERE installation_id = ? AND revision = ?
         AND stripe_subscription_id = ? AND stripe_subscription_item_id = ?
         AND subscription_status IN ('active', 'trialing')
         AND snapshot_state IN ${snapshotState} AND observed_quantity IS NOT NULL
         ${capacitySql}
    )`,
    bindings: [
      ...baseBindings,
      value.installationId,
      value.capacity.expectedRevision,
      value.capacity.subscriptionId,
      value.capacity.subscriptionItemId,
      ...capacityBindings,
    ],
  }
}

async function isLastAssignedActiveAdmin(db: D1Database, args: WriteLocalManagedOrgSeatAssignmentArgs) {
  if (args.assigned) return false
  const row = await db
    .prepare(
      `SELECT 1 AS matched
        WHERE EXISTS (
          SELECT 1 FROM org_seat_billing_lease
           WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
        ) AND EXISTS (
          SELECT 1 FROM org_workspace_seat_assignment AS target_assignment
          JOIN org_workspace_access AS target_access
            ON target_access.installation_id = target_assignment.installation_id
           AND target_access.github_user_id = target_assignment.github_user_id
         WHERE target_assignment.installation_id = ? AND target_assignment.github_user_id = ?
           AND target_assignment.assigned = 1 AND target_access.revoked_at IS NULL
           AND target_access.role = 'admin'
           AND NOT EXISTS (
             SELECT 1 FROM org_workspace_seat_assignment AS other_assignment
             JOIN org_workspace_access AS other_access
               ON other_access.installation_id = other_assignment.installation_id
              AND other_access.github_user_id = other_assignment.github_user_id
            WHERE other_assignment.installation_id = target_assignment.installation_id
              AND other_assignment.github_user_id <> target_assignment.github_user_id
              AND other_assignment.assigned = 1 AND other_access.revoked_at IS NULL
              AND other_access.role = 'admin'
           )
        )`,
    )
    .bind(
      args.installationId,
      args.leaseToken,
      args.leaseAcquiredAtMs,
      args.nowMs,
      args.installationId,
      args.githubUserId,
    )
    .first<{ matched: unknown }>()
  return row?.matched === 1
}

export async function writeLocalManagedOrgSeatAssignment(
  env: DbEnv,
  args: WriteLocalManagedOrgSeatAssignmentArgs,
): Promise<
  | { kind: "written"; snapshotRevision: number | null }
  | { kind: "last_admin" }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "unavailable" }
> {
  const login = displayLogin(args.lastKnownLogin)
  const actorLogin = normalizeActorLogin(args.actorLogin)
  if (
    !validLeaseFence(args) ||
    !validGithubUserId(args.githubUserId) ||
    !nonEmpty(login) ||
    !nonEmpty(actorLogin) ||
    !nonEmpty(args.nowIso) ||
    !validCapacityGuard(args.capacity)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  const condition = managedLocalWriteCondition(args)
  try {
    if (!(await guardedConditionMatches(db, args, condition.sql, condition.bindings))) {
      return (await isLastAssignedActiveAdmin(db, args)) ? { kind: "last_admin" } : { kind: "conflict" }
    }
    const statements: D1PreparedStatement[] = [exactManagedBatchGuard(db, args, condition.sql, condition.bindings)]
    statements.push(
      db
        .prepare(
          `INSERT INTO org_workspace_seat_assignment
             (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
           SELECT ?, ?, ?, ?, ?, ?, ?
             FROM org_workspace_access
            WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NULL
           ON CONFLICT(installation_id, github_user_id) DO UPDATE SET
             assigned = excluded.assigned, last_known_login = excluded.last_known_login,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(
          args.installationId,
          args.githubUserId,
          args.assigned ? 1 : 0,
          login,
          args.nowIso,
          args.nowIso,
          actorLogin,
          args.installationId,
          args.githubUserId,
        ),
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
    try {
      if (!(await guardedConditionMatches(db, args, condition.sql, condition.bindings))) {
        return (await isLastAssignedActiveAdmin(db, args)) ? { kind: "last_admin" } : { kind: "conflict" }
      }
    } catch {
      // Preserve the original unavailable classification below.
    }
    return { kind: "error", reason: "unavailable" }
  }
}

type CreatePendingManagedOrgSeatExpansionArgs = LeaseFence & {
  operationId: string
  idempotencyKey: string
  githubUserId: string
  lastKnownLogin: string
  actorLogin: string
  expectedAssignedQuantity: number
  desiredQuantity: number
  expectedSnapshotRevision: number
  subscriptionId: string
  subscriptionItemId: string
  nextAttemptAtMs: number
}

function exactManagedExpansionRetry(
  operation: OrgSeatBillingOperation,
  args: CreatePendingManagedOrgSeatExpansionArgs,
): boolean {
  return (
    operation.operationId === args.operationId &&
    operation.installationId === args.installationId &&
    operation.targetIdentityKind === "managed_github" &&
    operation.targetGithubUserId === args.githubUserId &&
    operation.actorLogin === normalizeActorLogin(args.actorLogin) &&
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

async function readActiveTargetRole(
  db: D1Database,
  installationId: number,
  githubUserId: string,
): Promise<"admin" | "member" | null> {
  const row = await db
    .prepare(
      `SELECT role FROM org_workspace_access
        WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(installationId, githubUserId)
    .first<{ role: unknown }>()
  return row?.role === "admin" || row?.role === "member" ? row.role : null
}

export async function createPendingManagedOrgSeatExpansion(
  env: DbEnv,
  args: CreatePendingManagedOrgSeatExpansionArgs,
): Promise<
  | { kind: "created" | "existing"; operation: OrgSeatBillingOperation }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  const login = displayLogin(args.lastKnownLogin)
  const actorLogin = normalizeActorLogin(args.actorLogin)
  if (
    !validLeaseFence(args) ||
    !nonEmpty(args.operationId) ||
    !nonEmpty(args.idempotencyKey) ||
    !validGithubUserId(args.githubUserId) ||
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
    const targetRole = await readActiveTargetRole(db, args.installationId, args.githubUserId)
    if (targetRole === null) return { kind: "conflict" }
    const prior = await readOperationByIdentity(db, args.operationId, args.idempotencyKey)
    if (prior.kind === "invalid") return { kind: "error", reason: "invalid_row" }
    if (prior.kind === "ok") {
      return exactManagedExpansionRetry(prior.operation, args)
        ? { kind: "existing", operation: prior.operation }
        : { kind: "conflict" }
    }
    const result = await db
      .prepare(
        `WITH target_access AS (
           SELECT role FROM org_workspace_access
            WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NULL
         ), seat_state AS (
           SELECT
             (SELECT COUNT(*)
                FROM org_workspace_seat_assignment AS assignment
                JOIN org_workspace_access AS access
                  ON access.installation_id = assignment.installation_id
                 AND access.github_user_id = assignment.github_user_id
               WHERE assignment.installation_id = ? AND assignment.assigned = 1
                 AND access.revoked_at IS NULL) AS assigned_quantity,
             COALESCE((SELECT assigned FROM org_workspace_seat_assignment
                        WHERE installation_id = ? AND github_user_id = ?), 0) AS target_assigned
         )
         INSERT OR IGNORE INTO org_seat_billing_operation
           (operation_id, installation_id, revision, login, target_identity_kind,
            target_github_user_id, actor_login, target_is_admin, requested_assigned,
            previous_assigned, desired_quantity, state, stripe_subscription_id,
            stripe_subscription_item_id, stripe_observed_quantity, idempotency_key,
            attempts, error_code, next_attempt_at_ms, created_at_ms, updated_at_ms,
            stripe_applied_at_ms, completed_at_ms)
         SELECT ?, ?, MAX(snapshot.revision, COALESCE((
                    SELECT MAX(revision) FROM org_seat_billing_operation WHERE installation_id = ?
                  ), 0)) + 1,
                ?, 'managed_github', ?, ?, CASE WHEN target.role = 'admin' THEN 1 ELSE 0 END,
                1, 0, ?, 'pending', ?, ?, snapshot.observed_quantity,
                ?, 0, NULL, ?, ?, ?, NULL, NULL
           FROM stripe_seat_subscription AS snapshot
           CROSS JOIN seat_state
           CROSS JOIN target_access AS target
          WHERE snapshot.installation_id = ? AND snapshot.revision = ?
            AND snapshot.stripe_subscription_id = ? AND snapshot.stripe_subscription_item_id = ?
            AND snapshot.subscription_status IN ('active', 'trialing')
            AND snapshot.snapshot_state = 'ready' AND snapshot.observed_quantity IS NOT NULL
            AND snapshot.observed_quantity = snapshot.derived_quantity
            AND seat_state.assigned_quantity = ? AND seat_state.target_assigned = 0
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
        args.githubUserId,
        args.installationId,
        args.installationId,
        args.githubUserId,
        args.operationId,
        args.installationId,
        args.installationId,
        login,
        args.githubUserId,
        actorLogin,
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
    if (stored.kind === "missing" || !exactManagedExpansionRetry(stored.operation, args)) {
      return { kind: "conflict" }
    }
    return (result.meta.changes ?? 0) === 1
      ? { kind: "created", operation: stored.operation }
      : { kind: "existing", operation: stored.operation }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

function managedCommitCondition(args: {
  installationId: number
  operationId: string
  revision: number
  providerQuantity: number
}): { sql: string; bindings: readonly unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM org_seat_billing_operation AS operation
      JOIN stripe_seat_subscription AS snapshot
        ON snapshot.installation_id = operation.installation_id
      JOIN org_workspace_access AS access
        ON access.installation_id = operation.installation_id
       AND access.github_user_id = operation.target_github_user_id
       AND access.revoked_at IS NULL
       WHERE operation.installation_id = ? AND operation.operation_id = ? AND operation.revision = ?
         AND operation.target_identity_kind = 'managed_github'
         AND operation.target_github_user_id IS NOT NULL
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

export async function commitManagedOrgSeatExpansion(
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
  const condition = managedCommitCondition(args)
  try {
    if (!(await guardedConditionMatches(db, args, condition.sql, condition.bindings))) return { kind: "conflict" }
    const results = await db.batch([
      exactManagedBatchGuard(db, args, condition.sql, condition.bindings),
      db
        .prepare(
          `INSERT INTO org_workspace_seat_assignment
             (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
           SELECT installation_id, target_github_user_id, 1, login, ?, ?, actor_login
             FROM org_seat_billing_operation
            WHERE installation_id = ? AND operation_id = ? AND revision = ?
              AND state = 'stripe_applied' AND target_identity_kind = 'managed_github'
              AND target_github_user_id IS NOT NULL
           ON CONFLICT(installation_id, github_user_id) DO UPDATE SET
             assigned = 1, last_known_login = excluded.last_known_login,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(args.nowIso, args.nowIso, args.installationId, args.operationId, args.revision),
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
                AND state = 'stripe_applied' AND target_identity_kind = 'managed_github'
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
           WHERE installation_id = ? AND operation_id = ? AND revision = ?
             AND state = 'stripe_applied' AND target_identity_kind = 'managed_github'`,
        )
        .bind(args.nowMs, args.nowMs, args.installationId, args.operationId, args.revision),
    ])
    if (results.slice(1).some((result) => (result.meta.changes ?? 0) !== 1)) return { kind: "conflict" }
    const snapshot = await readStripeSeatSubscription(env, args.installationId)
    if (snapshot.kind !== "ok") {
      return snapshot.kind === "error"
        ? { kind: "error", reason: snapshot.reason === "unavailable" ? "unavailable" : "invalid_row" }
        : { kind: "error", reason: "invalid_row" }
    }
    return {
      kind: "committed",
      snapshotRevision: snapshot.snapshot.revision,
      quantity: snapshot.snapshot.derivedQuantity,
    }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

export type CancelActiveManagedOrgSeatBillingOperationArgs = LeaseFence & {
  operationId: string
  revision: number
  expectedState: ActiveOperationState
  errorCode: string
  actorLogin: string
  nowIso: string
}

function managedCancelCondition(args: CancelActiveManagedOrgSeatBillingOperationArgs): {
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
         AND operation.state = ? AND operation.target_identity_kind = 'managed_github'
         AND operation.target_github_user_id IS NOT NULL
         AND operation.requested_assigned = 1 AND operation.previous_assigned = 0
         AND operation.actor_login IS NOT NULL AND operation.target_is_admin IS NOT NULL
         ${snapshotPredicate}
    )`,
    bindings: [args.installationId, args.operationId, args.revision, args.expectedState],
  }
}

export function prepareCancelActiveManagedOrgSeatBillingOperation(
  db: D1Database,
  args: CancelActiveManagedOrgSeatBillingOperationArgs,
):
  | { kind: "prepared"; terminalState: "canceled" | "committed"; statements: D1PreparedStatement[] }
  | { kind: "error"; reason: "invalid_input" } {
  const actorLogin = normalizeActorLogin(args.actorLogin)
  if (
    !validLeaseFence(args) ||
    !nonEmpty(args.operationId) ||
    !Number.isSafeInteger(args.revision) ||
    args.revision <= 0 ||
    (args.expectedState !== "pending" && args.expectedState !== "stripe_applied") ||
    !nonEmpty(args.errorCode) ||
    !nonEmpty(actorLogin) ||
    !nonEmpty(args.nowIso)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  const condition = managedCancelCondition(args)
  const statements: D1PreparedStatement[] = [exactManagedBatchGuard(db, args, condition.sql, condition.bindings)]
  statements.push(
    db
      .prepare(
        `INSERT INTO org_workspace_seat_assignment
           (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
         SELECT installation_id, target_github_user_id, 0, login, ?, ?, ?
           FROM org_seat_billing_operation
          WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = ?
            AND target_identity_kind = 'managed_github' AND target_github_user_id IS NOT NULL
         ON CONFLICT(installation_id, github_user_id) DO UPDATE SET
           assigned = 0, last_known_login = excluded.last_known_login,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(
        args.nowIso,
        args.nowIso,
        actorLogin,
        args.installationId,
        args.operationId,
        args.revision,
        args.expectedState,
      ),
  )
  if (args.expectedState === "stripe_applied") {
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
              WHERE installation_id = ? AND operation_id = ? AND revision = ?
                AND state = 'stripe_applied' AND target_identity_kind = 'managed_github'
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
             WHERE installation_id = ? AND operation_id = ? AND revision = ?
               AND state = 'pending' AND target_identity_kind = 'managed_github'`,
          )
          .bind(args.errorCode.trim(), args.nowMs, args.nowMs, args.installationId, args.operationId, args.revision)
      : db
          .prepare(
            `UPDATE org_seat_billing_operation SET
               state = 'committed', error_code = NULL, next_attempt_at_ms = NULL,
               updated_at_ms = ?, completed_at_ms = ?
             WHERE installation_id = ? AND operation_id = ? AND revision = ?
               AND state = 'stripe_applied' AND target_identity_kind = 'managed_github'`,
          )
          .bind(args.nowMs, args.nowMs, args.installationId, args.operationId, args.revision),
  )
  return {
    kind: "prepared",
    terminalState: args.expectedState === "pending" ? "canceled" : "committed",
    statements,
  }
}

export async function cancelActiveManagedOrgSeatBillingOperation(
  env: DbEnv,
  args: CancelActiveManagedOrgSeatBillingOperationArgs,
): Promise<
  | { kind: "settled"; terminalState: "canceled" | "committed" }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "unavailable" }
> {
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }
  const prepared = prepareCancelActiveManagedOrgSeatBillingOperation(env.SIGILIX_PLATFORM_DB, args)
  if (prepared.kind === "error") return prepared
  const condition = managedCancelCondition(args)
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
