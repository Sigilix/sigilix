// SIG-41 — POST /stripe/webhook end-to-end. Exercises the real verify → interpret →
// KV-link → D1 tenant.tier UPSERT path through the shim D1 (migration 0001) + a KV mock.
// Fake timers pin the clock to NOW so the verifier's real Date.now() matches the signed
// timestamp (otherwise a 2023 timestamp would be rejected as out-of-tolerance).

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleStripeWebhookRoute } from "@/src/features/billing/adapters/stripe-webhook-route"
import { signStripeBody } from "@/src/features/billing/adapters/stripe-sign.test-helpers"
import type { Env } from "@/src/shared/types/env"

const SECRET = "whsec_test"
const NOW = 1_700_000_000
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

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

async function makeEnv(extra: Partial<Env> = {}) {
  const db = makeD1()
  await db.exec(MIGRATION_SQL)
  const { kv, store } = makeKv()
  const env = {
    SIGILIX_STRIPE_WEBHOOK_SECRET: SECRET,
    SIGILIX_STRIPE_PRICE_PRO: "price_pro",
    SIGILIX_STRIPE_PRICE_MAX: "price_max",
    SIGILIX_STRIPE_PRICE_ULTRA: "price_ultra",
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_STATE: kv,
    ...extra,
  } as unknown as Env
  return { env, db, store }
}

async function signedReq(body: unknown, secret = SECRET, timestamp = NOW): Promise<Request> {
  const raw = JSON.stringify(body)
  const header = await signStripeBody(raw, secret, timestamp)
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

describe("handleStripeWebhookRoute", () => {
  let env: Env
  let db: D1Database
  let store: Map<string, string>
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    ;({ env, db, store } = await makeEnv())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("503 when the webhook secret is unconfigured", async () => {
    const { env: bare } = await makeEnv()
    delete (bare as { SIGILIX_STRIPE_WEBHOOK_SECRET?: string }).SIGILIX_STRIPE_WEBHOOK_SECRET
    const res = await handleStripeWebhookRoute(await signedReq({ id: "e1", type: "invoice.paid" }), bare)
    expect(res.status).toBe(503)
  })

  it("400 on an invalid signature (body never processed)", async () => {
    const req = await signedReq(
      {
        id: "e_bad",
        type: "checkout.session.completed",
        data: {
          object: { customer: "c", client_reference_id: "1", line_items: { data: [{ price: { id: "price_pro" } }] } },
        },
      },
      "whsec_wrong",
    )
    const res = await handleStripeWebhookRoute(req, env)
    expect(res.status).toBe(400)
    expect(await readTier(db, 1)).toBeNull()
  })

  it("happy path: checkout.session.completed → tenant.tier upserted to the mapped tier", async () => {
    const req = await signedReq({
      id: "e_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_A",
          client_reference_id: "42",
          subscription: { status: "active", items: { data: [{ price: { id: "price_max" } }] } },
        },
      },
    })
    const res = await handleStripeWebhookRoute(req, env)
    expect(res.status).toBe(200)
    expect(await readTier(db, 42)).toBe("max")
    expect(store.get("stripe-customer:cus_A")).toBe("42")
  })

  it("subscription.deleted → downgrade to free (installation resolved via KV link)", async () => {
    await handleStripeWebhookRoute(
      await signedReq({
        id: "e_link",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_B",
            client_reference_id: "7",
            subscription: { status: "active", items: { data: [{ price: { id: "price_pro" } }] } },
          },
        },
      }),
      env,
    )
    expect(await readTier(db, 7)).toBe("pro")
    const res = await handleStripeWebhookRoute(
      await signedReq({ id: "e_del", type: "customer.subscription.deleted", data: { object: { customer: "cus_B" } } }),
      env,
    )
    expect(res.status).toBe(200)
    expect(await readTier(db, 7)).toBe("free")
  })

  it("invoice.payment_failed → downgrade to free", async () => {
    const req = await signedReq({
      id: "e_fail",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_C", metadata: { installation_id: "9" } } },
    })
    const res = await handleStripeWebhookRoute(req, env)
    expect(res.status).toBe(200)
    expect(await readTier(db, 9)).toBe("free")
  })

  it("price→tier via lookup_key when no env id matches", async () => {
    const req = await signedReq({
      id: "e_sub",
      type: "customer.subscription.updated",
      data: {
        object: {
          status: "active",
          customer: "cus_D",
          metadata: { installation_id: "11" },
          items: { data: [{ price: { id: "price_unlisted", lookup_key: "ultra_yearly" } }] },
        },
      },
    })
    const res = await handleStripeWebhookRoute(req, env)
    expect(res.status).toBe(200)
    expect(await readTier(db, 11)).toBe("ultra")
  })

  it("absent installation link → 200 ack, no tenant touched (no random upgrade)", async () => {
    const req = await signedReq({
      id: "e_orphan",
      type: "customer.subscription.updated",
      data: {
        object: { status: "active", customer: "cus_UNKNOWN", items: { data: [{ price: { id: "price_max" } }] } },
      },
    })
    const res = await handleStripeWebhookRoute(req, env)
    expect(res.status).toBe(200)
    const anyTenant = await db.prepare("SELECT COUNT(*) AS n FROM tenant").first<{ n: number }>()
    expect(anyTenant?.n).toBe(0)
    expect(store.get("stripe-orphan:e_orphan")).toBeTruthy()
  })

  it("idempotent re-delivery → 200 ack, applied exactly once", async () => {
    const body = {
      id: "e_dup",
      type: "customer.subscription.updated",
      data: {
        object: {
          status: "active",
          customer: "cus_E",
          metadata: { installation_id: "13" },
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      },
    }
    const first = await handleStripeWebhookRoute(await signedReq(body), env)
    expect(first.status).toBe(200)
    expect(await readTier(db, 13)).toBe("pro")
    const dupBody = { ...body, data: { object: { ...body.data.object, status: "canceled" } } }
    const second = await handleStripeWebhookRoute(await signedReq(dupBody), env)
    expect(second.status).toBe(200)
    expect((await second.text()).trim()).toBe("duplicate")
    expect(await readTier(db, 13)).toBe("pro") // NOT downgraded — deduped
  })

  it("invoice.paid with an expanded active subscription → reaffirm tier", async () => {
    const req = await signedReq({
      id: "e_inv_active",
      type: "invoice.paid",
      data: {
        object: {
          customer: "cus_G",
          subscription: {
            status: "active",
            metadata: { installation_id: "21" },
            items: { data: [{ price: { id: "price_ultra" } }] },
          },
        },
      },
    })
    const res = await handleStripeWebhookRoute(req, env)
    expect(res.status).toBe(200)
    expect(await readTier(db, 21)).toBe("ultra")
  })

  it("invoice.paid WITHOUT an active subscription → link only, tenant tier untouched", async () => {
    // Seed a paid tenant + link; a bare invoice.paid must NOT change (or downgrade) it.
    await handleStripeWebhookRoute(
      await signedReq({
        id: "e_seed",
        type: "customer.subscription.created",
        data: {
          object: {
            status: "active",
            customer: "cus_H",
            metadata: { installation_id: "23" },
            items: { data: [{ price: { id: "price_pro" } }] },
          },
        },
      }),
      env,
    )
    expect(await readTier(db, 23)).toBe("pro")
    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "e_inv_bare",
        type: "invoice.paid",
        data: { object: { customer: "cus_H", lines: { data: [{ price: { id: "price_ultra" } }] } } },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(await readTier(db, 23)).toBe("pro") // unchanged — invoice lines don't set tier
  })

  it("installation conflict: a signed event naming a DIFFERENT installation than the linked one → 200 ack, no rebind, no tier change", async () => {
    // Establish cus_G ↔ installation 30 at tier pro.
    await handleStripeWebhookRoute(
      await signedReq({
        id: "e_conf_seed",
        type: "customer.subscription.created",
        data: {
          object: {
            status: "active",
            customer: "cus_G",
            metadata: { installation_id: "30" },
            items: { data: [{ price: { id: "price_pro" } }] },
          },
        },
      }),
      env,
    )
    expect(await readTier(db, 30)).toBe("pro")
    // A later event for cus_G claims installation 31 (stale/wrong metadata).
    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "e_conf",
        type: "customer.subscription.updated",
        data: {
          object: {
            status: "active",
            customer: "cus_G",
            metadata: { installation_id: "31" },
            items: { data: [{ price: { id: "price_ultra" } }] },
          },
        },
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("installation conflict")
    expect(await readTier(db, 31)).toBeNull() // wrong tenant NOT upgraded
    expect(await readTier(db, 30)).toBe("pro") // right tenant untouched
    expect(store.get("stripe-customer:cus_G")).toBe("30") // link NOT rebound
  })

  it("KV link-read error on a customer-only downgrade → 500 (unmarked, Stripe retries) — never silently keeps paid tier", async () => {
    const db2 = makeD1()
    await db2.exec(MIGRATION_SQL)
    const kvErr = {
      get: async () => {
        throw new Error("simulated KV outage")
      },
      put: async () => {},
    } as unknown as Env["OPENCLAW_STATE"]
    const e2 = {
      SIGILIX_STRIPE_WEBHOOK_SECRET: SECRET,
      SIGILIX_PLATFORM_DB: db2,
      OPENCLAW_STATE: kvErr,
    } as unknown as Env
    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "e_kverr",
        type: "customer.subscription.deleted",
        data: { object: { customer: "cus_Z" } },
      }),
      e2,
    )
    expect(res.status).toBe(500)
  })

  it("unhandled event type → 200 ack no-op", async () => {
    const res = await handleStripeWebhookRoute(
      await signedReq({ id: "e_other", type: "charge.refunded", data: { object: {} } }),
      env,
    )
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("ignored")
  })

  it("500 when the tier write genuinely fails (Stripe should redeliver)", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("simulated D1 error")
      },
    } as unknown as D1Database
    const { env: e2 } = await makeEnv()
    ;(e2 as { SIGILIX_PLATFORM_DB?: D1Database }).SIGILIX_PLATFORM_DB = brokenDb
    const res = await handleStripeWebhookRoute(
      await signedReq({
        id: "e_dbfail",
        type: "customer.subscription.updated",
        data: {
          object: {
            status: "active",
            customer: "cus_F",
            metadata: { installation_id: "17" },
            items: { data: [{ price: { id: "price_pro" } }] },
          },
        },
      }),
      e2,
    )
    expect(res.status).toBe(500)
  })
})
