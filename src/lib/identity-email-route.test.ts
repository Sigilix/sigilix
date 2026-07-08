// identity-email-route: POST /v1/identity/email (email capture). Session via a
// seeded fake KV, identity via the real D1 shim (migrations/0006).

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleIdentityEmailRoute } from "@/src/lib/identity-email-route"
import { upsertGithubIdentity } from "@/src/lib/user-identity-store"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const MIGRATION_0010 = readFileSync(
  new URL("../../migrations/0010_add_gitlab_id_to_user_identity.sql", import.meta.url),
  "utf8",
)
const COOKIE = "__Host-sigilix_session"

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string, t?: "json") => {
      const v = store.get(k)
      return v === undefined ? null : t === "json" ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace
  return { kv, store }
}

async function seed(kv: KVNamespace, sessionId: string, record: Partial<SessionRecord>): Promise<void> {
  const full: SessionRecord = {
    login: "u",
    encryptedAccessToken: "x",
    iv: "x",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ...record,
  }
  await kv.put(`auth_session:${sessionId}`, JSON.stringify(full))
}

function req(sessionId: string | null, body: unknown, contentType = "application/json"): Request {
  const headers = new Headers({ "content-type": contentType })
  if (sessionId) headers.set("cookie", `${COOKIE}=${sessionId}`)
  return new Request("https://x/v1/identity/email", { method: "POST", headers, body: JSON.stringify(body) })
}

describe("handleIdentityEmailRoute", () => {
  let env: Env
  let kv: KVNamespace
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await db.exec(MIGRATION_0010)
    const k = makeKV()
    kv = k.kv
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
  })

  it("401 without a session", async () => {
    expect((await handleIdentityEmailRoute(req(null, { email: "a@b.com" }), env)).status).toBe(401)
  })

  it("415 without application/json (CSRF guard)", async () => {
    await seed(kv, "s1", { userId: "u1" })
    expect((await handleIdentityEmailRoute(req("s1", { email: "a@b.com" }, "text/plain"), env)).status).toBe(415)
  })

  it("409 identity_not_linked when the session predates user_identity (no userId)", async () => {
    await seed(kv, "legacy", { githubUserId: 5 })
    const res = await handleIdentityEmailRoute(req("legacy", { email: "a@b.com" }), env)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "identity_not_linked" })
  })

  it("400 on an invalid email", async () => {
    const gh = await upsertGithubIdentity(db, { githubUserId: "10", nowIso: "2026-07-02T00:00:00.000Z" })
    await seed(kv, "s2", { userId: gh!.userId })
    expect((await handleIdentityEmailRoute(req("s2", { email: "not-an-email" }), env)).status).toBe(400)
  })

  it("persists a captured email and mirrors it onto the session", async () => {
    const gh = await upsertGithubIdentity(db, { githubUserId: "20", nowIso: "2026-07-02T00:00:00.000Z" })
    expect(gh!.email).toBeNull()
    await seed(kv, "s3", { userId: gh!.userId, login: "octo" })
    const res = await handleIdentityEmailRoute(req("s3", { email: "New@Example.com" }), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, email: "new@example.com" })
    // mirrored onto the live session record
    const session = JSON.parse((await kv.get("auth_session:s3")) as string)
    expect(session.email).toBe("new@example.com")
  })

  it("409 email_taken when another account already owns the email", async () => {
    await upsertGithubIdentity(db, {
      githubUserId: "30",
      email: "taken@example.com",
      nowIso: "2026-07-02T00:00:00.000Z",
    })
    const gh = await upsertGithubIdentity(db, { githubUserId: "31", nowIso: "2026-07-02T00:00:00.000Z" })
    await seed(kv, "s4", { userId: gh!.userId })
    const res = await handleIdentityEmailRoute(req("s4", { email: "taken@example.com" }), env)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: "email_taken" })
  })
})
