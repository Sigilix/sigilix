// auth-oauth-gitlab: kickoff config-gating + authorize URL, and the callback
// happy-path (code -> token -> /api/v4/user -> find-or-create by gitlab_id ->
// session). Mocks fetch for the GitLab token + user endpoints; identity via the
// real D1 shim (migrations/0006 + 0010).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleGitlabAuthCallback, handleGitlabAuthKickoff, isGitlabConfigured } from "@/src/lib/auth-oauth-gitlab"
import { findByGitlabId, findByEmail, upsertGithubIdentity } from "@/src/lib/user-identity-store"
import { base64urlEncode } from "@/src/lib/auth-session"

const MIGRATION_0006 = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const MIGRATION_0010 = readFileSync(
  new URL("../../migrations/0010_add_gitlab_id_to_user_identity.sql", import.meta.url),
  "utf8",
)
const KEY = base64urlEncode(new Uint8Array(32).fill(7))

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

// Mock the GitLab token + user endpoints for a given base origin (default
// gitlab.com). `user` is the /api/v4/user body; pass `tokenOk: false` to force a
// token-exchange failure.
function mockGitlabFetch(user: Record<string, unknown>, opts: { base?: string; tokenOk?: boolean } = {}) {
  const base = opts.base ?? "https://gitlab.com"
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === `${base}/oauth/token`) {
      if (opts.tokenOk === false) return new Response("bad", { status: 400 })
      return new Response(JSON.stringify({ access_token: "glpat-token", token_type: "bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url === `${base}/api/v4/user`) {
      return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

function baseEnv(kv: KVNamespace, db: D1Database, extra: Record<string, unknown> = {}) {
  return {
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_GITLAB_OAUTH_CLIENT_ID: "glid",
    SIGILIX_GITLAB_OAUTH_CLIENT_SECRET: "glsecret",
    OPENCLAW_SESSION_ENCRYPTION_KEY: KEY,
    OPENCLAW_BASE_URL: "https://api.sigilix.ai",
    ...extra,
  } as unknown as Parameters<typeof handleGitlabAuthCallback>[1]
}

function callbackReq(code: string, state: string, cookieNonce?: string): Request {
  const url = new URL("https://api.sigilix.ai/auth/gitlab/callback")
  url.searchParams.set("code", code)
  url.searchParams.set("state", state)
  const headers: HeadersInit = {}
  if (cookieNonce !== undefined) headers["cookie"] = `__Host-sigilix_oauth_state=${cookieNonce}`
  return new Request(url.toString(), { headers })
}

describe("isGitlabConfigured / kickoff", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reports not-configured when secrets are missing and 503s the kickoff", async () => {
    const { kv } = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Parameters<typeof handleGitlabAuthKickoff>[1]
    expect(isGitlabConfigured(env)).toBe(false)
    const res = await handleGitlabAuthKickoff(new Request("https://api.sigilix.ai/auth/gitlab/login"), env)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain("gitlab login not configured")
  })

  it("302s to gitlab.com/oauth/authorize with the right params + a state cookie", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_0006)
    await db.exec(MIGRATION_0010)
    const { kv } = makeKV()
    const res = await handleGitlabAuthKickoff(new Request("https://api.sigilix.ai/auth/gitlab/login"), baseEnv(kv, db))
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.origin + loc.pathname).toBe("https://gitlab.com/oauth/authorize")
    expect(loc.searchParams.get("client_id")).toBe("glid")
    expect(loc.searchParams.get("redirect_uri")).toBe("https://api.sigilix.ai/auth/gitlab/callback")
    expect(loc.searchParams.get("response_type")).toBe("code")
    expect(loc.searchParams.get("scope")).toBe("read_user email")
    const state = loc.searchParams.get("state")
    expect(state).toBeTruthy()
    // The state cookie is the browser-bound half of the CSRF check — it must equal
    // the `state` query param sent to GitLab.
    expect(res.headers.get("set-cookie")).toContain(`__Host-sigilix_oauth_state=${state}`)
  })

  it("honors a self-managed SIGILIX_GITLAB_BASE_URL (trailing slash stripped)", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_0006)
    await db.exec(MIGRATION_0010)
    const { kv } = makeKV()
    const res = await handleGitlabAuthKickoff(
      new Request("https://api.sigilix.ai/auth/gitlab/login"),
      baseEnv(kv, db, { SIGILIX_GITLAB_BASE_URL: "https://gitlab.example.com/" }),
    )
    const loc = new URL(res.headers.get("location")!)
    expect(loc.origin + loc.pathname).toBe("https://gitlab.example.com/oauth/authorize")
  })
})

describe("handleGitlabAuthCallback", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0006)
    await db.exec(MIGRATION_0010)
  })
  afterEach(() => vi.restoreAllMocks())

  it("code -> token -> user -> session: creates an identity by gitlab_id and sets the session cookie", async () => {
    const { kv, store } = makeKV({ "auth_state_gitlab:nonce-1": JSON.stringify({ createdAt: Date.now() }) })
    mockGitlabFetch({ id: 42, username: "octocat", name: "Octo Cat", email: "Octo@Example.com" })
    const res = await handleGitlabAuthCallback(callbackReq("code-1", "nonce-1", "nonce-1"), baseEnv(kv, db))
    expect(res.status).toBe(302)
    expect(res.headers.get("set-cookie")).toContain("__Host-sigilix_session=")
    const row = await findByGitlabId(db, "gitlab.com:42")
    expect(row).not.toBeNull()
    expect(row!.providers).toEqual(["gitlab"])
    expect(row!.email).toBe("octo@example.com") // normalized lowercase
    // A GitLab email is treated as UNVERIFIED (never a cross-provider linking key).
    expect(row!.emailVerified).toBe(false)
    expect(row!.name).toBe("Octo Cat")
    // The KV state nonce is single-use — consumed on callback.
    expect(store.has("auth_state_gitlab:nonce-1")).toBe(false)
  })

  it("logs in even when GitLab returns no email (row is created email=NULL; capture happens later)", async () => {
    const { kv } = makeKV({ "auth_state_gitlab:n2": JSON.stringify({ createdAt: Date.now() }) })
    mockGitlabFetch({ id: 99, username: "no-email", name: "No Email" })
    const res = await handleGitlabAuthCallback(callbackReq("c2", "n2", "n2"), baseEnv(kv, db))
    expect(res.status).toBe(302)
    expect(res.headers.get("set-cookie")).toContain("__Host-sigilix_session=")
    const row = await findByGitlabId(db, "gitlab.com:99")
    expect(row!.email).toBeNull()
    expect(row!.providers).toEqual(["gitlab"])
  })

  it("qualifies the stored gitlab_id with the instance host (self-managed ids are instance-local)", async () => {
    // A self-managed instance numbers users from 1, so the stored key must be
    // host-qualified — `gitlab.example.com:5`, not a bare `5` — otherwise it
    // could collide with gitlab.com user 5 over the same DB.
    const { kv } = makeKV({ "auth_state_gitlab:n3": JSON.stringify({ createdAt: Date.now() }) })
    mockGitlabFetch({ id: 5, username: "selfhosted" }, { base: "https://gitlab.example.com" })
    const res = await handleGitlabAuthCallback(
      callbackReq("c3", "n3", "n3"),
      baseEnv(kv, db, { SIGILIX_GITLAB_BASE_URL: "https://gitlab.example.com" }),
    )
    expect(res.status).toBe(302)
    expect(await findByGitlabId(db, "gitlab.example.com:5")).not.toBeNull()
    expect(await findByGitlabId(db, "gitlab.com:5")).toBeNull() // no bare-id collision
  })

  it("does NOT store a GitLab email that another account already holds (no silent attach)", async () => {
    // A GitHub row already owns held@example.com. A GitLab login whose profile
    // email matches must NOT steal or attach to it — the GitLab row is created
    // email=NULL, resolving by gitlab_id only (takeover-safe).
    await upsertGithubIdentity(db, { githubUserId: "700", email: "held@example.com", nowIso: "2026-07-05T00:00:00Z" })
    const { kv } = makeKV({ "auth_state_gitlab:n4": JSON.stringify({ createdAt: Date.now() }) })
    mockGitlabFetch({ id: 700123, username: "collide", email: "held@example.com" })
    const res = await handleGitlabAuthCallback(callbackReq("c4", "n4", "n4"), baseEnv(kv, db))
    expect(res.status).toBe(302)
    const gl = await findByGitlabId(db, "gitlab.com:700123")
    expect(gl!.email).toBeNull() // did not steal the address
    // The email still resolves to the ORIGINAL GitHub account.
    const owner = await findByEmail(db, "held@example.com")
    expect(owner!.gitlabId).toBeNull()
    expect(owner!.userId).not.toBe(gl!.userId)
  })

  it("fails closed on state mismatch (cookie != query) — no session", async () => {
    const { kv } = makeKV({ "auth_state_gitlab:n": JSON.stringify({ createdAt: Date.now() }) })
    const res = await handleGitlabAuthCallback(callbackReq("c", "n", "different"), baseEnv(kv, db))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("state_mismatch")
    expect(res.headers.get("set-cookie") ?? "").not.toContain("__Host-sigilix_session=")
  })

  it("503s the callback when GitLab login is not configured", async () => {
    const { kv } = makeKV({ "auth_state_gitlab:n": JSON.stringify({ createdAt: Date.now() }) })
    const env = { OPENCLAW_STATE: kv } as unknown as Parameters<typeof handleGitlabAuthCallback>[1]
    const res = await handleGitlabAuthCallback(callbackReq("c", "n", "n"), env)
    expect(res.status).toBe(503)
  })
})
