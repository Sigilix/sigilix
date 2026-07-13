// sig-stripe-checkout — POST /v1/billing/checkout + /v1/billing/portal end-to-end.
// Exercises the real session → decrypt → GitHub admin gate → KV customer reuse →
// Stripe form path, with a stubbed fetch standing in for GitHub + Stripe. Pins the
// anti-spoof invariant: client_reference_id is the SERVER-VERIFIED installation,
// never a body value; non-admins are 403'd; seat bounds + tier gate are enforced.

import { afterEach, describe, expect, it, vi } from "vitest"
import { handleBillingCheckoutRoute, handleBillingPortalRoute } from "@/src/lib/billing-checkout-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const NO_SUBSCRIPTION_DB = {
  prepare: () => ({ bind: () => ({ first: async () => null }) }),
} as unknown as Env["SIGILIX_PLATFORM_DB"]

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    // getSession reads the record with `get(key, "json")`; honor the type param
    // like the shared harness so the session record parses back into an object.
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

async function seedSession(kv: KVNamespace, sessionId: string, login: string): Promise<void> {
  await createSession({ kv, sessionId, login, githubUserId: 42, accessToken: "ghu_x", encryptionKeyB64url: ENC_KEY })
}

// `extra` is loosely typed so a test can UNSET an optional var (pass `undefined`)
// despite `exactOptionalPropertyTypes` — the route reads `env.X` and treats an
// undefined value as unset, which is exactly the "not configured" case under test.
function baseEnv(kv: KVNamespace, extra: Record<string, unknown> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    OPENCLAW_PORTAL_URL: "https://app.sigilix.ai",
    SIGILIX_STRIPE_SECRET_KEY: "sk_test_123",
    SIGILIX_STRIPE_PRICE_PRO: "price_pro",
    SIGILIX_STRIPE_PRICE_TEAMS: "price_teams",
    SIGILIX_STRIPE_PRICE_MAX: "price_max",
    SIGILIX_STRIPE_PRICE_ULTRA: "price_ultra",
    SIGILIX_PLATFORM_DB: NO_SUBSCRIPTION_DB,
    ...extra,
  } as unknown as Env
}

function post(body: unknown, sessionId: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request("https://x/v1/billing/checkout", { method: "POST", headers, body: JSON.stringify(body) })
}

interface StubOpts {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships?: Array<{ role: string; state: string; organization: { login: string } }>
  /** Capture holder for the checkout-session form body Stripe would receive. */
  captured?: { checkoutBody?: string; customerCalls?: number }
}

/** Stub GitHub (installations + memberships) and Stripe (customers / checkout / portal). */
function stubFetch(opts: StubOpts) {
  const cap = opts.captured ?? {}
  cap.customerCalls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({ total_count: opts.installations.length, installations: opts.installations }),
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify(opts.memberships ?? []))
      }
      if (url === "https://api.stripe.com/v1/customers") {
        cap.customerCalls = (cap.customerCalls ?? 0) + 1
        return new Response(JSON.stringify({ id: "cus_new" }))
      }
      if (url === "https://api.stripe.com/v1/checkout/sessions") {
        cap.checkoutBody = typeof init?.body === "string" ? init.body : ""
        return new Response(JSON.stringify({ url: "https://checkout.stripe.com/pay/cs_test" }))
      }
      if (url === "https://api.stripe.com/v1/billing_portal/sessions") {
        return new Response(JSON.stringify({ url: "https://billing.stripe.com/session/bp_test" }))
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

/** An admin: owns a personal install (id 555, login matches the session). */
const ADMIN_INSTALLS = [{ id: 555, account: { type: "User", login: "octocat" } }]

afterEach(() => vi.unstubAllGlobals())

describe("POST /v1/billing/checkout", () => {
  it("503 when SIGILIX_STRIPE_SECRET_KEY is unset", async () => {
    const { kv } = makeKV()
    const env = baseEnv(kv, { SIGILIX_STRIPE_SECRET_KEY: undefined })
    const res = await handleBillingCheckoutRoute(post({ tier: "pro" }, null), env)
    expect(res.status).toBe(503)
  })

  it("503 when SIGILIX_PLATFORM_DB is unset — never reaches Stripe", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const res = await handleBillingCheckoutRoute(
      post({ tier: "pro", installationId: 555 }, "s1"),
      baseEnv(kv, { SIGILIX_PLATFORM_DB: undefined }),
    )

    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401 without a session", async () => {
    const { kv } = makeKV()
    stubFetch({ installations: ADMIN_INSTALLS })
    const res = await handleBillingCheckoutRoute(post({ tier: "pro" }, null), baseEnv(kv))
    expect(res.status).toBe(401)
  })

  it("415 when the content-type is not application/json (CSRF guard)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubFetch({ installations: ADMIN_INSTALLS })
    // A CORS-simple cross-site POST would carry text/plain — reject before any side effect.
    const req = new Request("https://x/v1/billing/checkout", {
      method: "POST",
      headers: { "content-type": "text/plain", cookie: `${SESSION_COOKIE}=s1` },
      body: JSON.stringify({ tier: "pro", installationId: 555 }),
    })
    const res = await handleBillingCheckoutRoute(req, baseEnv(kv))
    expect(res.status).toBe(415)
  })

  it("400 on a null / non-object JSON body (never 500s the worker)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubFetch({ installations: ADMIN_INSTALLS })
    const req = new Request("https://x/v1/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=s1` },
      body: "null",
    })
    const res = await handleBillingCheckoutRoute(req, baseEnv(kv))
    expect(res.status).toBe(400)
  })

  it("409 when the org already has a live (active/trialing) subscription", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const captured: { checkoutBody?: string } = {}
    stubFetch({ installations: ADMIN_INSTALLS, captured })
    // A tenant row whose Stripe subscription is already active → a second checkout
    // would double-subscribe. Send them to the portal (409), never to Stripe.
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => ({ subscription_status: "active" }) }) }),
    } as unknown as Env["SIGILIX_PLATFORM_DB"]
    const res = await handleBillingCheckoutRoute(
      post({ tier: "max", installationId: 555 }, "s1"),
      baseEnv(kv, { SIGILIX_PLATFORM_DB: db }),
    )
    expect(res.status).toBe(409)
    expect(captured.checkoutBody).toBeUndefined() // never reached Stripe
  })

  it("503 (fail closed) when the subscription-status read throws — never risks a duplicate", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const captured: { checkoutBody?: string } = {}
    stubFetch({ installations: ADMIN_INSTALLS, captured })
    // D1 outage: the status read throws. We must NOT proceed to Stripe on an unknown
    // status (an org WITH a live sub would get a duplicate) — return 503 instead.
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("simulated D1 outage")
          },
        }),
      }),
    } as unknown as Env["SIGILIX_PLATFORM_DB"]
    const res = await handleBillingCheckoutRoute(
      post({ tier: "pro", installationId: 555 }, "s1"),
      baseEnv(kv, { SIGILIX_PLATFORM_DB: db }),
    )
    expect(res.status).toBe(503)
    expect(captured.checkoutBody).toBeUndefined()
  })

  it("builds a Checkout Session with client_reference_id from the SESSION, not the body (teams, no trial)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const captured: { checkoutBody?: string } = {}
    // The body carries a DIFFERENT, spoofed installationId (999) than the one the
    // session's token administers (555) — the spoof must be rejected as forbidden,
    // never written to Stripe. (Sending 555, which the caller admins, is honored below.)
    stubFetch({ installations: ADMIN_INSTALLS, captured })

    const spoof = await handleBillingCheckoutRoute(
      post({ tier: "teams", seats: 12, installationId: 999 }, "s1"),
      baseEnv(kv),
    )
    expect(spoof.status).toBe(403)
    expect(captured.checkoutBody).toBeUndefined() // never reached Stripe

    const ok = await handleBillingCheckoutRoute(
      post({ tier: "teams", seats: 12, installationId: 555 }, "s1"),
      baseEnv(kv),
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { url: string }
    expect(body.url).toBe("https://checkout.stripe.com/pay/cs_test")

    const form = new URLSearchParams(captured.checkoutBody)
    // Teams is a paid-immediately tier: NO trial_period_days on the Stripe form.
    expect(form.has("subscription_data[trial_period_days]")).toBe(false)
    expect(form.get("client_reference_id")).toBe("555") // the verified install, NOT 999
    expect(form.get("subscription_data[metadata][installation_id]")).toBe("555")
    expect(form.get("line_items[0][adjustable_quantity][minimum]")).toBe("10")
    expect(form.get("line_items[0][adjustable_quantity][maximum]")).toBe("150")
    expect(form.get("line_items[0][quantity]")).toBe("12")
  })

  it("grants the 14-day trial for PRO", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const captured: { checkoutBody?: string } = {}
    stubFetch({ installations: ADMIN_INSTALLS, captured })

    const res = await handleBillingCheckoutRoute(post({ tier: "pro", installationId: 555 }, "s1"), baseEnv(kv))
    expect(res.status).toBe(200)
    const form = new URLSearchParams(captured.checkoutBody)
    expect(form.get("subscription_data[trial_period_days]")).toBe("14")
  })

  it("grants NO trial for teams / max / ultra — even when the body spoofs a trial intent", async () => {
    for (const tier of ["teams", "max", "ultra"] as const) {
      const { kv } = makeKV()
      await seedSession(kv, "s1", "octocat")
      const captured: { checkoutBody?: string } = {}
      stubFetch({ installations: ADMIN_INSTALLS, captured })

      // The client sends a spoofed trial intent alongside a non-pro plan. The worker
      // ignores untrusted body fields and derives the trial from the validated tier,
      // so no trial is ever granted for these tiers.
      const seats = tier === "teams" ? 10 : 1
      const res = await handleBillingCheckoutRoute(
        post({ tier, seats, installationId: 555, intent: "trial", plan: tier, trial: true }, "s1"),
        baseEnv(kv),
      )
      expect(res.status).toBe(200)
      const form = new URLSearchParams(captured.checkoutBody)
      expect(form.has("subscription_data[trial_period_days]")).toBe(false)
    }
  })

  it("defaults to the sole installation when none is selected, min seats for the tier", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const captured: { checkoutBody?: string } = {}
    stubFetch({ installations: ADMIN_INSTALLS, captured })
    const res = await handleBillingCheckoutRoute(post({ tier: "pro" }, "s1"), baseEnv(kv))
    expect(res.status).toBe(200)
    const form = new URLSearchParams(captured.checkoutBody)
    expect(form.get("line_items[0][quantity]")).toBe("1") // pro min
    expect(form.get("client_reference_id")).toBe("555")
  })

  it("403 for a non-admin of the org (member of an org install)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // Org install where the caller is NOT an admin (no admin membership).
    stubFetch({
      installations: [{ id: 777, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })
    const res = await handleBillingCheckoutRoute(post({ tier: "pro", installationId: 777 }, "s1"), baseEnv(kv))
    expect(res.status).toBe(403)
  })

  it("400 for free / enterprise / unknown tiers", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubFetch({ installations: ADMIN_INSTALLS })
    for (const tier of ["free", "enterprise", "gold"]) {
      const res = await handleBillingCheckoutRoute(post({ tier, installationId: 555 }, "s1"), baseEnv(kv))
      expect(res.status).toBe(400)
    }
  })

  it("400 for out-of-range Teams seats (below 10)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubFetch({ installations: ADMIN_INSTALLS })
    const res = await handleBillingCheckoutRoute(
      post({ tier: "teams", seats: 5, installationId: 555 }, "s1"),
      baseEnv(kv),
    )
    expect(res.status).toBe(400)
  })

  it("503 when the tier's price id is not configured", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubFetch({ installations: ADMIN_INSTALLS })
    const env = baseEnv(kv, { SIGILIX_STRIPE_PRICE_MAX: undefined })
    const res = await handleBillingCheckoutRoute(post({ tier: "max", installationId: 555 }, "s1"), env)
    expect(res.status).toBe(503)
  })

  it("reuses the existing Stripe customer via the KV link (no duplicate customer)", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // A returning org: the webhook already linked installation 555 → cus_existing.
    store.set("stripe-installation:555", "cus_existing")
    const captured: { checkoutBody?: string; customerCalls?: number } = {}
    stubFetch({ installations: ADMIN_INSTALLS, captured })

    const res = await handleBillingCheckoutRoute(post({ tier: "pro", installationId: 555 }, "s1"), baseEnv(kv))
    expect(res.status).toBe(200)
    expect(captured.customerCalls).toBe(0) // never created a second customer
    const form = new URLSearchParams(captured.checkoutBody)
    expect(form.get("customer")).toBe("cus_existing")
  })

  it("creates + links a customer on first checkout (no prior link)", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const captured: { checkoutBody?: string; customerCalls?: number } = {}
    stubFetch({ installations: ADMIN_INSTALLS, captured })

    const res = await handleBillingCheckoutRoute(post({ tier: "pro", installationId: 555 }, "s1"), baseEnv(kv))
    expect(res.status).toBe(200)
    expect(captured.customerCalls).toBe(1)
    // Linked immediately (anti-duplicate) so a retried checkout reuses it.
    expect(store.get("stripe-installation:555")).toBe("cus_new")
    expect(store.get("stripe-customer:cus_new")).toBe("555")
  })
})

describe("POST /v1/billing/portal", () => {
  const portalReq = (body: unknown, sessionId: string | null) => {
    const headers = new Headers({ "content-type": "application/json" })
    if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
    return new Request("https://x/v1/billing/portal", { method: "POST", headers, body: JSON.stringify(body) })
  }

  it("returns a portal URL for an existing subscriber (admin)", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    store.set("stripe-installation:555", "cus_existing")
    stubFetch({ installations: ADMIN_INSTALLS })
    const res = await handleBillingPortalRoute(portalReq({ installationId: 555 }, "s1"), baseEnv(kv))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string }
    expect(body.url).toBe("https://billing.stripe.com/session/bp_test")
  })

  it("404 when the org has no Stripe customer yet", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubFetch({ installations: ADMIN_INSTALLS })
    const res = await handleBillingPortalRoute(portalReq({ installationId: 555 }, "s1"), baseEnv(kv))
    expect(res.status).toBe(404)
  })

  it("403 for a non-admin", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    store.set("stripe-installation:777", "cus_x")
    stubFetch({
      installations: [{ id: 777, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })
    const res = await handleBillingPortalRoute(portalReq({ installationId: 777 }, "s1"), baseEnv(kv))
    expect(res.status).toBe(403)
  })
})
