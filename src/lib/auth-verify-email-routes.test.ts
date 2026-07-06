// auth-verify-email-routes: the GET /auth/verify confirm flow + the
// POST /v1/auth/resend-verification endpoint, end-to-end through the real D1
// shim + a fake KV. Also asserts OAuth (github) identities are NOT subject to
// the password-login verify gate.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
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

/**
 * ExecutionContext stub that CAPTURES ctx.waitUntil promises (the resend/signup
 * send is deferred fire-and-forget for constant-time). `settled()` drains them so
 * a test can assert the deferred mint/send actually ran.
 */
function makeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p)
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return { ctx, settled: async () => void (await Promise.allSettled(pending)) }
}

async function tokenCount(db: D1Database, email: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM email_verification_token WHERE email = ?")
    .bind(email)
    .first<{ n: number }>()
  return row?.n ?? 0
}

describe("GET /auth/verify", () => {
  let env: Env
  let db: D1Database
  // Tokens are minted at a fixed `nowIso` (2026-07-03) with a 24h TTL, but the
  // consume path (handleVerifyEmailRoute) reads the REAL system clock. Pin the
  // clock to the mint instant so consume sees the token as live regardless of
  // the wall-clock date — otherwise these tests are a time-bomb that reads
  // `expired` once the machine date passes the TTL.
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"))
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

  afterEach(() => {
    vi.useRealTimers()
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

  it("a valid token marks the email verified and 302s to /login?verified=1 with NO session (login-CSRF guard)", async () => {
    const userId = await makeUnverifiedUser("v@example.com")
    const token = await mintVerificationToken(db, {
      userId,
      email: "v@example.com",
      nowIso: "2026-07-03T00:00:00.000Z",
    })

    const res = await handleVerifyEmailRoute(env, verifyUrl(token))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.sigilix.ai/login?verified=1")
    // CRITICAL: a top-level-navigable GET must NEVER mint a session (would let an
    // attacker's verify link log a victim in as the attacker).
    expect(res.headers.get("set-cookie")).toBeNull()

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
    const { ctx } = makeCtx()
    const res = await handleResendVerificationRoute(resendReq({ email: "nobody@example.com" }), env, ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("real account: the send is DEFERRED (constant-time) — token mints only after the waitUntil drains", async () => {
    await createPasswordIdentity(db, {
      email: "resend@example.com",
      passwordHash: "pbkdf2-sha256$1$AA$AA",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    const { ctx, settled } = makeCtx()
    const res = await handleResendVerificationRoute(resendReq({ email: "resend@example.com" }), env, ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // Nothing minted SYNCHRONOUSLY: the mint+send was dispatched fire-and-forget so
    // the real-account and no-account branches return in the same time (no oracle).
    expect(await tokenCount(db, "resend@example.com")).toBe(0)
    // Drain the deferred work → the fresh token is now persisted.
    await settled()
    expect(await tokenCount(db, "resend@example.com")).toBe(1)
  })

  it("is rate-limited per email (429 after the cap)", async () => {
    await createPasswordIdentity(db, {
      email: "rl@example.com",
      passwordHash: "pbkdf2-sha256$1$AA$AA",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const { ctx } = makeCtx()
      const res = await handleResendVerificationRoute(resendReq({ email: "rl@example.com" }), env, ctx)
      statuses.push(res.status)
    }
    // Per-email cap is 3/hour → the 4th+ attempts are throttled.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  })

  it("requires application/json (415 otherwise)", async () => {
    const { ctx } = makeCtx()
    const res = await handleResendVerificationRoute(resendReq({ email: "x@example.com" }, "text/plain"), env, ctx)
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
