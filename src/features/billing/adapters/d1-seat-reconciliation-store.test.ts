import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  acquireOrgSeatBillingLease,
  claimStripeSeatSubscriptionBinding,
  ensureSeatReconciliationTenant,
  readStripeCustomerBinding,
  readStripeInstallationBinding,
  readActiveOrgSeatBillingOperation,
  readStripeSeatSubscription,
  readTenantBillingState,
  releaseOrgSeatBillingLease,
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

describe("D1 seat reconciliation store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(migration("0001_create_tenant_repo_usage.sql"))
    await db.exec(migration("0007_create_org_seat_assignment.sql"))
    await db.exec(migration("0011_add_tenant_subscription_status.sql"))
    await db.exec(migration("0012_add_tenant_billing_source.sql"))
    await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
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
          (operation_id, installation_id, revision, login, requested_assigned, previous_assigned,
           desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
           stripe_observed_quantity, idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-1', 42, 1, 'alice', 0, 1, 2, 'pending', 'sub_42', 'si_42', 3,
                 'seat-42-1', 0, 2, 1, 1)`,
      )
      .run()
    await expect(readActiveOrgSeatBillingOperation(env(db), 42)).resolves.toEqual({
      kind: "ok",
      operation: expect.objectContaining({
        login: "alice",
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
})
