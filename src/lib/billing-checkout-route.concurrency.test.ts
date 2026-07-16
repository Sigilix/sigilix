// Regression contract for the installation-scoped Stripe Checkout attempt guard.
// This deliberately enters through the real Worker dispatcher and real session,
// GitHub exact-installation, D1 liveness, customer-binding, and Stripe adapters.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const SESSION_ID = "checkout-race-session"
const SESSION_COOKIE = "__Host-sigilix_session"
const INSTALLATION_ID = 555
const USER_ID = "checkout-race-user"
const PORTAL_ORIGIN = "https://app.sigilix.ai"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(23))

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
  return { kv, store }
}

async function makeDatabase(): Promise<D1Database> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0006_create_user_identity.sql",
    "0011_add_tenant_subscription_status.sql",
    "0012_add_tenant_billing_source.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0027_create_billing_checkout_attempt.sql",
  ]) {
    await db.exec(migration(name))
  }
  await db
    .prepare(
      `INSERT INTO user_identity
        (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES (?, '42', '["github"]', ?, ?)`,
    )
    .bind(USER_ID, "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z")
    .run()
  await db
    .prepare(
      `INSERT INTO tenant
        (installation_id, tier, subscription_status, billing_source, account_login,
         account_type, created_at, updated_at)
       VALUES (?, 'free', 'canceled', 'stripe', 'octocat', 'User', ?, ?)`,
    )
    .bind(INSTALLATION_ID, "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z")
    .run()
  return db
}

async function makeHarness(): Promise<{ db: D1Database; env: Env }> {
  const db = await makeDatabase()
  const { kv, store } = makeKV()
  await createSession({
    kv,
    sessionId: SESSION_ID,
    login: "octocat",
    githubUserId: 42,
    userId: USER_ID,
    accessToken: "ghu_checkout_race",
    encryptionKeyB64url: ENC_KEY,
  })
  store.set(`stripe-installation:${INSTALLATION_ID}`, "cus_existing")
  return {
    db,
    env: {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_PORTAL_URL: PORTAL_ORIGIN,
      SIGILIX_PORTAL_ORIGIN: PORTAL_ORIGIN,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_STRIPE_SECRET_KEY: "sk_test_checkout_race",
      SIGILIX_STRIPE_PRICE_PRO: "price_pro_monthly",
      SIGILIX_STRIPE_PRICE_MAX: "price_max_monthly",
    } as unknown as Env,
  }
}

function checkoutRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://api.sigilix.ai/v1/billing/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      origin: PORTAL_ORIGIN,
    },
    body: JSON.stringify({
      tier: "pro",
      seats: 1,
      billingPeriod: "monthly",
      installationId: INSTALLATION_ID,
      ...overrides,
    }),
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Stripe Checkout concurrency through worker.fetch", () => {
  it("allows only one current Checkout attempt for an installation", async () => {
    const { env } = await makeHarness()

    const firstCheckoutReached = deferred()
    const releaseFirstCheckout = deferred()
    const checkoutCalls: Array<{ body: string; idempotencyKey: string | null }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              installations: [{ id: INSTALLATION_ID, account: { type: "User", login: "octocat" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
        }
        if (url === "https://api.stripe.com/v1/checkout/sessions") {
          const headers = new Headers(init?.headers)
          const body = typeof init?.body === "string" ? init.body : ""
          checkoutCalls.push({ body, idempotencyKey: headers.get("idempotency-key") })
          const callNumber = checkoutCalls.length
          if (callNumber === 1) {
            firstCheckoutReached.resolve()
            await releaseFirstCheckout.promise
          }
          const expiresAt = Number(new URLSearchParams(body).get("expires_at"))
          return new Response(
            JSON.stringify({
              id: `cs_race_${callNumber}`,
              url: `https://checkout.stripe.com/pay/cs_race_${callNumber}`,
              ...(Number.isSafeInteger(expiresAt) ? { expires_at: expiresAt } : {}),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        throw new Error(`unexpected outbound request: ${url}`)
      }),
    )

    const untrustedFields = {
      idempotencyKey: "attacker-controlled-key",
      customerId: "cus_attacker",
      priceId: "price_attacker",
      expiresAtEpochSeconds: 1,
    }
    const firstResponsePromise = worker.fetch(checkoutRequest(untrustedFields), env, executionContext())
    await firstCheckoutReached.promise

    let secondResponse: Response
    try {
      secondResponse = await worker.fetch(checkoutRequest(untrustedFields), env, executionContext())
    } finally {
      releaseFirstCheckout.resolve()
    }
    const firstResponse = await firstResponsePromise

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(409)
    await expect(secondResponse.json()).resolves.toEqual({ error: "checkout_in_progress" })
    expect(checkoutCalls).toHaveLength(1)
    expect(checkoutCalls[0]?.idempotencyKey).toMatch(/\S/)
    expect(checkoutCalls[0]?.idempotencyKey).not.toBe("attacker-controlled-key")

    const stripeForm = new URLSearchParams(checkoutCalls[0]?.body)
    expect(stripeForm.get("customer")).toBe("cus_existing")
    expect(stripeForm.get("line_items[0][price]")).toBe("price_pro_monthly")
    const expiresAt = stripeForm.get("expires_at")
    expect(expiresAt).toMatch(/^\d+$/)
    expect(Number(expiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it("replays a ready Checkout URL without another Stripe POST", async () => {
    const { env } = await makeHarness()
    let checkoutCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account: { type: "User", login: "octocat" } }],
          })
        }
        if (url.startsWith("https://api.github.com/user/memberships/orgs?")) return Response.json([])
        if (url === "https://api.stripe.com/v1/checkout/sessions") {
          checkoutCalls += 1
          return Response.json({ id: "cs_replay", url: "https://checkout.stripe.com/pay/cs_replay" })
        }
        throw new Error(`unexpected outbound request: ${url}`)
      }),
    )

    const first = await worker.fetch(checkoutRequest(), env, executionContext())
    const second = await worker.fetch(checkoutRequest(), env, executionContext())

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ url: "https://checkout.stripe.com/pay/cs_replay" })
    await expect(second.json()).resolves.toEqual({ url: "https://checkout.stripe.com/pay/cs_replay" })
    expect(checkoutCalls).toBe(1)
  })

  it("blocks a different purchase intent while another Checkout POST is in flight", async () => {
    const { env } = await makeHarness()
    const firstCheckoutReached = deferred()
    const releaseFirstCheckout = deferred()
    let checkoutCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account: { type: "User", login: "octocat" } }],
          })
        }
        if (url.startsWith("https://api.github.com/user/memberships/orgs?")) return Response.json([])
        if (url === "https://api.stripe.com/v1/checkout/sessions") {
          checkoutCalls += 1
          firstCheckoutReached.resolve()
          await releaseFirstCheckout.promise
          return Response.json({ id: "cs_current", url: "https://checkout.stripe.com/pay/cs_current" })
        }
        throw new Error(`unexpected outbound request: ${url}`)
      }),
    )

    const firstPromise = worker.fetch(checkoutRequest(), env, executionContext())
    await firstCheckoutReached.promise
    const conflicting = await worker.fetch(checkoutRequest({ tier: "max", seats: 2 }), env, executionContext())
    releaseFirstCheckout.resolve()
    const first = await firstPromise

    expect(first.status).toBe(200)
    expect(conflicting.status).toBe(409)
    await expect(conflicting.json()).resolves.toEqual({ error: "checkout_in_progress" })
    expect(checkoutCalls).toBe(1)
  })

  it("does not replay or replace an expired Checkout URL during replacement grace", async () => {
    const { db, env } = await makeHarness()
    const nowMs = Date.now()
    await db
      .prepare(
        `INSERT INTO stripe_checkout_attempt
          (installation_id, attempt_id, intent_fingerprint, request_body, idempotency_key,
           state, generation, lease_token, lease_expires_at_ms, stripe_expires_at_ms,
           replace_after_ms, stripe_session_id, checkout_url, created_at_ms, updated_at_ms,
           ready_at_ms)
         VALUES (?, 'attempt-expired', ?, 'mode=subscription', 'checkout-expired-key',
                 'ready', 1, NULL, NULL, ?, ?, 'cs_expired', ?, ?, ?, ?)`,
      )
      .bind(
        INSTALLATION_ID,
        "a".repeat(64),
        nowMs - 1_000,
        nowMs + 300_000,
        "https://checkout.stripe.com/pay/cs_expired",
        nowMs - 10_000,
        nowMs - 2_000,
        nowMs - 2_000,
      )
      .run()
    let checkoutCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account: { type: "User", login: "octocat" } }],
          })
        }
        if (url.startsWith("https://api.github.com/user/memberships/orgs?")) return Response.json([])
        if (url === "https://api.stripe.com/v1/checkout/sessions") checkoutCalls += 1
        throw new Error(`unexpected outbound request: ${url}`)
      }),
    )

    const response = await worker.fetch(checkoutRequest(), env, executionContext())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "checkout_in_progress" })
    expect(checkoutCalls).toBe(0)
  })

  it("does not persist or return a Stripe result after a newer lease generation wins", async () => {
    const { db, env } = await makeHarness()
    const checkoutReached = deferred()
    const releaseCheckout = deferred()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account: { type: "User", login: "octocat" } }],
          })
        }
        if (url.startsWith("https://api.github.com/user/memberships/orgs?")) return Response.json([])
        if (url === "https://api.stripe.com/v1/checkout/sessions") {
          checkoutReached.resolve()
          await releaseCheckout.promise
          return Response.json({ id: "cs_stale", url: "https://checkout.stripe.com/pay/cs_stale" })
        }
        throw new Error(`unexpected outbound request: ${url}`)
      }),
    )

    const responsePromise = worker.fetch(checkoutRequest(), env, executionContext())
    await checkoutReached.promise
    const takeoverNowMs = Date.now()
    await db
      .prepare(
        `UPDATE stripe_checkout_attempt
            SET generation = generation + 1, lease_token = 'successor-lease',
                lease_expires_at_ms = ?, updated_at_ms = ?
          WHERE installation_id = ? AND state = 'creating'`,
      )
      .bind(takeoverNowMs + 45_000, takeoverNowMs, INSTALLATION_ID)
      .run()
    releaseCheckout.resolve()
    const response = await responsePromise

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "billing_unavailable" })
    const row = await db
      .prepare(
        "SELECT state, stripe_session_id, checkout_url, generation FROM stripe_checkout_attempt WHERE installation_id = ?",
      )
      .bind(INSTALLATION_ID)
      .first<Record<string, unknown>>()
    expect(row).toMatchObject({ state: "creating", stripe_session_id: null, checkout_url: null, generation: 2 })
  })

  it("recovers an ambiguous provider failure with the byte-identical body and key", async () => {
    vi.useFakeTimers()
    const startedAtMs = Date.parse("2026-07-15T08:00:00.000Z")
    vi.setSystemTime(startedAtMs)
    const { env } = await makeHarness()
    const checkoutCalls: Array<{ body: string; idempotencyKey: string | null }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return Response.json({
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account: { type: "User", login: "octocat" } }],
          })
        }
        if (url.startsWith("https://api.github.com/user/memberships/orgs?")) return Response.json([])
        if (url === "https://api.stripe.com/v1/checkout/sessions") {
          checkoutCalls.push({
            body: String(init?.body),
            idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
          })
          if (checkoutCalls.length === 1) throw new Error("response lost after provider execution")
          return Response.json({ id: "cs_recovered", url: "https://checkout.stripe.com/pay/cs_recovered" })
        }
        throw new Error(`unexpected outbound request: ${url}`)
      }),
    )

    const ambiguous = await worker.fetch(checkoutRequest(), env, executionContext())
    expect(ambiguous.status).toBe(502)
    vi.setSystemTime(startedAtMs + 46_000)
    const recovered = await worker.fetch(checkoutRequest(), env, executionContext())

    expect(recovered.status).toBe(200)
    expect(checkoutCalls).toHaveLength(2)
    expect(checkoutCalls[1]).toEqual(checkoutCalls[0])
  })
})
