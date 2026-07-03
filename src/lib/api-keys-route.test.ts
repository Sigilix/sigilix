// #155 onboarding-backend FOUNDATION (slice 1 of 2) — POST /v1/keys + DELETE
// /v1/keys/:id route tests. Session auth via a seeded fake KV (matching
// auth-session.ts's SessionRecord shape); D1 via the real-SQLite shim with
// migrations/0003_*.sql applied.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleCreateApiKeyRoute, handleListApiKeysRoute, handleRevokeApiKeyRoute } from "@/src/lib/api-keys-route"
import { insertApiKey, linkAccountTenant } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"

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

async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number): Promise<void> {
  const record: SessionRecord = {
    login: "octocat",
    githubUserId,
    encryptedAccessToken: "unused-in-these-tests",
    iv: "unused",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  await kv.put(`auth_session:${sessionId}`, JSON.stringify(record))
}

function reqWithSession(url: string, sessionId: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { ...init, headers })
}

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
// 0009 adds the api_key.name label column that insertApiKey now writes.
const NAME_MIGRATION_SQL = readFileSync(new URL("../../migrations/0009_add_api_key_name.sql", import.meta.url), "utf8")

/** Apply the api_key schema (0003) + the name column (0009) to a fresh D1 shim. */
async function applyKeySchema(db: D1Database): Promise<void> {
  await db.exec(MIGRATION_SQL)
  await db.exec(NAME_MIGRATION_SQL)
}

describe("handleCreateApiKeyRoute (POST /v1/keys)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applyKeySchema(db)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
  })

  it("401 without a session", async () => {
    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", null, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: 1 }),
      }),
      env,
    )
    expect(res.status).toBe(401)
  })

  it("403 when the session's user is not linked to the requested installation", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: 42 }),
      }),
      env,
    )
    expect(res.status).toBe(403)
  })

  it("415 (CSRF guard) when Content-Type is not application/json — SIG-155 slice 3 (SameSite=None mitigation)", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ installationId: 42 }),
      }),
      env,
    )
    expect(res.status).toBe(415)
  })

  it("400 on a missing/invalid installationId", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("mints a key, stores only its hash, and returns the plaintext exactly once", async () => {
    await seedSession(kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: 42 }),
      }),
      env,
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; key: string; installationId: number }
    expect(body.installationId).toBe(42)
    expect(body.key).toMatch(/^sigilix_live_/)

    const row = await db
      .prepare("SELECT key_hash FROM api_key WHERE id = ?")
      .bind(body.id)
      .first<{ key_hash: string }>()
    expect(row?.key_hash).toBe(await sha256Hex(body.key))
    // The hash column must never equal the plaintext itself.
    expect(row?.key_hash).not.toBe(body.key)
  })

  it("503 when SIGILIX_PLATFORM_DB is not configured", async () => {
    await seedSession(kv, "sess-1", 111)
    const noDbEnv = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: 1 }),
      }),
      noDbEnv,
    )
    expect(res.status).toBe(503)
  })
})

describe("handleRevokeApiKeyRoute (DELETE /v1/keys/:id)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applyKeySchema(db)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex("plaintext-doesnt-matter"),
      installationId: 42,
      createdBy: "111",
      nowIso: "2026-01-01T00:00:00Z",
    })
  })

  it("401 without a session", async () => {
    const res = await handleRevokeApiKeyRoute(
      reqWithSession("https://x/v1/keys/key-1", null, { method: "DELETE" }),
      env,
      "key-1",
    )
    expect(res.status).toBe(401)
  })

  it("404 for an unknown key id", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleRevokeApiKeyRoute(
      reqWithSession("https://x/v1/keys/nope", "sess-1", { method: "DELETE" }),
      env,
      "nope",
    )
    expect(res.status).toBe(404)
  })

  it("403 when the caller is not linked to the key's installation", async () => {
    await seedSession(kv, "sess-1", 999)
    const res = await handleRevokeApiKeyRoute(
      reqWithSession("https://x/v1/keys/key-1", "sess-1", { method: "DELETE" }),
      env,
      "key-1",
    )
    expect(res.status).toBe(403)
    const row = await db
      .prepare("SELECT revoked_at FROM api_key WHERE id = ?")
      .bind("key-1")
      .first<{ revoked_at: string | null }>()
    expect(row?.revoked_at).toBeNull()
  })

  it("revokes a key the caller is linked to", async () => {
    await seedSession(kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const res = await handleRevokeApiKeyRoute(
      reqWithSession("https://x/v1/keys/key-1", "sess-1", { method: "DELETE" }),
      env,
      "key-1",
    )
    expect(res.status).toBe(200)
    const row = await db
      .prepare("SELECT revoked_at FROM api_key WHERE id = ?")
      .bind("key-1")
      .first<{ revoked_at: string | null }>()
    expect(row?.revoked_at).not.toBeNull()
  })
})

describe("handleListApiKeysRoute (GET /v1/keys)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applyKeySchema(db)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
    // Two keys minted by user 111, one by a DIFFERENT user 999.
    await insertApiKey(db, {
      id: "k-mine-1",
      keyHash: await sha256Hex("secret-plaintext-1"),
      installationId: 42,
      createdBy: "111",
      nowIso: "2026-01-01T00:00:00Z",
      name: "laptop",
    })
    await insertApiKey(db, {
      id: "k-mine-2",
      keyHash: await sha256Hex("secret-plaintext-2"),
      installationId: 42,
      createdBy: "111",
      nowIso: "2026-01-02T00:00:00Z",
    })
    await insertApiKey(db, {
      id: "k-other",
      keyHash: await sha256Hex("secret-plaintext-other"),
      installationId: 77,
      createdBy: "999",
      nowIso: "2026-01-03T00:00:00Z",
      name: "not-yours",
    })
  })

  it("401 without a session", async () => {
    const res = await handleListApiKeysRoute(reqWithSession("https://x/v1/keys", null), env)
    expect(res.status).toBe(401)
  })

  it("lists ONLY the caller's own keys, never the hash/secret", async () => {
    await seedSession(kv, "sess-1", 111)
    const res = await handleListApiKeysRoute(reqWithSession("https://x/v1/keys", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      keys: { id: string; name: string | null; keyPrefix: string }[]
    }
    const ids = body.keys.map((k) => k.id).sort()
    expect(ids).toEqual(["k-mine-1", "k-mine-2"])
    // The other user's key is never present.
    expect(ids).not.toContain("k-other")
    // Never leak any secret material — no hash, no plaintext, only the masked prefix.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain(await sha256Hex("secret-plaintext-1"))
    expect(raw).not.toContain("secret-plaintext")
    for (const k of body.keys) expect(k.keyPrefix).toBe("sigilix_live_••••••••")
  })

  it("403 when the session has no linked GitHub account", async () => {
    // A session with no githubUserId (Google/password) can't own installation keys.
    await kv.put(
      "auth_session:sess-g",
      JSON.stringify({
        login: "g",
        provider: "google",
        userId: "u-g",
        encryptedAccessToken: "x",
        iv: "y",
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    )
    const res = await handleListApiKeysRoute(reqWithSession("https://x/v1/keys", "sess-g"), env)
    expect(res.status).toBe(403)
  })
})
