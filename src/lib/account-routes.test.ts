// sig-settings-backends — account controls route tests.
//
// Covers the P0 privacy surface: DELETE /v1/account (auth-guarded, typed-
// confirmation, actually purges every store, idempotent), GET /v1/account/export
// (returns ONLY the caller's data), POST /v1/account/logout-all (revokes every
// session the caller holds, and nobody else's).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { tryHandleAccountRoute } from "@/src/lib/account-routes"
import { purgeUserAccount, subjectFromSession } from "@/src/lib/account-store"
import { seedAccount, seedLiveIdentity } from "./account-routes.test-helpers"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const TEST_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMA==\n-----END PRIVATE KEY-----"

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

function legacySessionRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  const record = sessionRecord(over)
  delete record.userId
  return record
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
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0003_create_account_tenant_and_api_key.sql"))
  await db.exec(migration("0004_create_usage_events.sql"))
  await db.exec(migration("0005_create_user_profile.sql"))
  await db.exec(migration("0006_create_user_identity.sql"))
  await db.exec(migration("0008_create_email_verification_token.sql"))
  await db.exec(migration("0009_add_api_key_name.sql"))
  await db.exec(migration("0010_add_gitlab_id_to_user_identity.sql"))
  await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
  await db.exec(migration("0021_create_app_memory.sql"))
  await db.exec(migration("0022_create_org_workspace_access.sql"))
  await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
  await db.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
  const kv = makeKV()
  const env = {
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_PORTAL_ORIGIN: "https://app.sigilix.ai",
  } as unknown as Env
  return { env, db, kv }
}

async function seedManagedAccess(
  db: D1Database,
  args: {
    installationId: number
    githubUserId: string
    role: "admin" | "member"
    assigned?: boolean
    login?: string
    updatedBy?: string
  },
): Promise<void> {
  const now = "2026-01-01T00:00:00Z"
  await db
    .prepare(
      `INSERT OR IGNORE INTO tenant
        (installation_id, account_login, account_type, created_at, updated_at)
       VALUES (?, ?, 'Organization', ?, ?)`,
    )
    .bind(args.installationId, `org-${args.installationId}`, now, now)
    .run()
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .bind(
      args.installationId,
      args.githubUserId,
      args.role,
      now,
      now,
      args.updatedBy ?? "github:999",
      `seed-${args.installationId}-${args.githubUserId}`,
      args.role === "admin" ? "bootstrap_admin" : "member_added_or_regranted",
    )
    .run()
  if (args.assigned === undefined) return
  await db
    .prepare(
      `INSERT INTO org_workspace_seat_assignment
        (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.installationId,
      args.githubUserId,
      args.assigned ? 1 : 0,
      args.login ?? null,
      now,
      now,
      args.updatedBy ?? "github:999",
    )
    .run()
}

async function seedActiveManagedSeatOperation(
  db: D1Database,
  args: { installationId: number; githubUserId: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_seat_billing_operation
        (operation_id, installation_id, revision, login, target_identity_kind, target_github_user_id,
         actor_login, target_is_admin, requested_assigned, previous_assigned, desired_quantity, state,
         stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
         idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 1, 'octocat', 'managed_github', ?, 'owner', 0, 1, 0, 2, 'pending',
               'sub_test', 'si_test', 1, ?, 0, 1, 1, 1)`,
    )
    .bind(
      `op-${args.installationId}-${args.githubUserId}`,
      args.installationId,
      args.githubUserId,
      `seat-op-${args.installationId}-${args.githubUserId}`,
    )
    .run()
}

function beforeFirstBatch(db: D1Database, hook: () => Promise<void>): D1Database {
  let pending = true
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false
            await hook()
          }
          return target.batch(statements)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function seedPersonalAppMemory(
  db: D1Database,
  args: { id: string; userId: string; content: string; installationId?: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_memory
        (id, installation_id, scope, owner_user_id, app_id, content, content_hash, created_at_ms)
       VALUES (?, ?, 'personal', ?, 'cli', ?, ?, 100)`,
    )
    .bind(args.id, args.installationId ?? 42, args.userId, args.content, "a".repeat(64))
    .run()
}

async function seedOrganizationAppMemory(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_memory
        (id, installation_id, scope, owner_user_id, app_id, content, content_hash, created_at_ms)
       VALUES ('appmem_org', 42, 'organization', '', 'cli', 'Organization memory.', ?, 100)`,
    )
    .bind("b".repeat(64))
    .run()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Seed a full account footprint for a GitHub user (identity, profile, tenant, key, usage). */

describe("DELETE /v1/account", () => {
  let env: Env
  let db: D1Database
  let kv: KVNamespace & { _store: Map<string, string> }

  beforeEach(async () => {
    ;({ env, db, kv } = await makeEnv())
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat", email: "cat@x.com" })
    await seedPersonalAppMemory(db, { id: "appmem_user_a", userId: "user-a", content: "My CLI preference." })
    await seedOrganizationAppMemory(db)
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

  it("401 and NO purge when durable identity disagrees with the session", async () => {
    await seedAccount(db, { userId: "user-b", githubUserId: "222", login: "hubot" })
    await seedSession(kv, "mismatch", { userId: "user-a", githubUserId: 222, login: "octocat" })

    const res = await tryHandleAccountRoute(
      req("https://x/v1/account", "mismatch", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "octocat" }),
      }),
      env,
      ctx,
      new URL("https://x/v1/account"),
    )

    expect(res?.status).toBe(401)
    expect(res?.headers.get("set-cookie")).toBeNull()
    expect(await res?.json()).toEqual({ error: "unauthenticated" })
    expect(kv._store.has("auth_session:mismatch")).toBe(false)
    expect(await db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-a'").first()).not.toBeNull()
    expect(await db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-b'").first()).not.toBeNull()
  })

  it("rejects and revokes a legacy session before account deletion", async () => {
    await kv.put("auth_session:legacy-delete", JSON.stringify(legacySessionRecord()))

    const res = await worker.fetch(
      req("https://x/v1/account", "legacy-delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "octocat" }),
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toBeNull()
    await expect(res.json()).resolves.toEqual({ error: "unauthenticated" })
    expect(kv._store.has("auth_session:legacy-delete")).toBe(false)
    await expect(
      db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-a'").first(),
    ).resolves.not.toBeNull()
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
      ["SELECT 1 FROM app_memory WHERE scope = 'personal' AND owner_user_id = ?", "user-a"],
    ] as const) {
      const row = await db.prepare(sql).bind(bind).first()
      expect(row, sql).toBeNull()
    }
    // Session revoked.
    expect(kv._store.has("auth_session:s1")).toBe(false)
    expect(await db.prepare("SELECT id FROM app_memory WHERE id = 'appmem_org'").first()).not.toBeNull()
  })

  it("tombstones exact managed access, unassigns seats, and retains audit through the real Worker path", async () => {
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "999",
      role: "admin",
    })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "111",
      role: "member",
      assigned: true,
      login: "octocat",
    })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "222",
      role: "member",
      assigned: true,
      login: "hubot",
    })
    await seedManagedAccess(db, {
      installationId: 84,
      githubUserId: "999",
      role: "admin",
    })
    await seedManagedAccess(db, {
      installationId: 84,
      githubUserId: "111",
      role: "member",
      assigned: true,
      login: "octocat-renamed",
    })
    const googleLinked = sessionRecord({ provider: "google" })
    delete googleLinked.githubUserId
    await kv.put("auth_session:google-linked", JSON.stringify(googleLinked))

    const res = await worker.fetch(
      req("https://x/v1/account", "google-linked", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "octocat" }),
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      deleted: boolean
      purged: { orgWorkspaceAccess: number; orgWorkspaceSeat: number }
    }
    expect(body).toMatchObject({
      deleted: true,
      purged: { orgWorkspaceAccess: 2, orgWorkspaceSeat: 2 },
    })
    await expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM org_workspace_access" +
            " WHERE github_user_id = '111' AND revoked_at IS NOT NULL AND last_action = 'access_removed'",
        )
        .first(),
    ).resolves.toEqual({ n: 2 })
    await expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM org_workspace_seat_assignment" + " WHERE github_user_id = '111' AND assigned = 0",
        )
        .first(),
    ).resolves.toEqual({ n: 2 })
    await expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM org_workspace_access_audit" +
            " WHERE target_github_user_id = '111' AND action = 'access_removed' AND actor_id = 'github:111'",
        )
        .first(),
    ).resolves.toEqual({ n: 2 })
    await expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM org_workspace_access" +
            " WHERE github_user_id IN ('222', '999') AND revoked_at IS NULL",
        )
        .first(),
    ).resolves.toEqual({ n: 3 })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment" +
            " WHERE installation_id = 42 AND github_user_id = '222'",
        )
        .first(),
    ).resolves.toEqual({ assigned: 1 })
    await expect(db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-a'").first()).resolves.toBeNull()
  })

  it("returns 409 and changes nothing when deletion would remove the last managed admin", async () => {
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "111",
      role: "admin",
      assigned: true,
      login: "octocat",
    })
    await seedSession(kv, "last-admin")
    env.GITHUB_APP_ID = "123"
    env.GITHUB_PRIVATE_KEY = TEST_PRIVATE_KEY
    await kv.put(
      "gh-installation-token:42",
      JSON.stringify({ token: "ghs_42", expiresAt: Date.now() + 60 * 60 * 1000 }),
    )
    vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey)
    vi.spyOn(crypto.subtle, "sign").mockResolvedValue(new Uint8Array([1]).buffer)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === "https://api.github.com/app/installations/42") {
          return new Response(
            JSON.stringify({ id: 42, account: { id: 9001, login: "live-org", type: "Organization" } }),
            { status: 200 },
          )
        }
        if (url.startsWith("https://api.github.com/orgs/live-org/members?")) {
          return new Response(JSON.stringify([{ id: 111, login: "octocat" }]), { status: 200 })
        }
        throw new Error(`unexpected GitHub request: ${url}`)
      }),
    )

    const res = await worker.fetch(
      req("https://x/v1/account", "last-admin", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "octocat" }),
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: "account_delete_conflict", reason: "last_admin" })
    await expect(
      db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-a'").first(),
    ).resolves.not.toBeNull()
    await expect(
      db
        .prepare("SELECT revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'")
        .first(),
    ).resolves.toEqual({ revoked_at: null })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ assigned: 1 })
    expect(kv._store.has("auth_session:last-admin")).toBe(true)
  })

  it("returns 409 and changes nothing while exact-installation seat billing is active", async () => {
    await seedManagedAccess(db, { installationId: 42, githubUserId: "999", role: "admin" })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "111",
      role: "member",
      assigned: true,
      login: "octocat",
    })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "222",
      role: "member",
      assigned: true,
      login: "hubot",
    })
    // Even another member's operation fences the installation: changing this
    // caller's assigned seat would invalidate that operation's pinned quantity.
    await seedActiveManagedSeatOperation(db, { installationId: 42, githubUserId: "222" })
    await seedSession(kv, "billing-active")

    const res = await worker.fetch(
      req("https://x/v1/account", "billing-active", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "octocat" }),
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: "account_delete_conflict",
      reason: "billing_operation_active",
    })
    await expect(
      db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-a'").first(),
    ).resolves.not.toBeNull()
    await expect(
      db
        .prepare("SELECT revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'")
        .first(),
    ).resolves.toEqual({ revoked_at: null })
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-42-222'").first(),
    ).resolves.toEqual({ state: "pending" })
  })

  it("rolls the whole purge back when seat billing starts after preflight", async () => {
    await seedManagedAccess(db, { installationId: 42, githubUserId: "999", role: "admin" })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "111",
      role: "member",
      assigned: true,
      login: "octocat",
    })
    await seedSession(kv, "billing-race")
    env = {
      ...env,
      SIGILIX_PLATFORM_DB: beforeFirstBatch(db, () =>
        seedActiveManagedSeatOperation(db, { installationId: 42, githubUserId: "222" }),
      ),
    }

    const res = await worker.fetch(
      req("https://x/v1/account", "billing-race", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "octocat" }),
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: "account_delete_conflict",
      reason: "billing_operation_active",
    })
    await expect(
      db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-a'").first(),
    ).resolves.not.toBeNull()
    await expect(
      db
        .prepare("SELECT revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'")
        .first(),
    ).resolves.toEqual({ revoked_at: null })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ assigned: 1 })
  })

  it("rejects a stale session when the GitHub identity is recreated after resolution", async () => {
    await seedManagedAccess(db, { installationId: 42, githubUserId: "999", role: "admin" })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "111",
      role: "member",
      assigned: true,
      login: "octocat",
    })
    await seedSession(kv, "identity-race")
    env = {
      ...env,
      SIGILIX_PLATFORM_DB: beforeFirstBatch(db, async () => {
        await db.prepare("DELETE FROM user_identity WHERE user_id = 'user-a'").run()
        await db
          .prepare(
            `INSERT INTO user_identity
              (user_id, github_user_id, email, email_verified, name, providers, created_at, last_login_at)
             VALUES ('user-recreated', '111', 'new@x.com', 0, 'new-user', '["github"]', ?, ?)`,
          )
          .bind("2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z")
          .run()
      }),
    }

    const res = await worker.fetch(
      req("https://x/v1/account", "identity-race", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "octocat" }),
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toContain("__Host-sigilix_session=")
    await expect(res.json()).resolves.toEqual({ error: "unauthenticated" })
    await expect(
      db.prepare("SELECT github_user_id FROM user_identity WHERE user_id = 'user-recreated'").first(),
    ).resolves.toEqual({ github_user_id: "111" })
    await expect(
      db.prepare("SELECT github_user_id FROM user_profile WHERE github_user_id = 111").first(),
    ).resolves.toEqual({ github_user_id: 111 })
    await expect(db.prepare("SELECT id FROM api_key WHERE created_by = '111'").first()).resolves.not.toBeNull()
    await expect(
      db
        .prepare("SELECT revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'")
        .first(),
    ).resolves.toEqual({ revoked_at: null })
  })

  it("purgeUserAccount is idempotent — a re-run deletes 0 rows", async () => {
    const subject = subjectFromSession(sessionRecord({}))
    const first = await purgeUserAccount(db, subject)
    expect(first.userIdentity).toBe(1)
    expect(first.apiKey).toBe(1)
    expect(first.usageEvents).toBe(1)
    expect(first.emailVerificationToken).toBe(1)
    expect(first.appMemory).toBe(1)
    const second = await purgeUserAccount(db, subject)
    expect(second.userIdentity).toBe(0)
    expect(second.userCredential).toBe(0)
    expect(second.apiKey).toBe(0)
    expect(second.usageEvents).toBe(0)
    expect(second.emailVerificationToken).toBe(0)
    expect(second.appMemory).toBe(0)
  })

  it("resolves a legacy GitHub session before purging its personal app memories", async () => {
    const legacy = subjectFromSession(legacySessionRecord())
    expect(legacy.userId).toBeNull()
    const purged = await purgeUserAccount(db, legacy)
    expect(purged.appMemory).toBe(1)
    expect(await db.prepare("SELECT id FROM app_memory WHERE id = 'appmem_user_a'").first()).toBeNull()
  })
})

describe("GET /v1/account/export", () => {
  it("exports only exact managed lifecycle data through the real Worker path", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat", email: "cat@x.com" })
    await seedAccount(db, { userId: "user-b", githubUserId: "222", login: "hubot", email: "bot@x.com" })
    await seedManagedAccess(db, { installationId: 42, githubUserId: "999", role: "admin" })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "111",
      role: "member",
      assigned: true,
      login: "octocat",
    })
    await seedManagedAccess(db, {
      installationId: 42,
      githubUserId: "222",
      role: "member",
      assigned: true,
      login: "hubot-private",
    })
    await seedManagedAccess(db, { installationId: 84, githubUserId: "999", role: "admin" })
    await seedManagedAccess(db, {
      installationId: 84,
      githubUserId: "111",
      role: "member",
      assigned: false,
      login: "octocat-renamed",
      updatedBy: "github:222",
    })
    await db
      .prepare(
        `UPDATE org_workspace_access
            SET revoked_at = '2026-01-02T00:00:00Z', updated_at = '2026-01-02T00:00:00Z',
                updated_by = 'github:222', last_audit_id = 'removed-84-111', last_action = 'access_removed'
          WHERE installation_id = 84 AND github_user_id = '111'`,
      )
      .run()
    await seedSession(kv, "managed-export")

    const res = await worker.fetch(req("https://x/v1/account/export", "managed-export"), env, ctx)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      organizationAccess: Array<{
        installationId: number
        role: string
        revokedAt: string | null
        lastAction: string
        updatedBy?: string
      }>
      organizationSeats: Array<{
        installationId: number
        assigned: boolean
        lastKnownLogin: string | null
      }>
      organizationAccessAudit: Array<{
        installationId: number
        action: string
        actorId?: string
      }>
    }
    expect(body.organizationAccess).toEqual([
      expect.objectContaining({ installationId: 84, role: "member", revokedAt: "2026-01-02T00:00:00Z" }),
      expect.objectContaining({ installationId: 42, role: "member", revokedAt: null }),
    ])
    expect(body.organizationAccess.every((row) => row.updatedBy === undefined)).toBe(true)
    expect(body.organizationSeats).toEqual([
      expect.objectContaining({ installationId: 84, assigned: false, lastKnownLogin: "octocat-renamed" }),
      expect.objectContaining({ installationId: 42, assigned: true, lastKnownLogin: "octocat" }),
    ])
    expect(body.organizationAccessAudit.map((row) => row.action)).toEqual([
      "access_removed",
      "member_added_or_regranted",
      "member_added_or_regranted",
    ])
    expect(body.organizationAccessAudit.every((row) => row.actorId === undefined)).toBe(true)
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("hubot-private")
    expect(raw).not.toContain("github:222")
    expect(raw).not.toContain("github:999")
  })

  it("returns ONLY the caller's data — never another user's", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat", email: "cat@x.com" })
    await seedAccount(db, { userId: "user-b", githubUserId: "222", login: "hubot", email: "bot@x.com" })
    await seedPersonalAppMemory(db, { id: "appmem_user_a", userId: "user-a", content: "Caller CLI memory." })
    await seedPersonalAppMemory(db, { id: "appmem_user_b", userId: "user-b", content: "Other user's memory." })
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
      appMemories: Array<{ appId: string; content: string; scope: string }>
    }
    expect(body.subject.githubUserId).toBe("111")
    expect(body.identity?.userId).toBe("user-a")
    expect(body.apiKeys.length).toBe(1)
    expect(body.usageEvents.length).toBe(1)
    expect(body.appMemories).toEqual([
      expect.objectContaining({ appId: "cli", content: "Caller CLI memory.", scope: "personal" }),
    ])
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

  it("400 on any unexpected query parameter", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat" })
    await seedSession(kv, "s1", { userId: "user-a", githubUserId: 111, login: "octocat" })

    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/export?foo=bar", "s1"),
      env,
      ctx,
      new URL("https://x/v1/account/export?foo=bar"),
    )
    expect(res?.status).toBe(400)
    await expect(res?.json()).resolves.toEqual({ error: "unexpected_query_parameter" })
  })

  it("401 without exporting either identity when durable identity disagrees with the session", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat" })
    await seedAccount(db, { userId: "user-b", githubUserId: "222", login: "hubot" })
    await seedSession(kv, "mismatch", { userId: "user-a", githubUserId: 222, login: "octocat" })

    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/export", "mismatch"),
      env,
      ctx,
      new URL("https://x/v1/account/export"),
    )

    expect(res?.status).toBe(401)
    expect(res?.headers.get("set-cookie")).toBeNull()
    expect(await res?.json()).toEqual({ error: "unauthenticated" })
    expect(kv._store.has("auth_session:mismatch")).toBe(false)
  })

  it("rejects and revokes a legacy GitHub session before account export", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccount(db, { userId: "user-a", githubUserId: "111", login: "octocat" })
    await seedPersonalAppMemory(db, { id: "appmem_legacy", userId: "user-a", content: "Legacy session memory." })
    await kv.put("auth_session:legacy", JSON.stringify(legacySessionRecord({ githubUserId: 111 })))

    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/export", "legacy"),
      env,
      ctx,
      new URL("https://x/v1/account/export"),
    )
    expect(res?.status).toBe(401)
    expect(res?.headers.get("set-cookie")).toBeNull()
    await expect(res?.json()).resolves.toEqual({ error: "unauthenticated" })
    expect(kv._store.has("auth_session:legacy")).toBe(false)
  })
})

describe("POST /v1/account/logout-all", () => {
  it("revokes every session the caller holds — and nobody else's", async () => {
    const { env, db, kv } = await makeEnv()
    await seedLiveIdentity(db, "user-a", "111")
    await seedLiveIdentity(db, "user-b", "222")
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
    const { env, db, kv } = await makeEnv()
    await seedLiveIdentity(db, "user-a", "111")
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

  it("400 on any unexpected query parameter", async () => {
    const { env, db, kv } = await makeEnv()
    await seedLiveIdentity(db, "user-a", "111")
    await seedSession(kv, "a1")
    const res = await tryHandleAccountRoute(
      req("https://x/v1/account/logout-all?foo=bar", "a1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
      new URL("https://x/v1/account/logout-all?foo=bar"),
    )
    expect(res?.status).toBe(400)
    await expect(res?.json()).resolves.toEqual({ error: "unexpected_query_parameter" })
  })
})
