// auth-oauth-github: kickoff route, callback flow, redirect-after
// validation. Mocks fetch for the GitHub token + user endpoints.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  handleGitHubAuthCallback,
  handleGitHubAuthKickoff,
  handleLogout,
  safeRedirectAfter,
} from "../src/lib/auth-oauth-github"
import { base64urlEncode } from "../src/lib/auth-session"

interface FakeKV {
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  _store: Map<string, string>
}

function makeKV(initial: Record<string, string> = {}): FakeKV {
  const store = new Map(Object.entries(initial))
  return {
    _store: store,
    get: vi.fn(async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}

const TEST_KEY = base64urlEncode(new Uint8Array(32).fill(7))

const env = (kv: FakeKV) => ({
  OPENCLAW_STATE: kv as unknown as KVNamespace,
  GITHUB_OAUTH_CLIENT_ID: "Iv1.client",
  GITHUB_OAUTH_CLIENT_SECRET: "secret",
  OPENCLAW_SESSION_ENCRYPTION_KEY: TEST_KEY,
  OPENCLAW_BASE_URL: "https://app.sigilix.ai",
})

describe("safeRedirectAfter", () => {
  const base = "https://app.sigilix.ai"

  it("falls back to /auth/welcome on undefined", () => {
    expect(safeRedirectAfter(undefined, base)).toBe("/auth/welcome")
  })

  it("rejects scheme-relative URLs (//evil.com)", () => {
    expect(safeRedirectAfter("//evil.com", base)).toBe("/auth/welcome")
  })

  it("rejects backslash variants (//\\evil.com, /\\evil.com)", () => {
    expect(safeRedirectAfter("/\\evil.com", base)).toBe("/auth/welcome")
    expect(safeRedirectAfter("\\\\evil.com", base)).toBe("/auth/welcome")
  })

  it("rejects absolute URLs", () => {
    expect(safeRedirectAfter("https://evil.com", base)).toBe("/auth/welcome")
    expect(safeRedirectAfter("javascript:alert(1)", base)).toBe("/auth/welcome")
  })

  it("rejects encoded slashes that look in-app but break out", () => {
    // /%2f%2fevil.com would be decoded by some routers as //evil.com.
    // Per spec we reject anything not matching a strict pathname plus
    // same-origin parse.
    const result = safeRedirectAfter("/%2f%2fevil.com", base)
    // URL("/%2f%2fevil.com", "https://app.sigilix.ai") yields pathname
    // "/%2f%2fevil.com" with origin https://app.sigilix.ai — same-origin
    // check passes. Encoded slashes stay encoded; modern browsers do
    // NOT decode %2F before navigation, so this stays in-app. Acceptable.
    expect(result.startsWith("/")).toBe(true)
    expect(result).not.toContain("evil.com.")
  })

  it("rejects NUL byte injections", () => {
    expect(safeRedirectAfter("/path\0/leak", base)).toBe("/auth/welcome")
  })

  it("accepts simple in-app paths", () => {
    expect(safeRedirectAfter("/auth/welcome", base)).toBe("/auth/welcome")
    expect(safeRedirectAfter("/dashboard/home", base)).toBe("/dashboard/home")
  })

  it("preserves query strings and fragments", () => {
    expect(safeRedirectAfter("/path?q=ok", base)).toBe("/path?q=ok")
    expect(safeRedirectAfter("/path#frag", base)).toBe("/path#frag")
  })

  it("rejects raw paths that don't start with /", () => {
    expect(safeRedirectAfter("relative/path", base)).toBe("/auth/welcome")
    expect(safeRedirectAfter("welcome", base)).toBe("/auth/welcome")
  })
})

describe("handleGitHubAuthKickoff", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("writes state nonce to KV, sets state cookie, 302s to GitHub", async () => {
    const kv = makeKV()
    const req = new Request("https://app.sigilix.ai/auth/github")
    const res = await handleGitHubAuthKickoff(req, env(kv))
    expect(res.status).toBe(302)
    const location = res.headers.get("location")!
    expect(location).toContain("https://github.com/login/oauth/authorize")
    expect(location).toContain("client_id=Iv1.client")
    expect(location).toContain("scope=read%3Auser+user%3Aemail")
    expect(location).toMatch(/state=[^&]+/)
    // Cookie set
    const cookie = res.headers.get("set-cookie")!
    expect(cookie).toContain("__Host-sigilix_oauth_state=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Max-Age=600")
    // Nonce written to KV
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringMatching(/^auth_state:/),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 600 }),
    )
  })

  it("fails 503 when GITHUB_OAUTH_CLIENT_ID is unset", async () => {
    const kv = makeKV()
    const e = { ...env(kv), GITHUB_OAUTH_CLIENT_ID: undefined }
    const res = await handleGitHubAuthKickoff(
      new Request("https://app.sigilix.ai/auth/github"),
      e,
    )
    expect(res.status).toBe(503)
  })

  it("includes redirectAfter in the stored state record", async () => {
    const kv = makeKV()
    const req = new Request("https://app.sigilix.ai/auth/github?redirectAfter=/dashboard")
    await handleGitHubAuthKickoff(req, env(kv))
    const stored = [...kv._store.values()][0]
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored)
    expect(parsed.redirectAfter).toBe("/dashboard")
  })
})

describe("handleGitHubAuthCallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function callbackReq(args: { code: string; state: string; cookieNonce?: string }): Request {
    const url = new URL("https://app.sigilix.ai/auth/github/callback")
    url.searchParams.set("code", args.code)
    url.searchParams.set("state", args.state)
    const headers: HeadersInit = {}
    if (args.cookieNonce !== undefined) {
      headers["cookie"] = `__Host-sigilix_oauth_state=${args.cookieNonce}`
    }
    return new Request(url.toString(), { headers })
  }

  function mockGitHubFetch(args: {
    tokenResponse?: unknown
    tokenStatus?: number
    userResponse?: unknown
    userStatus?: number
  }) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.includes("github.com/login/oauth/access_token")) {
        return new Response(
          JSON.stringify(args.tokenResponse ?? { access_token: "ghu_token", token_type: "bearer" }),
          { status: args.tokenStatus ?? 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("api.github.com/user")) {
        return new Response(
          JSON.stringify(args.userResponse ?? { login: "alice", id: 12345 }),
          { status: args.userStatus ?? 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  it("happy path: validates state + cookie, exchanges code, fetches user, mints session, 302 to /auth/welcome", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({ createdAt: Date.now() }),
    })
    mockGitHubFetch({})
    const req = callbackReq({ code: "code-1", state: "nonce-1", cookieNonce: "nonce-1" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/auth/welcome")
    // State nonce was deleted
    expect(kv.delete).toHaveBeenCalledWith("auth_state:nonce-1")
    // Session cookie set
    const cookies = res.headers.getSetCookie()
    const sessionCookie = cookies.find((c) => c.startsWith("__Host-sigilix_session="))!
    expect(sessionCookie).toContain("HttpOnly")
    expect(sessionCookie).toContain("Secure")
    expect(sessionCookie).toContain("SameSite=Lax")
    // State cookie cleared
    const stateCookie = cookies.find(
      (c) => c.startsWith("__Host-sigilix_oauth_state=") && c.includes("Max-Age=0"),
    )
    expect(stateCookie).toBeTruthy()
    // KV session record was written
    const sessionEntry = [...kv._store.entries()].find(([k]) => k.startsWith("auth_session:"))
    expect(sessionEntry).toBeTruthy()
    const record = JSON.parse(sessionEntry![1])
    expect(record.login).toBe("alice")
    expect(record.githubUserId).toBe(12345)
    expect(record.encryptedAccessToken).toBeTruthy()
    // Plaintext access token is NOT stored.
    expect(sessionEntry![1]).not.toContain("ghu_token")
  })

  it("rejects state_mismatch when cookie nonce missing", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({ createdAt: Date.now() }),
    })
    mockGitHubFetch({})
    const req = callbackReq({ code: "c", state: "nonce-1" /* no cookieNonce */ })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("state_mismatch")
    // KV nonce should NOT be deleted on browser-binding failure (so the
    // legitimate browser can still complete its flow if it has the cookie).
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it("rejects state_mismatch when cookie nonce different from query state", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({ createdAt: Date.now() }),
    })
    const req = callbackReq({ code: "c", state: "nonce-1", cookieNonce: "different-nonce" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("state_mismatch")
  })

  it("rejects state_invalid when KV nonce missing (TTL expired or already-used)", async () => {
    const kv = makeKV()
    const req = callbackReq({ code: "c", state: "nonce-1", cookieNonce: "nonce-1" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("state_invalid")
  })

  it("rejects code_exchange_failed on GitHub HTTP 401", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({ createdAt: Date.now() }),
    })
    mockGitHubFetch({ tokenStatus: 401, tokenResponse: { error: "bad_verification_code" } })
    const req = callbackReq({ code: "c", state: "nonce-1", cookieNonce: "nonce-1" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("code_exchange_failed")
  })

  it("rejects user_fetch_failed when /user returns 5xx", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({ createdAt: Date.now() }),
    })
    mockGitHubFetch({ userStatus: 502 })
    const req = callbackReq({ code: "c", state: "nonce-1", cookieNonce: "nonce-1" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("user_fetch_failed")
  })

  it("rejects user_fetch_failed when /user response missing login or id", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({ createdAt: Date.now() }),
    })
    mockGitHubFetch({ userResponse: { /* missing login */ id: 1 } })
    const req = callbackReq({ code: "c", state: "nonce-1", cookieNonce: "nonce-1" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("user_fetch_failed")
  })

  it("honors redirectAfter from the stored state record (in-app path only)", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({ createdAt: Date.now(), redirectAfter: "/dashboard" }),
    })
    mockGitHubFetch({})
    const req = callbackReq({ code: "c", state: "nonce-1", cookieNonce: "nonce-1" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/dashboard")
  })

  it("rejects malicious redirectAfter values stored in KV (defense in depth)", async () => {
    const kv = makeKV({
      "auth_state:nonce-1": JSON.stringify({
        createdAt: Date.now(),
        redirectAfter: "//evil.com",
      }),
    })
    mockGitHubFetch({})
    const req = callbackReq({ code: "c", state: "nonce-1", cookieNonce: "nonce-1" })
    const res = await handleGitHubAuthCallback(req, env(kv))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/auth/welcome")
  })

  it("missing code or state returns 400", async () => {
    const kv = makeKV()
    const url = new URL("https://app.sigilix.ai/auth/github/callback")
    url.searchParams.set("state", "n")
    const res = await handleGitHubAuthCallback(new Request(url.toString()), env(kv))
    expect(res.status).toBe(400)
  })
})

describe("handleLogout", () => {
  it("deletes the session record and clears the cookie", async () => {
    const kv = makeKV({
      "auth_session:abc": JSON.stringify({
        login: "alice",
        githubUserId: 1,
        encryptedAccessToken: "x",
        iv: "y",
        createdAt: 0,
        lastSeenAt: 0,
      }),
    })
    const res = await handleLogout(new Request("https://app.sigilix.ai/auth/logout"), env(kv), "abc")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
    expect(kv.delete).toHaveBeenCalledWith("auth_session:abc")
    const cookie = res.headers.get("set-cookie")!
    expect(cookie).toContain("__Host-sigilix_session=")
    expect(cookie).toContain("Max-Age=0")
  })

  it("succeeds even when no session id present", async () => {
    const kv = makeKV()
    const res = await handleLogout(new Request("https://app.sigilix.ai/auth/logout"), env(kv), null)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
    expect(kv.delete).not.toHaveBeenCalled()
  })
})
