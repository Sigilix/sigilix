// #155 onboarding-backend FOUNDATION (slice 1 of 2) — POST /v1/keys + DELETE
// /v1/keys/:id route tests. Session auth uses real encrypted KV records; D1
// uses the real-SQLite shim with key + managed-access migrations. Security
// regressions also drive the real Worker dispatcher.

import { afterEach, describe, it, expect, beforeEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleCreateApiKeyRoute, handleListApiKeysRoute, handleRevokeApiKeyRoute } from "@/src/lib/api-keys-route"
import { insertApiKey, linkAccountTenant } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(19))
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

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
  await createSession({
    kv,
    sessionId,
    login: githubUserId === 111 ? "octocat" : `user-${githubUserId}`,
    githubUserId,
    userId: `user-${githubUserId}`,
    accessToken: `ghu-${githubUserId}`,
    encryptionKeyB64url: ENC_KEY,
  })
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
const IDENTITY_MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)
// 0009 adds the api_key.name label column that insertApiKey now writes.
const NAME_MIGRATION_SQL = readFileSync(new URL("../../migrations/0009_add_api_key_name.sql", import.meta.url), "utf8")
const ORG_ACCESS_MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0022_create_org_workspace_access.sql", import.meta.url),
  "utf8",
)

/** Apply the api_key schema (0003) + the name column (0009) to a fresh D1 shim. */
async function applyKeySchema(db: D1Database): Promise<void> {
  await db.exec(MIGRATION_SQL)
  await db.exec(IDENTITY_MIGRATION_SQL)
  await db.exec(NAME_MIGRATION_SQL)
  for (const [userId, githubUserId] of [
    ["user-111", "111"],
    ["user-999", "999"],
    ["u-g", null],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO user_identity
          (user_id, github_user_id, providers, created_at, last_login_at)
         VALUES (?, ?, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .bind(userId, githubUserId)
      .run()
  }
}

async function applyOrgAccessSchema(db: D1Database): Promise<void> {
  await db.exec(ORG_ACCESS_MIGRATION_SQL)
}

async function seedStoredAccess(
  db: D1Database,
  options: {
    installationId?: number
    githubUserId?: string
    role?: "admin" | "member"
    revokedAt?: string | null
  } = {},
): Promise<void> {
  const installationId = options.installationId ?? 42
  const githubUserId = options.githubUserId ?? "111"
  const now = "2026-07-13T00:00:00.000Z"
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      installationId,
      githubUserId,
      options.role ?? "member",
      now,
      now,
      options.revokedAt ?? null,
      "test-seed",
      `seed-${installationId}-${githubUserId}`,
      "member_added_or_regranted",
    )
    .run()
}

function stubGitHub(options: { visibleInstallationId?: number; liveRole?: "admin" | "member" } = {}): void {
  const visibleInstallationId = options.visibleInstallationId ?? 42
  const liveRole = options.liveRole ?? "member"
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            installations: [{ id: visibleInstallationId, account: { type: "Organization", login: "acme" } }],
          }),
          { status: 200 },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify([{ role: liveRole, state: "active", organization: { login: "acme" } }]), {
          status: 200,
        })
      }
      if (url.startsWith("https://api.github.com/orgs/acme/members?")) {
        return new Response(JSON.stringify([{ id: 111, login: "octocat" }]), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("handleCreateApiKeyRoute (POST /v1/keys)", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env

  beforeEach(async () => {
    db = makeD1()
    await applyKeySchema(db)
    kv = makeKV()
    env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token",
    } as unknown as Env
    await kv.put(
      "gh-installation-token:42",
      JSON.stringify({ token: "ghs_roster", expiresAt: Date.now() + 60 * 60 * 1000 }),
    )
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

  it("403 when a stale legacy link exists but GitHub cannot see the exact installation", async () => {
    await seedSession(kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub({ visibleInstallationId: 99 })
    const request = reqWithSession("https://x/v1/keys", "sess-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 42 }),
    })
    const res = await worker.fetch(request, env, CTX)
    expect(res.status).toBe(403)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
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

  it("rollout-off: a live exact GitHub member mints without a legacy account_tenant link", async () => {
    await seedSession(kv, "sess-1", 111)
    stubGitHub({ liveRole: "member" })
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "off"

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
    expect(res.headers.get("cache-control")).toBe("private, no-store")

    const row = await db
      .prepare("SELECT key_hash FROM api_key WHERE id = ?")
      .bind(body.id)
      .first<{ key_hash: string }>()
    expect(row?.key_hash).toBe(await sha256Hex(body.key))
    // The hash column must never equal the plaintext itself.
    expect(row?.key_hash).not.toBe(body.key)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first<{ n: number }>()).resolves.toEqual({
      n: 0,
    })
  })

  it("rollout-on: an active exact stored member can mint", async () => {
    await applyOrgAccessSchema(db)
    await seedStoredAccess(db)
    await seedSession(kv, "sess-1", 111)
    stubGitHub({ liveRole: "member" })
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"

    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: 42 }),
      }),
      env,
    )

    expect(res.status).toBe(201)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 1 })
  })

  it.each([
    { name: "missing", access: null },
    { name: "revoked", access: { installationId: 42, revokedAt: "2026-07-13T01:00:00.000Z" } },
    { name: "cross-installation", access: { installationId: 99, revokedAt: null } },
  ])("rollout-on: $name stored access denies mint despite a legacy link", async ({ access }) => {
    await applyOrgAccessSchema(db)
    if (access) await seedStoredAccess(db, access)
    await seedSession(kv, "sess-1", 111)
    await linkAccountTenant(db, {
      githubUserId: "111",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    stubGitHub({ liveRole: "member" })
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"

    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: 42 }),
      }),
      env,
    )

    expect(res.status).toBe(403)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 0 })
  })

  it("rollout-on: a live GitHub admin atomically bootstraps the first admin before minting", async () => {
    await applyOrgAccessSchema(db)
    await seedSession(kv, "sess-1", 111)
    stubGitHub({ liveRole: "admin" })
    env.OPENCLAW_ORG_MEMBERSHIP_MODE = "on"

    const res = await handleCreateApiKeyRoute(
      reqWithSession("https://x/v1/keys", "sess-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: 42 }),
      }),
      env,
    )

    expect(res.status).toBe(201)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM api_key").first<{ n: number }>()).resolves.toEqual({ n: 1 })
    await expect(
      db
        .prepare(
          "SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ role: "admin", revoked_at: null })
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
    env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
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

  it("404 when a same-installation linked caller does not own the key UUID", async () => {
    await seedSession(kv, "sess-1", 999)
    await linkAccountTenant(db, {
      githubUserId: "999",
      installationId: 42,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
    // Drive the real Worker dispatch: this regression must cover the public
    // DELETE route, not only the leaf handler.
    const res = await worker.fetch(reqWithSession("https://x/v1/keys/key-1", "sess-1", { method: "DELETE" }), env, CTX)
    expect(res.status).toBe(404)
    const row = await db
      .prepare("SELECT revoked_at FROM api_key WHERE id = ?")
      .bind("key-1")
      .first<{ revoked_at: string | null }>()
    expect(row?.revoked_at).toBeNull()
  })

  it("revokes the caller's own key without requiring a legacy link or active workspace access", async () => {
    await seedSession(kv, "sess-1", 111)

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

  it("returns idempotent success when the caller's own key is already revoked", async () => {
    await seedSession(kv, "sess-1", 111)
    const revokedAt = "2026-01-02T00:00:00Z"
    await db.prepare("UPDATE api_key SET revoked_at = ? WHERE id = ?").bind(revokedAt, "key-1").run()

    const res = await handleRevokeApiKeyRoute(
      reqWithSession("https://x/v1/keys/key-1", "sess-1", { method: "DELETE" }),
      env,
      "key-1",
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, alreadyRevoked: true })
    await expect(
      db.prepare("SELECT revoked_at FROM api_key WHERE id = ?").bind("key-1").first<{ revoked_at: string }>(),
    ).resolves.toEqual({ revoked_at: revokedAt })
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
    env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
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
