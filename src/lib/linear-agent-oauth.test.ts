// Tests for the Linear AGENT install — the actor=app install entry (/linear/install),
// the authorization-code callback, and the agent-token KV store.
//
// Covers: token KV round-trip + malformed/missing handling, not-configured 503,
// REQUIRED CSRF state (missing → 400, unknown → 400, deleted on use, preserved on a
// missing-code 400), missing-code 400, authorize-error 400, happy-path exchange +
// token persist + 200, redirect_uri PINNED to OPENCLAW_GATEWAY_ISSUER (fallback to the
// request origin), grant params, non-2xx / invalid-JSON / missing-access_token 502, KV
// persist failure 502, the workspace allowlist (reject mismatch 403, allow + warn when
// unset, allow on match), the /linear/install nonce + authorize-URL params,
// dedicated agent-app credentials (OPENCLAW_LINEAR_AGENT_CLIENT_ID/SECRET with fallback
// to LINEAR_OAUTH_CLIENT_*), single-attempt token exchange (no retry — reusing a
// consumed code causes invalid_grant), and — critically — that the code / client_secret
// / access token are NEVER logged.
//
// Fetch is stubbed via vi.spyOn(globalThis, "fetch"), following slack-install.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

// SIG-144 slice 2: handleLinearOAuthCallback now ALSO bootstraps the
// LinearTokenBroker DO via installAgentTokenToBroker. Mocked here (rather than
// built out as a real DO stub) the same way linear-agent-run.test.ts mocks
// buildLinearAgentClient — this file tests handleLinearOAuthCallback's OWN
// orchestration (it calls the helper with the right record, and a broker
// failure never breaks the response), not the broker client's own mapping
// logic (covered in linear-token-broker-client.test.ts).
vi.mock("@/src/lib/linear-token-broker-client", () => ({
  commitAgentTokenToBroker: vi.fn(),
  installAgentTokenToBroker: vi.fn(),
  rollbackAgentTokenFromBroker: vi.fn(),
  stageAgentTokenToBroker: vi.fn(),
  uninstallAgentTokenFromBroker: vi.fn(),
}))

import {
  handleLinearOAuthCallback,
  handleLinearInstall,
  getLinearAgentToken,
  putLinearAgentToken,
  refreshAgentToken,
  getValidAgentToken,
  LINEAR_AGENT_TOKEN_KEY,
  type LinearAgentTokenRecord,
} from "@/src/lib/linear-agent-oauth"
import { installAgentTokenToBroker } from "@/src/lib/linear-token-broker-client"
import type { Env } from "@/src/shared/types/env"

const mockInstallAgentTokenToBroker = vi.mocked(installAgentTokenToBroker)

// Default to success so the ~70 pre-existing callback tests below (which don't
// care about the broker bootstrap) see no warning noise; the dedicated tests
// in "handleLinearOAuthCallback — broker bootstrap (SIG-144 slice 2)" override
// this per-case.
beforeEach(() => {
  mockInstallAgentTokenToBroker.mockReset().mockResolvedValue(true)
})

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

/** Read + parse the stored agent token record straight from the fake KV. */
function readStoredRecord(kv: FakeKV): LinearAgentTokenRecord | null {
  const raw = kv._store.get(LINEAR_AGENT_TOKEN_KEY)
  return raw ? (JSON.parse(raw) as LinearAgentTokenRecord) : null
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

  it("returns 410 when LINEAR_OAUTH_CLIENT_ID is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { LINEAR_OAUTH_CLIENT_ID: undefined })
    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)
    expect(res.status).toBe(410)
  })

  it("returns 410 and never mints a new bare-nonce OAuth state", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { OPENCLAW_GATEWAY_ISSUER: CALLBACK_ORIGIN })

    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)

    expect(res.status).toBe(410)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("stays disabled when OPENCLAW_GATEWAY_ISSUER is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv) // no OPENCLAW_GATEWAY_ISSUER
    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)
    expect(res.status).toBe(410)
  })
})

// ─── handleLinearOAuthCallback ───────────────────────────────────────────────
describe("handleLinearOAuthCallback", () => {
  let spyLog: MockInstance
  let spyWarn: MockInstance
  let spyError: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    // restoreAllMocks above clears the module-level broker mock's implementation;
    // re-stub it so the callback's bootstrap step stays a no-op success (these
    // tests assert the OAuth/KV behavior, not the broker bootstrap).
    mockInstallAgentTokenToBroker.mockResolvedValue(true)
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

  it("captures the rotating refresh_token into the stored record (never logged)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenFetch({
      access_token: "lin_agent_xyz",
      refresh_token: "lin_refresh_SECRET_1",
      expires_in: 86400,
      scope: "app:assignable",
    })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(200)
    const record = readStoredRecord(kv)
    expect(record?.refreshToken).toBe("lin_refresh_SECRET_1")
    // The refresh token must NEVER reach any log line.
    const allOutput = [...spyLog.mock.calls.flat().map(String), ...spyError.mock.calls.flat().map(String)].join("\n")
    expect(allOutput).toContain("linear-agent-installed")
    expect(allOutput).toContain('"hasRefresh":true')
    expect(allOutput).not.toContain("lin_refresh_SECRET_1")
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

  it("returns 502 (not a throw) on a network error during token exchange (single attempt)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"))
    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))
    expect(res.status).toBe(502)
    // Single attempt only — authorization codes are single-use; no retry.
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  // ── single-attempt token exchange ────────────────────────────────────────────

  it("503: single attempt — 502 to caller, body logged server-side, NO second fetch", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const errorBody = JSON.stringify({ error: "service_unavailable", error_description: "Linear is down" })
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
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
    // Authorization codes are single-use — no retry on 5xx.
    expect(fetchSpy).toHaveBeenCalledOnce()
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

  it("success path: access_token body is never logged (single-attempt exchange)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenFetch({ access_token: "lin_agent_SECRET_SINGLE" })

    await handleLinearOAuthCallback(callbackReq({ code: "SECRET_CODE_SINGLE", state }), makeEnv(kv))

    const allOutput = [...spyLog.mock.calls.flat().map(String), ...spyError.mock.calls.flat().map(String)].join("\n")
    expect(allOutput).not.toContain("lin_agent_SECRET_SINGLE")
    expect(allOutput).not.toContain("SECRET_CODE_SINGLE")
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

// ─── handleLinearOAuthCallback — broker bootstrap (SIG-144 slice 2) ─────────
describe("handleLinearOAuthCallback — broker bootstrap (SIG-144 slice 2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    mockInstallAgentTokenToBroker.mockReset().mockResolvedValue(true)
  })

  it("calls installAgentTokenToBroker with the SAME record persisted to KV", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenFetch({
      access_token: "lin_agent_xyz",
      refresh_token: "lin_refresh_1",
      expires_in: 3600,
      scope: "app:assignable",
    })
    const env = makeEnv(kv)

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), env)

    expect(res.status).toBe(200)
    expect(mockInstallAgentTokenToBroker).toHaveBeenCalledTimes(1)
    const [calledEnv, calledRecord] = mockInstallAgentTokenToBroker.mock.calls[0]!
    expect(calledEnv).toBe(env)
    expect(calledRecord).toEqual(readStoredRecord(kv))
  })

  it("a broker bootstrap failure does NOT fail the response — KV remains the source of truth this slice", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenFetch({ access_token: "lin_agent_xyz", expires_in: 3600 })
    mockInstallAgentTokenToBroker.mockResolvedValue(false)

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(200)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_xyz")
    expect(mockInstallAgentTokenToBroker).toHaveBeenCalledTimes(1)
  })

  it("a broker bootstrap THROW does NOT fail the response either (defense in depth)", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    mockTokenFetch({ access_token: "lin_agent_xyz", expires_in: 3600 })
    mockInstallAgentTokenToBroker.mockRejectedValue(new Error("DO unreachable"))

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    expect(res.status).toBe(200)
    expect(await getLinearAgentToken(kv as unknown as KVNamespace)).toBe("lin_agent_xyz")
  })
})

// ─── dedicated agent-app credentials ─────────────────────────────────────────
describe("agent-specific OAuth credentials (OPENCLAW_LINEAR_AGENT_CLIENT_*)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // restoreAllMocks clears the module-level broker mock; re-stub it so the two
    // callback cases below don't emit a spurious broker-install-failed warning.
    mockInstallAgentTokenToBroker.mockResolvedValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("handleLinearInstall: stays disabled when dedicated agent credentials are set", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      OPENCLAW_LINEAR_AGENT_CLIENT_ID: "agent-app-id",
      OPENCLAW_GATEWAY_ISSUER: CALLBACK_ORIGIN,
    })
    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)
    expect(res.status).toBe(410)
  })

  it("handleLinearInstall: stays disabled when only shared credentials are set", async () => {
    const kv = makeFakeKV()
    // makeEnv defaults: LINEAR_OAUTH_CLIENT_ID = "client-id-123", no agent cred
    const env = makeEnv(kv, { OPENCLAW_GATEWAY_ISSUER: CALLBACK_ORIGIN })
    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)
    expect(res.status).toBe(410)
  })

  it("handleLinearInstall: returns 410 when neither agent nor shared client_id is set", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      LINEAR_OAUTH_CLIENT_ID: undefined,
      OPENCLAW_LINEAR_AGENT_CLIENT_ID: undefined,
    })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearInstall(new Request(`${CALLBACK_ORIGIN}/linear/install`), env)
    expect(res.status).toBe(410)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("callback: token exchange uses OPENCLAW_LINEAR_AGENT_CLIENT_ID/SECRET when both are set", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz" })
    const env = makeEnv(kv, {
      OPENCLAW_LINEAR_AGENT_CLIENT_ID: "agent-app-id",
      OPENCLAW_LINEAR_AGENT_CLIENT_SECRET: "agent-app-secret",
    })

    const res = await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), env)

    expect(res.status).toBe(200)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const form = new URLSearchParams(init.body as string)
    expect(form.get("client_id")).toBe("agent-app-id")
    expect(form.get("client_secret")).toBe("agent-app-secret")
  })

  it("callback: falls back to LINEAR_OAUTH_CLIENT_ID/SECRET when agent creds are unset", async () => {
    const kv = makeFakeKV()
    const state = seedState(kv)
    // makeEnv defaults: LINEAR_OAUTH_CLIENT_ID/SECRET set, no agent creds
    const fetchSpy = mockTokenFetch({ access_token: "lin_agent_xyz" })

    await handleLinearOAuthCallback(callbackReq({ code: "the-code", state }), makeEnv(kv))

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const form = new URLSearchParams(init.body as string)
    expect(form.get("client_id")).toBe("client-id-123")
    expect(form.get("client_secret")).toBe("client-secret-shh")
  })

  it("callback: returns 503 when neither agent nor shared credentials are configured", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      LINEAR_OAUTH_CLIENT_ID: undefined,
      LINEAR_OAUTH_CLIENT_SECRET: undefined,
      OPENCLAW_LINEAR_AGENT_CLIENT_ID: undefined,
      OPENCLAW_LINEAR_AGENT_CLIENT_SECRET: undefined,
    })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleLinearOAuthCallback(callbackReq({ code: "c", state: "s" }), env)
    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── refreshAgentToken (rotating refresh-token exchange) ─────────────────────
describe("refreshAgentToken", () => {
  let spyError: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    spyError = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function seedRecord(kv: FakeKV, record: LinearAgentTokenRecord): void {
    kv._store.set(LINEAR_AGENT_TOKEN_KEY, JSON.stringify(record))
  }

  it("returns null (no fetch) when there is no stored refresh token", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, { accessToken: "old", installedAt: 1 }) // no refreshToken
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await refreshAgentToken(makeEnv(kv))).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("rotates: persists BOTH the new access + new refresh token and returns the new access", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      scope: "app:assignable",
      expiresAt: Date.now() + 1000,
      installedAt: 42,
    })
    const fetchSpy = mockTokenFetch({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 86400,
      scope: "app:assignable,app:mentionable",
    })

    const result = await refreshAgentToken(makeEnv(kv))

    expect(result).toBe("access-new")
    expect(fetchSpy).toHaveBeenCalledOnce()
    // form-encoded grant_type=refresh_token with the stored refresh token + creds.
    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe("https://api.linear.app/oauth/token")
    const form = new URLSearchParams(init.body as string)
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe("refresh-old")
    expect(form.get("client_id")).toBe("client-id-123")
    expect(form.get("client_secret")).toBe("client-secret-shh")
    // Rotation persisted: both values replaced, installedAt preserved.
    const record = readStoredRecord(kv)
    expect(record?.accessToken).toBe("access-new")
    expect(record?.refreshToken).toBe("refresh-new")
    expect(record?.scope).toBe("app:assignable,app:mentionable")
    expect(record?.installedAt).toBe(42)
  })

  it("falls back to the OLD refresh token when the response omits a new one", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, { accessToken: "access-old", refreshToken: "refresh-old", installedAt: 1 })
    mockTokenFetch({ access_token: "access-new", expires_in: 86400 }) // no refresh_token

    expect(await refreshAgentToken(makeEnv(kv))).toBe("access-new")
    expect(readStoredRecord(kv)?.refreshToken).toBe("refresh-old")
  })

  it("returns null + logs + does NOT corrupt the stored record on a non-2xx response", async () => {
    const kv = makeFakeKV()
    const original: LinearAgentTokenRecord = {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      scope: "app:assignable",
      expiresAt: 111,
      installedAt: 7,
    }
    seedRecord(kv, original)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    )

    expect(await refreshAgentToken(makeEnv(kv))).toBeNull()
    // Loud, structured log — and no token material in it.
    const logged = JSON.stringify(spyError.mock.calls)
    expect(logged).toContain("linear-agent-refresh-failed")
    expect(logged).not.toContain("refresh-old")
    expect(logged).not.toContain("access-old")
    // Stored record untouched by a failed refresh.
    expect(readStoredRecord(kv)).toEqual(original)
  })

  it("returns null on a network error (single attempt — no retry)", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, { accessToken: "access-old", refreshToken: "refresh-old", installedAt: 1 })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"))

    expect(await refreshAgentToken(makeEnv(kv))).toBeNull()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(JSON.stringify(spyError.mock.calls)).toContain("linear-agent-refresh-failed")
  })

  it("returns null when the response is missing access_token (record not corrupted)", async () => {
    const kv = makeFakeKV()
    const original: LinearAgentTokenRecord = { accessToken: "access-old", refreshToken: "refresh-old", installedAt: 1 }
    seedRecord(kv, original)
    mockTokenFetch({ token_type: "Bearer" })

    expect(await refreshAgentToken(makeEnv(kv))).toBeNull()
    expect(readStoredRecord(kv)).toEqual(original)
  })

  it("returns null (no fetch) when OAuth creds are unset", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, { accessToken: "access-old", refreshToken: "refresh-old", installedAt: 1 })
    const env = makeEnv(kv, { LINEAR_OAUTH_CLIENT_ID: undefined, LINEAR_OAUTH_CLIENT_SECRET: undefined })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await refreshAgentToken(env)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("defaults expiresAt to 24h when the refresh response omits expires_in (keeps proactive refresh alive)", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, { accessToken: "access-old", refreshToken: "refresh-old", installedAt: 1 })
    const before = Date.now()
    mockTokenFetch({ access_token: "access-new", refresh_token: "refresh-new" }) // no expires_in

    expect(await refreshAgentToken(makeEnv(kv))).toBe("access-new")
    const record = readStoredRecord(kv)
    const dayMs = 24 * 60 * 60 * 1000
    expect(record?.expiresAt).toBeGreaterThanOrEqual(before + dayMs)
    expect(record?.expiresAt).toBeLessThanOrEqual(Date.now() + dayMs)
  })
})

// ─── getValidAgentToken (freshness gate + within-isolate single-flight) ──────
describe("getValidAgentToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function seedRecord(kv: FakeKV, record: LinearAgentTokenRecord): void {
    kv._store.set(LINEAR_AGENT_TOKEN_KEY, JSON.stringify(record))
  }

  it("returns null when no agent token is installed", async () => {
    const kv = makeFakeKV()
    expect(await getValidAgentToken(makeEnv(kv))).toBeNull()
  })

  it("returns the cached token as-is when no expiry is recorded (legacy install, no fetch)", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, { accessToken: "legacy", refreshToken: "r", installedAt: 1 }) // no expiresAt
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await getValidAgentToken(makeEnv(kv))).toBe("legacy")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns the cached token without refreshing when far from expiry (no fetch)", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, {
      accessToken: "still-good",
      refreshToken: "r",
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h out — well past the 10m buffer
      installedAt: 1,
    })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await getValidAgentToken(makeEnv(kv))).toBe("still-good")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refreshes when within the buffer of expiry and returns + persists the new token", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, {
      accessToken: "near-expiry",
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 5 * 60 * 1000, // 5m out — inside the 10m buffer
      installedAt: 1,
    })
    const fetchSpy = mockTokenFetch({ access_token: "fresh", refresh_token: "refresh-new", expires_in: 86400 })

    expect(await getValidAgentToken(makeEnv(kv))).toBe("fresh")
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(readStoredRecord(kv)?.accessToken).toBe("fresh")
  })

  it("refreshes when the token is already expired", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, {
      accessToken: "expired",
      refreshToken: "refresh-old",
      expiresAt: Date.now() - 1000,
      installedAt: 1,
    })
    const fetchSpy = mockTokenFetch({ access_token: "fresh", refresh_token: "refresh-new", expires_in: 86400 })

    expect(await getValidAgentToken(makeEnv(kv))).toBe("fresh")
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("falls back to the still-valid cached token when a refresh inside the buffer FAILS", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, {
      accessToken: "near-expiry-but-valid",
      refreshToken: "refresh-old",
      expiresAt: Date.now() + 5 * 60 * 1000, // inside the 10m buffer, not hard-expired
      installedAt: 1,
    })
    // Refresh attempt fails (transient 503).
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 503 }))

    // Availability: a failed refresh must NOT discard a token that is still valid.
    expect(await getValidAgentToken(makeEnv(kv))).toBe("near-expiry-but-valid")
    // The stored record is untouched by the failed refresh.
    expect(readStoredRecord(kv)?.accessToken).toBe("near-expiry-but-valid")
    expect(readStoredRecord(kv)?.refreshToken).toBe("refresh-old")
  })

  it("returns null when a refresh fails AND the stored token is already hard-expired", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, {
      accessToken: "expired",
      refreshToken: "refresh-old",
      expiresAt: Date.now() - 1000, // hard expired — no safe fallback
      installedAt: 1,
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 503 }))

    expect(await getValidAgentToken(makeEnv(kv))).toBeNull()
  })

  it("single-flight: two concurrent expired calls trigger exactly ONE token POST", async () => {
    const kv = makeFakeKV()
    seedRecord(kv, {
      accessToken: "expired",
      refreshToken: "refresh-old",
      expiresAt: Date.now() - 1000,
      installedAt: 1,
    })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "fresh", refresh_token: "refresh-new", expires_in: 86400 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    const [a, b] = await Promise.all([getValidAgentToken(makeEnv(kv)), getValidAgentToken(makeEnv(kv))])

    expect(a).toBe("fresh")
    expect(b).toBe("fresh")
    // Deduped within the isolate — only ONE refresh POST despite two concurrent calls.
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})
