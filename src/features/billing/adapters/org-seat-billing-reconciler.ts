import {
  acquireOrgSeatBillingLease,
  cancelActiveOrgSeatBillingOperation,
  commitOrgSeatExpansion,
  createPendingOrgSeatExpansion,
  deferOrgSeatBillingOperation,
  listDueOrgSeatBillingOperations,
  markOrgSeatExpansionStripeApplied,
  readActiveOrgSeatBillingOperation,
  readEffectiveOrgSeatAssignment,
  readStripeSeatSubscription,
  readTenantBillingState,
  releaseOrgSeatBillingLease,
  writeLocalOrgSeatAssignment,
} from "./d1-seat-reconciliation-store"
import { listSubscriptionItems, updateSubscriptionItemQuantity } from "./stripe-api"
import { resolvePriceTierConfig } from "./stripe-webhook-route"
import { decideSeatCapacityChange } from "@/src/features/billing/domain/seat-capacity"
import { SEAT_BOUNDS } from "@/src/features/billing/domain/checkout-session"
import { resolveStripeSeatTarget, type StripeSeatTarget } from "@/src/features/billing/domain/stripe-seat-target"
import type {
  OrgSeatBillingOperation,
  StripeSeatSubscriptionSnapshot,
} from "@/src/features/billing/domain/seat-reconciliation"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

const LEASE_TTL_MS = 60_000
const PROVIDER_TIMEOUT_MS = 20_000
const RETRY_DELAY_MS = 30_000
const DUE_OPERATION_LIMIT = 20

interface ReconcileArgs {
  installationId: number
  login: string
  requestedAssigned: boolean
  targetIsAdmin: boolean
  actorLogin: string
  ctx?: ExecutionContext
}

export type OrgSeatAssignmentReconcileResult =
  | { kind: "applied"; assigned: boolean; updatedAt: string }
  | { kind: "pending"; assigned: boolean; updatedAt: string; operationId: string }
  | { kind: "busy" }
  | { kind: "invalid"; error: string }
  | { kind: "unavailable"; error: string }

interface LeaseFence {
  leaseToken: string
  leaseAcquiredAtMs: number
  nowMs: number
}

type LiveTargetResult = { kind: "ready"; target: StripeSeatTarget } | { kind: "unavailable"; error: string }

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function retryAt(nowMs: number): number {
  return nowMs + RETRY_DELAY_MS
}

function providerSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
}

async function readLiveTarget(env: Env, snapshot: StripeSeatSubscriptionSnapshot): Promise<LiveTargetResult> {
  if (
    !env.SIGILIX_STRIPE_SECRET_KEY ||
    snapshot.snapshotState !== "ready" ||
    snapshot.stripeSubscriptionId === null ||
    snapshot.stripeSubscriptionItemId === null ||
    snapshot.stripePriceId === null ||
    snapshot.subscriptionStatus === null
  ) {
    return { kind: "unavailable", error: "seat_billing_snapshot_unavailable" }
  }
  const listed = await listSubscriptionItems(
    env.SIGILIX_STRIPE_SECRET_KEY,
    snapshot.stripeSubscriptionId,
    providerSignal(),
  )
  if (!listed.ok) return { kind: "unavailable", error: "seat_billing_provider_unavailable" }
  const resolution = resolveStripeSeatTarget({
    subscriptionStatus: snapshot.subscriptionStatus,
    priceConfig: resolvePriceTierConfig(env),
    items: listed.items,
  })
  if (
    resolution.kind !== "resolved" ||
    resolution.target.subscriptionItemId !== snapshot.stripeSubscriptionItemId ||
    resolution.target.priceId !== snapshot.stripePriceId
  ) {
    return { kind: "unavailable", error: "seat_billing_provider_mismatch" }
  }
  if (resolution.target.quantity !== snapshot.observedQuantity) {
    console.warn(
      JSON.stringify({
        event: "stripe-seat-capacity-diverged",
        installationId: snapshot.installationId,
        snapshotQuantity: snapshot.observedQuantity,
        liveQuantity: resolution.target.quantity,
      }),
    )
  }
  return { kind: "ready", target: resolution.target }
}

async function enqueueRecovery(
  env: Env,
  args: { installationId: number; operationId: string; ctx?: ExecutionContext },
): Promise<void> {
  if (!env.OPENCLAW_JOBS) return
  const promise = env.OPENCLAW_JOBS.send(
    { type: "org-seat-billing-reconcile", installationId: args.installationId, operationId: args.operationId },
    { delaySeconds: Math.ceil(RETRY_DELAY_MS / 1000) },
  ).catch((error) => {
    console.error(
      JSON.stringify({
        event: "stripe-seat-recovery-enqueue-failed",
        installationId: args.installationId,
        operationId: args.operationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })
  if (args.ctx) args.ctx.waitUntil(promise)
  else await promise
}

async function deferOperation(
  env: Env,
  operation: OrgSeatBillingOperation,
  fence: LeaseFence,
  errorCode: string,
): Promise<boolean> {
  const deferred = await deferOrgSeatBillingOperation(env, {
    installationId: operation.installationId,
    operationId: operation.operationId,
    revision: operation.revision,
    expectedState: operation.state === "stripe_applied" ? "stripe_applied" : "pending",
    errorCode,
    ...fence,
  })
  if (deferred.kind !== "deferred") {
    console.error(
      JSON.stringify({
        event: "stripe-seat-recovery-defer-failed",
        installationId: operation.installationId,
        operationId: operation.operationId,
        state: operation.state,
        errorCode,
        result: deferred.kind,
      }),
    )
    return false
  }
  return true
}

async function commitAppliedOperation(
  env: Env,
  operation: OrgSeatBillingOperation,
  fence: LeaseFence,
  observedQuantity: number,
): Promise<"committed" | "pending"> {
  if (observedQuantity < operation.desiredQuantity) return "pending"
  if (operation.state === "pending") {
    const marked = await markOrgSeatExpansionStripeApplied(env, {
      installationId: operation.installationId,
      operationId: operation.operationId,
      revision: operation.revision,
      // Migration 0020's operation receipt pins the exact requested quantity;
      // providerQuantity separately carries any higher live value into the snapshot.
      stripeObservedQuantity: operation.desiredQuantity,
      nextAttemptAtMs: retryAt(fence.nowMs),
      ...fence,
    })
    if (marked.kind !== "written") return "pending"
  }
  const committed = await commitOrgSeatExpansion(env, {
    installationId: operation.installationId,
    operationId: operation.operationId,
    revision: operation.revision,
    providerQuantity: observedQuantity,
    nowIso: new Date(fence.nowMs).toISOString(),
    ...fence,
  })
  return committed.kind === "committed" ? "committed" : "pending"
}

async function settleActiveForUnassign(
  env: Env,
  active: OrgSeatBillingOperation,
  actorLogin: string,
  fence: LeaseFence,
): Promise<boolean> {
  const settled = await cancelActiveOrgSeatBillingOperation(env, {
    installationId: active.installationId,
    operationId: active.operationId,
    revision: active.revision,
    expectedState: active.state === "stripe_applied" ? "stripe_applied" : "pending",
    errorCode: "seat_unassigned",
    actorLogin,
    nowIso: new Date(fence.nowMs).toISOString(),
    ...fence,
  })
  return settled.kind === "settled"
}

/** Reconcile one already-authorized explicit seat mutation. */
export async function reconcileOrgSeatAssignment(
  env: Env,
  args: ReconcileArgs,
): Promise<OrgSeatAssignmentReconcileResult> {
  const login = args.login.trim().toLowerCase()
  if (!validInstallationId(args.installationId) || login.length === 0 || args.actorLogin.trim().length === 0) {
    return { kind: "invalid", error: "invalid_seat_mutation" }
  }

  const nowMs = Date.now()
  const leaseToken = crypto.randomUUID()
  const lease = await acquireOrgSeatBillingLease(env, {
    installationId: args.installationId,
    token: leaseToken,
    nowMs,
    ttlMs: LEASE_TTL_MS,
  })
  if (lease.kind === "busy") return { kind: "busy" }
  if (lease.kind !== "acquired") return { kind: "unavailable", error: "seat_billing_unavailable" }
  const fence: LeaseFence = { leaseToken, leaseAcquiredAtMs: nowMs, nowMs }
  const updatedAt = new Date(nowMs).toISOString()

  try {
    const active = await readActiveOrgSeatBillingOperation(env, args.installationId)
    if (active.kind === "error") return { kind: "unavailable", error: "seat_billing_unavailable" }
    if (active.kind === "ok") {
      if (args.requestedAssigned || active.operation.login !== login) return { kind: "busy" }
      if (!(await settleActiveForUnassign(env, active.operation, args.actorLogin, fence))) {
        return { kind: "unavailable", error: "seat_billing_unavailable" }
      }
    }

    const effective = await readEffectiveOrgSeatAssignment(env, {
      installationId: args.installationId,
      login,
      ...fence,
    })
    if (effective.kind !== "ok") return { kind: "unavailable", error: "seat_billing_unavailable" }
    const currentQuantity = effective.assignment.assignedQuantity
    const prospectiveQuantity =
      effective.assignment.assigned === args.requestedAssigned
        ? currentQuantity
        : currentQuantity + (args.requestedAssigned ? 1 : -1)
    if (!Number.isSafeInteger(prospectiveQuantity) || prospectiveQuantity < 0) {
      return { kind: "unavailable", error: "seat_billing_state_invalid" }
    }

    if (!args.requestedAssigned) {
      const written = await writeLocalOrgSeatAssignment(env, {
        installationId: args.installationId,
        login,
        assigned: args.requestedAssigned,
        targetIsAdmin: args.targetIsAdmin,
        actorLogin: args.actorLogin,
        nowIso: updatedAt,
        capacity: { kind: "local-only" },
        ...fence,
      })
      return written.kind === "written"
        ? { kind: "applied", assigned: args.requestedAssigned, updatedAt }
        : { kind: "unavailable", error: "seat_billing_unavailable" }
    }

    const billing = await readTenantBillingState(env, args.installationId)
    if (billing.kind === "error" || billing.kind === "missing") {
      return { kind: "unavailable", error: "seat_billing_unavailable" }
    }
    if (billing.kind === "non-stripe") {
      const written = await writeLocalOrgSeatAssignment(env, {
        installationId: args.installationId,
        login,
        assigned: true,
        targetIsAdmin: args.targetIsAdmin,
        actorLogin: args.actorLogin,
        nowIso: updatedAt,
        capacity: { kind: "local-only" },
        ...fence,
      })
      return written.kind === "written"
        ? { kind: "applied", assigned: true, updatedAt }
        : { kind: "unavailable", error: "seat_billing_unavailable" }
    }

    const snapshotRead = await readStripeSeatSubscription(env, args.installationId)
    if (snapshotRead.kind !== "ok" || snapshotRead.snapshot.snapshotState !== "ready") {
      return { kind: "unavailable", error: "seat_billing_snapshot_unavailable" }
    }
    const snapshot = snapshotRead.snapshot
    if (
      snapshot.observedQuantity === null ||
      snapshot.stripeSubscriptionId === null ||
      snapshot.stripeSubscriptionItemId === null
    ) {
      return { kind: "unavailable", error: "seat_billing_snapshot_unavailable" }
    }

    const decision = decideSeatCapacityChange({
      purchasedQuantity: snapshot.observedQuantity,
      currentAssignedQuantity: currentQuantity,
      prospectiveAssignedQuantity: prospectiveQuantity,
      requestedAssigned: args.requestedAssigned,
    })
    if (decision.kind === "invalid_input") return { kind: "unavailable", error: "seat_billing_state_invalid" }
    if (decision.kind === "no_op" || decision.kind === "local_only") {
      const written = await writeLocalOrgSeatAssignment(env, {
        installationId: args.installationId,
        login,
        assigned: true,
        targetIsAdmin: args.targetIsAdmin,
        actorLogin: args.actorLogin,
        nowIso: updatedAt,
        capacity: {
          kind: "snapshot",
          expectedRevision: snapshot.revision,
          subscriptionId: snapshot.stripeSubscriptionId,
          subscriptionItemId: snapshot.stripeSubscriptionItemId,
          minimumQuantity: prospectiveQuantity,
        },
        ...fence,
      })
      return written.kind === "written"
        ? { kind: "applied", assigned: true, updatedAt }
        : { kind: "unavailable", error: "seat_billing_unavailable" }
    }

    const live = await readLiveTarget(env, snapshot)
    if (live.kind !== "ready") return live
    if (decision.quantity > SEAT_BOUNDS[live.target.tier].max) {
      return { kind: "invalid", error: "seat_capacity_limit" }
    }
    if (live.target.quantity >= decision.quantity) {
      const written = await writeLocalOrgSeatAssignment(env, {
        installationId: args.installationId,
        login,
        assigned: true,
        targetIsAdmin: args.targetIsAdmin,
        actorLogin: args.actorLogin,
        nowIso: updatedAt,
        capacity: {
          kind: "live",
          expectedRevision: snapshot.revision,
          subscriptionId: snapshot.stripeSubscriptionId,
          subscriptionItemId: snapshot.stripeSubscriptionItemId,
          minimumQuantity: decision.quantity,
          liveQuantity: live.target.quantity,
        },
        ...fence,
      })
      return written.kind === "written"
        ? { kind: "applied", assigned: true, updatedAt }
        : { kind: "unavailable", error: "seat_billing_unavailable" }
    }

    const operationId = crypto.randomUUID()
    const created = await createPendingOrgSeatExpansion(env, {
      installationId: args.installationId,
      operationId,
      idempotencyKey: `sigilix-seat-${operationId}`,
      login,
      actorLogin: args.actorLogin,
      targetIsAdmin: args.targetIsAdmin,
      expectedAssignedQuantity: currentQuantity,
      desiredQuantity: decision.quantity,
      expectedSnapshotRevision: snapshot.revision,
      subscriptionId: snapshot.stripeSubscriptionId,
      subscriptionItemId: snapshot.stripeSubscriptionItemId,
      nextAttemptAtMs: retryAt(nowMs),
      ...fence,
    })
    if (created.kind !== "created" && created.kind !== "existing") {
      return { kind: "unavailable", error: "seat_billing_unavailable" }
    }
    const operation = created.operation
    const updated = await updateSubscriptionItemQuantity(env.SIGILIX_STRIPE_SECRET_KEY!, {
      subscriptionItemId: operation.stripeSubscriptionItemId,
      quantity: operation.desiredQuantity,
      idempotencyKey: operation.idempotencyKey,
      signal: providerSignal(),
    })
    if (!updated.ok) {
      const deferred = await deferOperation(env, operation, fence, `stripe_update_${updated.status}`)
      await enqueueRecovery(env, {
        installationId: args.installationId,
        operationId,
        ...(args.ctx ? { ctx: args.ctx } : {}),
      })
      if (!deferred) {
        console.warn(JSON.stringify({ event: "stripe-seat-recovery-enqueued-without-defer", operationId }))
      }
      return { kind: "pending", assigned: false, updatedAt, operationId }
    }
    const committed = await commitAppliedOperation(env, operation, fence, updated.quantity)
    if (committed === "committed") return { kind: "applied", assigned: true, updatedAt }

    await enqueueRecovery(env, {
      installationId: args.installationId,
      operationId,
      ...(args.ctx ? { ctx: args.ctx } : {}),
    })
    return { kind: "pending", assigned: false, updatedAt, operationId }
  } finally {
    const released = await releaseOrgSeatBillingLease(env, {
      installationId: args.installationId,
      token: leaseToken,
      acquiredAtMs: nowMs,
    })
    if (released.kind === "error") {
      console.error(JSON.stringify({ event: "stripe-seat-lease-release-failed", installationId: args.installationId }))
    }
  }
}

/** Queue/scheduled recovery for one durable expansion operation. */
export async function recoverOrgSeatBillingOperation(
  env: Env,
  job: Extract<JobMessage, { type: "org-seat-billing-reconcile" }>,
): Promise<void> {
  if (!validInstallationId(job.installationId) || job.operationId.trim().length === 0) return
  const nowMs = Date.now()
  const leaseToken = crypto.randomUUID()
  const lease = await acquireOrgSeatBillingLease(env, {
    installationId: job.installationId,
    token: leaseToken,
    nowMs,
    ttlMs: LEASE_TTL_MS,
  })
  if (lease.kind === "busy") throw new Error("seat reconciliation busy")
  if (lease.kind !== "acquired") throw new Error("seat reconciliation unavailable")
  const fence: LeaseFence = { leaseToken, leaseAcquiredAtMs: nowMs, nowMs }
  try {
    const active = await readActiveOrgSeatBillingOperation(env, job.installationId)
    if (active.kind === "missing") return
    if (active.kind !== "ok" || active.operation.operationId !== job.operationId) {
      throw new Error("seat reconciliation operation unavailable")
    }
    const operation = active.operation
    const billing = await readTenantBillingState(env, job.installationId)
    const snapshot = await readStripeSeatSubscription(env, job.installationId)
    if (billing.kind !== "stripe-active" || snapshot.kind !== "ok" || snapshot.snapshot.snapshotState !== "ready") {
      if (!(await deferOperation(env, operation, fence, "stripe_snapshot_unavailable"))) {
        throw new Error("seat reconciliation defer failed")
      }
      throw new Error("seat reconciliation snapshot unavailable")
    }
    const live = await readLiveTarget(env, snapshot.snapshot)
    if (live.kind !== "ready") {
      if (!(await deferOperation(env, operation, fence, live.error))) {
        throw new Error("seat reconciliation defer failed")
      }
      throw new Error(live.error)
    }

    let observedQuantity = live.target.quantity
    if (operation.state === "pending" && observedQuantity < operation.desiredQuantity) {
      const updated = await updateSubscriptionItemQuantity(env.SIGILIX_STRIPE_SECRET_KEY!, {
        subscriptionItemId: operation.stripeSubscriptionItemId,
        quantity: operation.desiredQuantity,
        idempotencyKey: operation.idempotencyKey,
        signal: providerSignal(),
      })
      if (!updated.ok) {
        if (!(await deferOperation(env, operation, fence, `stripe_update_${updated.status}`))) {
          throw new Error("seat reconciliation defer failed")
        }
        throw new Error("seat reconciliation provider update failed")
      }
      observedQuantity = updated.quantity
    }
    if (observedQuantity < operation.desiredQuantity) {
      if (!(await deferOperation(env, operation, fence, "provider_quantity_regressed"))) {
        throw new Error("seat reconciliation defer failed")
      }
      throw new Error("seat reconciliation provider quantity regressed")
    }
    if ((await commitAppliedOperation(env, operation, fence, observedQuantity)) !== "committed") {
      throw new Error("seat reconciliation commit failed")
    }
  } finally {
    await releaseOrgSeatBillingLease(env, {
      installationId: job.installationId,
      token: leaseToken,
      acquiredAtMs: nowMs,
    })
  }
}

/** Cron helper: enqueue a bounded set of durable operations whose retry is due. */
export async function enqueueDueOrgSeatBillingOperations(env: Env, nowMs = Date.now()): Promise<number> {
  try {
    const due = await listDueOrgSeatBillingOperations(env, { nowMs, limit: DUE_OPERATION_LIMIT })
    if (due.kind !== "ok" || !env.OPENCLAW_JOBS) return 0
    let enqueued = 0
    for (const operation of due.operations) {
      try {
        await env.OPENCLAW_JOBS.send({
          type: "org-seat-billing-reconcile",
          installationId: operation.installationId,
          operationId: operation.operationId,
        })
        enqueued += 1
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "stripe-seat-recovery-scan-enqueue-failed",
            installationId: operation.installationId,
            operationId: operation.operationId,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
    return enqueued
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "stripe-seat-recovery-scan-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return 0
  }
}
