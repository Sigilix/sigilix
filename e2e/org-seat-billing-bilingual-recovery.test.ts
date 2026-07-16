import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dispatchJob } from "@/src/index-dispatch"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const NOW_MS = 1_784_200_000_000
const PRICE_ID = "price_pro_monthly"

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0007_create_org_seat_assignment.sql",
    "0011_add_tenant_subscription_status.sql",
    "0012_add_tenant_billing_source.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
    "0031_create_org_activity_seat_assignment.sql",
    "0032_extend_org_seat_billing_operation_activity_identity.sql",
  ]) {
    await db.exec(migration(name))
  }
  await db
    .prepare(
      `INSERT INTO tenant
        (installation_id, tier, subscription_status, billing_source, created_at, updated_at)
       VALUES
        (42, 'pro', 'active', 'stripe', 't', 't'),
        (43, 'pro', 'active', 'stripe', 't', 't')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO stripe_seat_subscription
        (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         stripe_price_id, subscription_status, observed_quantity, derived_quantity, revision,
         snapshot_state, last_refreshed_at_ms, created_at_ms, updated_at_ms)
       VALUES
        (42, 'cus_42', 'sub_42', 'si_42', ?, 'active', 1, 1, 1, 'ready', 1, 1, 1),
        (43, 'cus_43', 'sub_43', 'si_43', ?, 'active', 1, 1, 1, 'ready', 1, 1, 1)`,
    )
    .bind(PRICE_ID, PRICE_ID)
    .run()
  await db
    .prepare(
      `INSERT INTO org_seat_assignment
        (installation_id, login, assigned, is_admin, updated_at, updated_by)
       VALUES (43, 'shared-login', 0, 0, 'legacy-untouched', 'preserve-legacy')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO org_activity_seat_assignment
        (installation_id, github_user_id, assigned, is_admin, last_known_login,
         created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login)
       VALUES
        (42, '222', 0, 0, 'foreign-activity', 'activity-untouched', 'activity-untouched',
         '444', 'foreign-admin')`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO org_seat_billing_operation
        (operation_id, installation_id, revision, login, target_identity_kind,
         target_github_user_id, activity_actor_github_user_id, actor_login, target_is_admin,
         requested_assigned, previous_assigned, desired_quantity, state,
         stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
         idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
       VALUES
        ('op-legacy', 42, 2, 'shared-login', 'legacy_login', NULL, NULL, 'legacy-admin', 0,
         1, 0, 2, 'pending', 'sub_42', 'si_42', 1, 'seat-42-legacy', 0, 1, 1, 1),
        ('op-activity', 43, 2, 'shared-login', 'activity_github', '222', '333', 'activity-admin', 1,
         1, 0, 2, 'pending', 'sub_43', 'si_43', 1, 'seat-43-activity', 0, 1, 1, 1)`,
    )
    .run()
  return db
}

function makeEnv(db: D1Database): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_STRIPE_SECRET_KEY: "sk_test_secret",
    SIGILIX_STRIPE_PRICE_PRO: PRICE_ID,
  } as Env
}

function stripeItem(subscriptionItemId: string, quantity: number): object {
  return {
    id: subscriptionItemId,
    quantity,
    price: {
      id: PRICE_ID,
      lookup_key: null,
      nickname: null,
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    },
  }
}

function stubStripe(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === "https://api.stripe.com/v1/subscription_items?subscription=sub_42&limit=100") {
      expect(init?.method).toBe("GET")
      return Response.json({ data: [stripeItem("si_42", 1)], has_more: false })
    }
    if (url === "https://api.stripe.com/v1/subscription_items/si_42") {
      expect(init?.method).toBe("POST")
      expect(init?.headers).toMatchObject({ "idempotency-key": "seat-42-legacy" })
      expect(String(init?.body)).toContain("quantity=2")
      return Response.json({ id: "si_42", quantity: 2 })
    }
    if (url === "https://api.stripe.com/v1/subscription_items?subscription=sub_43&limit=100") {
      expect(init?.method).toBe("GET")
      return Response.json({ data: [stripeItem("si_43", 3)], has_more: false })
    }
    throw new Error(`unexpected Stripe request: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("bilingual durable seat recovery through the real queue dispatcher", () => {
  it("recovers legacy and immutable activity identities without crossing installations", async () => {
    const db = await makeDb()
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    const fetchMock = stubStripe()

    await dispatchJob({ type: "org-seat-billing-reconcile", installationId: 42, operationId: "op-legacy" }, makeEnv(db))
    await dispatchJob(
      { type: "org-seat-billing-reconcile", installationId: 43, operationId: "op-activity" },
      makeEnv(db),
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1)
    await expect(
      db
        .prepare(
          `SELECT installation_id, login, assigned, is_admin, updated_at, updated_by
             FROM org_seat_assignment WHERE login = 'shared-login' ORDER BY installation_id`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          installation_id: 42,
          login: "shared-login",
          assigned: 1,
          is_admin: 0,
          updated_at: new Date(NOW_MS).toISOString(),
          updated_by: "legacy-admin",
        },
        {
          installation_id: 43,
          login: "shared-login",
          assigned: 0,
          is_admin: 0,
          updated_at: "legacy-untouched",
          updated_by: "preserve-legacy",
        },
      ],
    })
    await expect(
      db
        .prepare(
          `SELECT installation_id, github_user_id, assigned, is_admin, last_known_login,
                  created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login
             FROM org_activity_seat_assignment WHERE github_user_id = '222' ORDER BY installation_id`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          installation_id: 42,
          github_user_id: "222",
          assigned: 0,
          is_admin: 0,
          last_known_login: "foreign-activity",
          created_at: "activity-untouched",
          updated_at: "activity-untouched",
          updated_by_actor_github_user_id: "444",
          updated_by_actor_login: "foreign-admin",
        },
        {
          installation_id: 43,
          github_user_id: "222",
          assigned: 1,
          is_admin: 1,
          last_known_login: "shared-login",
          created_at: new Date(NOW_MS).toISOString(),
          updated_at: new Date(NOW_MS).toISOString(),
          updated_by_actor_github_user_id: "333",
          updated_by_actor_login: "activity-admin",
        },
      ],
    })
    await expect(
      db
        .prepare(
          `SELECT installation_id, operation_id, revision, state, stripe_observed_quantity,
                  activity_actor_github_user_id, completed_at_ms
             FROM org_seat_billing_operation ORDER BY installation_id`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          installation_id: 42,
          operation_id: "op-legacy",
          revision: 2,
          state: "committed",
          stripe_observed_quantity: 2,
          activity_actor_github_user_id: null,
          completed_at_ms: NOW_MS,
        },
        {
          installation_id: 43,
          operation_id: "op-activity",
          revision: 2,
          state: "committed",
          stripe_observed_quantity: 2,
          activity_actor_github_user_id: "333",
          completed_at_ms: NOW_MS,
        },
      ],
    })
    await expect(
      db
        .prepare(
          `SELECT installation_id, observed_quantity, derived_quantity, revision
             FROM stripe_seat_subscription ORDER BY installation_id`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        { installation_id: 42, observed_quantity: 2, derived_quantity: 2, revision: 2 },
        { installation_id: 43, observed_quantity: 3, derived_quantity: 3, revision: 2 },
      ],
    })
    await expect(db.prepare("SELECT COUNT(*) AS leases FROM org_seat_billing_lease").first()).resolves.toEqual({
      leases: 0,
    })
  })
})
