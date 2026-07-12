// Tests for Slack KV install store and OAuth v2 callback.
// Covers: KV round-trip, SLACK_BOT_TOKEN fallback, missing-code 400,
// happy-path exchange+redirect, ok:false 502, non-2xx 502, default base URL,
// CSRF state verification (missing/forged/valid state, nonce deletion),
// and buildSlackAuthorizeUrl URL generation.
// Fetch is stubbed via vi.spyOn(globalThis, "fetch") following the pattern in
// auth-oauth-github.test.ts.

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  putSlackInstall,
  getSlackBotToken,
  handleSlackOAuthCallback,
  buildSlackAuthorizeUrl,
  handleSlackInstall,
} from "@/src/lib/slack/slack-install"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const BASE_SQL = readFileSync(new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const SLACK_SQL = readFileSync(
  new URL("../../../migrations/0019_create_slack_channel_repo.sql", import.meta.url),
  "utf8",
)

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

/** Build a minimal Env-shaped object for tests. Only the fields the module
 *  under test actually reads at runtime. Cast to Env via `unknown` because
 *  the full interface has many required DO bindings not needed in unit tests. */
function makeEnv(kv: FakeKV, extra: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv as unknown as KVNamespace,
    ...extra,
  } as unknown as Env
}

/** Seed a CSRF nonce into the fake KV and return the state string. */
function seedState(kv: FakeKV, state = "test-state-nonce"): string {
  kv._store.set(`slack-oauth-state:${state}`, "1")
  return state
}

// ─── putSlackInstall / getSlackBotToken ─────────────────────────────────────

describe("putSlackInstall / getSlackBotToken", () => {
  it("round-trips an install record through KV", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv)
    const install = { teamId: "T123", botToken: "xoxb-abc", installedAt: 1000 }

    await putSlackInstall(env, install)

    expect(kv.put).toHaveBeenCalledWith("slack-install:T123", JSON.stringify(install))
    const token = await getSlackBotToken(env, "T123")
    expect(token).toBe("xoxb-abc")
  })

  it("returns null when no KV record and SLACK_BOT_TOKEN is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv)
    expect(await getSlackBotToken(env, "TUNKNOWN")).toBeNull()
  })

  it("falls back to SLACK_BOT_TOKEN when no KV record exists", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { SLACK_BOT_TOKEN: "xoxb-fallback" })
    expect(await getSlackBotToken(env, "TUNKNOWN")).toBe("xoxb-fallback")
  })

  it("prefers the KV botToken over SLACK_BOT_TOKEN", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { SLACK_BOT_TOKEN: "xoxb-fallback" })
    await putSlackInstall(env, { teamId: "T456", botToken: "xoxb-kv", installedAt: 2000 })
    expect(await getSlackBotToken(env, "T456")).toBe("xoxb-kv")
  })

  it("falls back to env token when KV record has a missing botToken field (malformed record)", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { SLACK_BOT_TOKEN: "xoxb-env-fallback" })
    // Manually write a malformed record (no botToken field) to KV.
    kv._store.set("slack-install:TMALFORMED", JSON.stringify({ teamId: "TMALFORMED", installedAt: 1000 }))
    const token = await getSlackBotToken(env, "TMALFORMED")
    expect(token).toBe("xoxb-env-fallback")
  })

  it("falls back to env token when KV record has an empty-string botToken", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { SLACK_BOT_TOKEN: "xoxb-env-fallback" })
    kv._store.set("slack-install:TEMPTY", JSON.stringify({ teamId: "TEMPTY", botToken: "", installedAt: 1000 }))
    const token = await getSlackBotToken(env, "TEMPTY")
    expect(token).toBe("xoxb-env-fallback")
  })
})

// ─── buildSlackAuthorizeUrl ──────────────────────────────────────────────────

describe("buildSlackAuthorizeUrl", () => {
  it("stores a slack-oauth-state:* nonce in KV and returns a URL with that exact state", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "myclient",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })

    const url = await buildSlackAuthorizeUrl(env)

    // One nonce stored.
    const stateKey = [...kv._store.keys()].find((k) => k.startsWith("slack-oauth-state:"))
    expect(stateKey).toBeDefined()
    const storedState = stateKey!.replace("slack-oauth-state:", "")

    // URL carries the same state value.
    expect(url).toContain(`state=${encodeURIComponent(storedState)}`)
    expect(url).toContain("https://slack.com/oauth/v2/authorize")
    expect(url).toContain("client_id=myclient")
    expect(url).toContain(encodeURIComponent("https://app.sigilix.ai/slack/oauth/callback"))
  })

  it("uses custom scopes when provided", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, { SLACK_CLIENT_ID: "cid", OPENCLAW_BASE_URL: "https://app.sigilix.ai" })
    const url = await buildSlackAuthorizeUrl(env, { scopes: "chat:write" })
    expect(url).toContain(encodeURIComponent("chat:write"))
  })
})

// ─── handleSlackOAuthCallback ────────────────────────────────────────────────

describe("handleSlackOAuthCallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function callbackReq(params: Record<string, string> = {}): Request {
    const url = new URL("https://app.sigilix.ai/slack/oauth/callback")
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return new Request(url.toString())
  }

  function mockSlackFetch(response: { ok: boolean; status?: number; body?: unknown }) {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(response.body ?? { ok: response.ok }), {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }

  // ── CSRF state tests ──

  it("returns 400 when state query param is missing", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123" }), env)
    expect(res.status).toBe(400)
    // No code exchange attempted.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns 400 when state is unknown / forged (not in KV)", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "forged-state" }), env)
    expect(res.status).toBe(400)
    // No code exchange attempted.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("proceeds and deletes the state key when state is valid (pre-seeded in KV)", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)
    mockSlackFetch({ ok: true, body: { ok: true, access_token: "xoxb-new", team: { id: "T999" } } })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state }), env)

    expect(res.status).toBe(302)
    // Nonce deleted to prevent replay.
    expect(kv.delete).toHaveBeenCalledWith(`slack-oauth-state:${state}`)
    expect(kv._store.has(`slack-oauth-state:${state}`)).toBe(false)
  })

  // ── Existing callback tests (updated to include valid state) ──

  it("returns 400 when code query param is missing", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)
    // state is valid but code is absent.
    const res = await handleSlackOAuthCallback(callbackReq({ state }), env)
    expect(res.status).toBe(400)
  })

  it("happy path: exchanges code, stores install, 302 to /slack/installed", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)
    mockSlackFetch({
      ok: true,
      body: { ok: true, access_token: "xoxb-new", team: { id: "T999" } },
    })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state }), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/slack/installed")
    expect(kv.put).toHaveBeenCalledWith("slack-install:T999", expect.stringContaining("xoxb-new"))
  })

  it("returns 502 when Slack API returns ok:false", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)
    mockSlackFetch({ ok: false, body: { ok: false, error: "invalid_code" } })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "badcode", state }), env)
    expect(res.status).toBe(502)
  })

  it("returns 502 on non-2xx HTTP response from Slack", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
    })
    const state = seedState(kv)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("server error", { status: 500 }))

    const res = await handleSlackOAuthCallback(callbackReq({ code: "badcode", state }), env)
    expect(res.status).toBe(502)
  })

  it("uses default base URL (https://app.sigilix.ai) when OPENCLAW_BASE_URL is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      // OPENCLAW_BASE_URL intentionally omitted
    })
    const state = seedState(kv)
    mockSlackFetch({
      ok: true,
      body: { ok: true, access_token: "xoxb-default", team: { id: "T001" } },
    })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code", state }), env)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/slack/installed")
  })

  // ── New OAuth-correctness tests ──

  it("includes redirect_uri in the token-exchange form body", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, access_token: "xoxb-new", team: { id: "T999" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await handleSlackOAuthCallback(callbackReq({ code: "code123", state }), env)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = new URLSearchParams(init.body as string)
    expect(body.get("redirect_uri")).toBe("https://app.sigilix.ai/slack/oauth/callback")
  })

  it("returns 502 (not a throw) when KV nonce delete fails", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)
    kv.delete.mockRejectedValueOnce(new Error("KV unavailable"))

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state }), env)
    expect(res.status).toBe(502)
  })

  it("returns 502 (not a throw) when KV put (install persist) fails", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)
    kv.put.mockRejectedValueOnce(new Error("KV unavailable"))
    mockSlackFetch({ ok: true, body: { ok: true, access_token: "xoxb-new", team: { id: "T999" } } })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state }), env)
    expect(res.status).toBe(502)
  })

  it("returns 400 and preserves the nonce when code is missing but state is valid", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const state = seedState(kv)

    const res = await handleSlackOAuthCallback(callbackReq({ state }), env)

    expect(res.status).toBe(400)
    // Nonce must NOT be consumed — the state key must still be in KV.
    expect(kv._store.has(`slack-oauth-state:${state}`)).toBe(true)
    expect(kv.delete).not.toHaveBeenCalled()
  })
})

// ─── handleSlackInstall ──────────────────────────────────────────────────────

describe("handleSlackInstall", () => {
  it("returns 302 to the Slack authorize URL with a fresh state nonce", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "cid",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })

    const res = await handleSlackInstall(new Request("https://app.sigilix.ai/slack/install"), env)

    expect(res.status).toBe(302)
    const location = res.headers.get("location") ?? ""
    expect(location).toContain("https://slack.com/oauth/v2/authorize")
    // A nonce was stored in KV.
    const hasStateKey = [...kv._store.keys()].some((k) => k.startsWith("slack-oauth-state:"))
    expect(hasStateKey).toBe(true)
  })

  it("returns 503 when SLACK_CLIENT_ID is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv) // no SLACK_CLIENT_ID

    const res = await handleSlackInstall(new Request("https://app.sigilix.ai/slack/install"), env)

    expect(res.status).toBe(503)
  })
})

// ─── Org-linked install (installation id threaded through OAuth state) ───────

describe("org-linked install → slack_workspace linkage", () => {
  const NOW = "2026-07-11T00:00:00.000Z"
  const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
  const COOKIE = "__Host-sigilix_session"
  // Matches sessionUserKey() for a session with githubUserId 111 and no userId.
  const USER_KEY = "gh:111"

  /** JSON-aware fake KV — requireSession/createSession read records as "json". */
  function makeSessionKV() {
    const values = new Map<string, string>()
    const kv = {
      _store: values,
      get: async (key: string, type?: "json") => {
        const raw = values.get(key)
        if (raw === undefined) return null
        return type === "json" ? JSON.parse(raw) : raw
      },
      put: async (key: string, value: string, _opts?: unknown) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
    }
    return kv as unknown as KVNamespace & { _store: Map<string, string> }
  }

  async function makeDb(): Promise<D1Database> {
    const db = makeD1()
    await db.exec(BASE_SQL)
    await db.exec(SLACK_SQL)
    return db
  }

  async function makeSessionEnv(kv: ReturnType<typeof makeSessionKV>, extra: Partial<Env> = {}): Promise<Env> {
    await createSession({
      kv,
      sessionId: "session-1",
      login: "octocat",
      githubUserId: 111,
      accessToken: "github-user-token",
      encryptionKeyB64url: ENC_KEY,
    })
    return {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://api.sigilix.ai",
      OPENCLAW_PORTAL_URL: "https://app.sigilix.ai",
      ...extra,
    } as unknown as Env
  }

  function callbackReq(params: Record<string, string>, withSessionCookie = true): Request {
    const url = new URL("https://api.sigilix.ai/slack/oauth/callback")
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return new Request(url.toString(), {
      headers: withSessionCookie ? { cookie: `${COOKIE}=session-1` } : {},
    })
  }

  function mockSlackExchangeOk(teamId = "TCUST"): void {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, access_token: "xoxb-cust", team: { id: teamId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }

  function seedOrgState(kv: { _store: Map<string, string> }, installationId = 42): void {
    kv._store.set(
      "slack-oauth-state:org-state",
      JSON.stringify({ installationId, login: "octocat", userKey: USER_KEY }),
    )
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("links the Slack team to the initiating installation and bounces to the portal", async () => {
    const kv = makeSessionKV()
    const db = await makeDb()
    const env = await makeSessionEnv(kv, { SIGILIX_PLATFORM_DB: db })
    seedOrgState(kv)
    mockSlackExchangeOk("TCUST")

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "org-state" }), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackConnected=1")
    // Bot token stored in KV as before…
    expect(kv._store.get("slack-install:TCUST")).toContain("xoxb-cust")
    // …and the workspace linked to installation 42 in D1.
    const row = await db
      .prepare("SELECT installation_id, installed_by FROM slack_workspace WHERE team_id = 'TCUST'")
      .first<{ installation_id: number; installed_by: string }>()
    expect(row).toEqual({ installation_id: 42, installed_by: "octocat" })
  })

  it("REJECTS an org-linked callback without the initiating user's session (forwarded link)", async () => {
    const kv = makeSessionKV()
    const db = await makeDb()
    const env = await makeSessionEnv(kv, { SIGILIX_PLATFORM_DB: db })
    seedOrgState(kv)
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    const res = await handleSlackOAuthCallback(
      callbackReq({ code: "code123", state: "org-state" }, /* withSessionCookie */ false),
      env,
    )

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackError=session_mismatch")
    // No token exchange, no install stored, no workspace linked.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      await db
        .prepare("SELECT team_id FROM slack_workspace")
        .all()
        .then((r) => r.results),
    ).toEqual([])
  })

  it("REJECTS an org-linked callback from a DIFFERENT signed-in user than the initiator", async () => {
    const kv = makeSessionKV()
    const db = await makeDb()
    const env = await makeSessionEnv(kv, { SIGILIX_PLATFORM_DB: db })
    // State was minted by someone else (different stable user key).
    kv._store.set(
      "slack-oauth-state:org-state",
      JSON.stringify({ installationId: 42, login: "attacker", userKey: "gh:999" }),
    )

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "org-state" }), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackError=session_mismatch")
  })

  it("legacy anonymous state ('1') stores the install with NO org linkage", async () => {
    const kv = makeSessionKV()
    const db = await makeDb()
    const env = await makeSessionEnv(kv, { SIGILIX_PLATFORM_DB: db })
    kv._store.set("slack-oauth-state:anon-state", "1")
    mockSlackExchangeOk("TANON")

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "anon-state" }, false), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://api.sigilix.ai/slack/installed")
    const row = await db.prepare("SELECT team_id FROM slack_workspace WHERE team_id = 'TANON'").first()
    expect(row).toBeNull()
  })

  it("rejects a malformed structured state outright (never downgrades to an unlinked install)", async () => {
    const kv = makeSessionKV()
    const env = await makeSessionEnv(kv)
    kv._store.set("slack-oauth-state:org-state", JSON.stringify({ installationId: 42 })) // no login/userKey
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "org-state" }), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackError=state_invalid")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("surfaces org_link_failed (portal redirect) when the workspace linkage cannot be written", async () => {
    const kv = makeSessionKV()
    // No SIGILIX_PLATFORM_DB bound → upsert throws → org_link_failed.
    const env = await makeSessionEnv(kv)
    seedOrgState(kv)
    mockSlackExchangeOk("TFAIL")

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "org-state" }), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackError=org_link_failed")
  })

  it("handleSlackInstall with ?installation_id and no session redirects to the portal login", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "cid",
      OPENCLAW_PORTAL_URL: "https://app.sigilix.ai",
    })

    const res = await handleSlackInstall(new Request("https://api.sigilix.ai/slack/install?installation_id=42"), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/login")
    // No OAuth state minted for an unauthenticated org-linked request.
    expect([...kv._store.keys()].some((k) => k.startsWith("slack-oauth-state:"))).toBe(false)
  })

  it("handleSlackInstall rejects a malformed installation_id with a portal error redirect", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "cid",
      OPENCLAW_PORTAL_URL: "https://app.sigilix.ai",
    })

    const res = await handleSlackInstall(new Request("https://api.sigilix.ai/slack/install?installation_id=-5"), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackError=invalid_installation")
  })

  it("REFUSES to re-point a team already linked to a DIFFERENT installation (no takeover)", async () => {
    const kv = makeSessionKV()
    const db = await makeDb()
    const env = await makeSessionEnv(kv, { SIGILIX_PLATFORM_DB: db })
    // Existing linkage: team TSWAP belongs to installation 7 with one binding.
    await db
      .prepare(
        "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
          " VALUES ('TSWAP', 7, 'owner-admin', ?, ?)",
      )
      .bind(NOW, NOW)
      .run()
    await db
      .prepare(
        "INSERT INTO slack_channel_binding (team_id, channel_id, installation_id, use_all_repos, created_at, updated_at)" +
          " VALUES ('TSWAP', 'C1', 7, 1, ?, ?)",
      )
      .bind(NOW, NOW)
      .run()
    // A different org (42) completes an install into the SAME Slack team.
    seedOrgState(kv, 42)
    mockSlackExchangeOk("TSWAP")

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "org-state" }), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackError=workspace_already_linked")
    // The original owner keeps the team AND its bindings.
    const workspace = await db
      .prepare("SELECT installation_id FROM slack_workspace WHERE team_id = 'TSWAP'")
      .first<{ installation_id: number }>()
    expect(workspace).toEqual({ installation_id: 7 })
    const bindings = await db.prepare("SELECT channel_id FROM slack_channel_binding WHERE team_id = 'TSWAP'").all()
    expect(bindings.results.length).toBe(1)
  })

  it("re-install by the SAME installation refreshes the link and keeps bindings", async () => {
    const kv = makeSessionKV()
    const db = await makeDb()
    const env = await makeSessionEnv(kv, { SIGILIX_PLATFORM_DB: db })
    await db
      .prepare(
        "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
          " VALUES ('TSAME', 42, 'octocat', ?, ?)",
      )
      .bind(NOW, NOW)
      .run()
    await db
      .prepare(
        "INSERT INTO slack_channel_binding (team_id, channel_id, installation_id, use_all_repos, created_at, updated_at)" +
          " VALUES ('TSAME', 'C1', 42, 1, ?, ?)",
      )
      .bind(NOW, NOW)
      .run()
    seedOrgState(kv, 42)
    mockSlackExchangeOk("TSAME")

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123", state: "org-state" }), env)

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/apps/slack?slackConnected=1")
    const bindings = await db.prepare("SELECT channel_id FROM slack_channel_binding WHERE team_id = 'TSAME'").all()
    expect(bindings.results.length).toBe(1)
  })
})
