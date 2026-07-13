// sig-billing-dup-sub-guard: end-to-end for the single-active-subscription webhook guard.
// Exercises the real verify → interpret → KV-link → LIST/CANCEL (mocked Stripe fetch) →
// D1 tenant.tier UPSERT path. The Stripe REST calls (GET /v1/subscriptions, DELETE
// /v1/subscriptions/:id) are mocked via a stubbed global fetch — the ONLY fetch the
// webhook path makes (signature verify uses Web Crypto, tenant writes use the D1 shim).

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleStripeWebhookRoute } from "@/src/features/billing/adapters/stripe-webhook-route"
import { signStripeBody } from "@/src/features/billing/adapters/stripe-sign.test-helpers"
import type { Env } from "@/src/shared/types/env"

const SECRET = "whsec_test"
const STRIPE_KEY = "sk_test_dedupe"
const NOW = 1_700_000_000
const MIGRATION_SQL = [
  readFileSync(new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../../../migrations/0011_add_tenant_subscription_status.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../../../migrations/0012_add_tenant_billing_source.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../../../../migrations/0020_create_stripe_seat_reconciliation.sql", import.meta.url), "utf8"),
].join("\n")

function makeKv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

async function makeEnv() {
  const db = makeD1()
  await db.exec(MIGRATION_SQL)
  const { kv, store } = makeKv()
  const env = {
    SIGILIX_STRIPE_WEBHOOK_SECRET: SECRET,
    SIGILIX_STRIPE_SECRET_KEY: STRIPE_KEY,
    SIGILIX_STRIPE_PRICE_PRO: "price_pro",
    SIGILIX_STRIPE_PRICE_TEAMS: "price_teams",
    SIGILIX_STRIPE_PRICE_MAX: "price_max",
    SIGILIX_STRIPE_PRICE_ULTRA: "price_ultra",
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_STATE: kv,
  } as unknown as Env
  return { env, db, store }
}

async function signedReq(body: unknown): Promise<Request> {
  const raw = JSON.stringify(body)
  const header = await signStripeBody(raw, SECRET, NOW)
  return new Request("https://api.sigilix.ai/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: raw,
  })
}

async function readTier(db: D1Database, installationId: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT tier FROM tenant WHERE installation_id = ?")
    .bind(installationId)
    .first<{ tier: string }>()
  return row?.tier ?? null
}

/** A subscription as the mocked Stripe list returns it (`status` mutates on cancel). */
interface FakeSub {
  id: string
  status: string
  created: number
  priceId: string
}

interface StripeState {
  subs: Record<string, FakeSub[]>
  deleted: string[]
  failCancel?: boolean
  failList?: boolean
}

/**
 * Stub global fetch so the ONLY outbound calls (Stripe list + cancel) are served locally.
 * A successful DELETE mutates the subscription's status to "canceled" so a subsequent list
 * reflects Stripe reality (the survivor is then the sole active sub).
 */
function installStripeFetch(state: StripeState) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    const u = new URL(urlStr)
    const method = init?.method ?? "GET"
    if (u.pathname === "/v1/subscriptions" && method === "GET") {
      if (state.failList) return new Response("boom", { status: 500 })
      const customer = u.searchParams.get("customer") ?? ""
      const data = (state.subs[customer] ?? []).map((s) => ({
        id: s.id,
        status: s.status,
        created: s.created,
        items: { data: [{ price: { id: s.priceId } }] },
      }))
      return new Response(JSON.stringify({ object: "list", data, has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (u.pathname === "/v1/subscription_items" && method === "GET") {
      const subscriptionId = u.searchParams.get("subscription") ?? ""
      const subscription = Object.values(state.subs)
        .flat()
        .find((candidate) => candidate.id === subscriptionId)
      const data = subscription
        ? [
            {
              id: `si_${subscription.id}`,
              quantity: subscription.priceId === "price_teams" ? 10 : 1,
              price: {
                id: subscription.priceId,
                lookup_key: null,
                nickname: null,
                recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              },
            },
          ]
        : []
      return new Response(JSON.stringify({ object: "list", data, has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (u.pathname.startsWith("/v1/subscriptions/") && method === "DELETE") {
      const id = decodeURIComponent(u.pathname.slice("/v1/subscriptions/".length))
      if (state.failCancel) {
        return new Response(JSON.stringify({ error: { message: "cannot cancel" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        })
      }
      state.deleted.push(id)
      for (const list of Object.values(state.subs)) {
        for (const s of list) if (s.id === id) s.status = "canceled"
      }
      return new Response(JSON.stringify({ id, status: "canceled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected stripe call ${method} ${u.pathname}`)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

/** A subscription.created event body (active) — the trigger for the dedupe guard. */
function subCreatedEvent(id: string, customerId: string, installationId: number, priceId: string) {
  return {
    id: `evt_${id}`,
    type: "customer.subscription.created",
    data: {
      object: {
        id,
        status: "active",
        customer: customerId,
        metadata: { installation_id: String(installationId) },
        items: { data: [{ price: { id: priceId } }] },
      },
    },
  }
}

/** Two active subs on one customer: sub_old (max, older) + sub_new (pro, newer). */
function twoActiveDup(): StripeState {
  return {
    subs: {
      cus_DUP: [
        { id: "sub_old", status: "active", created: 100, priceId: "price_max" },
        { id: "sub_new", status: "active", created: 200, priceId: "price_pro" },
      ],
    },
    deleted: [],
  }
}

describe("stripe webhook — single active subscription guard", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    ;({ env, db } = await makeEnv())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("two active subs on ONE customer → newer cancelled, OLDEST kept + drives the tier", async () => {
    // The event is for the NEWER sub (as in the double-checkout race). Even though its own
    // price is 'pro', the surviving OLDEST sub ('max') must drive the tenant's tier.
    const state = twoActiveDup()
    const fetchMock = installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_new", "cus_DUP", 42, "price_pro")),
      env,
    )

    expect(res.status).toBe(200)
    expect(state.deleted).toEqual(["sub_new"]) // newer cancelled; older survivor NOT
    expect(await readTier(db, 42)).toBe("max") // driven by the surviving (oldest) sub
    expect(fetchMock).toHaveBeenCalledTimes(4) // list + two item reads + one cancel
  })

  it("checkout.session.completed with an EXPANDED active dup also routes through the guard", async () => {
    // A double-checkout race can surface the newer sub via checkout.session.completed
    // (expanded, active) — it must NOT bypass the guard and set the cancelled dup's 'pro'.
    const state = twoActiveDup()
    installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "evt_checkout_dup",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_DUP",
            client_reference_id: "42",
            subscription: { id: "sub_new", status: "active", items: { data: [{ price: { id: "price_pro" } }] } },
          },
        },
      }),
      env,
    )

    expect(res.status).toBe(200)
    expect(state.deleted).toEqual(["sub_new"]) // the newer dup is cancelled
    expect(await readTier(db, 42)).toBe("max") // survivor drives tier, not the checkout's 'pro'
  })

  it("stale duplicate event AFTER the dup was already cancelled → survivor still drives tier (no overwrite)", async () => {
    // The older sub's event landed first and cancelled sub_new; Stripe now (re)delivers the
    // sub_new.created event with its original active payload. The webhook must ignore that
    // stale 'pro' payload and keep the surviving 'max' tier — NOT overwrite it.
    const state: StripeState = {
      subs: {
        cus_DUP: [
          { id: "sub_old", status: "active", created: 100, priceId: "price_max" },
          { id: "sub_new", status: "canceled", created: 200, priceId: "price_pro" }, // already cancelled
        ],
      },
      deleted: [],
    }
    installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_new", "cus_DUP", 42, "price_pro")),
      env,
    )

    expect(res.status).toBe(200)
    expect(state.deleted).toEqual([]) // nothing to cancel (only the survivor is live)
    expect(await readTier(db, 42)).toBe("max") // survivor's tier, not the stale 'pro'
  })

  it("an older unrelated subscription never displaces or cancels the configured Sigilix subscription", async () => {
    const state: StripeState = {
      subs: {
        cus_DUP: [
          { id: "sub_old", status: "active", created: 100, priceId: "price_grandfathered" },
          { id: "sub_new", status: "active", created: 200, priceId: "price_pro" },
        ],
      },
      deleted: [],
    }
    installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_new", "cus_DUP", 88, "price_pro")),
      env,
    )

    expect(res.status).toBe(200)
    expect(state.deleted).toEqual([])
    expect(await readTier(db, 88)).toBe("pro")
  })

  it("stale active event but Stripe shows NO live subscription → records free provider truth", async () => {
    // An out-of-order / late subscription.created arrives after every sub was cancelled: the
    // live list is empty. The stale 'active' payload must NOT re-upgrade the tenant.
    const state: StripeState = {
      subs: { cus_GONE: [{ id: "sub_gone", status: "canceled", created: 100, priceId: "price_pro" }] },
      deleted: [],
    }
    installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_gone", "cus_GONE", 71, "price_pro")),
      env,
    )

    expect(res.status).toBe(200)
    expect(state.deleted).toEqual([]) // nothing to cancel
    expect(await readTier(db, 71)).toBe("free") // tenant is never upgraded from the stale payload
  })

  it("the subscription.deleted for a dup WE cancelled does NOT downgrade the surviving tenant", async () => {
    const state = twoActiveDup()
    installStripeFetch(state)
    await handleStripeWebhookRoute(await signedReq(subCreatedEvent("sub_new", "cus_DUP", 42, "price_pro")), env)
    expect(await readTier(db, 42)).toBe("max")

    // Stripe now delivers subscription.deleted for the dup we cancelled — the survivor
    // (sub_old, still active in the mocked list) must keep the tenant on 'max'.
    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "evt_del_dup",
        type: "customer.subscription.deleted",
        data: {
          object: { id: "sub_new", status: "canceled", customer: "cus_DUP", metadata: { installation_id: "42" } },
        },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(await readTier(db, 42)).toBe("max") // NEVER downgraded to free
  })

  it("invoice.payment_failed while an active survivor still bills → NOT downgraded to free", async () => {
    // Seed a paid tenant with a single active sub, then a payment_failed arrives for the
    // customer while that sub is still active (e.g. a failed invoice on a cancelled dup that
    // races the cancellation). The live survivor must keep the tenant paid.
    const state: StripeState = {
      subs: { cus_PF: [{ id: "sub_pf", status: "active", created: 100, priceId: "price_pro" }] },
      deleted: [],
    }
    installStripeFetch(state)
    await handleStripeWebhookRoute(await signedReq(subCreatedEvent("sub_pf", "cus_PF", 33, "price_pro")), env)
    expect(await readTier(db, 33)).toBe("pro")

    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "evt_pf",
        type: "invoice.payment_failed",
        data: { object: { customer: "cus_PF", metadata: { installation_id: "33" } } },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(await readTier(db, 33)).toBe("pro") // survivor still active → never dropped
  })

  it("a genuine full cancellation (no survivor) → downgrades to free", async () => {
    // Seed a paid tenant with a single active sub, then cancel it for real.
    const state: StripeState = {
      subs: { cus_SOLO: [{ id: "sub_solo", status: "active", created: 100, priceId: "price_pro" }] },
      deleted: [],
    }
    installStripeFetch(state)
    await handleStripeWebhookRoute(await signedReq(subCreatedEvent("sub_solo", "cus_SOLO", 7, "price_pro")), env)
    expect(await readTier(db, 7)).toBe("pro")

    // The only sub is gone → no active survivor → downgrade to free is correct.
    state.subs.cus_SOLO = [{ id: "sub_solo", status: "canceled", created: 100, priceId: "price_pro" }]
    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "evt_del_solo",
        type: "customer.subscription.deleted",
        data: {
          object: { id: "sub_solo", status: "canceled", customer: "cus_SOLO", metadata: { installation_id: "7" } },
        },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(await readTier(db, 7)).toBe("free")
  })

  it("subscription.deleted while the survivor list read FAILS → 500 (fail closed, never a wrong downgrade)", async () => {
    const state = twoActiveDup()
    installStripeFetch(state)
    await handleStripeWebhookRoute(await signedReq(subCreatedEvent("sub_new", "cus_DUP", 42, "price_pro")), env)
    expect(await readTier(db, 42)).toBe("max")

    // A transient Stripe list outage during the paired deletion must NOT drop the tenant.
    state.failList = true
    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "evt_del_dup2",
        type: "customer.subscription.deleted",
        data: {
          object: { id: "sub_new", status: "canceled", customer: "cus_DUP", metadata: { installation_id: "42" } },
        },
      }),
      env,
    )
    expect(res.status).toBe(500) // Stripe redelivers; survivor's tier untouched
    expect(await readTier(db, 42)).toBe("max")
  })

  it("active event while the subscription list read FAILS → 500 (fail closed, no stale tier persisted)", async () => {
    const state = twoActiveDup()
    state.failList = true
    installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_new", "cus_DUP", 44, "price_pro")),
      env,
    )

    expect(res.status).toBe(500) // Stripe redelivers; no PAID tier written from an unverified list
    expect(await readTier(db, 44)).toBe("free")
  })

  it("a genuine single subscription → NO cancel call, tier from the event (happy path)", async () => {
    const state: StripeState = {
      subs: { cus_SOLO: [{ id: "sub_solo", status: "active", created: 100, priceId: "price_pro" }] },
      deleted: [],
    }
    const fetchMock = installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_solo", "cus_SOLO", 7, "price_pro")),
      env,
    )

    expect(res.status).toBe(200)
    expect(await readTier(db, 7)).toBe("pro")
    expect(state.deleted).toEqual([]) // no DELETE ever issued
    expect(fetchMock).toHaveBeenCalledTimes(2) // subscription list + exact item list
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.method ?? "GET").not.toBe("DELETE")
    }
  })

  it("cancel-API failure → webhook blocks the ambiguous snapshot and never applies a tier", async () => {
    const state = twoActiveDup()
    state.failCancel = true
    installStripeFetch(state)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_new", "cus_DUP", 55, "price_pro")),
      env,
    )

    expect(res.status).toBe(200) // permanent provider ambiguity is recorded, not retried forever
    expect(state.deleted).toEqual([]) // cancel failed → nothing actually cancelled
    expect(await readTier(db, 55)).toBe("free")
  })

  it("different customers with ONE sub each → untouched (no cross-customer cancellation)", async () => {
    const state: StripeState = {
      subs: {
        cus_X: [{ id: "sub_x", status: "active", created: 100, priceId: "price_pro" }],
        cus_Y: [{ id: "sub_y", status: "active", created: 100, priceId: "price_max" }],
      },
      deleted: [],
    }
    installStripeFetch(state)

    const resX = await handleStripeWebhookRoute(await signedReq(subCreatedEvent("sub_x", "cus_X", 1, "price_pro")), env)
    const resY = await handleStripeWebhookRoute(await signedReq(subCreatedEvent("sub_y", "cus_Y", 2, "price_max")), env)

    expect(resX.status).toBe(200)
    expect(resY.status).toBe(200)
    expect(await readTier(db, 1)).toBe("pro")
    expect(await readTier(db, 2)).toBe("max")
    expect(state.deleted).toEqual([]) // neither cancelled — each has exactly one
  })

  it("no outbound Stripe key → guard skipped entirely (behaviour unchanged, no Stripe call)", async () => {
    const { env: noKey, db: db2 } = await makeEnv()
    delete (noKey as { SIGILIX_STRIPE_SECRET_KEY?: string }).SIGILIX_STRIPE_SECRET_KEY
    const fetchMock = vi.fn(async () => {
      throw new Error("no Stripe call expected when the outbound key is unset")
    })
    vi.stubGlobal("fetch", fetchMock)

    const res = await handleStripeWebhookRoute(
      await signedReq(subCreatedEvent("sub_solo", "cus_NOKEY", 9, "price_pro")),
      noKey,
    )
    expect(res.status).toBe(200)
    expect(await readTier(db2, 9)).toBe("pro")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
