// sig-settings-backends — account controls route tests.
//
// Covers the P0 privacy surface: DELETE /v1/account (auth-guarded, typed-
// confirmation, actually purges every store, idempotent), GET /v1/account/export
// (returns ONLY the caller's data), POST /v1/account/logout-all (revokes every
// session the caller holds, and nobody else's).

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { tryHandleAccountRoute } from "@/src/lib/account-routes"
import { purgeUserAccount, subjectFromSession } from "@/src/lib/account-store"
import { insertApiKey, linkAccountTenant } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
}

/** In-memory KV with the real `.list` page shape (keys[] + list_complete + cursor). */
function makeKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    _store: store,
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
    list: async (opts?: { prefix?: string; cursor?: string }) => {
      const prefix = opts?.prefix ?? ""
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }))
      return { keys, list_complete: true, cacheStatus: null }
    },
  } as unknown as KVNamespace & { _store: Map<string, string> }
}

function sessionRecord(over: Partial<SessionRecord>): SessionRecord {
  return {
    login: "octocat",
    githubUserId: 111,
    userId: "user-a",
    provider: "github",
    encryptedAccessToken: "unused",
    iv: "unused",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ...over,
  }
}

async function seedSession(kv: KVNamespace, sessionId: string, over: Partial<SessionRecord> = {}): Promise<void> {
  await kv.put(`auth_session:${sessionId}`, JSON.stringify(sessionRecord(over)))
}

function req(url: string, sessionId: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { ...init, headers })
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

async function makeEnv(): Promise<{ env: Env; db: D1Database; kv: KVNamespace & { _store: Map<string, string> } }> {
  const db = makeD1()
  await db.exec(migration("0003_create_account_tenant_and_api_key.sql"))
  await db.exec(migration("0004_create_usage_events.sql"))
  await db.exec(migration("0005_create_user_profile.sql"))
  await db.exec(migration("0006_create_user_identity.sql"))
  await db.exec(migration("0008_create_email_verification_token.sql"))
  await db.exec(migration("0009_add_api_key_name.sql"))
  const kv = makeKV()
  const env = {
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_PORTAL_ORIGIN: "https://app.sigilix.ai",
  } as unknown as Env
  return { env, db, kv }
}

/** Seed a full account footprint for a GitHub user (identity, profile, tenant, key, usage). */
async function seedAccount(
  db: D1Database,
  args: { userId: string; githubUserId: string; login: string; email?: string },
): Promise<void> {
  const now = "2026-01-01T00:00:00Z"
  await db
    .prepare(
      "INSERT INTO user_identity (user_id, github_user_id, email, email_verified, name, providers, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)",
    )
    .bind(args.userId, args.githubUserId, args.email ?? null, args.login, JSON.stringify(["github"]), now, now)
    .run()
  await db
    .prepare("INSERT INTO user_credential (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(args.userId, "pbkdf2-sha256$1$x$y", now, now)
    .run()
  await db
    .prepare(
      "INSERT INTO user_profile (github_user_id, display_name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(Number(args.githubUserId), args.login, '{"theme":"dark"}', now, now)
    .run()
  await linkAccountTenant(db, { githubUserId: args.githubUserId, installationId: 42, role: "owner", nowIso: now })
  await insertApiKey(db, {
    id: `key-${args.userId}`,
    keyHash: await sha256Hex(`plain-${args.userId}`),
    installationId: 42,
    createdBy: args.githubUserId,
    nowIso: now,
    name: "laptop",
  })
  await db
    .prepare("INSERT INTO usage_events (meter, installation_id, user_key, surface, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind("coding_agent", 42, `gh:${args.githubUserId}`, "cli", now)
    .run()
  await db
    .prepare(
      "INSERT INTO email_verification_token (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(`tok-${args.userId}`, args.userId, args.email ?? "x@y.com", now, "2099-01-01T00:00:00Z")
    .run()
}

describe("DELETE /v1/account", () => {
  let env: Env
  let db: D1Database
  let kv: KVNamespace & { _store: Map<string, string> }

  beforeEach(async () => {
    ;({ env, db, kv } = await makeEnv())
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat", email: "cat@x.com" })
  })

  it("401 without a session", async () => {
    const res = await tryHandleAccountRoute(
      req("https://x/v1/account", null, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
      new URL("https://x/v1/account"),
    )
    expect(res?.status).toBe(401)
  })

  it("415 (CSRF guard) without application/json", async () => {
    await seedSession(kv, "s1")
    const res = await tryHandleAccountRoute(
      req("https://x/v1/account", "s1", { method: "DELETE", headers: { "content-type": "text/plain" }, body: "{}" }),
      env,
      ctx,
      new URL("https://x/v1/account"),
    )
    expect(res?.status).toBe(415)
  })

  it("400 and NO purge when the typed confirmation doesn't match", async () => {
    await seedSession(kv, "s1")
    const res = await tryHandleAccountRoute(
      req("https://x/v1/account", "s1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "wrong" }),
      }),
      env,
      ctx,
      new URL("https://x/v1/account"),
    )
    expect(res?.status).toBe(400)
    const row = await db.prepare("SELECT user_id FROM user_identity WHERE user_id = ?").bind("user-a").first()
    expect(row).not.toBeNull()
  })

  it("purges EVERY store, revokes the session, and clears the cookie on a matching confirmation", async () => {
    await seedSession(kv, "s1")
    const res = await tryHandleAccountRoute(
      req("https://x/v1/account", "s1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "OctoCat" }), // case-insensitive match on login
      }),
      env,
      ctx,
      new URL("https://x/v1/account"),
    )
    expect(res?.status).toBe(200)
    expect(res?.headers.get("set-cookie")).toContain("__Host-sigilix_session=")

    // Every store row that IS this user must be gone.
    for (const [sql, bind] of [
      ["SELECT 1 FROM user_identity WHERE user_id = ?", "user-a"],
      ["SELECT 1 FROM user_credential WHERE user_id = ?", "user-a"],
      ["SELECT 1 FROM user_profile WHERE github_user_id = ?", 111],
      ["SELECT 1 FROM account_tenant WHERE github_user_id = ?", "111"],
      ["SELECT 1 FROM api_key WHERE created_by = ?", "111"],
      ["SELECT 1 FROM usage_events WHERE user_key = ?", "gh:111"],
      ["SELECT 1 FROM email_verification_token WHERE user_id = ?", "user-a"],
    ] as const) {
      const row = await db.prepare(sql).bind(bind).first()
      expect(row, sql).toBeNull()
    }
    // Session revoked.
    expect(kv._store.has("auth_session:s1")).toBe(false)
  })

  it("purgeUserAccount is idempotent — a re-run deletes 0 rows", async () => {
    const subject = subjectFromSession(sessionRecord({}))
    const first = await purgeUserAccount(db, subject)
    expect(first.userIdentity).toBe(1)
    expect(first.apiKey).toBe(1)
    expect(first.usageEvents).toBe(1)
    expect(first.emailVerificationToken).toBe(1)
    const second = await purgeUserAccount(db, subject)
    expect(second.userIdentity).toBe(0)
    expect(second.userCredential).toBe(0)
    expect(second.apiKey).toBe(0)
    expect(second.usageEvents).toBe(0)
    expect(second.emailVerificationToken).toBe(0)
  })
})

describe("GET /v1/account/export", () => {
  it("returns ONLY the caller's data — never another user's", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat", email: "cat@x.com" })
    await seedAccount(db, { userId: "user-b", githubUserId: "222", login: "hubot", email: "bot@x.com" })
    await seedSession(kv, "s1", { userId: "user-a", githubUserId: 111, login: "octocat" })

    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/export", "s1"),
      env,
      ctx,
      new URL("https://x/v1/account/export"),
    )
    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-disposition")).toContain("attachment")
    const body = (await res!.json()) as {
      subject: { githubUserId: string }
      identity: { userId: string } | null
      apiKeys: { installationId: number }[]
      usageEvents: unknown[]
    }
    expect(body.subject.githubUserId).toBe("111")
    expect(body.identity?.userId).toBe("user-a")
    expect(body.apiKeys.length).toBe(1)
    expect(body.usageEvents.length).toBe(1)
    // The serialized export must not mention the OTHER user anywhere.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("user-b")
    expect(raw).not.toContain("hubot")
    expect(raw).not.toContain("222")
  })

  it("401 without a session", async () => {
    const { env } = await makeEnv()
    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/export", null),
      env,
      ctx,
      new URL("https://x/v1/account/export"),
    )
    expect(res?.status).toBe(401)
  })
})

describe("POST /v1/account/logout-all", () => {
  it("revokes every session the caller holds — and nobody else's", async () => {
    const { env, kv } = await makeEnv()
    // three sessions for user-a (across devices), one for a different user.
    await seedSession(kv, "a1", { userId: "user-a", githubUserId: 111 })
    await seedSession(kv, "a2", { userId: "user-a", githubUserId: 111 })
    await seedSession(kv, "a3", { userId: "user-a", githubUserId: 111 })
    // a LEGACY session for the same person — no userId, but the same githubUserId.
    await kv.put(
      "auth_session:a-legacy",
      JSON.stringify({
        login: "octocat",
        githubUserId: 111,
        encryptedAccessToken: "x",
        iv: "y",
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    )
    await seedSession(kv, "b1", { userId: "user-b", githubUserId: 222, login: "hubot" })

    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/logout-all", "a1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
      new URL("https://x/v1/account/logout-all"),
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { revoked: number }
    expect(body.revoked).toBe(4) // the 3 + the legacy session sharing githubUserId
    expect(kv._store.has("auth_session:a1")).toBe(false)
    expect(kv._store.has("auth_session:a2")).toBe(false)
    expect(kv._store.has("auth_session:a3")).toBe(false)
    expect(kv._store.has("auth_session:a-legacy")).toBe(false)
    // the other user's session is untouched.
    expect(kv._store.has("auth_session:b1")).toBe(true)
  })

  it("415 without application/json (CSRF guard)", async () => {
    const { env, kv } = await makeEnv()
    await seedSession(kv, "a1")
    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/logout-all", "a1", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      env,
      ctx,
      new URL("https://x/v1/account/logout-all"),
    )
    expect(res?.status).toBe(415)
  })
})
