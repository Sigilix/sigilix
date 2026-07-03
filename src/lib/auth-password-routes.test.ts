// auth-password-routes: end-to-end signup + login through the real D1 shim +
// a fake KV. Covers session issuance, duplicate rejection, wrong-password
// fail-closed, weak-password validation, CSRF content-type guard, and
// cross-provider account linking (a Google email blocks a password signup).

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleLoginRoute, handleSignupRoute } from "@/src/lib/auth-password-routes"
import { findOrCreateGoogleIdentity } from "@/src/lib/user-identity-store"
import { base64urlEncode } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
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

describe("email/password auth routes", () => {
  let env: Env
  beforeEach(async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    env = { OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: db, OPENCLAW_SESSION_ENCRYPTION_KEY: KEY } as unknown as Env
  })

  it("signup succeeds, sets a __Host session cookie, and login then works", async () => {
    const signup = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", {
        email: "user@example.com",
        password: "a-strong-passphrase",
        name: "User",
      }),
      env,
    )
    expect(signup.status).toBe(201)
    const cookie = signup.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("__Host-sigilix_session=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")

    const login = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "user@example.com", password: "a-strong-passphrase" }),
      env,
    )
    expect(login.status).toBe(200)
    expect(login.headers.get("set-cookie")).toContain("__Host-sigilix_session=")
  })

  it("remember me OFF → login sets a browser-session cookie (no Max-Age) with secure flags intact", async () => {
    await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "rm@example.com", password: "a-strong-passphrase" }),
      env,
    )
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
    // The short-lived session keeps every existing protection.
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=None")
  })

  it("remember me default (flag absent) → persistent 30-day cookie", async () => {
    const signup = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "def@example.com", password: "a-strong-passphrase" }),
      env,
    )
    expect(signup.status).toBe(201)
    expect(signup.headers.get("set-cookie") ?? "").toContain("Max-Age=2592000")
  })

  it("rejects a duplicate signup with 409 email_taken", async () => {
    await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "dup@example.com", password: "passphrase-123" }),
      env,
    )
    const again = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "DUP@example.com", password: "passphrase-123" }),
      env,
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: "email_taken" })
  })

  it("login fails closed on a wrong password (401, generic error, no session)", async () => {
    await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "z@example.com", password: "right-passphrase" }),
      env,
    )
    const res = await handleLoginRoute(
      jsonReq("https://x/v1/auth/login", { email: "z@example.com", password: "wrong-passphrase" }),
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toBeNull()
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
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "weak_password" })
  })

  it("requires application/json (CSRF guard) — 415 otherwise", async () => {
    const res = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "c@example.com", password: "passphrase-123" }, "text/plain"),
      env,
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
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "email_taken" })
  })

  it("503s when the identity DB is not configured (fail-closed, no crash)", async () => {
    const noDb = { OPENCLAW_STATE: makeKV(), OPENCLAW_SESSION_ENCRYPTION_KEY: KEY } as unknown as Env
    const res = await handleSignupRoute(
      jsonReq("https://x/v1/auth/signup", { email: "a@b.com", password: "passphrase-123" }),
      noDb,
    )
    expect(res.status).toBe(503)
  })
})
