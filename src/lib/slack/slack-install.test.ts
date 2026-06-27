// Tests for Slack KV install store and OAuth v2 callback.
// Covers: KV round-trip, SLACK_BOT_TOKEN fallback, missing-code 400,
// happy-path exchange+redirect, ok:false 502, non-2xx 502, default base URL.
// Fetch is stubbed via vi.spyOn(globalThis, "fetch") following the pattern in
// auth-oauth-github.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { putSlackInstall, getSlackBotToken, handleSlackOAuthCallback } from "@/src/lib/slack/slack-install"
import type { Env } from "@/src/shared/types/env"

// ─── Map-backed fake KVNamespace ────────────────────────────────────────────

function makeFakeKV() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
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

  it("returns 400 when code query param is missing", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    const res = await handleSlackOAuthCallback(callbackReq({}), env)
    expect(res.status).toBe(400)
  })

  it("happy path: exchanges code, stores install, 302 to /slack/installed", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      OPENCLAW_BASE_URL: "https://app.sigilix.ai",
    })
    mockSlackFetch({
      ok: true,
      body: { ok: true, access_token: "xoxb-new", team: { id: "T999" } },
    })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code123" }), env)

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
    mockSlackFetch({ ok: false, body: { ok: false, error: "invalid_code" } })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "badcode" }), env)
    expect(res.status).toBe(502)
  })

  it("returns 502 on non-2xx HTTP response from Slack", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("server error", { status: 500 }))

    const res = await handleSlackOAuthCallback(callbackReq({ code: "badcode" }), env)
    expect(res.status).toBe(502)
  })

  it("uses default base URL (https://app.sigilix.ai) when OPENCLAW_BASE_URL is unset", async () => {
    const kv = makeFakeKV()
    const env = makeEnv(kv, {
      SLACK_CLIENT_ID: "clientid",
      SLACK_CLIENT_SECRET: "secret",
      // OPENCLAW_BASE_URL intentionally omitted
    })
    mockSlackFetch({
      ok: true,
      body: { ok: true, access_token: "xoxb-default", team: { id: "T001" } },
    })

    const res = await handleSlackOAuthCallback(callbackReq({ code: "code" }), env)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/slack/installed")
  })
})
