// auth-password-routes: end-to-end signup + login through the real D1 shim +
// a fake KV. Covers session issuance, duplicate rejection, wrong-password
// fail-closed, weak-password validation, CSRF content-type guard, cross-provider
// account linking (a Google email blocks a password signup), and the
// email-verification gate (sig-email-verification): signup issues NO session and
// login is blocked until the email is verified.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleLoginRoute, handleSignupRoute } from "@/src/lib/auth-password-routes"
import { findOrCreateGoogleIdentity, markEmailVerified } from "@/src/lib/user-identity-store"
import { base64urlEncode } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_0006 = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const MIGRATION_0008 = readFileSync(
  new URL("../../migrations/0008_create_email_verification_token.sql", import.meta.url),
  "utf8",
)
const MIGRATION_0010 = readFileSync(
  new URL("../../migrations/0010_add_gitlab_id_to_user_identity.sql", import.meta.url),
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

function jsonReq(url: string, body: unknown, contentType = "application/json"): Request {
  return new Request(url, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) })
}

/** ExecutionContext stub that DROPS ctx.waitUntil work (the verify send is fire-and-forget). */
const noopCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

/** Capturing ExecutionContext stub — `settled()` drains the deferred verify send. */
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

describe("email/password auth routes", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0006)
    await db.exec(MIGRATION_0010)
    await db.exec(MIGRATION_0008)
    env = { OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: db, OPENCLAW_SESSION_ENCRYPTION_KEY: KEY } as unknown as Env
  })

  /** Sign up, then flip the new account to verified (simulates clicking the link). */
  async function signupAndVerify(email: string, password: string, name?: string): Promise<string> {
    const res = await handleSignupRoute(jsonReq("https://x/v1/auth/signup", { email, password, name }), env, noopCtx)
    expect(res.status).toBe(201)
    const { userId } = (await res.json()) as { userId: string }
    expect(await markEmailVerified(db, userId, email)).toBe(true)
    return userId
  }

  it("signup issues NO session, reports verificationRequired, and DEFERS the verify send (constant-time)", async () => {
    const { ctx, settled } = makeCtx()
    const signup = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", {
        email: "user@example.com",
        password: "a-strong-passphrase",
        name: "User",
      }),
      env,
      ctx,
    )
    expect(signup.status).toBe(201)
    expect(signup.headers.get("set-cookie")).toBeNull()
    // emailSent=true reflects that a verify email was DISPATCHED (its outcome is not
    // awaited — see the constant-time note in handleSignupRoute).
    expect(await signup.json()).toMatchObject({ ok: true, verificationRequired: true, emailSent: true })
    // The send is deferred fire-and-forget so the new-account path returns as fast as
    // the email_taken 409 (no existence oracle): nothing minted synchronously.
    expect(await tokenCount(db, "user@example.com")).toBe(0)
    await settled()
    expect(await tokenCount(db, "user@example.com")).toBe(1)
  })

  it("login is BLOCKED (403 email_unverified) until the email is verified, then works", async () => {
    const signup = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "gate@example.com", password: "a-strong-passphrase" }),
      env,
      noopCtx,
    )
    const { userId } = (await signup.json()) as { userId: string }

    const blocked = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "gate@example.com", password: "a-strong-passphrase" }),
      env,
    )
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get("set-cookie")).toBeNull()
    expect(await blocked.json()).toMatchObject({ error: "email_unverified", email: "gate@example.com" })

    expect(await markEmailVerified(db, userId, "gate@example.com")).toBe(true)
    const login = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "gate@example.com", password: "a-strong-passphrase" }),
      env,
    )
    expect(login.status).toBe(200)
    expect(login.headers.get("set-cookie")).toContain("__Host-sigilix_session=")
  })

  it("remember me OFF → login sets a browser-session cookie (no Max-Age) with secure flags intact", async () => {
    await signupAndVerify("rm@example.com", "a-strong-passphrase")
    const login = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", {
        email: "rm@example.com",
        password: "a-strong-passphrase",
        remember: false,
      }),
      env,
    )
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("__Host-sigilix_session=")
    expect(cookie).not.toContain("Max-Age")
    expect(cookie).not.toContain("Expires")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=None")
  })

  it("remember me default (flag absent) → persistent 30-day login cookie", async () => {
    await signupAndVerify("def@example.com", "a-strong-passphrase")
    const login = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "def@example.com", password: "a-strong-passphrase" }),
      env,
    )
    expect(login.status).toBe(200)
    expect(login.headers.get("set-cookie") ?? "").toContain("Max-Age=2592000")
  })

  it("rejects a duplicate signup with 409 email_taken", async () => {
    await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "dup@example.com", password: "passphrase-123" }),
      env,
      noopCtx,
    )
    const again = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "DUP@example.com", password: "passphrase-123" }),
      env,
      noopCtx,
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: "email_taken" })
  })

  it("login fails closed on a wrong password (401, generic error, no session)", async () => {
    await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "z@example.com", password: "right-passphrase" }),
      env,
      noopCtx,
    )
    const res = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "z@example.com", password: "wrong-passphrase" }),
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" })
  })

  it("a wrong password on an UNVERIFIED account still returns 401 (the verify gate never leaks existence)", async () => {
    // The gate sits AFTER the constant-time password check, so a wrong password
    // yields the same generic 401 whether or not the account is verified.
    await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "unv@example.com", password: "right-passphrase" }),
      env,
      noopCtx,
    )
    const res = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "unv@example.com", password: "wrong-passphrase" }),
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" })
  })

  it("login for an unknown email returns the SAME generic 401 (no user enumeration)", async () => {
    const res = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "nobody@example.com", password: "whatever-passphrase" }),
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" })
  })

  it("rejects a weak password with 400", async () => {
    const res = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "w@example.com", password: "short" }),
      env,
      noopCtx,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "weak_password" })
  })

  it("requires application/json (CSRF guard) — 415 otherwise", async () => {
    const res = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "c@example.com", password: "passphrase-123" }, "text/plain"),
      env,
      noopCtx,
    )
    expect(res.status).toBe(415)
  })

  it("account-linking: a Google-owned email blocks a password signup (409), routing the user to log in", async () => {
    await findOrCreateGoogleIdentity(env.SIGILIX_PLATFORM_DB!, {
      googleSub: "sub-x",
      email: "shared@example.com",
      nowIso: "2026-07-02T00:00:00.000Z",
    })
    const res = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "shared@example.com", password: "passphrase-123" }),
      env,
      noopCtx,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "email_taken" })
  })

  it("503s when the identity DB is not configured (fail-closed, no crash)", async () => {
    const noDb = { OPENCLAW_STATE: makeKV(), OPENCLAW_SESSION_ENCRYPTION_KEY: KEY } as unknown as Env
    const res = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "a@b.com", password: "passphrase-123" }),
      noDb,
      noopCtx,
    )
    expect(res.status).toBe(503)
  })
})
