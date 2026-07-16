// Account deletion session-liveness regressions.
//
// KV revocation is deliberately best-effort, so every session-backed write
// must also prove that the session's durable account still exists. These tests
// exercise the delete + stale profile-write sequence through the real Worker.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import type { SessionRecord } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const SESSION_ID = "deleted-account-session"
const SESSION_KEY = `auth_session:${SESSION_ID}`
const SESSION_COOKIE = "__Host-sigilix_session"
const NOW = "2026-07-15T00:00:00.000Z"
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
}

interface TestKV extends KVNamespace {
  readonly store: Map<string, string>
  readonly deleteAttempts: string[]
  readonly failDeleteKeys: Set<string>
}

function makeKV(): TestKV {
  const store = new Map<string, string>()
  const deleteAttempts: string[] = []
  const failDeleteKeys = new Set<string>()
  return {
    store,
    deleteAttempts,
    failDeleteKeys,
    get: async (key: string, type?: "json") => {
      const value = store.get(key)
      if (value === undefined) return null
      return type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => {
      deleteAttempts.push(key)
      if (failDeleteKeys.has(key)) throw new Error(`targeted KV delete failed: ${key}`)
      store.delete(key)
    },
    list: async (options?: { prefix?: string }) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as TestKV
}

async function makeEnv(): Promise<{ env: Env; db: D1Database; kv: TestKV }> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0003_create_account_tenant_and_api_key.sql",
    "0004_create_usage_events.sql",
    "0005_create_user_profile.sql",
    "0006_create_user_identity.sql",
    "0008_create_email_verification_token.sql",
    "0009_add_api_key_name.sql",
    "0010_add_gitlab_id_to_user_identity.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0021_create_app_memory.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
  ]) {
    await db.exec(migration(name))
  }
  const kv = makeKV()
  const env = {
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_PORTAL_ORIGIN: "https://app.sigilix.ai",
  } as unknown as Env
  await seedAccount(db)
  await seedSession(kv)
  return { env, db, kv }
}

async function seedAccount(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_identity
        (user_id, github_user_id, email, email_verified, name, providers, created_at, last_login_at)
       VALUES ('user-a', '111', 'cat@x.com', 0, 'octocat', '["github"]', ?, ?)`,
    )
    .bind(NOW, NOW)
    .run()
  await db
    .prepare(
      `INSERT INTO user_profile
        (github_user_id, display_name, settings, created_at, updated_at)
       VALUES (111, 'Before delete', '{}', ?, ?)`,
    )
    .bind(NOW, NOW)
    .run()
}

async function seedSession(kv: KVNamespace): Promise<string> {
  const record: SessionRecord = {
    login: "octocat",
    githubUserId: 111,
    userId: "user-a",
    provider: "github",
    encryptedAccessToken: "unused",
    iv: "unused",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  const raw = JSON.stringify(record)
  await kv.put(SESSION_KEY, raw)
  return raw
}

function request(path: "/v1/account" | "/v1/profile", method: "DELETE" | "PATCH", body: unknown): Request {
  return new Request(`https://api.sigilix.ai${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      origin: "https://app.sigilix.ai",
    },
    body: JSON.stringify(body),
  })
}

async function deleteAccount(env: Env): Promise<Response> {
  return worker.fetch(request("/v1/account", "DELETE", { confirm: "octocat" }), env, ctx)
}

async function patchProfile(env: Env): Promise<Response> {
  return worker.fetch(request("/v1/profile", "PATCH", { display_name: "Resurrected" }), env, ctx)
}

async function readProfile(db: D1Database): Promise<{ display_name: string } | null> {
  return db
    .prepare("SELECT display_name FROM user_profile WHERE github_user_id = 111")
    .first<{ display_name: string }>()
}

describe("deleted-account session liveness", () => {
  it("rejects a stale profile write when targeted KV session revocation failed", async () => {
    const { env, db, kv } = await makeEnv()
    kv.failDeleteKeys.add(SESSION_KEY)

    const deletion = await deleteAccount(env)

    expect(deletion.status).toBe(200)
    await expect(deletion.json()).resolves.toMatchObject({ deleted: true, sessionsRevoked: 0 })
    expect(kv.deleteAttempts).toContain(SESSION_KEY)
    expect(kv.store.has(SESSION_KEY)).toBe(true)
    await expect(readProfile(db)).resolves.toBeNull()

    const staleWrite = await patchProfile(env)

    expect.soft(staleWrite.status).toBe(401)
    expect.soft(await readProfile(db)).toBeNull()
  })

  it("rejects a session reinserted after successful deletion by a delayed KV write", async () => {
    const { env, db, kv } = await makeEnv()
    const capturedSession = kv.store.get(SESSION_KEY)
    expect(capturedSession).toBeDefined()

    const deletion = await deleteAccount(env)

    expect(deletion.status).toBe(200)
    expect(kv.deleteAttempts).toContain(SESSION_KEY)
    expect(kv.store.has(SESSION_KEY)).toBe(false)
    await expect(readProfile(db)).resolves.toBeNull()

    await kv.put(SESSION_KEY, capturedSession!)
    const staleWrite = await patchProfile(env)

    expect.soft(staleWrite.status).toBe(401)
    expect.soft(await readProfile(db)).toBeNull()
  })
})
