import { readStripeSeatSubscription } from "./d1-seat-reconciliation-store"
import type { Env } from "@/src/shared/types/env"

type DbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

type LeaseFence = {
  installationId: number
  leaseToken: string
  leaseAcquiredAtMs: number
  nowMs: number
}

type CommitArgs = LeaseFence & {
  operationId: string
  revision: number
  providerQuantity: number
  nowIso: string
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0")
}

function validFence(value: LeaseFence): boolean {
  return (
    validInstallationId(value.installationId) &&
    nonEmpty(value.leaseToken) &&
    nonNegativeInteger(value.leaseAcquiredAtMs) &&
    nonNegativeInteger(value.nowMs)
  )
}

function activityCommitCondition(args: CommitArgs): { sql: string; bindings: readonly unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM org_seat_billing_operation AS operation
      JOIN stripe_seat_subscription AS snapshot
        ON snapshot.installation_id = operation.installation_id
       WHERE operation.installation_id = ? AND operation.operation_id = ? AND operation.revision = ?
         AND operation.target_identity_kind = 'activity_github'
         AND operation.target_github_user_id IS NOT NULL
         AND operation.activity_actor_github_user_id IS NOT NULL
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

function exactActivityBatchGuard(
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
       '__activity_seat_batch_guard__', 0, 1
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

/** Commit one already-authorized, provider-applied activity seat expansion. */
export async function commitActivityOrgSeatExpansion(
  env: DbEnv,
  args: CommitArgs,
): Promise<
  | { kind: "committed"; snapshotRevision: number; quantity: number }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }
> {
  if (
    !validFence(args) ||
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
  const condition = activityCommitCondition(args)
  try {
    if (!(await guardedConditionMatches(db, args, condition.sql, condition.bindings))) {
      return { kind: "conflict" }
    }
    const results = await db.batch([
      exactActivityBatchGuard(db, args, condition.sql, condition.bindings),
      db
        .prepare(
          `INSERT INTO org_activity_seat_assignment
             (installation_id, github_user_id, assigned, is_admin, last_known_login,
              created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login)
           SELECT installation_id, target_github_user_id, 1, target_is_admin, login,
                  ?, ?, activity_actor_github_user_id, actor_login
             FROM org_seat_billing_operation
            WHERE installation_id = ? AND operation_id = ? AND revision = ?
              AND state = 'stripe_applied' AND target_identity_kind = 'activity_github'
              AND target_github_user_id IS NOT NULL AND activity_actor_github_user_id IS NOT NULL
           ON CONFLICT(installation_id, github_user_id) DO UPDATE SET
             assigned = 1,
             is_admin = MAX(org_activity_seat_assignment.is_admin, excluded.is_admin),
             last_known_login = excluded.last_known_login,
             updated_at = excluded.updated_at,
             updated_by_actor_github_user_id = excluded.updated_by_actor_github_user_id,
             updated_by_actor_login = excluded.updated_by_actor_login`,
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
                AND state = 'stripe_applied' AND target_identity_kind = 'activity_github'
                AND target_github_user_id IS NOT NULL AND activity_actor_github_user_id IS NOT NULL
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
             AND state = 'stripe_applied' AND target_identity_kind = 'activity_github'
             AND target_github_user_id IS NOT NULL AND activity_actor_github_user_id IS NOT NULL`,
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
