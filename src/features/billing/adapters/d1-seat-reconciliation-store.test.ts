import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  acquireOrgSeatBillingLease,
  readActiveOrgSeatBillingOperation,
  readStripeSeatSubscription,
  readTenantBillingState,
  releaseOrgSeatBillingLease,
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
