// auth-oauth-google: kickoff config-gating + callback find-or-create by email
// with account-linking. Mocks fetch for the Google token + userinfo endpoints;
// identity via the real D1 shim (migrations/0006).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleGoogleAuthCallback, handleGoogleAuthKickoff, isGoogleConfigured } from "@/src/lib/auth-oauth-google"
import { findByGithubUserId, findByGoogleSub, findByEmail, upsertGithubIdentity } from "@/src/lib/user-identity-store"
import { base64urlEncode } from "@/src/lib/auth-session"

const MIGRATION_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const KEY = base64urlEncode(new Uint8Array(32).fill(3))

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

function mockGoogleFetch(userinfo: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "ya29.token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
      return new Response(JSON.stringify(userinfo), { status: 200, headers: { "content-type": "application/json" } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

function baseEnv(kv: KVNamespace, db: D1Database) {
  return {
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    OPENCLAW_SESSION_ENCRYPTION_KEY: KEY,
    OPENCLAW_BASE_URL: "https://api.sigilix.ai",
  } as unknown as Parameters<typeof handleGoogleAuthCallback>[1]
}

function callbackReq(code: string, state: string, cookieNonce?: string): Request {
  const url = new URL("https://api.sigilix.ai/auth/google/callback")
  url.searchParams.set("code", code)
  url.searchParams.set("state", state)
  const headers: HeadersInit = {}
  if (cookieNonce !== undefined) headers["cookie"] = `__Host-sigilix_oauth_state=${cookieNonce}`
  return new Request(url.toString(), { headers })
}

describe("isGoogleConfigured / kickoff", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reports not-configured when secrets are missing and 503s the kickoff", async () => {
    const { kv } = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Parameters<typeof handleGoogleAuthKickoff>[1]
    expect(isGoogleConfigured(env)).toBe(false)
    const res = await handleGoogleAuthKickoff(new Request("https://api.sigilix.ai/auth/google/login"), env)
    expect(res.status).toBe(503)
  })

  it("302s to Google with a state cookie when configured", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    const { kv } = makeKV()
    const res = await handleGoogleAuthKickoff(new Request("https://api.sigilix.ai/auth/google/login"), baseEnv(kv, db))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("accounts.google.com")
    expect(res.headers.get("set-cookie")).toContain("__Host-sigilix_oauth_state=")
  })
})

describe("handleGoogleAuthCallback", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })
  afterEach(() => vi.restoreAllMocks())

  it("creates an identity by email and mints a session cookie", async () => {
    const { kv } = makeKV({ "auth_state_google:nonce-1": JSON.stringify({ createdAt: Date.now() }) })
    mockGoogleFetch({ sub: "g-1", email: "New@Example.com", email_verified: true, name: "New User" })
    const res = await handleGoogleAuthCallback(callbackReq("code-1", "nonce-1", "nonce-1"), baseEnv(kv, db))
    expect(res.status).toBe(302)
    expect(res.headers.get("set-cookie")).toContain("__Host-sigilix_session=")
    const row = await findByEmail(db, "new@example.com")
    expect(row).not.toBeNull()
    expect(row!.emailVerified).toBe(true)
    expect(row!.providers).toEqual(["google"])
  })

  it("does NOT merge a verified Google login into an unverified same-email GitHub row (takeover-safe, non-destructive)", async () => {
    // A GitHub row holds link@example.com UNVERIFIED (GitHub emails are never
    // proven). A verified Google login for the same address must NOT join it —
    // linking is DEFERRED non-destructively: the GitHub row keeps its email +
    // stays github-only, and Google gets its OWN separate row (email=NULL,
    // resolves by google_sub). Nobody is revoked or orphaned.
    await upsertGithubIdentity(db, {
      githubUserId: "555",
      email: "link@example.com",
      nowIso: "2026-07-02T00:00:00.000Z",
    })
    const { kv } = makeKV({ "auth_state_google:nonce-2": JSON.stringify({ createdAt: Date.now() }) })
    mockGoogleFetch({ sub: "g-2", email: "link@example.com", email_verified: true })
    const res = await handleGoogleAuthCallback(callbackReq("code-2", "nonce-2", "nonce-2"), baseEnv(kv, db))
    expect(res.status).toBe(302)
    const byGithub = await findByGithubUserId(db, "555")
    const byGoogle = await findByGoogleSub(db, "g-2")
    expect(byGithub!.providers).toEqual(["github"]) // github row did NOT gain google
    expect(byGithub!.email).toBe("link@example.com") // non-destructive — email retained
    expect(byGithub!.googleSub).toBeNull() // never gained the google_sub (no takeover)
    expect(byGoogle!.userId).not.toBe(byGithub!.userId) // separate accounts, no silent merge
    expect(byGoogle!.providers).toEqual(["google"])
    expect(byGoogle!.emailVerified).toBe(true)
    expect(byGoogle!.email).toBeNull() // deferred — the Google row resolves by google_sub
    // The email still resolves to the (surviving) GitHub account.
    expect((await findByEmail(db, "link@example.com"))!.userId).toBe(byGithub!.userId)
  })

  it("fails closed on state mismatch (cookie != query)", async () => {
    const { kv } = makeKV({ "auth_state_google:n": JSON.stringify({ createdAt: Date.now() }) })
    const res = await handleGoogleAuthCallback(callbackReq("c", "n", "different"), baseEnv(kv, db))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("state_mismatch")
  })

  it("rejects an unverified Google email (403, no session)", async () => {
    const { kv } = makeKV({ "auth_state_google:n3": JSON.stringify({ createdAt: Date.now() }) })
    mockGoogleFetch({ sub: "g-3", email: "unverified@example.com", email_verified: false })
    const res = await handleGoogleAuthCallback(callbackReq("c3", "n3", "n3"), baseEnv(kv, db))
    expect(res.status).toBe(403)
    expect(res.headers.get("set-cookie") ?? "").not.toContain("__Host-sigilix_session=")
  })
})
