import { describe, expect, it } from "vitest"
import { decodeOrgSeatBillingOperationRow, decodeStripeSeatSubscriptionRow } from "./seat-reconciliation"

const VALID_ROW = {
  installation_id: 42,
  stripe_customer_id: "cus_42",
  stripe_subscription_id: "sub_42",
  stripe_subscription_item_id: "si_42",
  stripe_price_id: "price_42",
  subscription_status: "active",
  observed_quantity: 3,
  derived_quantity: 4,
  revision: 2,
  snapshot_state: "review_required",
  block_reason: null,
  last_stripe_event_id: "evt_42",
  last_stripe_event_created_at_ms: 100,
  last_stripe_event_received_at_ms: 110,
  last_refreshed_at_ms: 120,
  refresh_due_at_ms: 220,
  created_at_ms: 10,
  updated_at_ms: 120,
}

describe("decodeStripeSeatSubscriptionRow", () => {
  it("decodes a complete strict snapshot", () => {
    expect(decodeStripeSeatSubscriptionRow(VALID_ROW)).toEqual({
      installationId: 42,
      stripeCustomerId: "cus_42",
      stripeSubscriptionId: "sub_42",
      stripeSubscriptionItemId: "si_42",
      stripePriceId: "price_42",
      subscriptionStatus: "active",
      observedQuantity: 3,
      derivedQuantity: 4,
      revision: 2,
      snapshotState: "review_required",
      blockReason: null,
      lastStripeEventId: "evt_42",
      lastStripeEventCreatedAtMs: 100,
      lastStripeEventReceivedAtMs: 110,
      lastRefreshedAtMs: 120,
      refreshDueAtMs: 220,
      createdAtMs: 10,
      updatedAtMs: 120,
    })
  })

  it("rejects unknown states and malformed blocked-state coupling", () => {
    expect(decodeStripeSeatSubscriptionRow({ ...VALID_ROW, snapshot_state: "unknown" })).toBeNull()
    expect(decodeStripeSeatSubscriptionRow({ ...VALID_ROW, snapshot_state: "blocked" })).toBeNull()
    expect(
      decodeStripeSeatSubscriptionRow({ ...VALID_ROW, snapshot_state: "ready", block_reason: "manual review" }),
    ).toBeNull()
  })

  it("allows future Stripe statuses while rejecting invalid numeric fields", () => {
    expect(
      decodeStripeSeatSubscriptionRow({
        ...VALID_ROW,
        subscription_status: "future_status",
        snapshot_state: "discovering",
      }),
    ).not.toBeNull()
    expect(decodeStripeSeatSubscriptionRow({ ...VALID_ROW, subscription_status: "future_status" })).toBeNull()
    expect(decodeStripeSeatSubscriptionRow({ ...VALID_ROW, observed_quantity: -1 })).toBeNull()
    expect(decodeStripeSeatSubscriptionRow({ ...VALID_ROW, revision: 1.5 })).toBeNull()
  })

  it("enforces the ready and review-required quantity matrices", () => {
    expect(
      decodeStripeSeatSubscriptionRow({ ...VALID_ROW, snapshot_state: "ready", derived_quantity: 3 }),
    ).not.toBeNull()
    expect(decodeStripeSeatSubscriptionRow({ ...VALID_ROW, snapshot_state: "ready" })).toBeNull()
    expect(decodeStripeSeatSubscriptionRow({ ...VALID_ROW, derived_quantity: 3 })).toBeNull()
    expect(
      decodeStripeSeatSubscriptionRow({
        ...VALID_ROW,
        snapshot_state: "ready",
        derived_quantity: 3,
        stripe_customer_id: null,
      }),
    ).toBeNull()
  })
})

describe("decodeOrgSeatBillingOperationRow", () => {
  it("decodes durable seat intent and rejects invalid revisions", () => {
    const row = {
      operation_id: "op-1",
      installation_id: 42,
      revision: 1,
      login: "alice",
      target_identity_kind: "legacy_login",
      target_github_user_id: null,
      actor_login: "owner",
      target_is_admin: 0,
      requested_assigned: 0,
      previous_assigned: 1,
      desired_quantity: 2,
      state: "pending",
      stripe_subscription_id: "sub_42",
      stripe_subscription_item_id: "si_42",
      stripe_observed_quantity: 3,
      idempotency_key: "seat-42-1",
      attempts: 0,
      error_code: null,
      next_attempt_at_ms: 2,
      created_at_ms: 1,
      updated_at_ms: 1,
      stripe_applied_at_ms: null,
      completed_at_ms: null,
    }
    expect(decodeOrgSeatBillingOperationRow(row)).toEqual({
      operationId: "op-1",
      installationId: 42,
      revision: 1,
      login: "alice",
      targetIdentityKind: "legacy_login",
      targetGithubUserId: null,
      actorLogin: "owner",
      targetIsAdmin: false,
      requestedAssigned: false,
      previousAssigned: true,
      desiredQuantity: 2,
      state: "pending",
      stripeSubscriptionId: "sub_42",
      stripeSubscriptionItemId: "si_42",
      stripeObservedQuantity: 3,
      idempotencyKey: "seat-42-1",
      attempts: 0,
      errorCode: null,
      nextAttemptAtMs: 2,
      createdAtMs: 1,
      updatedAtMs: 1,
      stripeAppliedAtMs: null,
      completedAtMs: null,
    })
    expect(decodeOrgSeatBillingOperationRow({ ...row, revision: 0 })).toBeNull()
    expect(decodeOrgSeatBillingOperationRow({ ...row, state: "stripe_applied" })).toBeNull()
    expect(
      decodeOrgSeatBillingOperationRow({
        ...row,
        state: "stripe_applied",
        stripe_observed_quantity: 2,
        stripe_applied_at_ms: 3,
      }),
    ).not.toBeNull()
    expect(
      decodeOrgSeatBillingOperationRow({
        ...row,
        state: "committed",
        stripe_observed_quantity: 2,
        stripe_applied_at_ms: 3,
        next_attempt_at_ms: null,
        completed_at_ms: 4,
      }),
    ).not.toBeNull()
    expect(
      decodeOrgSeatBillingOperationRow({
        ...row,
        state: "failed",
        next_attempt_at_ms: null,
        completed_at_ms: 4,
        error_code: "stripe_error",
      }),
    ).not.toBeNull()
    expect(decodeOrgSeatBillingOperationRow({ ...row, actor_login: null })).toBeNull()
    expect(decodeOrgSeatBillingOperationRow({ ...row, target_is_admin: null })).toBeNull()
  })

  it("decodes a managed target only with a canonical immutable GitHub user id", () => {
    const row = {
      operation_id: "op-managed",
      installation_id: 42,
      revision: 1,
      login: "renamed-user",
      target_identity_kind: "managed_github",
      target_github_user_id: "9007199254740991",
      actor_login: "owner",
      target_is_admin: 0,
      requested_assigned: 1,
      previous_assigned: 0,
      desired_quantity: 2,
      state: "pending",
      stripe_subscription_id: "sub_42",
      stripe_subscription_item_id: "si_42",
      stripe_observed_quantity: 1,
      idempotency_key: "seat-42-managed",
      attempts: 0,
      error_code: null,
      next_attempt_at_ms: 2,
      created_at_ms: 1,
      updated_at_ms: 1,
      stripe_applied_at_ms: null,
      completed_at_ms: null,
    }

    expect(decodeOrgSeatBillingOperationRow(row)).toEqual(
      expect.objectContaining({
        login: "renamed-user",
        targetIdentityKind: "managed_github",
        targetGithubUserId: "9007199254740991",
      }),
    )

    for (const targetGithubUserId of [null, "", "0", "01", "-1", "1.0", " 1", "1 ", "9007199254740992", 123]) {
      expect(decodeOrgSeatBillingOperationRow({ ...row, target_github_user_id: targetGithubUserId })).toBeNull()
    }
  })

  it("rejects missing, unknown, or mismatched target identity pairs", () => {
    const row = {
      operation_id: "op-pairing",
      installation_id: 42,
      revision: 1,
      login: "alice",
      target_identity_kind: "legacy_login",
      target_github_user_id: null,
      actor_login: "owner",
      target_is_admin: 0,
      requested_assigned: 1,
      previous_assigned: 0,
      desired_quantity: 2,
      state: "pending",
      stripe_subscription_id: "sub_42",
      stripe_subscription_item_id: "si_42",
      stripe_observed_quantity: 1,
      idempotency_key: "seat-42-pairing",
      attempts: 0,
      error_code: null,
      next_attempt_at_ms: 2,
      created_at_ms: 1,
      updated_at_ms: 1,
      stripe_applied_at_ms: null,
      completed_at_ms: null,
    }

    expect(decodeOrgSeatBillingOperationRow({ ...row, target_identity_kind: "managed_github" })).toBeNull()
    expect(decodeOrgSeatBillingOperationRow({ ...row, target_github_user_id: "123" })).toBeNull()
    expect(decodeOrgSeatBillingOperationRow({ ...row, target_identity_kind: "future_identity" })).toBeNull()
    const { target_identity_kind: _kind, ...missingKind } = row
    expect(decodeOrgSeatBillingOperationRow(missingKind)).toBeNull()
    const { target_github_user_id: _githubUserId, ...missingGithubUserId } = row
    expect(decodeOrgSeatBillingOperationRow(missingGithubUserId)).toBeNull()
  })

  it("keeps terminal historical rows readable while failing active recovery closed without context", () => {
    const historical = {
      operation_id: "op-legacy",
      installation_id: 42,
      revision: 1,
      login: "alice",
      target_identity_kind: "legacy_login",
      target_github_user_id: null,
      actor_login: null,
      target_is_admin: null,
      requested_assigned: 1,
      previous_assigned: 0,
      desired_quantity: 2,
      state: "canceled",
      stripe_subscription_id: "sub_42",
      stripe_subscription_item_id: "si_42",
      stripe_observed_quantity: 1,
      idempotency_key: "seat-42-legacy",
      attempts: 0,
      error_code: "superseded",
      next_attempt_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 2,
      stripe_applied_at_ms: null,
      completed_at_ms: 2,
    }

    expect(decodeOrgSeatBillingOperationRow(historical)).toEqual(
      expect.objectContaining({ actorLogin: null, targetIsAdmin: null, state: "canceled" }),
    )
    expect(
      decodeOrgSeatBillingOperationRow({
        ...historical,
        state: "pending",
        error_code: null,
        next_attempt_at_ms: 3,
        completed_at_ms: null,
      }),
    ).toBeNull()
  })
})
