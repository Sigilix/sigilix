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

function env(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_STRIPE_SECRET_KEY: "sk_test_secret",
    SIGILIX_STRIPE_PRICE_PRO: PRICE_ID,
    ...overrides,
  } as Env
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0011_add_tenant_subscription_status.sql"))
  await db.exec(migration("0012_add_tenant_billing_source.sql"))
  await db.exec(migration("0007_create_org_seat_assignment.sql"))
  await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
  await db.exec(migration("0022_create_org_workspace_access.sql"))
  await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
  await db.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
  await db.exec(migration("0032_extend_org_seat_billing_operation_activity_identity.sql"))
  await db.exec(migration("0033_create_org_activity_seat_readiness.sql"))
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

async function seedManagedAccess(
  db: D1Database,
  args: { githubUserId: string; role?: "admin" | "member" },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', NULL,
               'github:owner', ?, 'member_added_or_regranted')`,
    )
    .bind(INSTALLATION_ID, args.githubUserId, args.role ?? "member", `audit-${INSTALLATION_ID}-${args.githubUserId}`)
    .run()
}

async function seedManagedAssignment(
  db: D1Database,
  args: { githubUserId: string; lastKnownLogin: string; assigned?: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_seat_assignment
        (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 'github:owner')`,
    )
    .bind(INSTALLATION_ID, args.githubUserId, args.assigned === false ? 0 : 1, args.lastKnownLogin)
    .run()
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

function stubStripeUpdateFailure(quantity: number): ReturnType<typeof vi.fn> {
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
      return new Response(JSON.stringify({ error: { message: "try again" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

async function startPendingManagedExpansion(
  db: D1Database,
  args: { githubUserId?: string; lastKnownLogin?: string } = {},
): Promise<{ operationId: string; fetchMock: ReturnType<typeof vi.fn> }> {
  const githubUserId = args.githubUserId ?? "111"
  const lastKnownLogin = args.lastKnownLogin ?? "shared-login"
  await seedManagedAccess(db, { githubUserId })
  await seedManagedAccess(db, { githubUserId: "222" })
  await seedManagedAccess(db, { githubUserId: "333" })
  await seedManagedAssignment(db, { githubUserId: "222", lastKnownLogin: "shared-login" })
  await seedManagedAssignment(db, { githubUserId: "333", lastKnownLogin: "third-member" })
  const fetchMock = stubStripeUpdateFailure(2)
  const result = await reconcileOrgSeatAssignment(env(db, { OPENCLAW_ORG_MEMBERSHIP_MODE: "on" }), {
    installationId: INSTALLATION_ID,
    target: { kind: "managed_github", githubUserId, lastKnownLogin },
    requestedAssigned: true,
    actorLogin: "owner",
  })
  expect(result).toMatchObject({ kind: "pending", assigned: false })
  if (result.kind !== "pending") throw new Error("managed expansion was not persisted")
  return { operationId: result.operationId, fetchMock }
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
        target: { kind: "legacy_login", login: "alice", targetIsAdmin: false },
        requestedAssigned: false,
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
        target: { kind: "legacy_login", login: "charlie", targetIsAdmin: false },
        requestedAssigned: true,
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
        target: { kind: "legacy_login", login: "charlie", targetIsAdmin: false },
        requestedAssigned: false,
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

  it("unassigns the same managed GitHub identity after its display login changes", async () => {
    const db = await makeDb()
    await seedManagedAccess(db, { githubUserId: "111" })
    await seedManagedAssignment(db, { githubUserId: "111", lastKnownLogin: "old-login" })
    const fetchMock = vi.fn(() => Promise.reject(new Error("Stripe must not be called")))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      reconcileOrgSeatAssignment(env(db, { OPENCLAW_ORG_MEMBERSHIP_MODE: "on" }), {
        installationId: INSTALLATION_ID,
        target: { kind: "managed_github", githubUserId: "111", lastKnownLogin: "renamed-login" },
        requestedAssigned: false,
        actorLogin: "owner",
      }),
    ).resolves.toMatchObject({ kind: "applied", assigned: false })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(
      db
        .prepare(
          "SELECT github_user_id, assigned, last_known_login FROM org_workspace_seat_assignment" +
            " WHERE installation_id = ?",
        )
        .bind(INSTALLATION_ID)
        .all(),
    ).resolves.toMatchObject({
      results: [{ github_user_id: "111", assigned: 0, last_known_login: "renamed-login" }],
    })
  })

  it("persists managed expansion identity and a v2 Stripe idempotency key", async () => {
    const db = await makeDb()
    const { operationId, fetchMock } = await startPendingManagedExpansion(db, {
      lastKnownLogin: "renamed-target",
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(
      db
        .prepare(
          `SELECT operation_id, login, target_identity_kind, target_github_user_id,
                  idempotency_key, state
             FROM org_seat_billing_operation WHERE operation_id = ?`,
        )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({
      operation_id: operationId,
      login: "renamed-target",
      target_identity_kind: "managed_github",
      target_github_user_id: "111",
      idempotency_key: `sigilix-seat-v2-${operationId}`,
      state: "pending",
    })
  })

  it("recovers a managed expansion from persisted identity after membership mode flips off", async () => {
    const db = await makeDb()
    const { operationId } = await startPendingManagedExpansion(db, {
      lastKnownLogin: "persisted-login",
    })
    const recoveryFetch = stubLiveStripe(3)

    await recoverOrgSeatBillingOperation(env(db, { OPENCLAW_ORG_MEMBERSHIP_MODE: "off" }), {
      type: "org-seat-billing-reconcile",
      installationId: INSTALLATION_ID,
      operationId,
    })

    expect(recoveryFetch).toHaveBeenCalledTimes(1)
    expect(String(recoveryFetch.mock.calls[0]?.[0])).toContain("/v1/subscription_items?")
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = ?").bind(operationId).first(),
    ).resolves.toEqual({ state: "committed" })
    await expect(
      db
        .prepare(
          "SELECT assigned, last_known_login FROM org_workspace_seat_assignment" +
            " WHERE installation_id = ? AND github_user_id = '111'",
        )
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 1, last_known_login: "persisted-login" })
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'persisted-login'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toBeNull()
  })

  it("keeps a same-login managed operation busy when the immutable GitHub target differs", async () => {
    const db = await makeDb()
    const { operationId, fetchMock } = await startPendingManagedExpansion(db, {
      githubUserId: "111",
      lastKnownLogin: "shared-login",
    })

    await expect(
      reconcileOrgSeatAssignment(env(db, { OPENCLAW_ORG_MEMBERSHIP_MODE: "on" }), {
        installationId: INSTALLATION_ID,
        target: { kind: "managed_github", githubUserId: "222", lastKnownLogin: "shared-login" },
        requestedAssigned: false,
        actorLogin: "owner",
      }),
    ).resolves.toEqual({ kind: "busy" })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = ?").bind(operationId).first(),
    ).resolves.toEqual({ state: "pending" })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment" +
            " WHERE installation_id = ? AND github_user_id = '222'",
        )
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 1 })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment" +
            " WHERE installation_id = ? AND github_user_id = '111'",
        )
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toBeNull()
  })

  it("refuses to unassign the sole, and therefore last, assigned active managed admin", async () => {
    const db = await makeDb()
    await seedManagedAccess(db, { githubUserId: "111", role: "admin" })
    await seedManagedAssignment(db, { githubUserId: "111", lastKnownLogin: "owner" })
    const fetchMock = vi.fn(() => Promise.reject(new Error("Stripe must not be called")))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      reconcileOrgSeatAssignment(env(db, { OPENCLAW_ORG_MEMBERSHIP_MODE: "on" }), {
        installationId: INSTALLATION_ID,
        target: { kind: "managed_github", githubUserId: "111", lastKnownLogin: "owner-renamed" },
        requestedAssigned: false,
        actorLogin: "owner",
      }),
    ).resolves.toEqual({ kind: "last_admin" })

    expect(fetchMock).not.toHaveBeenCalled()
    await expect(
      db
        .prepare(
          "SELECT assigned, last_known_login FROM org_workspace_seat_assignment" +
            " WHERE installation_id = ? AND github_user_id = '111'",
        )
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 1, last_known_login: "owner" })
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
