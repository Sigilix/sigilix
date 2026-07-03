// sig-user-profile — GET/PATCH /v1/profile tests.
// Harness mirrors usage-route.test.ts: makeD1 + the user_profile migration, KV
// session seeding. Covers read/write persistence, own-profile-only isolation,
// fail-closed auth, validation, the plan seam, and (via the worker entrypoint)
// that the route + its PATCH preflight are registered in index.ts.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  handleUserProfileGetRoute,
  handleUserProfilePatchRoute,
  type ProfileResponse,
} from "@/src/lib/user-profile-route"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))

const MIGRATION_PROFILE_SQL = readFileSync(
  new URL("../../migrations/0005_create_user_profile.sql", import.meta.url),
  "utf8",
)

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_PROFILE_SQL)
  return db
}

async function seedSession(
  kv: KVNamespace,
  sessionId: string,
  args: { login: string; githubUserId: number; name?: string },
): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login: args.login,
    githubUserId: args.githubUserId,
    ...(args.name !== undefined ? { name: args.name } : {}),
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

function makeEnv(kv: KVNamespace, db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    ...overrides,
  } as unknown as Env
}

function getReq(sessionId?: string): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request("https://api.sigilix.ai/v1/profile", { method: "GET", headers })
}

function patchReq(sessionId: string | undefined, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request("https://api.sigilix.ai/v1/profile", { method: "PATCH", headers, body: JSON.stringify(body) })
}

describe("GET /v1/profile", () => {
  it("fails closed (401) with no session", async () => {
    const kv = makeKV()
    const db = await makeDb()
    const res = await handleUserProfileGetRoute(getReq(), makeEnv(kv, db))
    expect(res.status).toBe(401)
  })

  it("falls back to the GitHub display name when no profile row exists", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "damartinezjulio", githubUserId: 42, name: "Daniel Martinez" })
    const res = await handleUserProfileGetRoute(getReq("s1"), makeEnv(kv, db))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProfileResponse
    expect(body.display_name).toBe("Daniel Martinez")
    expect(body.display_name_source).toBe("github")
    expect(body.login).toBe("damartinezjulio")
    expect(body.settings).toEqual({})
    expect(body.plan).toBe("free")
  })

  it("falls back to the login when there is no GitHub name and no row", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "damartinezjulio", githubUserId: 42 })
    const res = await handleUserProfileGetRoute(getReq("s1"), makeEnv(kv, db))
    const body = (await res.json()) as ProfileResponse
    expect(body.display_name).toBe("damartinezjulio")
    expect(body.display_name_source).toBe("login")
  })

  it("returns the caller's REAL plan from OPENCLAW_PLAN (never hardcoded)", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "someone", githubUserId: 7 })
    const res = await handleUserProfileGetRoute(getReq("s1"), makeEnv(kv, db, { OPENCLAW_PLAN: "pro" } as Partial<Env>))
    const body = (await res.json()) as ProfileResponse
    expect(body.plan).toBe("pro")
  })
})

describe("PATCH /v1/profile", () => {
  it("fails closed (401) with no session", async () => {
    const kv = makeKV()
    const db = await makeDb()
    const res = await handleUserProfilePatchRoute(patchReq(undefined, { display_name: "X" }), makeEnv(kv, db))
    expect(res.status).toBe(401)
  })

  it("persists display_name + settings and reads them back (source=profile)", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "damartinezjulio", githubUserId: 42, name: "Daniel Martinez" })
    const env = makeEnv(kv, db)

    const patch = await handleUserProfilePatchRoute(
      patchReq("s1", { display_name: "Dan M.", settings: { theme: "dark", bio: "builder" } }),
      env,
    )
    expect(patch.status).toBe(200)
    const patched = (await patch.json()) as ProfileResponse
    expect(patched.display_name).toBe("Dan M.")
    expect(patched.display_name_source).toBe("profile")
    expect(patched.settings).toEqual({ theme: "dark", bio: "builder" })

    // A fresh GET proves it persisted to D1, not just echoed.
    const get = await handleUserProfileGetRoute(getReq("s1"), env)
    const body = (await get.json()) as ProfileResponse
    expect(body.display_name).toBe("Dan M.")
    expect(body.settings).toEqual({ theme: "dark", bio: "builder" })
  })

  it("leaves display_name unchanged when only settings are patched", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "u", githubUserId: 1 })
    const env = makeEnv(kv, db)
    await handleUserProfilePatchRoute(patchReq("s1", { display_name: "Kept" }), env)
    await handleUserProfilePatchRoute(patchReq("s1", { settings: { theme: "light" } }), env)
    const body = (await (await handleUserProfileGetRoute(getReq("s1"), env)).json()) as ProfileResponse
    expect(body.display_name).toBe("Kept")
    expect(body.settings).toEqual({ theme: "light" })
  })

  it("clears display_name back to the fallback when patched with null", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "u", githubUserId: 1, name: "GitHub Name" })
    const env = makeEnv(kv, db)
    await handleUserProfilePatchRoute(patchReq("s1", { display_name: "Custom" }), env)
    await handleUserProfilePatchRoute(patchReq("s1", { display_name: null }), env)
    const body = (await (await handleUserProfileGetRoute(getReq("s1"), env)).json()) as ProfileResponse
    expect(body.display_name).toBe("GitHub Name")
    expect(body.display_name_source).toBe("github")
  })

  it("rejects an over-long display_name (400) and an invalid settings type (400)", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "u", githubUserId: 1 })
    const env = makeEnv(kv, db)
    const long = await handleUserProfilePatchRoute(patchReq("s1", { display_name: "x".repeat(81) }), env)
    expect(long.status).toBe(400)
    const badSettings = await handleUserProfilePatchRoute(patchReq("s1", { settings: [1, 2, 3] }), env)
    expect(badSettings.status).toBe(400)
    const empty = await handleUserProfilePatchRoute(patchReq("s1", {}), env)
    expect(empty.status).toBe(400)
  })

  it("returns 503 when the platform DB is not bound", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "s1", { login: "u", githubUserId: 1 })
    const env = makeEnv(kv, db, { SIGILIX_PLATFORM_DB: undefined } as unknown as Partial<Env>)
    const res = await handleUserProfilePatchRoute(patchReq("s1", { display_name: "X" }), env)
    expect(res.status).toBe(503)
  })
})

describe("own-profile-only isolation", () => {
  it("a second user never sees another user's persisted profile", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, "sa", { login: "alice", githubUserId: 100, name: "Alice A" })
    await seedSession(kv, "sb", { login: "bob", githubUserId: 200, name: "Bob B" })
    const env = makeEnv(kv, db)

    await handleUserProfilePatchRoute(patchReq("sa", { display_name: "Alice Secret", settings: { bio: "a" } }), env)

    const bob = (await (await handleUserProfileGetRoute(getReq("sb"), env)).json()) as ProfileResponse
    expect(bob.display_name).toBe("Bob B") // Bob's own github fallback, NOT Alice's
    expect(bob.settings).toEqual({})
    expect(bob.login).toBe("bob")
  })
})

describe("index.ts wiring", () => {
  it("registers the /v1/profile PATCH preflight (CORS)", async () => {
    const kv = makeKV()
    const db = await makeDb()
    const env = makeEnv(kv, db)
    const res = await worker.fetch(
      new Request("https://api.sigilix.ai/v1/profile", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3300",
          "access-control-request-method": "PATCH",
        },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-methods") ?? "").toContain("PATCH")
  })
})
