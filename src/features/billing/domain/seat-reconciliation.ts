export const STRIPE_SNAPSHOT_STATES = ["discovering", "ready", "review_required", "blocked", "not_applicable"] as const

export type StripeSnapshotState = (typeof STRIPE_SNAPSHOT_STATES)[number]

export const ORG_SEAT_BILLING_OPERATION_STATES = [
  "pending",
  "stripe_applied",
  "committed",
  "failed",
  "canceled",
] as const

export type OrgSeatBillingOperationState = (typeof ORG_SEAT_BILLING_OPERATION_STATES)[number]

export interface OrgSeatBillingOperation {
  operationId: string
  installationId: number
  revision: number
  login: string
  requestedAssigned: boolean
  previousAssigned: boolean
  desiredQuantity: number
  state: OrgSeatBillingOperationState
  stripeSubscriptionId: string
  stripeSubscriptionItemId: string
  stripeObservedQuantity: number | null
  idempotencyKey: string
  attempts: number
  errorCode: string | null
  nextAttemptAtMs: number | null
  createdAtMs: number
  updatedAtMs: number
  stripeAppliedAtMs: number | null
  completedAtMs: number | null
}

export interface StripeSeatSubscriptionSnapshot {
  installationId: number
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  stripeSubscriptionItemId: string | null
  stripePriceId: string | null
  subscriptionStatus: string | null
  observedQuantity: number | null
  derivedQuantity: number
  revision: number
  snapshotState: StripeSnapshotState
  blockReason: string | null
  lastStripeEventId: string | null
  lastStripeEventCreatedAtMs: number | null
  lastStripeEventReceivedAtMs: number | null
  lastRefreshedAtMs: number | null
  refreshDueAtMs: number | null
  createdAtMs: number
  updatedAtMs: number
}

export type TenantBillingState =
  | { kind: "stripe-active"; installationId: number; subscriptionStatus: "active" | "trialing" }
  | {
      kind: "non-stripe"
      installationId: number
      billingSource: null | "github_marketplace"
      subscriptionStatus: string | null
    }
  | { kind: "missing" }
  | { kind: "error"; reason: "invalid_installation" | "invalid_row" | "stripe_inactive" | "unavailable" }

type SnapshotRow = {
  installation_id: unknown
  stripe_customer_id: unknown
  stripe_subscription_id: unknown
  stripe_subscription_item_id: unknown
  stripe_price_id: unknown
  subscription_status: unknown
  observed_quantity: unknown
  derived_quantity: unknown
  revision: unknown
  snapshot_state: unknown
  block_reason: unknown
  last_stripe_event_id: unknown
  last_stripe_event_created_at_ms: unknown
  last_stripe_event_received_at_ms: unknown
  last_refreshed_at_ms: unknown
  refresh_due_at_ms: unknown
  created_at_ms: unknown
  updated_at_ms: unknown
}

type OperationRow = {
  operation_id: unknown
  installation_id: unknown
  revision: unknown
  login: unknown
  requested_assigned: unknown
  previous_assigned: unknown
  desired_quantity: unknown
  state: unknown
  stripe_subscription_id: unknown
  stripe_subscription_item_id: unknown
  stripe_observed_quantity: unknown
  idempotency_key: unknown
  attempts: unknown
  error_code: unknown
  next_attempt_at_ms: unknown
  created_at_ms: unknown
  updated_at_ms: unknown
  stripe_applied_at_ms: unknown
  completed_at_ms: unknown
}

function isSnapshotState(value: unknown): value is StripeSnapshotState {
  return typeof value === "string" && (STRIPE_SNAPSHOT_STATES as readonly string[]).includes(value)
}

function isOperationState(value: unknown): value is OrgSeatBillingOperationState {
  return typeof value === "string" && (ORG_SEAT_BILLING_OPERATION_STATES as readonly string[]).includes(value)
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null) return null
  return nonNegativeInteger(value) ? value : undefined
}

export function decodeStripeSeatSubscriptionRow(value: unknown): StripeSeatSubscriptionSnapshot | null {
  if (typeof value !== "object" || value === null) return null
  const row = value as SnapshotRow
  const stripeCustomerId = nullableString(row.stripe_customer_id)
  const stripeSubscriptionId = nullableString(row.stripe_subscription_id)
  const stripeSubscriptionItemId = nullableString(row.stripe_subscription_item_id)
  const stripePriceId = nullableString(row.stripe_price_id)
  const subscriptionStatus = nullableString(row.subscription_status)
  const observedQuantity = nullableNonNegativeInteger(row.observed_quantity)
  const blockReason = nullableString(row.block_reason)
  const lastStripeEventId = nullableString(row.last_stripe_event_id)
  const lastStripeEventCreatedAtMs = nullableNonNegativeInteger(row.last_stripe_event_created_at_ms)
  const lastStripeEventReceivedAtMs = nullableNonNegativeInteger(row.last_stripe_event_received_at_ms)
  const lastRefreshedAtMs = nullableNonNegativeInteger(row.last_refreshed_at_ms)
  const refreshDueAtMs = nullableNonNegativeInteger(row.refresh_due_at_ms)
  if (
    !nonNegativeInteger(row.installation_id) ||
    row.installation_id === 0 ||
    stripeCustomerId === undefined ||
    stripeSubscriptionId === undefined ||
    stripeSubscriptionItemId === undefined ||
    stripePriceId === undefined ||
    subscriptionStatus === undefined ||
    observedQuantity === undefined ||
    !nonNegativeInteger(row.derived_quantity) ||
    !nonNegativeInteger(row.revision) ||
    !isSnapshotState(row.snapshot_state) ||
    blockReason === undefined ||
    lastStripeEventId === undefined ||
    lastStripeEventCreatedAtMs === undefined ||
    lastStripeEventReceivedAtMs === undefined ||
    lastRefreshedAtMs === undefined ||
    refreshDueAtMs === undefined ||
    !nonNegativeInteger(row.created_at_ms) ||
    !nonNegativeInteger(row.updated_at_ms)
  ) {
    return null
  }
  if (row.snapshot_state === "blocked" ? blockReason === null || blockReason.trim() === "" : blockReason !== null) {
    return null
  }
  if (row.snapshot_state === "ready" || row.snapshot_state === "review_required") {
    if (
      stripeCustomerId === null ||
      stripeSubscriptionId === null ||
      stripeSubscriptionItemId === null ||
      stripePriceId === null ||
      (subscriptionStatus !== "active" && subscriptionStatus !== "trialing") ||
      observedQuantity === null ||
      lastRefreshedAtMs === null
    ) {
      return null
    }
    const quantitiesMatch = observedQuantity === row.derived_quantity
    if (row.snapshot_state === "ready" ? !quantitiesMatch : quantitiesMatch) return null
  }
  return {
    installationId: row.installation_id,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeSubscriptionItemId,
    stripePriceId,
    subscriptionStatus,
    observedQuantity,
    derivedQuantity: row.derived_quantity,
    revision: row.revision,
    snapshotState: row.snapshot_state,
    blockReason,
    lastStripeEventId,
    lastStripeEventCreatedAtMs,
    lastStripeEventReceivedAtMs,
    lastRefreshedAtMs,
    refreshDueAtMs,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

export function decodeOrgSeatBillingOperationRow(value: unknown): OrgSeatBillingOperation | null {
  if (typeof value !== "object" || value === null) return null
  const row = value as OperationRow
  const operationId = nullableString(row.operation_id)
  const login = nullableString(row.login)
  const stripeSubscriptionId = nullableString(row.stripe_subscription_id)
  const stripeSubscriptionItemId = nullableString(row.stripe_subscription_item_id)
  const stripeObservedQuantity = nullableNonNegativeInteger(row.stripe_observed_quantity)
  const idempotencyKey = nullableString(row.idempotency_key)
  const errorCode = nullableString(row.error_code)
  const nextAttemptAtMs = nullableNonNegativeInteger(row.next_attempt_at_ms)
  const stripeAppliedAtMs = nullableNonNegativeInteger(row.stripe_applied_at_ms)
  const completedAtMs = nullableNonNegativeInteger(row.completed_at_ms)
  if (
    operationId == null ||
    !nonNegativeInteger(row.installation_id) ||
    row.installation_id === 0 ||
    !nonNegativeInteger(row.revision) ||
    row.revision === 0 ||
    login == null ||
    login.trim() === "" ||
    (row.requested_assigned !== 0 && row.requested_assigned !== 1) ||
    (row.previous_assigned !== 0 && row.previous_assigned !== 1) ||
    !nonNegativeInteger(row.desired_quantity) ||
    !isOperationState(row.state) ||
    stripeSubscriptionId == null ||
    stripeSubscriptionItemId == null ||
    stripeObservedQuantity === undefined ||
    idempotencyKey == null ||
    !nonNegativeInteger(row.attempts) ||
    errorCode === undefined ||
    nextAttemptAtMs === undefined ||
    !nonNegativeInteger(row.created_at_ms) ||
    !nonNegativeInteger(row.updated_at_ms) ||
    stripeAppliedAtMs === undefined ||
    completedAtMs === undefined
  ) {
    return null
  }
  if (
    (row.state === "pending" &&
      (stripeObservedQuantity === null ||
        nextAttemptAtMs === null ||
        stripeAppliedAtMs !== null ||
        completedAtMs !== null)) ||
    (row.state === "stripe_applied" &&
      (stripeObservedQuantity !== row.desired_quantity ||
        stripeAppliedAtMs === null ||
        nextAttemptAtMs === null ||
        completedAtMs !== null)) ||
    (row.state === "committed" &&
      (stripeObservedQuantity !== row.desired_quantity ||
        stripeAppliedAtMs === null ||
        completedAtMs === null ||
        nextAttemptAtMs !== null ||
        errorCode !== null)) ||
    ((row.state === "failed" || row.state === "canceled") &&
      (errorCode === null ||
        errorCode.trim() === "" ||
        completedAtMs === null ||
        nextAttemptAtMs !== null ||
        stripeAppliedAtMs !== null))
  ) {
    return null
  }
  return {
    operationId,
    installationId: row.installation_id,
    revision: row.revision,
    login,
    requestedAssigned: row.requested_assigned === 1,
    previousAssigned: row.previous_assigned === 1,
    desiredQuantity: row.desired_quantity,
    state: row.state,
    stripeSubscriptionId,
    stripeSubscriptionItemId,
    stripeObservedQuantity,
    idempotencyKey,
    attempts: row.attempts,
    errorCode,
    nextAttemptAtMs,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    stripeAppliedAtMs,
    completedAtMs,
  }
}
