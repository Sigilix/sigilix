import { acquireOrgSeatBillingLease, releaseOrgSeatBillingLease } from "./d1-seat-reconciliation-store"
import { enqueueDueOrgSeatBillingOperations } from "./org-seat-billing-reconciler"
import { listInstallationRepoIds } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

const LEASE_TTL_MS = 60_000
const RETRY_DELAY_MS = 30_000
const DUE_COMMAND_LIMIT = 20

type ActivityCommandJob = Extract<JobMessage, { type: "org-activity-seat-command" }>

interface PendingCommand {
  deliveryId: string
  installationId: number
  repositoryId: number
  targetGithubUserId: string
  actorGithubUserId: string
  receivedAtMs: number
  cutoverAtMs: number | null
}

interface SeatDecision {
  assignedQuantity: number
  targetAssigned: boolean | null
  targetHasExplicitZero: boolean
  observedQuantity: number
}

type LeaseFence = {
  installationId: number
  leaseToken: string
  leaseAcquiredAtMs: number
  nowMs: number
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function boundedText(value: string, max: number): boolean {
  return value.trim().length > 0 && value.length <= max && !value.includes("\0")
}

function canonicalGithubId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

async function readPendingCommand(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  deliveryId: string,
): Promise<{ kind: "pending"; command: PendingCommand } | { kind: "done" } | { kind: "unavailable" }> {
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "unavailable" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT state.state, command.delivery_id, command.installation_id, command.repository_id,
              command.target_github_user_id, command.actor_github_user_id, command.received_at_ms,
              readiness.cutover_at_ms
         FROM org_activity_seat_command_state AS state
         JOIN org_activity_seat_command AS command ON command.delivery_id = state.delivery_id
         LEFT JOIN org_activity_seat_readiness AS readiness
           ON readiness.installation_id = command.installation_id
        WHERE state.delivery_id = ?`,
    )
      .bind(deliveryId)
      .first<Record<string, unknown>>()
    if (row === null || row.state !== "pending") return { kind: "done" }
    if (
      typeof row.delivery_id !== "string" ||
      !boundedText(row.delivery_id, 128) ||
      !validInstallationId(Number(row.installation_id)) ||
      !validInstallationId(Number(row.repository_id)) ||
      !canonicalGithubId(row.target_github_user_id) ||
      !canonicalGithubId(row.actor_github_user_id) ||
      !nonNegativeInteger(row.received_at_ms) ||
      (row.cutover_at_ms !== null && !nonNegativeInteger(row.cutover_at_ms))
    ) {
      return { kind: "unavailable" }
    }
    return {
      kind: "pending",
      command: {
        deliveryId: row.delivery_id,
        installationId: Number(row.installation_id),
        repositoryId: Number(row.repository_id),
        targetGithubUserId: row.target_github_user_id,
        actorGithubUserId: row.actor_github_user_id,
        receivedAtMs: row.received_at_ms,
        cutoverAtMs: row.cutover_at_ms === null ? null : Number(row.cutover_at_ms),
      },
    }
  } catch {
    return { kind: "unavailable" }
  }
}

async function deferCommand(env: Env, deliveryId: string, errorCode: string): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  const nowMs = Date.now()
  try {
    await env.SIGILIX_PLATFORM_DB.prepare(
      `UPDATE org_activity_seat_command_state SET
         attempts = attempts + 1, next_attempt_at_ms = ?, last_error_code = ?, updated_at_ms = ?
       WHERE delivery_id = ? AND state = 'pending'`,
    )
      .bind(nowMs + RETRY_DELAY_MS, errorCode, nowMs, deliveryId)
      .run()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "activity-seat-command-defer-failed",
        deliveryId,
        errorCode,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

async function markPreCutover(env: Env, command: PendingCommand): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  const nowMs = Date.now()
  await env.SIGILIX_PLATFORM_DB.prepare(
    `UPDATE org_activity_seat_command_state SET
       state = 'ignored', resolution = 'pre_cutover', next_attempt_at_ms = NULL,
       last_error_code = NULL, updated_at_ms = ?, terminal_at_ms = ?
     WHERE delivery_id = ? AND state = 'pending'`,
  )
    .bind(nowMs, nowMs, command.deliveryId)
    .run()
}

async function markRepositoryNotAuthorized(env: Env, command: PendingCommand, nowMs: number): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) return
  await env.SIGILIX_PLATFORM_DB.prepare(
    `UPDATE org_activity_seat_command_state SET
       state = 'ignored', resolution = 'repository_not_authorized', next_attempt_at_ms = NULL,
       last_error_code = NULL, updated_at_ms = ?, terminal_at_ms = ?
     WHERE delivery_id = ? AND state = 'pending'`,
  )
    .bind(nowMs, nowMs, command.deliveryId)
    .run()
}

async function exactRepositoryIsAuthorized(env: Env, command: PendingCommand): Promise<boolean | null> {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_PRIVATE_KEY
  if (!env.OPENCLAW_STATE || !appId?.trim() || !privateKey?.trim()) return null
  try {
    const listed = await listInstallationRepoIds(env.OPENCLAW_STATE, appId, privateKey, command.installationId)
    return listed.complete ? listed.items.includes(command.repositoryId) : null
  } catch {
    return null
  }
}

async function readSeatDecision(env: Env, command: PendingCommand, fence: LeaseFence): Promise<SeatDecision | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM org_seat_billing_lease
           WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?)
           AS lease_count,
         (SELECT COUNT(*) FROM org_activity_seat_command_state
           WHERE delivery_id = ? AND state = 'pending') AS pending_count,
         (SELECT COUNT(*) FROM org_activity_seat_readiness
           WHERE installation_id = ? AND cutover_at_ms < ?) AS readiness_count,
         (SELECT effective_assigned FROM org_activity_ready_effective_seat
           WHERE installation_id = ? AND github_user_id = ?) AS target_assigned,
         (SELECT has_explicit_zero FROM org_activity_ready_effective_seat
           WHERE installation_id = ? AND github_user_id = ?) AS target_has_explicit_zero,
         (SELECT COUNT(*) FROM org_activity_ready_effective_seat
           WHERE installation_id = ? AND effective_assigned = 1) AS assigned_quantity,
         snapshot.observed_quantity, snapshot.derived_quantity, snapshot.snapshot_state,
         snapshot.subscription_status,
         (SELECT COUNT(*) FROM org_seat_billing_operation
           WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')) AS active_operation_count
       FROM stripe_seat_subscription AS snapshot
       WHERE snapshot.installation_id = ?`,
    )
      .bind(
        command.installationId,
        fence.leaseToken,
        fence.leaseAcquiredAtMs,
        fence.nowMs,
        command.deliveryId,
        command.installationId,
        command.receivedAtMs,
        command.installationId,
        command.targetGithubUserId,
        command.installationId,
        command.targetGithubUserId,
        command.installationId,
        command.installationId,
        command.installationId,
      )
      .first<Record<string, unknown>>()
    if (
      row === null ||
      row.lease_count !== 1 ||
      row.pending_count !== 1 ||
      row.readiness_count !== 1 ||
      row.active_operation_count !== 0 ||
      row.snapshot_state !== "ready" ||
      (row.subscription_status !== "active" && row.subscription_status !== "trialing") ||
      !nonNegativeInteger(row.observed_quantity) ||
      row.derived_quantity !== row.observed_quantity ||
      !nonNegativeInteger(row.assigned_quantity) ||
      (row.target_assigned !== null && row.target_assigned !== 0 && row.target_assigned !== 1) ||
      (row.target_has_explicit_zero !== null &&
        row.target_has_explicit_zero !== 0 &&
        row.target_has_explicit_zero !== 1)
    ) {
      return null
    }
    return {
      assignedQuantity: row.assigned_quantity,
      targetAssigned: row.target_assigned === null ? null : row.target_assigned === 1,
      targetHasExplicitZero: row.target_has_explicit_zero === 1,
      observedQuantity: row.observed_quantity,
    }
  } catch {
    return null
  }
}

async function markExistingSeat(
  env: Env,
  command: PendingCommand,
  resolution: "already_assigned" | "manual_unassign",
  authorizedAtMs: number,
  fence: LeaseFence,
): Promise<boolean> {
  if (!env.SIGILIX_PLATFORM_DB) return false
  const state = resolution === "already_assigned" ? "applied" : "ignored"
  try {
    const result = await env.SIGILIX_PLATFORM_DB.prepare(
      `UPDATE org_activity_seat_command_state SET
         state = ?, resolution = ?, repository_authorized_at_ms = ?, next_attempt_at_ms = NULL,
         last_error_code = NULL, updated_at_ms = ?, terminal_at_ms = ?
       WHERE delivery_id = ? AND state = 'pending'
         AND EXISTS (
           SELECT 1 FROM org_seat_billing_lease
            WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
         )`,
    )
      .bind(
        state,
        resolution,
        authorizedAtMs,
        fence.nowMs,
        fence.nowMs,
        command.deliveryId,
        command.installationId,
        fence.leaseToken,
        fence.leaseAcquiredAtMs,
        fence.nowMs,
      )
      .run()
    return (result.meta.changes ?? 0) === 1
  } catch {
    return false
  }
}

function exactBatchGuard(db: D1Database, command: PendingCommand, fence: LeaseFence, mode: "local" | "expand") {
  const comparison = mode === "local" ? "<" : "="
  return db
    .prepare(
      `INSERT INTO org_seat_billing_lease
         (installation_id, lease_token, acquired_at_ms, expires_at_ms)
       SELECT CASE WHEN EXISTS (
         SELECT 1 FROM org_seat_billing_lease
          WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
       ) AND EXISTS (
         SELECT 1
           FROM org_activity_seat_command AS command
           JOIN org_activity_seat_command_state AS state ON state.delivery_id = command.delivery_id
           JOIN org_activity_seat_readiness AS readiness
             ON readiness.installation_id = command.installation_id
           JOIN stripe_seat_subscription AS snapshot
             ON snapshot.installation_id = command.installation_id
          WHERE command.delivery_id = ? AND command.installation_id = ?
            AND command.repository_id = ? AND command.target_github_user_id = ?
            AND command.actor_github_user_id = ? AND command.received_at_ms > readiness.cutover_at_ms
            AND state.state = 'pending'
            AND snapshot.subscription_status IN ('active', 'trialing')
            AND snapshot.snapshot_state = 'ready' AND snapshot.observed_quantity IS NOT NULL
            AND snapshot.observed_quantity = snapshot.derived_quantity
            AND (SELECT COUNT(*) FROM org_activity_ready_effective_seat AS effective
                  WHERE effective.installation_id = command.installation_id
                    AND effective.effective_assigned = 1) ${comparison} snapshot.observed_quantity
            AND NOT EXISTS (
              SELECT 1 FROM org_activity_ready_effective_seat AS target
               WHERE target.installation_id = command.installation_id
                 AND target.github_user_id = command.target_github_user_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM org_seat_billing_operation AS active
               WHERE active.installation_id = command.installation_id
                 AND active.state IN ('pending', 'stripe_applied')
            )
       ) THEN ? ELSE 0 END,
       '__activity_command_batch_guard__', 0, 1
       ON CONFLICT(installation_id) DO NOTHING`,
    )
    .bind(
      command.installationId,
      fence.leaseToken,
      fence.leaseAcquiredAtMs,
      fence.nowMs,
      command.deliveryId,
      command.installationId,
      command.repositoryId,
      command.targetGithubUserId,
      command.actorGithubUserId,
      command.installationId,
    )
}

async function commitLocalAssignment(
  env: Env,
  command: PendingCommand,
  authorizedAtMs: number,
  fence: LeaseFence,
): Promise<boolean> {
  if (!env.SIGILIX_PLATFORM_DB) return false
  const db = env.SIGILIX_PLATFORM_DB
  const nowIso = new Date(fence.nowMs).toISOString()
  try {
    const results = await db.batch([
      exactBatchGuard(db, command, fence, "local"),
      db
        .prepare(
          `INSERT INTO org_activity_seat_assignment
            (installation_id, github_user_id, assigned, is_admin, last_known_login,
             created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login)
           SELECT installation_id, target_github_user_id, 1,
                  CASE WHEN author_association = 'OWNER' THEN 1 ELSE 0 END,
                  COALESCE(target_login, target_github_user_id), ?, ?,
                  actor_github_user_id, COALESCE(actor_login, actor_github_user_id)
             FROM org_activity_seat_command WHERE delivery_id = ?`,
        )
        .bind(nowIso, nowIso, command.deliveryId),
      db
        .prepare(
          `UPDATE org_activity_seat_command_state SET
             state = 'applied', resolution = 'assigned', repository_authorized_at_ms = ?,
             next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?, terminal_at_ms = ?
           WHERE delivery_id = ? AND state = 'pending'`,
        )
        .bind(authorizedAtMs, fence.nowMs, fence.nowMs, command.deliveryId),
    ])
    return results.slice(1).every((result) => (result.meta.changes ?? 0) === 1)
  } catch {
    return false
  }
}

async function delegateExpansion(
  env: Env,
  command: PendingCommand,
  authorizedAtMs: number,
  fence: LeaseFence,
): Promise<string | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  const db = env.SIGILIX_PLATFORM_DB
  const operationId = crypto.randomUUID()
  const idempotencyKey = `sigilix-activity-seat-${operationId}`
  try {
    const results = await db.batch([
      exactBatchGuard(db, command, fence, "expand"),
      db
        .prepare(
          `INSERT INTO org_seat_billing_operation
            (operation_id, installation_id, revision, login, target_identity_kind,
             target_github_user_id, activity_actor_github_user_id, actor_login, target_is_admin,
             requested_assigned, previous_assigned, desired_quantity, state,
             stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
             idempotency_key, attempts, error_code, next_attempt_at_ms, created_at_ms, updated_at_ms,
             stripe_applied_at_ms, completed_at_ms)
           SELECT ?, command.installation_id,
                  MAX(snapshot.revision, COALESCE((
                    SELECT MAX(revision) FROM org_seat_billing_operation
                     WHERE installation_id = command.installation_id
                  ), 0)) + 1,
                  COALESCE(command.target_login, command.target_github_user_id), 'activity_github',
                  command.target_github_user_id, command.actor_github_user_id,
                  COALESCE(command.actor_login, command.actor_github_user_id),
                  CASE WHEN command.author_association = 'OWNER' THEN 1 ELSE 0 END,
                  1, 0, snapshot.observed_quantity + 1, 'pending',
                  snapshot.stripe_subscription_id, snapshot.stripe_subscription_item_id,
                  snapshot.observed_quantity, ?, 0, NULL, ?, ?, ?, NULL, NULL
             FROM org_activity_seat_command AS command
             JOIN stripe_seat_subscription AS snapshot
               ON snapshot.installation_id = command.installation_id
            WHERE command.delivery_id = ?`,
        )
        .bind(operationId, idempotencyKey, fence.nowMs, fence.nowMs, fence.nowMs, command.deliveryId),
      db
        .prepare(
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = ?, repository_authorized_at_ms = ?,
             next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?, terminal_at_ms = ?
           WHERE delivery_id = ? AND state = 'pending'`,
        )
        .bind(operationId, authorizedAtMs, fence.nowMs, fence.nowMs, command.deliveryId),
    ])
    return results.slice(1).every((result) => (result.meta.changes ?? 0) === 1) ? operationId : null
  } catch {
    return null
  }
}

async function enqueueBillingRecovery(env: Env, installationId: number, operationId: string): Promise<void> {
  try {
    await env.OPENCLAW_JOBS.send({ type: "org-seat-billing-reconcile", installationId, operationId })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "activity-seat-billing-enqueue-failed",
        installationId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/** Consume one immutable activity command without coupling billing to PR review. */
export async function consumeActivitySeatCommand(env: Env, job: ActivityCommandJob): Promise<void> {
  if (!boundedText(job.deliveryId, 128)) return
  const pending = await readPendingCommand(env, job.deliveryId)
  if (pending.kind === "done") return
  if (pending.kind !== "pending") return deferCommand(env, job.deliveryId, "command_unavailable")
  const command = pending.command
  if (command.cutoverAtMs === null) return deferCommand(env, command.deliveryId, "readiness_unavailable")
  if (command.receivedAtMs <= command.cutoverAtMs) {
    try {
      await markPreCutover(env, command)
    } catch {
      await deferCommand(env, command.deliveryId, "pre_cutover_transition_failed")
    }
    return
  }

  const authorized = await exactRepositoryIsAuthorized(env, command)
  if (authorized === null) return deferCommand(env, command.deliveryId, "repository_scope_unavailable")
  const authorizedAtMs = Date.now()
  if (authorizedAtMs < command.receivedAtMs) return deferCommand(env, command.deliveryId, "worker_clock_regressed")
  if (!authorized) {
    try {
      await markRepositoryNotAuthorized(env, command, authorizedAtMs)
    } catch {
      await deferCommand(env, command.deliveryId, "repository_transition_failed")
    }
    return
  }

  const leaseToken = crypto.randomUUID()
  const leaseAcquiredAtMs = Date.now()
  const lease = await acquireOrgSeatBillingLease(env, {
    installationId: command.installationId,
    token: leaseToken,
    nowMs: leaseAcquiredAtMs,
    ttlMs: LEASE_TTL_MS,
  })
  if (lease.kind !== "acquired") return deferCommand(env, command.deliveryId, `lease_${lease.kind}`)
  try {
    const fence = { installationId: command.installationId, leaseToken, leaseAcquiredAtMs, nowMs: Date.now() }
    const decision = await readSeatDecision(env, command, fence)
    if (decision === null) return deferCommand(env, command.deliveryId, "seat_state_unavailable")
    if (decision.targetAssigned === true) {
      if (!(await markExistingSeat(env, command, "already_assigned", authorizedAtMs, fence))) {
        await deferCommand(env, command.deliveryId, "already_assigned_transition_failed")
      }
      return
    }
    if (decision.targetAssigned === false && decision.targetHasExplicitZero) {
      if (!(await markExistingSeat(env, command, "manual_unassign", authorizedAtMs, fence))) {
        await deferCommand(env, command.deliveryId, "manual_unassign_transition_failed")
      }
      return
    }
    if (decision.assignedQuantity < decision.observedQuantity) {
      if (!(await commitLocalAssignment(env, command, authorizedAtMs, fence))) {
        await deferCommand(env, command.deliveryId, "local_assignment_conflict")
      }
      return
    }
    if (decision.assignedQuantity !== decision.observedQuantity) {
      return deferCommand(env, command.deliveryId, "seat_quantity_diverged")
    }
    const operationId = await delegateExpansion(env, command, authorizedAtMs, fence)
    if (operationId === null) return deferCommand(env, command.deliveryId, "operation_delegation_conflict")
    await enqueueBillingRecovery(env, command.installationId, operationId)
  } finally {
    await releaseOrgSeatBillingLease(env, {
      installationId: command.installationId,
      token: leaseToken,
      acquiredAtMs: leaseAcquiredAtMs,
    })
  }
}

/** Best-effort immediate pickup; the due-state scan remains crash recovery. */
export async function enqueueActivitySeatCommand(env: Env, deliveryId: string, ctx?: ExecutionContext): Promise<void> {
  const promise = env.OPENCLAW_JOBS.send({ type: "org-activity-seat-command", deliveryId }).catch((error) => {
    console.error(
      JSON.stringify({
        event: "activity-seat-command-enqueue-failed",
        deliveryId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })
  if (ctx) ctx.waitUntil(promise)
  else await promise
}

/** Cron helper: enqueue a bounded set of scanner-owned commands whose retry is due. */
export async function enqueueDueActivitySeatCommands(env: Env, nowMs = Date.now()): Promise<number> {
  if (!env.SIGILIX_PLATFORM_DB || !env.OPENCLAW_JOBS || !nonNegativeInteger(nowMs)) return 0
  try {
    const due = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT delivery_id FROM org_activity_seat_command_state
        WHERE state = 'pending' AND next_attempt_at_ms <= ?
        ORDER BY next_attempt_at_ms, delivery_id LIMIT ?`,
    )
      .bind(nowMs, DUE_COMMAND_LIMIT)
      .all<{ delivery_id: unknown }>()
    let enqueued = 0
    for (const row of due.results) {
      if (typeof row.delivery_id !== "string" || !boundedText(row.delivery_id, 128)) continue
      try {
        await env.OPENCLAW_JOBS.send({ type: "org-activity-seat-command", deliveryId: row.delivery_id })
        enqueued += 1
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "activity-seat-command-scan-enqueue-failed",
            deliveryId: row.delivery_id,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
    return enqueued
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "activity-seat-command-scan-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return 0
  }
}

/** One scheduled recovery promise for command pickup and delegated Stripe operations. */
export async function enqueueDueSeatWork(env: Env): Promise<void> {
  await Promise.all([enqueueDueActivitySeatCommands(env), enqueueDueOrgSeatBillingOperations(env)])
}
