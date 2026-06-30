// Tests for the Linear AGENT install — the actor=app install entry (/linear/install),
// the authorization-code callback, and the agent-token KV store.
//
// Covers: token KV round-trip + malformed/missing handling, not-configured 503,
// REQUIRED CSRF state (missing → 400, unknown → 400, deleted on use, preserved on a
// missing-code 400), missing-code 400, authorize-error 400, happy-path exchange +
// token persist + 200, redirect_uri PINNED to OPENCLAW_GATEWAY_ISSUER (fallback to the
// request origin), grant params, non-2xx / invalid-JSON / missing-access_token 502, KV
// persist failure 502, the workspace allowlist (reject mismatch 403, allow + warn when
// unset, allow on match), the /linear/install nonce + authorize-URL params, and —
// critically — that the code / client_secret / access token are NEVER logged.
//
// Fetch is stubbed via vi.spyOn(globalThis, "fetch"), following slack-install.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import {
  handleLinearOAuthCallback,
  handleLinearInstall,
  getLinearAgentToken,
  putLinearAgentToken,
  LINEAR_AGENT_TOKEN_KEY,
} from "@/src/lib/linear-agent-oauth"
import type { Env } from "@/src/shared/types/env"

// ─── Map-backed fake KVNamespace ────────────────────────────────────────────
function makeFakeKV() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}
type FakeKV = ReturnType<typeof makeFakeKV>

function makeEnv(kv: FakeKV, extra: Record<string, unknown> = {}): Env {
  return {
    OPENCLAW_STATE: kv as unknown as KVNamespace,
    LINEAR_OAUTH_CLIENT_ID: "client-id-123",
    LINEAR_OAUTH_CLIENT_SECRET: "client-secret-shh",
    ...extra,
  } as unknown as Env
}

const CALLBACK_ORIGIN = "https://sigilix.dan-martinezjulio.workers.dev"
function callbackReq(params: Record<string, string> = {}): Request {
  const url = new URL(`${CALLBACK_ORIGIN}/linear/oauth/callback`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url.toString())
}

/** Seed a CSRF nonce into the fake KV and return the state string. */
function seedState(kv: FakeKV, state = "nonce-1"): string {
  kv._store.set(`linear-oauth-state:${state}`, "1")
  return state
}

function mockTokenFetch(body: unknown, status = 200): MockInstance {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )
}

/** Queue the token-exchange response THEN the `query { organization { id } }` response
 *  on a SINGLE fetch spy (chained = FIFO; two separate spyOn calls would invert it). */
function mockTokenThenOrgFetch(tokenBody: unknown, orgId: string | null): MockInstance {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(JSON.stringify(tokenBody), { status: 200, headers: { "content-type": "application/json" } }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { organization: orgId ? { id: orgId } : null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
}

// ─── token KV store ──────────────────────────────────────────────────────────
describe("putLinearAgentToken / getLinearAgentToken", () => {
  it("round-trips an agent token through KV under the agent-token key", async () => {
    const kv = makeFakeKV()
    await putLinearAgentToken(kv as unknown as KVNamespace, { accessToken: "lin_agent_abc", installedAt: 1 })
    expect(kv.put).toHaveBeenCalledWith(LINEAR_AGENT_TOKEN_KEY, expect.stringContaining("lin_agent_abc"))
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_abc")
  })

  it("returns null when no token is stored", async () => {
    const kv = makeFakeKV()
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBeNull()
  })

  it("returns null for a malformed record (no accessToken / bad JSON)", async () => {
    const kv = makeFakeKV()
    kv._store.set(LINEAR_AGENT_TOKEN_KEY, JSON.stringify({ installedAt: 1 }))
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBeNull()
    kv._store.set(LINEAR_AGENT_TOKEN_KEY, "not json")
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBeNull()
  })
})

// ─── handleLinearInstall (the actor=app install entry) ───────────────────────
describe("handleLinearInstall", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns 503 when LINEAR_OAUTH_CLIENT_ID is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { LINEAR_OAUTH_CLIENT_ID: undefined })
    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)
    expect(res.status).toBe(503)
  })

  it("mints a nonce + 302-redirects with actor=app, state, scopes, and a pinned redirect_uri", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { OPENCLAW_GATEWAY_ISSUER: CALLBACK_ORIGIN })

    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)

    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get("location") ?? "")
    expect(loc.origin + loc.pathname).toBe("https://linear.app/oauth/authorize")
    expect(loc.searchParams.get("response_type")).toBe("code")
    expect(loc.searchParams.get("client_id")).toBe("client-id-123")
    expect(loc.searchParams.get("actor")).toBe("app")
    expect(loc.searchParams.get("scope")).toBe(
      "read,write,comments:create,issues:create,app:assignable,app:mentionable",
    )
    expect(loc.searchParams.get("redirect_uri")).toBe(`${CALLBACK_ORIGIN}/linear/oauth/callback`)
    const state = loc.searchParams.get("state")
    expect(state).toBeTruthy()
    // The exact nonce was stored in KV (callback can verify it).
    expect(kv._store.has(`linear-oauth-state:${state}`)).toBe(true)
  })

  it("falls back to the request origin for redirect_uri when OPENCLAW_GATEWAY_ISSUER is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv) // no OPENCLAW_GATEWAY_ISSUER
    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)
    const loc = new URL(res.headers.get("location") ?? "")
    expect(loc.searchParams.get("redirect_uri")).toBe(`${CALLBACK_ORIGIN}/linear/oauth/callback`)
  })
})

// ─── handleLinearOAuthCallback ───────────────────────────────────────────────
describe("handleLinearOAuthCallback", () => {
  let spyLog: MockInstance
  let spyWarn: MockInstance
  let spyError: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns 503 when LINEAR_OAUTH_CLIENT_ID/SECRET are unset (no fetch)", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { LINEAR_OAUTH_CLIENT_ID: undefined, LINEAR_OAUTH_CLIENT_SECRET: undefined })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ code: "c", state: "s" }), env)
    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns 400 when the CSRF state is missing (no fetch)", async () => {
    const kv = makeFakeKV()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code" }), makeEnv(kv))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns 400 when the CSRF state is unknown / forged (not in KV, no fetch)", async () => {
    const kv = makeFakeKV()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state: "forged" }), makeEnv(kv))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns 400 when the authorization code is missing, preserving the nonce (no fetch)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ state }), makeEnv(kv))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    // Nonce NOT consumed on a missing-code 400 (replay-safe).
    expect(kv._store.has(`linear-oauth-state:${state}`)).toBe(true)
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it("returns 400 when Linear bounced with ?error (no fetch, raw error not echoed)", async () => {
    const kv = makeFakeKV()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ error: "access_denied" }), makeEnv(kv))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await res.text()).not.toContain("access_denied")
  })

  it("happy path: verifies+deletes the nonce, exchanges the code, stores the token, 200", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz", expires_in: 3600, scope: "app:assignable" })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("Sigilix agent installed")
    // Nonce consumed on use to prevent replay.
    expect(kv.delete).toHaveBeenCalledWith(`linear-oauth-state:${state}`)
    expect(kv._store.has(`linear-oauth-state:${state}`)).toBe(false)
    // Token persisted under the agent-token key.
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_xyz")
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("sends grant_type, client creds, code + the request-origin redirect_uri when issuer unset", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz" })

    await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe("https://api.linear.app/oauth/token")
    const form = new URLSearchParams(init.body as string)
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("client_id")).toBe("client-id-123")
    expect(form.get("client_secret")).toBe("client-secret-shh")
    expect(form.get("code")).toBe("the-code")
    expect(form.get("redirect_uri")).toBe(`${CALLBACK_ORIGIN}/linear/oauth/callback`)
  })

  it("PINS redirect_uri to OPENCLAW_GATEWAY_ISSUER (not the request origin)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz" })
    const env = makeEnv(kv, { OPENCLAW_GATEWAY_ISSUER: "https://pinned.example.com" })

    await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), env)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const form = new URLSearchParams(init.body as string)
    expect(form.get("redirect_uri")).toBe("https://pinned.example.com/linear/oauth/callback")
  })

  it("returns 502 on a non-2xx token response (body never logged)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("the-code leaked here", { status: 400 }))
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))
    expect(res.status).toBe(502)
    const logged = spyError.mock.calls.flat().map(String).join("\n")
    expect(logged).not.toContain("the-code")
  })

  it("returns 502 when the token response is missing access_token", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenFetch({ token_type: "Bearer" })
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))
    expect(res.status).toBe(502)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBeNull()
  })

  it("returns 502 (not a throw) when the KV persist fails", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    kv.put.mockRejectedValueOnce(new Error("KV unavailable"))
    mockTokenFetch({ access_token: "lin_agent_xyz" })
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))
    expect(res.status).toBe(502)
  })

  it("returns 502 (not a throw) when the nonce delete fails", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    kv.delete.mockRejectedValueOnce(new Error("KV unavailable"))
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))
    expect(res.status).toBe(502)
    // No code exchange after a failed nonce delete.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns 502 (not a throw) on a network error during token exchange (all 3 attempts rejected)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))
    expect(res.status).toBe(502)
  })

  // ── token exchange retry logic ───────────────────────────────────────────────

  it("503 then 200: succeeds after retry (fetch called more than once)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "service_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "lin_agent_retry_ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(200)
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_retry_ok")
  })

  it("503 on all attempts: final failure (502 to caller), error body logged server-side, code never logged", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const errorBody = JSON.stringify({ error: "service_unavailable", error_description: "Linear is down" })
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(errorBody, { status: 503, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(errorBody, { status: 503, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(errorBody, { status: 503, headers: { "content-type": "application/json" } }))

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(502)
    // Body logged server-side for diagnosis — use JSON.stringify to inspect nested objects.
    const loggedJson = JSON.stringify(spyError.mock.calls)
    expect(loggedJson).toContain("service_unavailable")
    // code must never appear in any log output.
    expect(loggedJson).not.toContain("the-code")
    // Caller-facing message stays generic.
    expect(await res.text()).toContain("Sigilix install failed during token exchange")
  })

  it("400: no retry (single attempt — deterministic client error)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    )

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("success path: access_token body is never logged even when retries occurred", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "service_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "lin_agent_SECRET_RETRY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )

    await handleLinearOAuthCallback(callbackReq({ code: "SECRET_CODE_RETRY", state }), makeEnv(kv))

    const allOutput = [...spyLog.mock.calls.flat().map(String), ...spyError.mock.calls.flat().map(String)].join("\n")
    expect(allOutput).not.toContain("lin_agent_SECRET_RETRY")
    expect(allOutput).not.toContain("SECRET_CODE_RETRY")
    expect(allOutput).not.toContain("client-secret-shh")
  })

  // ── workspace allowlist (OPENCLAW_LINEAR_ALLOWED_ORG_ID) ────────────────────

  it("rejects a mismatched org with a neutral 403 and does NOT persist the token", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenThenOrgFetch({ access_token: "lin_agent_xyz" }, "org-other")
    const env = makeEnv(kv, { OPENCLAW_LINEAR_ALLOWED_ORG_ID: "org-allowed" })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), env)

    expect(res.status).toBe(403)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBeNull()
    expect(spyError.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-install-org-rejected")
  })

  it("allows + persists when the org matches the allowlist", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenThenOrgFetch({ access_token: "lin_agent_xyz" }, "org-allowed")
    const env = makeEnv(kv, { OPENCLAW_LINEAR_ALLOWED_ORG_ID: "org-allowed" })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), env)

    expect(res.status).toBe(200)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_xyz")
  })

  it("allows + persists + WARNS when no allowlist is configured (no org read)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz" })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(200)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_xyz")
    // Only the token exchange — no org read when the allowlist is unset.
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(spyWarn.mock.calls.flat().map(String).join("\n")).toContain("linear-agent-install-no-org-allowlist")
  })

  it("NEVER logs the code, client_secret, or access token", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenFetch({ access_token: "lin_agent_SECRET_TOKEN", scope: "app:assignable" })

    await handleLinearOAuthCallback(callbackReq({ code: "SECRET_CODE_42", state }), makeEnv(kv))

    const allOutput = [...spyLog.mock.calls.flat().map(String), ...spyError.mock.calls.flat().map(String)].join("\n")
    expect(allOutput).toContain("linear-agent-installed")
    expect(allOutput).not.toContain("lin_agent_SECRET_TOKEN")
    expect(allOutput).not.toContain("SECRET_CODE_42")
    expect(allOutput).not.toContain("client-secret-shh")
  })
})
