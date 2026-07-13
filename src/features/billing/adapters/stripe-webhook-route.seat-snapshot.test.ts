import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import worker from "@/src/index"
import { readStripeSeatSubscription } from "@/src/features/billing"
import { signStripeBody } from "@/src/features/billing/adapters/stripe-sign.test-helpers"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const WEBHOOK_SECRET = "whsec_seat_snapshot"
const STRIPE_SECRET = "sk_test_seat_snapshot"
const NOW_SECONDS = 1_800_000_000

function migration(name: string): string {
  return readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")
}

function makeKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value)
      },
      delete: async (key: string) => {
        store.delete(key)
      },
    } as unknown as KVNamespace,
  }
}

async function makeEnv(): Promise<{ env: Env; db: D1Database; store: Map<string, string> }> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0011_add_tenant_subscription_status.sql",
    "0012_add_tenant_billing_source.sql",
    "0020_create_stripe_seat_reconciliation.sql",
  ]) {
    await db.exec(migration(name))
  }
  const { kv, store } = makeKv()
  return {
    db,
    store,
    env: {
      SIGILIX_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SIGILIX_STRIPE_SECRET_KEY: STRIPE_SECRET,
      SIGILIX_STRIPE_PRICE_PRO: "price_pro_month",
      SIGILIX_STRIPE_PRICE_TEAMS: "price_teams_month",
      SIGILIX_STRIPE_PRICE_MAX: "price_max_month",
      SIGILIX_STRIPE_PRICE_ULTRA: "price_ultra_month",
      SIGILIX_STRIPE_PRICE_PRO_ANNUAL: "price_pro_year",
      SIGILIX_STRIPE_PRICE_TEAMS_ANNUAL: "price_teams_year",
      SIGILIX_STRIPE_PRICE_MAX_ANNUAL: "price_max_year",
      SIGILIX_STRIPE_PRICE_ULTRA_ANNUAL: "price_ultra_year",
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_STATE: kv,
    } as unknown as Env,
  }
}

async function signedRequest(body: unknown): Promise<Request> {
  const rawBody = JSON.stringify(body)
  const signature = await signStripeBody(rawBody, WEBHOOK_SECRET, NOW_SECONDS)
  return new Request("https://api.sigilix.ai/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: rawBody,
  })
}

function installStripeFetch(args: {
  subscriptionId: string
  customerId: string
  status?: "active" | "trialing"
  created?: number
  itemId: string
  priceId: string
  quantity: number
  interval: "month" | "year"
}) {
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString())
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`)
      if (url.pathname === "/v1/subscriptions") {
        return Response.json({
          object: "list",
          has_more: false,
          data: [
            {
              id: args.subscriptionId,
              customer: args.customerId,
              status: args.status ?? "active",
              created: args.created ?? 100,
              items: { data: [{ price: { id: args.priceId } }] },
            },
          ],
        })
      }
      if (url.pathname === "/v1/subscription_items") {
        expect(url.searchParams.get("subscription")).toBe(args.subscriptionId)
        return Response.json({
          object: "list",
          has_more: false,
          data: [
            {
              id: args.itemId,
              quantity: args.quantity,
              price: {
                id: args.priceId,
                lookup_key: null,
                nickname: null,
                recurring: { interval: args.interval, interval_count: 1, usage_type: "licensed" },
              },
            },
          ],
        })
      }
      throw new Error(`unexpected Stripe call ${init?.method ?? "GET"} ${url.pathname}`)
    }),
  )
  return calls
}

function subscriptionEvent(args: {
  id: string
  subscriptionId: string
  customerId: string
  installationId: number
  priceId: string
  status?: "active" | "trialing"
}) {
  return {
    id: args.id,
    created: NOW_SECONDS,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: args.subscriptionId,
        customer: args.customerId,
        status: args.status ?? "active",
        metadata: { installation_id: String(args.installationId) },
        items: { data: [{ price: { id: args.priceId } }] },
      },
    },
  }
}

describe("Stripe webhook seat-capacity snapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SECONDS * 1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    { label: "monthly", priceId: "price_pro_month", interval: "month" as const, quantity: 4 },
    { label: "annual", priceId: "price_max_year", interval: "year" as const, quantity: 7 },
  ])("materializes the exact $label item and capacity through worker.fetch", async (fixture) => {
    const { env, db, store } = await makeEnv()
    const calls = installStripeFetch({
      subscriptionId: `sub_${fixture.label}`,
      customerId: `cus_${fixture.label}`,
      itemId: `si_${fixture.label}`,
      priceId: fixture.priceId,
      quantity: fixture.quantity,
      interval: fixture.interval,
    })
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

    const response = await worker.fetch(
      await signedRequest(
        subscriptionEvent({
          id: `evt_${fixture.label}`,
          subscriptionId: `sub_${fixture.label}`,
          customerId: `cus_${fixture.label}`,
          installationId: fixture.label === "monthly" ? 42 : 43,
          priceId: fixture.priceId,
        }),
      ),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    const installationId = fixture.label === "monthly" ? 42 : 43
    await expect(readStripeSeatSubscription({ SIGILIX_PLATFORM_DB: db }, installationId)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        stripeCustomerId: `cus_${fixture.label}`,
        stripeSubscriptionId: `sub_${fixture.label}`,
        stripeSubscriptionItemId: `si_${fixture.label}`,
        stripePriceId: fixture.priceId,
        subscriptionStatus: "active",
        observedQuantity: fixture.quantity,
        derivedQuantity: fixture.quantity,
        snapshotState: "ready",
        revision: 1,
      }),
    })
    expect(store.get(`stripe-customer:cus_${fixture.label}`)).toBe(String(installationId))
    expect(store.get(`stripe-installation:${installationId}`)).toBe(`cus_${fixture.label}`)
    expect(calls).toEqual(["GET /v1/subscriptions", "GET /v1/subscription_items"])
  })

  it("rejects a second customer claiming an installation already bound in D1", async () => {
    const { env, db, store } = await makeEnv()
    await db
      .prepare(
        "INSERT INTO tenant" +
          " (installation_id, tier, subscription_status, billing_source, created_at, updated_at)" +
          " VALUES (42, 'free', 'canceled', 'stripe', 't', 't')",
      )
      .run()
    await db
      .prepare(
        `INSERT INTO stripe_seat_subscription
          (installation_id, stripe_customer_id, derived_quantity, revision, snapshot_state,
           created_at_ms, updated_at_ms)
         VALUES (42, 'cus_bound', 0, 1, 'not_applicable', 1, 1)`,
      )
      .run()
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

    const response = await worker.fetch(
      await signedRequest(
        subscriptionEvent({
          id: "evt_intruder",
          subscriptionId: "sub_intruder",
          customerId: "cus_intruder",
          installationId: 42,
          priceId: "price_pro_month",
        }),
      ),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    expect((await response.text()).trim()).toBe("installation conflict")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.get("stripe-installation:42")).not.toBe("cus_intruder")
    await expect(readStripeSeatSubscription({ SIGILIX_PLATFORM_DB: db }, 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({ stripeCustomerId: "cus_bound", snapshotState: "not_applicable" }),
    })
  })

  it("never lets a stale Stripe cancellation downgrade a legacy entitlement", async () => {
    const { env, db, store } = await makeEnv()
    await db
      .prepare(
        "INSERT INTO tenant" +
          " (installation_id, tier, subscription_status, billing_source, created_at, updated_at)" +
          " VALUES (42, 'max', 'active', 'legacy_entitlement', 't', 't')",
      )
      .run()
    store.set("stripe-customer:cus_legacy", "42")
    store.set("stripe-installation:42", "cus_legacy")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ object: "list", data: [], has_more: false })),
    )
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

    const response = await worker.fetch(
      await signedRequest({
        id: "evt_legacy_stale",
        created: NOW_SECONDS - 600,
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_legacy",
            status: "canceled",
            metadata: { installation_id: "42" },
          },
        },
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    await expect(
      db
        .prepare("SELECT tier, billing_source FROM tenant WHERE installation_id = 42")
        .first<{ tier: string; billing_source: string }>(),
    ).resolves.toEqual({ tier: "max", billing_source: "legacy_entitlement" })
    await expect(readStripeSeatSubscription({ SIGILIX_PLATFORM_DB: db }, 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({
        stripeCustomerId: "cus_legacy",
        snapshotState: "not_applicable",
        observedQuantity: null,
      }),
    })
  })
})
