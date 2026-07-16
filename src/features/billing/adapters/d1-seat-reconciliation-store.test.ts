/* eslint-disable max-lines -- This D1 integration matrix keeps every durable seat transition against the real schema. */
import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  acquireOrgSeatBillingLease,
  cancelActiveOrgSeatBillingOperation,
  claimStripeSeatSubscriptionBinding,
  commitOrgSeatExpansion,
  createPendingOrgSeatExpansion,
  deferOrgSeatBillingOperation,
  ensureSeatReconciliationTenant,
  listDueOrgSeatBillingOperations,
  markOrgSeatExpansionStripeApplied,
  prepareCancelActiveOrgSeatBillingOperation,
  readEffectiveOrgSeatAssignment,
  readStripeCustomerBinding,
  readStripeInstallationBinding,
  readActiveOrgSeatBillingOperation,
  readStripeSeatSubscription,
  readTenantBillingState,
  releaseOrgSeatBillingLease,
  writeLocalOrgSeatAssignment,
  writeStripeSeatSubscriptionSnapshot,
} from "./d1-seat-reconciliation-store"
import type { Env } from "@/src/shared/types/env"

function migration(name: string): string {
  return readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")
}

function env(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function brokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 failure")
    },
  } as unknown as D1Database
}

async function seedReadySnapshot(db: D1Database, quantity = 2): Promise<void> {
  await expect(
    writeStripeSeatSubscriptionSnapshot(env(db), {
      installationId: 42,
      expectedRevision: null,
      state: "ready",
      customerId: "cus_42",
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      priceId: "price_42",
      subscriptionStatus: "active",
      quantity,
      eventId: "evt_seed",
      eventCreatedAtMs: 1,
      eventReceivedAtMs: 1,
      nowMs: 1,
    }),
  ).resolves.toEqual({ kind: "written", revision: 1 })
}

async function acquireLease(db: D1Database, token = "lease-a", nowMs = 10) {
  await expect(acquireOrgSeatBillingLease(env(db), { installationId: 42, token, nowMs, ttlMs: 100 })).resolves.toEqual({
    kind: "acquired",
    expiresAtMs: nowMs + 100,
  })
  return { leaseToken: token, leaseAcquiredAtMs: nowMs, nowMs }
}

async function activateActivitySeatReadiness(
  db: D1Database,
  fence: { leaseAcquiredAtMs: number; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_activity_seat_readiness
        (installation_id, activation_id, activation_source, schema_version, cutover_at_ms,
         cutover_at, activated_by_actor_github_user_id, stripe_snapshot_revision,
         billing_lease_acquired_at_ms)
       VALUES (42, 'cutover-42', 'legacy_backfill_v1', 1, ?, ?, '9001', 1, ?)`,
    )
    .bind(fence.nowMs, new Date(fence.nowMs).toISOString(), fence.leaseAcquiredAtMs)
    .run()
}

describe("D1 seat reconciliation store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(migration("0001_create_tenant_repo_usage.sql"))
    await db.exec(migration("0007_create_org_seat_assignment.sql"))
    await db.exec(migration("0011_add_tenant_subscription_status.sql"))
    await db.exec(migration("0012_add_tenant_billing_source.sql"))
    await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
    await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
    await db.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
    await db.exec(migration("0032_extend_org_seat_billing_operation_activity_identity.sql"))
    await db.exec(migration("0033_create_org_activity_seat_readiness.sql"))
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (?, 'teams', 't', 't')")
      .bind(42)
      .run()
  })

  it("distinguishes active Stripe, non-Stripe, missing, invalid, and storage failure", async () => {
    await db
      .prepare("UPDATE tenant SET billing_source = 'stripe', subscription_status = 'active' WHERE installation_id = 42")
      .run()
    await expect(readTenantBillingState(env(db), 42)).resolves.toEqual({
      kind: "stripe-active",
      installationId: 42,
      subscriptionStatus: "active",
    })

    await db
      .prepare(
        "INSERT INTO tenant (installation_id, tier, billing_source, subscription_status, created_at, updated_at)" +
          " VALUES (43, 'teams', 'github_marketplace', 'active', 't', 't')",
      )
      .run()
    await expect(readTenantBillingState(env(db), 43)).resolves.toEqual({
      kind: "non-stripe",
      installationId: 43,
      billingSource: "github_marketplace",
      subscriptionStatus: "active",
    })
    await expect(readTenantBillingState(env(db), 404)).resolves.toEqual({ kind: "missing" })

    await db.prepare("UPDATE tenant SET subscription_status = 'past_due' WHERE installation_id = 42").run()
    await expect(readTenantBillingState(env(db), 42)).resolves.toEqual({ kind: "error", reason: "stripe_inactive" })
    await expect(readTenantBillingState({ SIGILIX_PLATFORM_DB: brokenDb() }, 42)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    })
  })

  it("creates a missing reconciliation tenant without overwriting an existing paid tier", async () => {
    await expect(ensureSeatReconciliationTenant(env(db), 43, "2026-07-13T01:00:00.000Z")).resolves.toEqual({
      kind: "ready",
    })
    await expect(
      db.prepare("SELECT tier FROM tenant WHERE installation_id = 43").first<{ tier: string }>(),
    ).resolves.toEqual({ tier: "free" })

    await db.prepare("UPDATE tenant SET tier = 'max' WHERE installation_id = 43").run()
    await expect(ensureSeatReconciliationTenant(env(db), 43, "2026-07-13T02:00:00.000Z")).resolves.toEqual({
      kind: "ready",
    })
    await expect(
      db.prepare("SELECT tier FROM tenant WHERE installation_id = 43").first<{ tier: string }>(),
    ).resolves.toEqual({ tier: "max" })
  })

  it("returns missing separately from a malformed or unavailable Stripe snapshot", async () => {
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({ kind: "missing" })
    await db
      .prepare(
        `INSERT INTO stripe_seat_subscription
          (installation_id, derived_quantity, snapshot_state, created_at_ms, updated_at_ms)
         VALUES (42, 2, 'discovering', 1, 1)`,
      )
      .run()
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({ installationId: 42, derivedQuantity: 2, snapshotState: "discovering" }),
    })
    await expect(readStripeSeatSubscription({}, 42)).resolves.toEqual({ kind: "error", reason: "unavailable" })
  })

  it("persists a provider-only ready snapshot and exposes its bidirectional D1 binding", async () => {
    await expect(
      writeStripeSeatSubscriptionSnapshot(env(db), {
        installationId: 42,
        expectedRevision: null,
        state: "ready",
        customerId: "cus_42",
        subscriptionId: "sub_42",
        subscriptionItemId: "si_42",
        priceId: "price_42",
        subscriptionStatus: "active",
        quantity: 4,
        eventId: "evt_42",
        eventCreatedAtMs: 1_000,
        eventReceivedAtMs: 1_100,
        nowMs: 1_100,
      }),
    ).resolves.toEqual({ kind: "written", revision: 1 })

    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        stripeCustomerId: "cus_42",
        stripeSubscriptionId: "sub_42",
        stripeSubscriptionItemId: "si_42",
        stripePriceId: "price_42",
        subscriptionStatus: "active",
        observedQuantity: 4,
        derivedQuantity: 4,
        snapshotState: "ready",
        revision: 1,
      }),
    })
    await expect(readStripeCustomerBinding(env(db), 42)).resolves.toEqual({ kind: "hit", customerId: "cus_42" })
    await expect(readStripeInstallationBinding(env(db), "cus_42")).resolves.toEqual({
      kind: "hit",
      installationId: 42,
    })
  })

  it("claims one durable customer-to-installation binding before any tier write", async () => {
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (43, 'free', 't', 't')")
      .run()
    await expect(
      claimStripeSeatSubscriptionBinding(env(db), {
        installationId: 42,
        customerId: "cus_claimed",
        nowMs: 100,
      }),
    ).resolves.toEqual({ kind: "claimed", revision: 0 })
    await expect(
      claimStripeSeatSubscriptionBinding(env(db), {
        installationId: 42,
        customerId: "cus_claimed",
        nowMs: 200,
      }),
    ).resolves.toEqual({ kind: "claimed", revision: 0 })
    await expect(
      claimStripeSeatSubscriptionBinding(env(db), {
        installationId: 43,
        customerId: "cus_claimed",
        nowMs: 200,
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(
      claimStripeSeatSubscriptionBinding(env(db), {
        installationId: 42,
        customerId: "cus_other",
        nowMs: 200,
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        stripeCustomerId: "cus_claimed",
        snapshotState: "discovering",
        revision: 0,
      }),
    })
  })

  it("revision-CAS prevents stale webhook state and preserves matching event-order audit metadata", async () => {
    const base = {
      installationId: 42,
      customerId: "cus_42",
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      priceId: "price_42",
      subscriptionStatus: "active" as const,
      quantity: 4,
      eventReceivedAtMs: 2_100,
      nowMs: 2_100,
    }
    await expect(
      writeStripeSeatSubscriptionSnapshot(env(db), {
        ...base,
        expectedRevision: null,
        state: "ready",
        eventId: "evt_new",
        eventCreatedAtMs: 2_000,
      }),
    ).resolves.toEqual({ kind: "written", revision: 1 })
    await expect(
      writeStripeSeatSubscriptionSnapshot(env(db), {
        ...base,
        expectedRevision: 0,
        state: "ready",
        eventId: "evt_stale_writer",
        eventCreatedAtMs: 3_000,
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(
      writeStripeSeatSubscriptionSnapshot(env(db), {
        ...base,
        expectedRevision: 1,
        state: "ready",
        eventId: "evt_old_delivery",
        eventCreatedAtMs: 1_000,
        eventReceivedAtMs: 2_200,
        nowMs: 2_200,
      }),
    ).resolves.toEqual({ kind: "written", revision: 2 })

    const snapshot = await readStripeSeatSubscription(env(db), 42)
    expect(snapshot).toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        revision: 2,
        lastStripeEventId: "evt_new",
        lastStripeEventCreatedAtMs: 2_000,
        lastStripeEventReceivedAtMs: 2_200,
      }),
    })
  })

  it("clears phantom capacity for not-applicable and blocked provider states", async () => {
    await expect(
      writeStripeSeatSubscriptionSnapshot(env(db), {
        installationId: 42,
        expectedRevision: null,
        state: "not_applicable",
        customerId: "cus_42",
        eventId: "evt_none",
        eventCreatedAtMs: 1_000,
        eventReceivedAtMs: 1_100,
        nowMs: 1_100,
      }),
    ).resolves.toEqual({ kind: "written", revision: 1 })
    const none = await readStripeSeatSubscription(env(db), 42)
    expect(none).toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        stripeCustomerId: "cus_42",
        stripeSubscriptionId: null,
        stripeSubscriptionItemId: null,
        stripePriceId: null,
        observedQuantity: null,
        derivedQuantity: 0,
        snapshotState: "not_applicable",
      }),
    })

    await expect(
      writeStripeSeatSubscriptionSnapshot(env(db), {
        installationId: 42,
        expectedRevision: 1,
        state: "blocked",
        customerId: "cus_42",
        reason: "ambiguous_seat_items",
        eventId: "evt_blocked",
        eventCreatedAtMs: 2_000,
        eventReceivedAtMs: 2_100,
        nowMs: 2_100,
      }),
    ).resolves.toEqual({ kind: "written", revision: 2 })
    const blocked = await readStripeSeatSubscription(env(db), 42)
    expect(blocked).toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        observedQuantity: null,
        derivedQuantity: 0,
        snapshotState: "blocked",
        blockReason: "ambiguous_seat_items",
      }),
    })
  })

  it("never lets one customer bind to two installations", async () => {
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (43, 'teams', 't', 't')")
      .run()
    const initial = {
      expectedRevision: null,
      state: "ready" as const,
      customerId: "cus_shared",
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      priceId: "price_42",
      subscriptionStatus: "active" as const,
      quantity: 4,
      eventId: "evt_42",
      eventCreatedAtMs: 1_000,
      eventReceivedAtMs: 1_100,
      nowMs: 1_100,
    }
    await expect(writeStripeSeatSubscriptionSnapshot(env(db), { ...initial, installationId: 42 })).resolves.toEqual({
      kind: "written",
      revision: 1,
    })
    await expect(
      writeStripeSeatSubscriptionSnapshot(env(db), {
        ...initial,
        installationId: 43,
        subscriptionId: "sub_43",
        subscriptionItemId: "si_43",
        eventId: "evt_43",
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(readStripeInstallationBinding(env(db), "cus_shared")).resolves.toEqual({
      kind: "hit",
      installationId: 42,
    })
  })

  it("enforces snapshot states and blocked-reason coupling without constraining Stripe statuses", async () => {
    const insert = db.prepare(
      `INSERT INTO stripe_seat_subscription
        (installation_id, subscription_status, derived_quantity, snapshot_state, block_reason,
         created_at_ms, updated_at_ms)
       VALUES (42, ?, 0, ?, ?, 1, 1)`,
    )
    await expect(insert.bind("future_status", "discovering", null).run()).resolves.toMatchObject({ success: true })
    await db.prepare("DELETE FROM stripe_seat_subscription WHERE installation_id = 42").run()
    await expect(insert.bind("active", "unknown", null).run()).rejects.toThrow()
    await expect(insert.bind("active", "blocked", null).run()).rejects.toThrow()
    await expect(insert.bind("active", "blocked", "manual review").run()).resolves.toMatchObject({ success: true })
    await db.prepare("DELETE FROM stripe_seat_subscription WHERE installation_id = 42").run()
    await expect(insert.bind("active", "ready", null).run()).rejects.toThrow()
    await expect(
      db
        .prepare(
          `INSERT INTO stripe_seat_subscription
            (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
             stripe_price_id, subscription_status, observed_quantity, derived_quantity, snapshot_state,
             last_refreshed_at_ms, created_at_ms, updated_at_ms)
           VALUES (42, 'cus_42', 'sub_42', 'si_42', 'price_42', NULL, 2, 2, 'ready', 2, 1, 2)`,
        )
        .run(),
    ).rejects.toThrow()
    await expect(
      db
        .prepare(
          `INSERT INTO stripe_seat_subscription
            (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
             stripe_price_id, subscription_status, observed_quantity, derived_quantity, snapshot_state,
             last_refreshed_at_ms, created_at_ms, updated_at_ms)
           VALUES (42, 'cus_42', 'sub_42', 'si_42', 'price_42', 'active', 2, 2, 'ready', 2, 1, 2)`,
        )
        .run(),
    ).resolves.toMatchObject({ success: true })
  })

  it("does not let one Stripe customer identity back two tenants", async () => {
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (43, 'teams', 't', 't')")
      .run()
    const insert = db.prepare(
      `INSERT INTO stripe_seat_subscription
        (installation_id, stripe_customer_id, derived_quantity, snapshot_state, created_at_ms, updated_at_ms)
       VALUES (?, 'cus_shared', 0, 'discovering', 1, 1)`,
    )
    await insert.bind(42).run()
    await expect(insert.bind(43).run()).rejects.toThrow()
  })

  it("reads the active operation with its pinned target and durable seat intent", async () => {
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned,
           desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
           stripe_observed_quantity, idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-1', 42, 1, 'alice', 'owner', 0, 0, 1, 2, 'pending', 'sub_42', 'si_42', 3,
                 'seat-42-1', 0, 2, 1, 1)`,
      )
      .run()
    await expect(readActiveOrgSeatBillingOperation(env(db), 42)).resolves.toEqual({
      kind: "ok",
      operation: expect.objectContaining({
        login: "alice",
        actorLogin: "owner",
        targetIsAdmin: false,
        requestedAssigned: false,
        previousAssigned: true,
        desiredQuantity: 2,
        stripeSubscriptionId: "sub_42",
        stripeSubscriptionItemId: "si_42",
      }),
    })
    await expect(readActiveOrgSeatBillingOperation(env(db), 43)).resolves.toEqual({ kind: "missing" })
  })

  it("indexes both recoverable operation states by their next-attempt time", async () => {
    const row = await db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_org_seat_billing_operation_recovery'",
      )
      .first<{ sql: string }>()
    expect(row?.sql).toContain("state IN ('pending', 'stripe_applied')")
    expect(row?.sql).toContain("next_attempt_at_ms IS NOT NULL")
  })

  it("rejects NULL observed quantities for Stripe-applied and committed operations", async () => {
    const insert = db.prepare(
      `INSERT INTO org_seat_billing_operation
        (operation_id, installation_id, revision, login, requested_assigned, previous_assigned,
         desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
         stripe_observed_quantity, idempotency_key, attempts, next_attempt_at_ms,
         stripe_applied_at_ms, completed_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 42, ?, 'alice', 1, 0, 2, ?, 'sub_42', 'si_42', NULL, ?, 1, ?, ?, ?, 1, 1)`,
    )
    await expect(insert.bind("op-applied", 1, "stripe_applied", "idem-applied", 2, 2, null).run()).rejects.toThrow()
    await expect(insert.bind("op-committed", 2, "committed", "idem-committed", null, 2, 3).run()).rejects.toThrow()
  })

  it("acquires one lease, recovers after expiry, and only releases the exact lease version", async () => {
    await expect(
      acquireOrgSeatBillingLease(env(db), { installationId: 42, token: "lease-a", nowMs: 10, ttlMs: 20 }),
    ).resolves.toEqual({ kind: "acquired", expiresAtMs: 30 })
    await expect(
      acquireOrgSeatBillingLease(env(db), { installationId: 42, token: "lease-b", nowMs: 20, ttlMs: 20 }),
    ).resolves.toEqual({ kind: "busy" })
    await expect(
      acquireOrgSeatBillingLease(env(db), { installationId: 42, token: "lease-b", nowMs: 30, ttlMs: 20 }),
    ).resolves.toEqual({ kind: "acquired", expiresAtMs: 50 })
    await expect(
      releaseOrgSeatBillingLease(env(db), { installationId: 42, token: "lease-a", acquiredAtMs: 10 }),
    ).resolves.toEqual({ kind: "not_owner" })
    await expect(
      releaseOrgSeatBillingLease(env(db), { installationId: 42, token: "lease-b", acquiredAtMs: 30 }),
    ).resolves.toEqual({ kind: "released" })
  })

  it("atomically grants only one of concurrent lease attempts", async () => {
    const results = await Promise.all(
      ["lease-a", "lease-b", "lease-c"].map((token) =>
        acquireOrgSeatBillingLease(env(db), { installationId: 42, token, nowMs: 10, ttlMs: 20 }),
      ),
    )
    expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1)
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(2)
  })

  it("classifies legacy entitlements as non-Stripe local-only billing", async () => {
    await db
      .prepare(
        "UPDATE tenant SET billing_source = 'legacy_entitlement', subscription_status = 'active'" +
          " WHERE installation_id = 42",
      )
      .run()

    await expect(readTenantBillingState(env(db), 42)).resolves.toEqual({
      kind: "non-stripe",
      installationId: 42,
      billingSource: "legacy_entitlement",
      subscriptionStatus: "active",
    })
  })

  it("reads the lease-fenced effective assignment from override, activity default, or absence", async () => {
    const fence = await acquireLease(db)
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (7, 42, 'acme/api', 't')")
      .run()
    await db
      .prepare(
        "INSERT INTO usage_ledger" +
          " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
          " VALUES (42, 7, 1, 'abc', 1, 1, 'Alice', '2026-07-13T00:00:00.000Z')",
      )
      .run()

    await expect(
      readEffectiveOrgSeatAssignment(env(db), { installationId: 42, login: " ALICE ", ...fence }),
    ).resolves.toEqual({
      kind: "ok",
      assignment: {
        installationId: 42,
        login: "alice",
        assigned: true,
        isAdmin: false,
        source: "activity",
        assignedQuantity: 1,
      },
    })

    await db
      .prepare(
        "INSERT INTO org_seat_assignment" +
          " (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (42, 'alice', 0, 1, 't', 'owner')",
      )
      .run()
    await expect(
      readEffectiveOrgSeatAssignment(env(db), { installationId: 42, login: "alice", ...fence }),
    ).resolves.toEqual({
      kind: "ok",
      assignment: expect.objectContaining({ assigned: false, isAdmin: true, source: "override", assignedQuantity: 0 }),
    })
    await expect(
      readEffectiveOrgSeatAssignment(env(db), {
        installationId: 42,
        login: "bob",
        ...fence,
        leaseToken: "stale",
      }),
    ).resolves.toEqual({ kind: "conflict" })
  })

  it("writes local seats under the exact lease and can atomically refresh live capacity", async () => {
    await seedReadySnapshot(db, 2)
    const fence = await acquireLease(db)
    await db
      .prepare(
        "INSERT INTO org_seat_assignment" +
          " (installation_id, login, assigned, is_admin, updated_at, updated_by) VALUES (42, 'alice', 0, 1, 't', 'owner')",
      )
      .run()

    await expect(
      writeLocalOrgSeatAssignment(env(db), {
        installationId: 42,
        login: "Alice",
        assigned: true,
        targetIsAdmin: false,
        actorLogin: "owner",
        nowIso: "2026-07-13T00:00:00.000Z",
        ...fence,
        capacity: {
          kind: "snapshot",
          expectedRevision: 1,
          subscriptionId: "sub_42",
          subscriptionItemId: "si_42",
          minimumQuantity: 1,
        },
      }),
    ).resolves.toEqual({ kind: "written", snapshotRevision: 1 })
    await expect(
      db
        .prepare("SELECT assigned, is_admin FROM org_seat_assignment WHERE installation_id = 42 AND login = 'alice'")
        .first(),
    ).resolves.toEqual({ assigned: 1, is_admin: 1 })
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({ observedQuantity: 2, derivedQuantity: 2, revision: 1 }),
    })

    await db
      .prepare(
        "UPDATE stripe_seat_subscription SET observed_quantity = 3, derived_quantity = 2," +
          " revision = 2, snapshot_state = 'review_required' WHERE installation_id = 42",
      )
      .run()
    await expect(
      writeLocalOrgSeatAssignment(env(db), {
        installationId: 42,
        login: "bob",
        assigned: true,
        targetIsAdmin: true,
        actorLogin: "owner",
        nowIso: "2026-07-13T00:01:00.000Z",
        ...fence,
        capacity: {
          kind: "live",
          expectedRevision: 2,
          subscriptionId: "sub_42",
          subscriptionItemId: "si_42",
          minimumQuantity: 2,
          liveQuantity: 4,
        },
      }),
    ).resolves.toEqual({ kind: "written", snapshotRevision: 3 })
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        observedQuantity: 4,
        derivedQuantity: 4,
        revision: 3,
        snapshotState: "ready",
      }),
    })

    await expect(
      writeLocalOrgSeatAssignment(env(db), {
        installationId: 42,
        login: "mallory",
        assigned: true,
        targetIsAdmin: false,
        actorLogin: "owner",
        nowIso: "2026-07-13T00:02:00.000Z",
        ...fence,
        capacity: { kind: "local-only" },
        leaseToken: "stale",
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(
      db.prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = 42 AND login = 'mallory'").first(),
    ).resolves.toBeNull()
  })

  it("returns typed conflicts for legacy writes after activity readiness without widening installation scope", async () => {
    await seedReadySnapshot(db, 2)
    const fence = await acquireLease(db)
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (7, 42, 'acme/api', 't')")
      .run()
    for (const [prNumber, login] of [
      [1, "bob"],
      [2, "carol"],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO usage_ledger
            (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)
           VALUES (42, 7, ?, ?, 1, 1, ?, '2026-07-13T00:00:00.000Z')`,
        )
        .bind(prNumber, `head-${prNumber}`, login)
        .run()
    }
    await activateActivitySeatReadiness(db, fence)

    await expect(
      writeLocalOrgSeatAssignment(env(db), {
        installationId: 42,
        login: "alice",
        assigned: true,
        targetIsAdmin: false,
        actorLogin: "owner",
        nowIso: "2026-07-13T00:01:00.000Z",
        ...fence,
        capacity: { kind: "local-only" },
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(db.prepare("SELECT 1 FROM org_seat_assignment WHERE installation_id = 42").first()).resolves.toBeNull()

    await expect(
      createPendingOrgSeatExpansion(env(db), {
        installationId: 42,
        operationId: "op-after-cutover",
        idempotencyKey: "seat-42-after-cutover",
        login: "alice",
        actorLogin: "owner",
        targetIsAdmin: false,
        expectedAssignedQuantity: 2,
        desiredQuantity: 3,
        expectedSnapshotRevision: 1,
        subscriptionId: "sub_42",
        subscriptionItemId: "si_42",
        nextAttemptAtMs: 20,
        ...fence,
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(
      db.prepare("SELECT 1 FROM org_seat_billing_operation WHERE installation_id = 42").first(),
    ).resolves.toBeNull()

    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (43, 'teams', 't', 't')")
      .run()
    await expect(
      acquireOrgSeatBillingLease(env(db), { installationId: 43, token: "lease-43", nowMs: 10, ttlMs: 100 }),
    ).resolves.toEqual({ kind: "acquired", expiresAtMs: 110 })
    await expect(
      writeLocalOrgSeatAssignment(env(db), {
        installationId: 43,
        login: "alice",
        assigned: true,
        targetIsAdmin: false,
        actorLogin: "owner",
        nowIso: "2026-07-13T00:02:00.000Z",
        leaseToken: "lease-43",
        leaseAcquiredAtMs: 10,
        nowMs: 10,
        capacity: { kind: "local-only" },
      }),
    ).resolves.toEqual({ kind: "written", snapshotRevision: null })
    await expect(
      db.prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = 43 AND login = 'alice'").first(),
    ).resolves.toEqual({ assigned: 1 })
  })

  it("allocates a monotonic pending expansion and treats an exact retry as existing", async () => {
    await seedReadySnapshot(db, 2)
    const fence = await acquireLease(db)
    for (const login of ["bob", "carol"]) {
      await db
        .prepare(
          "INSERT INTO org_seat_assignment" +
            " (installation_id, login, assigned, is_admin, updated_at, updated_by) VALUES (42, ?, 1, 0, 't', 'owner')",
        )
        .bind(login)
        .run()
    }
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, requested_assigned, previous_assigned,
           desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
           stripe_observed_quantity, idempotency_key, attempts, error_code, next_attempt_at_ms,
           created_at_ms, updated_at_ms, completed_at_ms)
         VALUES ('old-op', 42, 5, 'old', 1, 0, 2, 'canceled', 'sub_42', 'si_42', 1,
                 'old-key', 0, 'superseded', NULL, 1, 1, 1)`,
      )
      .run()
    const args = {
      installationId: 42,
      operationId: "op-expand",
      idempotencyKey: "seat-42-op-expand",
      login: "alice",
      actorLogin: "owner",
      targetIsAdmin: false,
      expectedAssignedQuantity: 2,
      desiredQuantity: 3,
      expectedSnapshotRevision: 1,
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      nextAttemptAtMs: 20,
      ...fence,
    }

    await expect(createPendingOrgSeatExpansion(env(db), args)).resolves.toEqual({
      kind: "created",
      operation: expect.objectContaining({
        operationId: "op-expand",
        revision: 6,
        actorLogin: "owner",
        targetIsAdmin: false,
        state: "pending",
        stripeObservedQuantity: 2,
        desiredQuantity: 3,
      }),
    })
    await expect(createPendingOrgSeatExpansion(env(db), args)).resolves.toEqual({
      kind: "existing",
      operation: expect.objectContaining({ operationId: "op-expand", revision: 6 }),
    })
  })

  it("marks Stripe applied and commits seat, snapshot, and operation without shrinking newer capacity", async () => {
    await seedReadySnapshot(db, 2)
    const fence = await acquireLease(db)
    for (const login of ["bob", "carol"]) {
      await db
        .prepare(
          "INSERT INTO org_seat_assignment" +
            " (installation_id, login, assigned, is_admin, updated_at, updated_by) VALUES (42, ?, 1, 0, 't', 'owner')",
        )
        .bind(login)
        .run()
    }
    const created = await createPendingOrgSeatExpansion(env(db), {
      installationId: 42,
      operationId: "op-expand",
      idempotencyKey: "seat-42-op-expand",
      login: "alice",
      actorLogin: "owner",
      targetIsAdmin: true,
      expectedAssignedQuantity: 2,
      desiredQuantity: 3,
      expectedSnapshotRevision: 1,
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      nextAttemptAtMs: 20,
      ...fence,
    })
    expect(created).toEqual({ kind: "created", operation: expect.objectContaining({ revision: 2 }) })

    await expect(
      markOrgSeatExpansionStripeApplied(env(db), {
        installationId: 42,
        operationId: "op-expand",
        revision: 2,
        stripeObservedQuantity: 4,
        nextAttemptAtMs: 30,
        ...fence,
      }),
    ).resolves.toEqual({ kind: "written" })
    await db
      .prepare(
        "UPDATE stripe_seat_subscription SET observed_quantity = 4, derived_quantity = 4," +
          " revision = 10 WHERE installation_id = 42",
      )
      .run()
    await expect(
      commitOrgSeatExpansion(env(db), {
        installationId: 42,
        operationId: "op-expand",
        revision: 2,
        providerQuantity: 4,
        nowIso: "2026-07-13T00:03:00.000Z",
        ...fence,
      }),
    ).resolves.toEqual({ kind: "committed", snapshotRevision: 10, quantity: 4 })
    await expect(
      db
        .prepare("SELECT assigned, is_admin FROM org_seat_assignment WHERE installation_id = 42 AND login = 'alice'")
        .first(),
    ).resolves.toEqual({ assigned: 1, is_admin: 1 })
    await expect(readActiveOrgSeatBillingOperation(env(db), 42)).resolves.toEqual({ kind: "missing" })
  })

  it("settles pending and Stripe-applied removals atomically without shrinking paid capacity", async () => {
    await seedReadySnapshot(db, 1)
    const fence = await acquireLease(db)
    await db
      .prepare(
        "INSERT INTO org_seat_assignment" +
          " (installation_id, login, assigned, is_admin, updated_at, updated_by) VALUES (42, 'bob', 1, 0, 't', 'owner')",
      )
      .run()
    const create = async (operationId: string) =>
      createPendingOrgSeatExpansion(env(db), {
        installationId: 42,
        operationId,
        idempotencyKey: `seat-42-${operationId}`,
        login: "alice",
        actorLogin: "owner",
        targetIsAdmin: false,
        expectedAssignedQuantity: 1,
        desiredQuantity: 2,
        expectedSnapshotRevision: 1,
        subscriptionId: "sub_42",
        subscriptionItemId: "si_42",
        nextAttemptAtMs: 20,
        ...fence,
      })
    expect(await create("op-pending")).toEqual({
      kind: "created",
      operation: expect.objectContaining({ revision: 2 }),
    })
    const prepared = prepareCancelActiveOrgSeatBillingOperation(db, {
      installationId: 42,
      operationId: "op-pending",
      revision: 2,
      expectedState: "pending",
      errorCode: "member_removed",
      actorLogin: "owner-2",
      nowIso: "2026-07-13T00:04:00.000Z",
      ...fence,
    })
    expect(prepared).toMatchObject({ kind: "prepared", terminalState: "canceled" })
    await expect(
      cancelActiveOrgSeatBillingOperation(env(db), {
        installationId: 42,
        operationId: "op-pending",
        revision: 2,
        expectedState: "pending",
        errorCode: "member_removed",
        actorLogin: "owner-2",
        nowIso: "2026-07-13T00:04:00.000Z",
        ...fence,
      }),
    ).resolves.toEqual({ kind: "settled", terminalState: "canceled" })

    expect(await create("op-applied")).toEqual({
      kind: "created",
      operation: expect.objectContaining({ revision: 3 }),
    })
    await markOrgSeatExpansionStripeApplied(env(db), {
      installationId: 42,
      operationId: "op-applied",
      revision: 3,
      stripeObservedQuantity: 2,
      nextAttemptAtMs: 30,
      ...fence,
    })
    await expect(
      cancelActiveOrgSeatBillingOperation(env(db), {
        installationId: 42,
        operationId: "op-applied",
        revision: 3,
        expectedState: "stripe_applied",
        errorCode: "member_removed",
        actorLogin: "owner-2",
        nowIso: "2026-07-13T00:05:00.000Z",
        ...fence,
      }),
    ).resolves.toEqual({ kind: "settled", terminalState: "committed" })
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({ observedQuantity: 2, derivedQuantity: 2, revision: 3 }),
    })
    await expect(
      db
        .prepare("SELECT assigned, is_admin FROM org_seat_assignment WHERE installation_id = 42 AND login = 'alice'")
        .first(),
    ).resolves.toEqual({ assigned: 0, is_admin: 0 })
  })

  it("lists due operations in a bounded order and rejects historical active rows without context", async () => {
    await seedReadySnapshot(db, 1)
    const fence = await acquireLease(db)
    await db
      .prepare(
        "INSERT INTO org_seat_assignment" +
          " (installation_id, login, assigned, is_admin, updated_at, updated_by) VALUES (42, 'bob', 1, 0, 't', 'owner')",
      )
      .run()
    await createPendingOrgSeatExpansion(env(db), {
      installationId: 42,
      operationId: "op-due",
      idempotencyKey: "seat-42-due",
      login: "alice",
      actorLogin: "owner",
      targetIsAdmin: false,
      expectedAssignedQuantity: 1,
      desiredQuantity: 2,
      expectedSnapshotRevision: 1,
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      nextAttemptAtMs: 20,
      ...fence,
    })
    await expect(listDueOrgSeatBillingOperations(env(db), { nowMs: 19, limit: 10 })).resolves.toEqual({
      kind: "ok",
      operations: [],
    })
    await expect(listDueOrgSeatBillingOperations(env(db), { nowMs: 20, limit: 1 })).resolves.toEqual({
      kind: "ok",
      operations: [expect.objectContaining({ operationId: "op-due" })],
    })

    const historicalDb = makeD1()
    await historicalDb.exec(migration("0001_create_tenant_repo_usage.sql"))
    await historicalDb.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
    await historicalDb
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (42, 'teams', 't', 't')")
      .run()
    await historicalDb
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, requested_assigned, previous_assigned,
           desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
           stripe_observed_quantity, idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('legacy-active', 42, 1, 'alice', 1, 0, 2, 'pending', 'sub_42', 'si_42', 1,
                 'legacy-active-key', 0, 1, 1, 1)`,
      )
      .run()
    await historicalDb.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
    await historicalDb.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
    await historicalDb.exec(migration("0032_extend_org_seat_billing_operation_activity_identity.sql"))
    await expect(listDueOrgSeatBillingOperations(env(historicalDb), { nowMs: 1, limit: 10 })).resolves.toEqual({
      kind: "error",
      reason: "invalid_row",
    })
  })

  it("defers a Stripe-applied operation with capped exponential backoff when live quantity regresses", async () => {
    await seedReadySnapshot(db, 2)
    const fence = await acquireLease(db)
    for (const login of ["bob", "carol"]) {
      await db
        .prepare(
          "INSERT INTO org_seat_assignment" +
            " (installation_id, login, assigned, is_admin, updated_at, updated_by) VALUES (42, ?, 1, 0, 't', 'owner')",
        )
        .bind(login)
        .run()
    }
    await createPendingOrgSeatExpansion(env(db), {
      installationId: 42,
      operationId: "op-regressed",
      idempotencyKey: "seat-42-regressed",
      login: "alice",
      actorLogin: "owner",
      targetIsAdmin: false,
      expectedAssignedQuantity: 2,
      desiredQuantity: 3,
      expectedSnapshotRevision: 1,
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      nextAttemptAtMs: 20,
      ...fence,
    })
    await markOrgSeatExpansionStripeApplied(env(db), {
      installationId: 42,
      operationId: "op-regressed",
      revision: 2,
      stripeObservedQuantity: 3,
      nextAttemptAtMs: 30,
      ...fence,
    })
    await db
      .prepare(
        "UPDATE stripe_seat_subscription SET observed_quantity = 2, derived_quantity = 3," +
          " snapshot_state = 'review_required' WHERE installation_id = 42",
      )
      .run()
    const deferArgs = {
      installationId: 42,
      operationId: "op-regressed",
      revision: 2,
      expectedState: "stripe_applied" as const,
      errorCode: "stripe_quantity_regressed",
      ...fence,
    }
    await expect(deferOrgSeatBillingOperation(env(db), deferArgs)).resolves.toEqual({
      kind: "deferred",
      attempts: 2,
      nextAttemptAtMs: 10_010,
    })
    await expect(readActiveOrgSeatBillingOperation(env(db), 42)).resolves.toEqual({
      kind: "ok",
      operation: expect.objectContaining({
        operationId: "op-regressed",
        state: "stripe_applied",
        attempts: 2,
        errorCode: "stripe_quantity_regressed",
        nextAttemptAtMs: 10_010,
      }),
    })
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        observedQuantity: 2,
        derivedQuantity: 3,
        revision: 1,
        snapshotState: "review_required",
      }),
    })
    await expect(
      db.prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = 42 AND login = 'alice'").first(),
    ).resolves.toBeNull()
    await db.prepare("UPDATE org_seat_billing_operation SET attempts = 99 WHERE operation_id = 'op-regressed'").run()
    await expect(deferOrgSeatBillingOperation(env(db), deferArgs)).resolves.toEqual({
      kind: "deferred",
      attempts: 100,
      nextAttemptAtMs: 300_010,
    })
  })
})
