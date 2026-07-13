import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import {
  acquireOrgSeatBillingLease,
  createPendingOrgSeatExpansion,
  markOrgSeatExpansionStripeApplied,
  releaseOrgSeatBillingLease,
} from "./d1-seat-reconciliation-store"
import { reconcileOrgSeatAssignment, recoverOrgSeatBillingOperation } from "./org-seat-billing-reconciler"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { OrgSeatBillingOperation } from "@/src/features/billing/domain/seat-reconciliation"
import type { Env } from "@/src/shared/types/env"

const INSTALLATION_ID = 42
const NOW_MS = 1_784_000_000_000
const PRICE_ID = "price_pro_monthly"

const migration = (name: string): string =>
  readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")

function env(db: D1Database): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_STRIPE_SECRET_KEY: "sk_test_secret",
    SIGILIX_STRIPE_PRICE_PRO: PRICE_ID,
  } as Env
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0011_add_tenant_subscription_status.sql"))
  await db.exec(migration("0012_add_tenant_billing_source.sql"))
  await db.exec(migration("0007_create_org_seat_assignment.sql"))
  await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
  await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
  await db
    .prepare(
      `INSERT INTO tenant
        (installation_id, tier, subscription_status, billing_source, created_at, updated_at)
       VALUES (?, 'pro', 'active', 'stripe', 't', 't')`,
    )
    .bind(INSTALLATION_ID)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (7, ?, 'acme/api', 't')")
    .bind(INSTALLATION_ID)
    .run()
  for (const [prNumber, login] of [
    [1, "alice"],
    [2, "bob"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO usage_ledger
          (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)
         VALUES (?, 7, ?, ?, 1, 1, ?, 't')`,
      )
      .bind(INSTALLATION_ID, prNumber, `sha-${prNumber}`, login)
      .run()
  }
  await db
    .prepare(
      `INSERT INTO stripe_seat_subscription
        (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         stripe_price_id, subscription_status, observed_quantity, derived_quantity, revision,
         snapshot_state, last_refreshed_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'cus_42', 'sub_42', 'si_42', ?, 'active', 2, 2, 1, 'ready', ?, ?, ?)`,
    )
    .bind(INSTALLATION_ID, PRICE_ID, NOW_MS, NOW_MS, NOW_MS)
    .run()
  return db
}

function stripeItem(quantity: number): object {
  return {
    id: "si_42",
    quantity,
    price: {
      id: PRICE_ID,
      lookup_key: null,
      nickname: null,
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    },
  }
}

function stubLiveStripe(quantity: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === "https://api.stripe.com/v1/subscription_items?subscription=sub_42&limit=100") {
      expect(init?.method).toBe("GET")
      return new Response(JSON.stringify({ data: [stripeItem(quantity)], has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url === "https://api.stripe.com/v1/subscription_items/si_42") {
      expect(init?.method).toBe("POST")
      return new Response(JSON.stringify({ id: "si_42", quantity: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

async function seedPendingOperation(db: D1Database): Promise<OrgSeatBillingOperation> {
  const billingEnv = env(db)
  const leaseToken = "seed-lease"
  const lease = await acquireOrgSeatBillingLease(billingEnv, {
    installationId: INSTALLATION_ID,
    token: leaseToken,
    nowMs: NOW_MS,
    ttlMs: 60_000,
  })
  expect(lease.kind).toBe("acquired")
  const created = await createPendingOrgSeatExpansion(billingEnv, {
    installationId: INSTALLATION_ID,
    operationId: "op-expand-charlie",
    idempotencyKey: "sigilix-seat-op-expand-charlie",
    login: "charlie",
    actorLogin: "owner",
    targetIsAdmin: false,
    expectedAssignedQuantity: 2,
    desiredQuantity: 3,
    expectedSnapshotRevision: 1,
    subscriptionId: "sub_42",
    subscriptionItemId: "si_42",
    nextAttemptAtMs: NOW_MS + 30_000,
    leaseToken,
    leaseAcquiredAtMs: NOW_MS,
    nowMs: NOW_MS,
  })
  expect(created.kind).toBe("created")
  if (created.kind !== "created") throw new Error("pending operation was not created")
  await expect(
    releaseOrgSeatBillingLease(billingEnv, {
      installationId: INSTALLATION_ID,
      token: leaseToken,
      acquiredAtMs: NOW_MS,
    }),
  ).resolves.toEqual({ kind: "released" })
  return created.operation
}

async function readOperationState(db: D1Database): Promise<{ state: string; error_code: string | null }> {
  const row = await db
    .prepare("SELECT state, error_code FROM org_seat_billing_operation WHERE operation_id = 'op-expand-charlie'")
    .first<{ state: string; error_code: string | null }>()
  if (!row) throw new Error("missing operation")
  return row
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("organization seat billing reconciliation", () => {
  it("does not settle another member's active expansion during unassign", async () => {
    const db = await makeDb()
    await seedPendingOperation(db)
    const fetchMock = vi.fn(() => Promise.reject(new Error("Stripe must not be called")))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      reconcileOrgSeatAssignment(env(db), {
        installationId: INSTALLATION_ID,
        login: "alice",
        requestedAssigned: false,
        targetIsAdmin: false,
        actorLogin: "owner",
      }),
    ).resolves.toEqual({ kind: "busy" })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(readOperationState(db)).resolves.toEqual({ state: "pending", error_code: null })
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login IN ('alice', 'charlie')")
        .bind(INSTALLATION_ID)
        .all(),
    ).resolves.toMatchObject({ results: [] })
  })

  it("commits a response-lost expansion from live Stripe without posting the quantity twice", async () => {
    const db = await makeDb()
    await seedPendingOperation(db)
    const fetchMock = stubLiveStripe(5)

    await recoverOrgSeatBillingOperation(env(db), {
      type: "org-seat-billing-reconcile",
      installationId: INSTALLATION_ID,
      operationId: "op-expand-charlie",
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/subscription_items?")
    await expect(readOperationState(db)).resolves.toEqual({ state: "committed", error_code: null })
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'charlie'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 1 })
    await expect(
      db
        .prepare("SELECT observed_quantity, derived_quantity FROM stripe_seat_subscription WHERE installation_id = ?")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ observed_quantity: 5, derived_quantity: 5 })
  })

  it("uses provider capacity already ahead of the snapshot without issuing an update", async () => {
    const db = await makeDb()
    const fetchMock = stubLiveStripe(3)

    await expect(
      reconcileOrgSeatAssignment(env(db), {
        installationId: INSTALLATION_ID,
        login: "charlie",
        requestedAssigned: true,
        targetIsAdmin: false,
        actorLogin: "owner",
      }),
    ).resolves.toMatchObject({ kind: "applied", assigned: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'charlie'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 1 })
    await expect(
      db
        .prepare("SELECT observed_quantity, derived_quantity FROM stripe_seat_subscription WHERE installation_id = ?")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ observed_quantity: 3, derived_quantity: 3 })
  })

  it("unassigns locally while Stripe billing is inactive and never calls the provider", async () => {
    const db = await makeDb()
    await db
      .prepare(
        `INSERT INTO org_seat_assignment
          (installation_id, login, assigned, is_admin, updated_at, updated_by)
         VALUES (?, 'charlie', 1, 0, 't', 'owner')`,
      )
      .bind(INSTALLATION_ID)
      .run()
    await db
      .prepare("UPDATE tenant SET subscription_status = 'canceled' WHERE installation_id = ?")
      .bind(INSTALLATION_ID)
      .run()
    const fetchMock = vi.fn(() => Promise.reject(new Error("Stripe must not be called")))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      reconcileOrgSeatAssignment(env(db), {
        installationId: INSTALLATION_ID,
        login: "charlie",
        requestedAssigned: false,
        targetIsAdmin: false,
        actorLogin: "owner",
      }),
    ).resolves.toMatchObject({ kind: "applied", assigned: false })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'charlie'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 0 })
  })

  it("fails closed when a stripe-applied operation observes provider quantity regression", async () => {
    const db = await makeDb()
    const operation = await seedPendingOperation(db)
    const leaseToken = "mark-lease"
    await expect(
      acquireOrgSeatBillingLease(env(db), {
        installationId: INSTALLATION_ID,
        token: leaseToken,
        nowMs: NOW_MS,
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ kind: "acquired" })
    await expect(
      markOrgSeatExpansionStripeApplied(env(db), {
        installationId: INSTALLATION_ID,
        operationId: operation.operationId,
        revision: operation.revision,
        stripeObservedQuantity: 3,
        nextAttemptAtMs: NOW_MS + 30_000,
        leaseToken,
        leaseAcquiredAtMs: NOW_MS,
        nowMs: NOW_MS,
      }),
    ).resolves.toEqual({ kind: "written" })
    await releaseOrgSeatBillingLease(env(db), {
      installationId: INSTALLATION_ID,
      token: leaseToken,
      acquiredAtMs: NOW_MS,
    })
    const fetchMock = stubLiveStripe(2)

    await expect(
      recoverOrgSeatBillingOperation(env(db), {
        type: "org-seat-billing-reconcile",
        installationId: INSTALLATION_ID,
        operationId: operation.operationId,
      }),
    ).rejects.toThrow("provider quantity regressed")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(readOperationState(db)).resolves.toEqual({
      state: "stripe_applied",
      error_code: "provider_quantity_regressed",
    })
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'charlie'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toBeNull()
  })
})
