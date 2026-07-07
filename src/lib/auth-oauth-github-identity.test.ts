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
const MIGRATION_0010 = readFileSync(
  new URL("../../migrations/0010_add_gitlab_id_to_user_identity.sql", import.meta.url),
  "utf8",
)
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

// `emails` (when given) is served from GET /user/emails — matched BEFORE the
// broader `/user` branch since both URLs contain "api.github.com/user".
// `emailsStatus` forces a non-200 to exercise the fail-soft fallback.
function mockGitHubFetch(user: Record<string, unknown>, opts: { emails?: unknown; emailsStatus?: number } = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes("github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "ghu_x", token_type: "bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("api.github.com/user/emails")) {
      return new Response(JSON.stringify(opts.emails ?? []), {
        status: opts.emailsStatus ?? 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("api.github.com/user")) {
      return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

function callbackReqFor(state: string) {
  const url = new URL("https://api.sigilix.ai/auth/github/callback")
  url.searchParams.set("code", "c1")
  url.searchParams.set("state", state)
  return new Request(url.toString(), { headers: { cookie: `__Host-sigilix_oauth_state=${state}` } })
}

function identityEnv(kv: KVNamespace, db: ReturnType<typeof makeD1>) {
  return {
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    GITHUB_OAUTH_CLIENT_ID: "Iv1.x",
    GITHUB_OAUTH_CLIENT_SECRET: "s",
    OPENCLAW_SESSION_ENCRYPTION_KEY: KEY,
    OPENCLAW_BASE_URL: "https://api.sigilix.ai",
  } as unknown as Parameters<typeof handleGitHubAuthCallback>[1]
}

describe("GitHub callback persists identity on login", () => {
  afterEach(() => vi.restoreAllMocks())

  it("upserts a user_identity row (email/name/avatar/providers) and threads user_id onto the session", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    await db.exec(MIGRATION_0010)
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

  it("private-email user (/user email null) resolves the primary+verified address from /user/emails and completes login", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    await db.exec(MIGRATION_0010)
    const { kv, store } = makeKV({ "auth_state:n2": JSON.stringify({ createdAt: Date.now() }) })
    mockGitHubFetch(
      { login: "bob", id: 777, name: "Bob", email: null, avatar_url: "https://a/2" },
      {
        emails: [
          { email: "bob-noreply@users.noreply.github.com", primary: false, verified: true },
          { email: "bob@example.com", primary: true, verified: true },
        ],
      },
    )

    const res = await handleGitHubAuthCallback(callbackReqFor("n2"), identityEnv(kv, db))
    expect(res.status).toBe(302)

    const identity = await findByGithubUserId(db, "777")
    expect(identity).not.toBeNull()
    expect(identity!.email).toBe("bob@example.com")

    const sessionKey = [...store.keys()].find((k) => k.startsWith("auth_session:"))!
    const session = JSON.parse(store.get(sessionKey)!)
    expect(session.email).toBe("bob@example.com")
  })

  it("selection precedence: primary+verified wins over a non-primary verified email", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    await db.exec(MIGRATION_0010)
    const { kv } = makeKV({ "auth_state:n3": JSON.stringify({ createdAt: Date.now() }) })
    mockGitHubFetch(
      { login: "carol", id: 888, email: null },
      {
        emails: [
          { email: "verified-nonprimary@example.com", primary: false, verified: true },
          { email: "primary-verified@example.com", primary: true, verified: true },
        ],
      },
    )

    const res = await handleGitHubAuthCallback(callbackReqFor("n3"), identityEnv(kv, db))
    expect(res.status).toBe(302)

    const identity = await findByGithubUserId(db, "888")
    expect(identity!.email).toBe("primary-verified@example.com")
  })

  it("/user/emails failure falls through soft — login is NOT blocked and no email is captured", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    await db.exec(MIGRATION_0010)
    const { kv, store } = makeKV({ "auth_state:n4": JSON.stringify({ createdAt: Date.now() }) })
    mockGitHubFetch({ login: "dave", id: 999, email: null }, { emailsStatus: 404, emails: { message: "Not Found" } })

    const res = await handleGitHubAuthCallback(callbackReqFor("n4"), identityEnv(kv, db))
    // Login still completes.
    expect(res.status).toBe(302)

    const identity = await findByGithubUserId(db, "999")
    expect(identity).not.toBeNull()
    expect(identity!.email).toBeNull()

    // No email threaded onto the session → portal still prompts for one.
    const sessionKey = [...store.keys()].find((k) => k.startsWith("auth_session:"))!
    const session = JSON.parse(store.get(sessionKey)!)
    expect("email" in session).toBe(false)
  })
})
