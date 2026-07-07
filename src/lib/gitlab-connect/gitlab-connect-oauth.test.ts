// sig-gitlab-connector: tests for the connect OAuth round-trip (start + callback).
// The start route mints a CSRF nonce + 302s to GitLab's authorize with scope=api;
// the callback validates the nonce (cookie + KV), exchanges the code, and stores
// the OAuth token (encrypted) so the project-picker step can read it.

import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { base64urlEncode, createSession, STATE_COOKIE_NAME } from "@/src/lib/auth-session"
import { handleGitLabConnectStart, handleGitLabConnectCallback } from "./gitlab-connect-oauth"
import { getUserOAuthToken } from "./gitlab-connect-store"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(3))

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace
}

function env(kv: KVNamespace, extra?: Partial<Env>): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    OPENCLAW_BASE_URL: "https://api.sigilix.test",
    OPENCLAW_PORTAL_URL: "https://app.sigilix.test",
    SIGILIX_GITLAB_OAUTH_CLIENT_ID: "cid",
    SIGILIX_GITLAB_OAUTH_CLIENT_SECRET: "csecret",
    ...extra,
  } as unknown as Env
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

afterEach(() => vi.unstubAllGlobals())

describe("gitlab connect — OAuth start", () => {
  it("503 when the OAuth app is not configured", async () => {
    const kv = makeKV()
    const e = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    const res = await handleGitLabConnectStart(new Request("https://api/gitlab/connect/start"), e, ctx)
    expect(res.status).toBe(503)
  })

  it("redirects an unauthenticated user to the portal login", async () => {
    const kv = makeKV()
    const res = await handleGitLabConnectStart(new Request("https://api/gitlab/connect/start"), env(kv), ctx)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.test/login")
  })

  it("302s to GitLab authorize with scope=api + a state cookie", async () => {
    const kv = makeKV()
    await createSession({
      kv,
      sessionId: "s1",
      login: "octo",
      githubUserId: 111,
      accessToken: "x",
      encryptionKeyB64url: ENC_KEY,
    })
    const req = new Request("https://api/gitlab/connect/start", { headers: { cookie: `${SESSION_COOKIE}=s1` } })
    const res = await handleGitLabConnectStart(req, env(kv), ctx)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.origin + loc.pathname).toBe("https://gitlab.com/oauth/authorize")
    expect(loc.searchParams.get("scope")).toBe("api")
    expect(loc.searchParams.get("client_id")).toBe("cid")
    expect(loc.searchParams.get("redirect_uri")).toBe("https://api.sigilix.test/gitlab/connect/callback")
    const nonce = loc.searchParams.get("state")!
    expect(res.headers.get("set-cookie")).toContain(nonce)
  })
})

describe("gitlab connect — OAuth callback", () => {
  async function startAndGetNonce(kv: KVNamespace): Promise<string> {
    await createSession({
      kv,
      sessionId: "s1",
      login: "octo",
      githubUserId: 111,
      accessToken: "x",
      encryptionKeyB64url: ENC_KEY,
    })
    const req = new Request("https://api/gitlab/connect/start", { headers: { cookie: `${SESSION_COOKIE}=s1` } })
    const res = await handleGitLabConnectStart(req, env(kv), ctx)
    return new URL(res.headers.get("location")!).searchParams.get("state")!
  }

  it("stores the OAuth token and bounces back to the portal on success", async () => {
    const kv = makeKV()
    const nonce = await startAndGetNonce(kv)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://gitlab.com/oauth/token") {
          return new Response(JSON.stringify({ access_token: "oauth-tok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    const req = new Request(`https://api/gitlab/connect/callback?code=abc&state=${nonce}`, {
      headers: { cookie: `${STATE_COOKIE_NAME}=${nonce}` },
    })
    const res = await handleGitLabConnectCallback(req, env(kv))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.test/apps/gitlab?gitlabConnected=1")
    expect(await getUserOAuthToken(env(kv), "gh:111")).toBe("oauth-tok")
  })

  it("rejects a state-cookie mismatch (browser binding)", async () => {
    const kv = makeKV()
    const nonce = await startAndGetNonce(kv)
    const req = new Request(`https://api/gitlab/connect/callback?code=abc&state=${nonce}`, {
      headers: { cookie: `${STATE_COOKIE_NAME}=different` },
    })
    const res = await handleGitLabConnectCallback(req, env(kv))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.test/apps/gitlab?gitlabError=state_mismatch")
  })

  it("rejects a replayed (already-consumed) nonce", async () => {
    const kv = makeKV()
    const nonce = await startAndGetNonce(kv)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "t" }), { status: 200 })),
    )
    const mk = () =>
      new Request(`https://api/gitlab/connect/callback?code=abc&state=${nonce}`, {
        headers: { cookie: `${STATE_COOKIE_NAME}=${nonce}` },
      })
    const first = await handleGitLabConnectCallback(mk(), env(kv))
    expect(first.headers.get("location")).toContain("gitlabConnected=1")
    const replay = await handleGitLabConnectCallback(mk(), env(kv))
    expect(replay.headers.get("location")).toBe("https://app.sigilix.test/apps/gitlab?gitlabError=state_invalid")
  })
})
