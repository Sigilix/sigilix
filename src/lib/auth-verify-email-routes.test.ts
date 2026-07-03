// auth-verify-email-routes: the GET /auth/verify confirm flow + the
// POST /v1/auth/resend-verification endpoint, end-to-end through the real D1
// shim + a fake KV. Also asserts OAuth (github) identities are NOT subject to
// the password-login verify gate.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleResendVerificationRoute, handleVerifyEmailRoute } from "@/src/lib/auth-verify-email-routes"
import { handleLoginRoute } from "@/src/lib/auth-password-routes"
import { mintVerificationToken } from "@/src/lib/email-verification-store"
import { createPasswordIdentity, findByEmail, upsertGithubIdentity } from "@/src/lib/user-identity-store"
import { base64urlEncode } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_0006 = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const MIGRATION_0008 = readFileSync(
  new URL("../../migrations/0008_create_email_verification_token.sql", import.meta.url),
  "utf8",
)
const KEY = base64urlEncode(new Uint8Array(32).fill(9))

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (k: string, t?: "json") => {
      const v = store.get(k)
      return v === undefined ? null : t === "json" ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace
}

function verifyUrl(token: string | null): URL {
  const u = new URL("https://api.sigilix.ai/auth/verify")
  if (token !== null) u.searchParams.set("token", token)
  return u
}

function resendReq(body: unknown, contentType = "application/json"): Request {
  return new Request("https://api.sigilix.ai/v1/auth/resend-verification", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  })
}

describe("GET /auth/verify", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0006)
    await db.exec(MIGRATION_0008)
    env = {
      OPENCLAW_STATE: makeKV(),
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: KEY,
      OPENCLAW_PORTAL_URL: "https://app.sigilix.ai",
    } as unknown as Env
  })

  async function makeUnverifiedUser(email: string): Promise<string> {
    const created = await createPasswordIdentity(db, {
      email,
      passwordHash: "pbkdf2-sha256$1$AA$AA",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    if (!created.ok) throw new Error("setup: expected a fresh account")
    return created.identity.userId
  }

  it("a valid token verifies the email, sets a session cookie, and 302s to the portal landing (status=ok)", async () => {
    const userId = await makeUnverifiedUser("v@example.com")
    const token = await mintVerificationToken(db, {
      userId,
      email: "v@example.com",
      nowIso: "2026-07-03T00:00:00.000Z",
    })

    const res = await handleVerifyEmailRoute(env, verifyUrl(token))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/auth/verified?status=ok")
    expect(res.headers.get("set-cookie")).toContain("__Host-sigilix_session=")

    const identity = await findByEmail(db, "v@example.com")
    expect(identity?.emailVerified).toBe(true)
  })

  it("a second click of the same link is inert: 302 status=used, no session", async () => {
    const userId = await makeUnverifiedUser("v2@example.com")
    const token = await mintVerificationToken(db, {
      userId,
      email: "v2@example.com",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    await handleVerifyEmailRoute(env, verifyUrl(token))
    const res = await handleVerifyEmailRoute(env, verifyUrl(token))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/auth/verified?status=used")
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("a missing token 302s to status=invalid with no session", async () => {
    const res = await handleVerifyEmailRoute(env, verifyUrl(null))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/auth/verified?status=invalid")
    expect(res.headers.get("set-cookie")).toBeNull()
  })
})

describe("POST /v1/auth/resend-verification", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0006)
    await db.exec(MIGRATION_0008)
    env = {
      OPENCLAW_STATE: makeKV(),
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: KEY,
    } as unknown as Env
  })

  it("returns a NEUTRAL 200 for an unknown email (no account enumeration)", async () => {
    const res = await handleResendVerificationRoute(resendReq({ email: "nobody@example.com" }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("returns a neutral 200 for a real unverified account (and mints a fresh token)", async () => {
    await createPasswordIdentity(db, {
      email: "resend@example.com",
      passwordHash: "pbkdf2-sha256$1$AA$AA",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    const res = await handleResendVerificationRoute(resendReq({ email: "resend@example.com" }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const tokenRow = await db
      .prepare("SELECT COUNT(*) AS n FROM email_verification_token WHERE email = ?")
      .bind("resend@example.com")
      .first<{ n: number }>()
    expect(tokenRow?.n).toBe(1)
  })

  it("is rate-limited per email (429 after the cap)", async () => {
    await createPasswordIdentity(db, {
      email: "rl@example.com",
      passwordHash: "pbkdf2-sha256$1$AA$AA",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await handleResendVerificationRoute(resendReq({ email: "rl@example.com" }), env)
      statuses.push(res.status)
    }
    // Per-email cap is 3/hour → the 4th+ attempts are throttled.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  })

  it("requires application/json (415 otherwise)", async () => {
    const res = await handleResendVerificationRoute(resendReq({ email: "x@example.com" }, "text/plain"), env)
    expect(res.status).toBe(415)
  })
})

describe("OAuth identities are not subject to the password verify gate", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0006)
    await db.exec(MIGRATION_0008)
    env = {
      OPENCLAW_STATE: makeKV(),
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: KEY,
    } as unknown as Env
  })

  it("a GitHub-only identity (email_verified=0) is NOT 403-gated — it simply isn't a password account (401)", async () => {
    // GitHub logins never pass through the password login route; their OAuth
    // callback mints a session with no email_verified check. Proven here by the
    // password route treating a github-only email as a non-account (generic 401),
    // never the email_unverified 403 that gates password logins.
    const gh = await upsertGithubIdentity(db, {
      githubUserId: "12345",
      email: "gh@example.com",
      name: "GH User",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    expect(gh?.emailVerified).toBe(false)
    const res = await handleLoginRoute(
      new Request("https://api.sigilix.ai/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "gh@example.com", password: "whatever-passphrase" }),
      }),
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" })
  })
})
