// Tests for the Linear AGENT install — actor=app authorization-code callback +
// agent-token KV store.
//
// Covers: token KV round-trip + malformed/missing handling, not-configured 503,
// missing-code 400, authorize-error 400, happy-path exchange + token persist + 200,
// exact redirect_uri (derived from the request origin) + grant params, opportunistic
// state-nonce consumption, non-2xx / invalid-JSON / missing-access_token 502, KV
// persist failure 502, and — critically — that the code / client_secret / access
// token are NEVER logged.
//
// Fetch is stubbed via vi.spyOn(globalThis, "fetch"), following slack-install.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import {
  handleLinearOAuthCallback,
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

function mockTokenFetch(body: unknown, status = 200): MockInstance {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
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

// ─── handleLinearOAuthCallback ───────────────────────────────────────────────
describe("handleLinearOAuthCallback", () => {
  let spyLog: MockInstance
  let spyError: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns 503 when LINEAR_OAUTH_CLIENT_ID/SECRET are unset (no fetch)", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { LINEAR_OAUTH_CLIENT_ID: undefined, LINEAR_OAUTH_CLIENT_SECRET: undefined })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ code: "c" }), env)
    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns 400 when the authorization code is missing (no fetch)", async () => {
    const kv = makeFakeKV()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq(), makeEnv(kv))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns 400 when Linear bounced with ?error (no fetch, raw error not echoed)", async () => {
    const kv = makeFakeKV()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ error: "access_denied" }), makeEnv(kv))
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await res.text()).not.toContain("access_denied")
  })

  it("happy path: exchanges the code, stores the agent token, returns 200 success page", async () => {
    const kv = makeFakeKV()
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz", expires_in: 3600, scope: "app:assignable" })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code" }), makeEnv(kv))

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("Sigilix agent installed")
    // Token persisted under the agent-token key.
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_xyz")
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("sends grant_type=authorization_code + the exact request-derived redirect_uri + the code", async () => {
    const kv = makeFakeKV()
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz" })

    await handleLinearOAuthCallback(callbackReq({ code: "the-code" }), makeEnv(kv))

    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe("https://api.linear.app/oauth/token")
    const form = new URLSearchParams(init.body as string)
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("client_id")).toBe("client-id-123")
    expect(form.get("client_secret")).toBe("client-secret-shh")
    expect(form.get("code")).toBe("the-code")
    expect(form.get("redirect_uri")).toBe(`${CALLBACK_ORIGIN}/linear/oauth/callback`)
  })

  it("consumes a matching CSRF state nonce when one exists in KV", async () => {
    const kv = makeFakeKV()
    kv._store.set("linear-oauth-state:nonce-1", "1")
    mockTokenFetch({ access_token: "lin_agent_xyz" })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state: "nonce-1" }), makeEnv(kv))

    expect(res.status).toBe(200)
    expect(kv.delete).toHaveBeenCalledWith("linear-oauth-state:nonce-1")
    expect(kv._store.has("linear-oauth-state:nonce-1")).toBe(false)
  })

  it("does NOT block the install when state has no stored nonce (manual authorize)", async () => {
    const kv = makeFakeKV()
    mockTokenFetch({ access_token: "lin_agent_xyz" })
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state: "unknown" }), makeEnv(kv))
    expect(res.status).toBe(200)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_xyz")
  })

  it("returns 502 on a non-2xx token response (body never logged)", async () => {
    const kv = makeFakeKV()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("the-code leaked here", { status: 400 }))
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code" }), makeEnv(kv))
    expect(res.status).toBe(502)
    const logged = spyError.mock.calls.flat().map(String).join("\n")
    expect(logged).not.toContain("the-code")
  })

  it("returns 502 when the token response is missing access_token", async () => {
    const kv = makeFakeKV()
    mockTokenFetch({ token_type: "Bearer" })
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code" }), makeEnv(kv))
    expect(res.status).toBe(502)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBeNull()
  })

  it("returns 502 (not a throw) when the KV persist fails", async () => {
    const kv = makeFakeKV()
    kv.put.mockRejectedValueOnce(new Error("KV unavailable"))
    mockTokenFetch({ access_token: "lin_agent_xyz" })
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code" }), makeEnv(kv))
    expect(res.status).toBe(502)
  })

  it("returns 502 (not a throw) on a network error during token exchange", async () => {
    const kv = makeFakeKV()
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"))
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code" }), makeEnv(kv))
    expect(res.status).toBe(502)
  })

  it("NEVER logs the code, client_secret, or access token", async () => {
    const kv = makeFakeKV()
    mockTokenFetch({ access_token: "lin_agent_SECRET_TOKEN", scope: "app:assignable" })

    await handleLinearOAuthCallback(callbackReq({ code: "SECRET_CODE_42" }), makeEnv(kv))

    const allOutput = [...spyLog.mock.calls.flat().map(String), ...spyError.mock.calls.flat().map(String)].join("\n")
    expect(allOutput).toContain("linear-agent-installed")
    expect(allOutput).not.toContain("lin_agent_SECRET_TOKEN")
    expect(allOutput).not.toContain("SECRET_CODE_42")
    expect(allOutput).not.toContain("client-secret-shh")
  })
})
