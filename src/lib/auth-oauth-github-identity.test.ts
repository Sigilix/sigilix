// auth-oauth-github (identity persistence slice — sig-user-identity): with the
// identity DB bound, a GitHub login UPSERTS a real user_identity row and threads
// the surrogate user_id + email onto the session. Complements the existing
// auth-oauth-github.test.ts (which runs without the DB — best-effort skip).

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleGitHubAuthCallback } from "@/src/lib/auth-oauth-github"
import { findByGithubUserId } from "@/src/lib/user-identity-store"
import { base64urlEncode } from "@/src/lib/auth-session"

const MIGRATION_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const KEY = base64urlEncode(new Uint8Array(32).fill(4))

function makeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    kv: {
      get: async (k: string, t?: "json") => {
        const v = store.get(k)
        return v === undefined ? null : t === "json" ? JSON.parse(v) : v
      },
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
  }
}

function mockGitHubFetch(user: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes("github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "ghu_x", token_type: "bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("api.github.com/user")) {
      return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

describe("GitHub callback persists identity on login", () => {
  afterEach(() => vi.restoreAllMocks())

  it("upserts a user_identity row (email/name/avatar/providers) and threads user_id onto the session", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    const { kv, store } = makeKV({ "auth_state:n1": JSON.stringify({ createdAt: Date.now() }) })
    mockGitHubFetch({ login: "alice", id: 4242, name: "Alice", email: "alice@example.com", avatar_url: "https://a/1" })

    const url = new URL("https://api.sigilix.ai/auth/github/callback")
    url.searchParams.set("code", "c1")
    url.searchParams.set("state", "n1")
    const req = new Request(url.toString(), { headers: { cookie: "__Host-sigilix_oauth_state=n1" } })

    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      GITHUB_OAUTH_CLIENT_ID: "Iv1.x",
      GITHUB_OAUTH_CLIENT_SECRET: "s",
      OPENCLAW_SESSION_ENCRYPTION_KEY: KEY,
      OPENCLAW_BASE_URL: "https://api.sigilix.ai",
    } as unknown as Parameters<typeof handleGitHubAuthCallback>[1]

    const res = await handleGitHubAuthCallback(req, env)
    expect(res.status).toBe(302)

    // The real user record now exists.
    const identity = await findByGithubUserId(db, "4242")
    expect(identity).not.toBeNull()
    expect(identity!.email).toBe("alice@example.com")
    expect(identity!.name).toBe("Alice")
    expect(identity!.avatarUrl).toBe("https://a/1")
    expect(identity!.providers).toEqual(["github"])

    // The session carries the surrogate user_id + email + provider.
    const sessionKey = [...store.keys()].find((k) => k.startsWith("auth_session:"))!
    const session = JSON.parse(store.get(sessionKey)!)
    expect(session.userId).toBe(identity!.userId)
    expect(session.email).toBe("alice@example.com")
    expect(session.provider).toBe("github")
  })
})
