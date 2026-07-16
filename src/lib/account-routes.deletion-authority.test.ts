// Account deletion authority regressions.
//
// Deleting a stored organization admin is safe only when every affected exact
// GitHub App installation has a complete live roster with another reachable
// stored admin. These tests exercise that contract through the real Worker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const CALLER_ID = "111"
const SUCCESSOR_ID = "999"
const SESSION_ID = "account-delete-authority"
const SESSION_COOKIE = "__Host-sigilix_session"
const TEST_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMA==\n-----END PRIVATE KEY-----"
const NOW = "2026-07-15T00:00:00.000Z"
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
}

function makeKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: async (key: string, type?: "json") => {
      const value = store.get(key)
      if (value === undefined) return null
      return type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async (options?: { prefix?: string }) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace & { _store: Map<string, string> }
}

async function makeEnv(): Promise<{
  env: Env
  db: D1Database
  kv: KVNamespace & { _store: Map<string, string> }
}> {
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
    OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_PORTAL_ORIGIN: "https://app.sigilix.ai",
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: TEST_PRIVATE_KEY,
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
       VALUES ('user-a', ?, 'cat@x.com', 0, 'octocat', '["github"]', ?, ?)`,
    )
    .bind(CALLER_ID, NOW, NOW)
    .run()
  await db
    .prepare(
      "INSERT INTO user_credential (user_id, password_hash, created_at, updated_at) VALUES ('user-a', 'hash', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  await db
    .prepare(
      "INSERT INTO user_profile (github_user_id, display_name, settings, created_at, updated_at)" +
        " VALUES (?, 'octocat', '{}', ?, ?)",
    )
    .bind(Number(CALLER_ID), NOW, NOW)
    .run()
  await db
    .prepare(
      `INSERT INTO email_verification_token
        (token_hash, user_id, email, created_at, expires_at)
       VALUES ('token-a', 'user-a', 'cat@x.com', ?, '2099-01-01T00:00:00Z')`,
    )
    .bind(NOW)
    .run()
  await db
    .prepare(
      `INSERT INTO app_memory
        (id, installation_id, scope, owner_user_id, app_id, content, content_hash, created_at_ms)
       VALUES ('memory-a', 42, 'personal', 'user-a', 'cli', 'preference', ?, 100)`,
    )
    .bind("a".repeat(64))
    .run()
}

async function seedSession(kv: KVNamespace): Promise<void> {
  const record: SessionRecord = {
    login: "octocat",
    githubUserId: Number(CALLER_ID),
    userId: "user-a",
    provider: "github",
    encryptedAccessToken: "unused",
    iv: "unused",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  await kv.put(`auth_session:${SESSION_ID}`, JSON.stringify(record))
}

async function seedAccess(
  db: D1Database,
  installationId: number,
  githubUserId: string,
  options: { assigned?: boolean; accountLogin?: string } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO tenant
        (installation_id, account_login, account_type, created_at, updated_at)
       VALUES (?, ?, 'Organization', ?, ?)`,
    )
    .bind(installationId, options.accountLogin ?? `org-${installationId}`, NOW, NOW)
    .run()
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, 'admin', ?, ?, NULL, 'test-seed', ?, 'bootstrap_admin')`,
    )
    .bind(installationId, githubUserId, NOW, NOW, `seed-${installationId}-${githubUserId}`)
    .run()
  if (options.assigned !== true) return
  await db
    .prepare(
      `INSERT INTO org_workspace_seat_assignment
        (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
       VALUES (?, ?, 1, 'octocat', ?, ?, 'test-seed')`,
    )
    .bind(installationId, githubUserId, NOW, NOW)
    .run()
}

async function seedInstallationToken(kv: KVNamespace, installationId: number): Promise<void> {
  await kv.put(
    `gh-installation-token:${installationId}`,
    JSON.stringify({ token: `ghs_${installationId}`, expiresAt: Date.now() + 60 * 60 * 1000 }),
  )
}

interface StubPage {
  body: unknown
  status?: number
}

interface InstallationStub {
  accountLogin: string
  pages: Record<number, StubPage>
  exactBody?: unknown
  exactStatus?: number
  exactError?: Error
}

interface RosterRequest {
  installationId: number
  url: string
  authorization: string | null
}

function stubExactInstallations(stubs: Record<number, InstallationStub>): {
  fetchMock: ReturnType<typeof vi.fn>
  rosterRequests: RosterRequest[]
} {
  const rosterRequests: RosterRequest[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const parsed = new URL(url)
    const exact = /^\/app\/installations\/(\d+)$/.exec(parsed.pathname)
    if (exact) {
      const installationId = Number(exact[1])
      const stub = stubs[installationId]
      if (!stub) return new Response("not found", { status: 404 })
      if (stub.exactError) throw stub.exactError
      return new Response(
        JSON.stringify(
          stub.exactBody ?? {
            id: installationId,
            account: { id: 900_000 + installationId, login: stub.accountLogin, type: "Organization" },
          },
        ),
        { status: stub.exactStatus ?? 200 },
      )
    }
    for (const [rawInstallationId, stub] of Object.entries(stubs)) {
      const installationId = Number(rawInstallationId)
      if (parsed.pathname !== `/orgs/${encodeURIComponent(stub.accountLogin)}/members`) continue
      rosterRequests.push({
        installationId,
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      })
      const page = Number(parsed.searchParams.get("page") ?? "1")
      const response = stub.pages[page] ?? { body: [] }
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200 })
    }
    throw new Error(`unexpected GitHub request: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return { fetchMock, rosterRequests }
}

async function accountState(db: D1Database): Promise<unknown[]> {
  const queries = [
    "SELECT * FROM user_identity WHERE user_id = 'user-a'",
    "SELECT * FROM user_credential WHERE user_id = 'user-a'",
    `SELECT * FROM user_profile WHERE github_user_id = ${CALLER_ID}`,
    `SELECT * FROM org_workspace_access WHERE github_user_id = '${CALLER_ID}' ORDER BY installation_id`,
    `SELECT * FROM org_workspace_seat_assignment WHERE github_user_id = '${CALLER_ID}' ORDER BY installation_id`,
    `SELECT * FROM org_workspace_access_audit WHERE target_github_user_id = '${CALLER_ID}' ORDER BY installation_id, audit_id`,
    "SELECT * FROM email_verification_token WHERE user_id = 'user-a'",
    "SELECT * FROM app_memory WHERE owner_user_id = 'user-a'",
  ]
  return Promise.all(queries.map(async (sql) => (await db.prepare(sql).all()).results))
}

function deleteRequest(): Request {
  return new Request("https://api.sigilix.ai/v1/account", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
      origin: "https://app.sigilix.ai",
    },
    body: JSON.stringify({ confirm: "octocat" }),
  })
}

beforeEach(() => {
  vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey)
  vi.spyOn(crypto.subtle, "sign").mockResolvedValue(new Uint8Array([1]).buffer)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("DELETE /v1/account exact-installation admin reachability", () => {
  it("rejects a reachable caller admin when the only other stored admin departed the complete live roster", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccess(db, 42, CALLER_ID, { assigned: true })
    await seedAccess(db, 42, SUCCESSOR_ID)
    await seedInstallationToken(kv, 42)
    const before = await accountState(db)
    const { rosterRequests } = stubExactInstallations({
      42: { accountLogin: "live-org", pages: { 1: { body: [{ id: Number(CALLER_ID), login: "octocat" }] } } },
    })

    const response = await worker.fetch(deleteRequest(), env, ctx)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "account_delete_conflict", reason: "last_admin" })
    expect(await accountState(db)).toEqual(before)
    expect(kv._store.has(`auth_session:${SESSION_ID}`)).toBe(true)
    expect(rosterRequests).toEqual([expect.objectContaining({ installationId: 42, authorization: "token ghs_42" })])
  })

  it("deletes when a complete live roster contains another active stored admin", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccess(db, 42, CALLER_ID, { assigned: true })
    await seedAccess(db, 42, SUCCESSOR_ID)
    await seedInstallationToken(kv, 42)
    const { rosterRequests } = stubExactInstallations({
      42: {
        accountLogin: "live-org",
        pages: {
          1: {
            body: [
              { id: Number(CALLER_ID), login: "octocat" },
              { id: Number(SUCCESSOR_ID), login: "successor" },
            ],
          },
        },
      },
    })

    const response = await worker.fetch(deleteRequest(), env, ctx)

    expect(response.status).toBe(200)
    await expect(db.prepare("SELECT 1 FROM user_identity WHERE user_id = 'user-a'").first()).resolves.toBeNull()
    await expect(
      db
        .prepare("SELECT revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = ?")
        .bind(CALLER_ID)
        .first<{ revoked_at: string | null }>(),
    ).resolves.toEqual({ revoked_at: expect.any(String) })
    await expect(
      db
        .prepare("SELECT revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = ?")
        .bind(SUCCESSOR_ID)
        .first(),
    ).resolves.toEqual({ revoked_at: null })
    expect(rosterRequests).toEqual([expect.objectContaining({ installationId: 42, authorization: "token ghs_42" })])
  })

  it("uses the exact live App account instead of stale tenant account metadata", async () => {
    const { env, db, kv } = await makeEnv()
    await seedAccess(db, 42, CALLER_ID)
    await seedAccess(db, 42, SUCCESSOR_ID)
    await db.prepare("UPDATE tenant SET account_login = 'stale-org' WHERE installation_id = 42").run()
    await seedInstallationToken(kv, 42)
    const { fetchMock, rosterRequests } = stubExactInstallations({
      42: {
        accountLogin: "live-org",
        pages: {
          1: {
            body: [
              { id: Number(CALLER_ID), login: "octocat" },
              { id: Number(SUCCESSOR_ID), login: "successor" },
            ],
          },
        },
      },
    })

    const response = await worker.fetch(deleteRequest(), env, ctx)

    expect(response.status).toBe(200)
    const urls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(urls).toContain("https://api.github.com/app/installations/42")
    expect(urls.some((url) => url.includes("/orgs/live-org/members?"))).toBe(true)
    expect(urls.some((url) => url.includes("/orgs/stale-org/members?"))).toBe(false)
    expect(rosterRequests).toEqual([expect.objectContaining({ installationId: 42, authorization: "token ghs_42" })])
  })

  it.each([
    [
      "partial",
      {
        1: {
          body: [
            { id: Number(CALLER_ID), login: "octocat" },
            { id: Number(SUCCESSOR_ID), login: "successor" },
            ...Array.from({ length: 98 }, (_, index) => ({ id: 1_000 + index, login: `member-${index}` })),
          ],
        },
        2: { body: { message: "unavailable" }, status: 503 },
      },
    ],
    ["malformed 200", { 1: { body: [{ id: Number(SUCCESSOR_ID) }] } }],
  ] satisfies Array<[string, Record<number, StubPage>]>)(
    "returns 503 without mutation for a %s exact-installation roster",
    async (_case, pages) => {
      const { env, db, kv } = await makeEnv()
      await seedAccess(db, 42, CALLER_ID, { assigned: true })
      await seedAccess(db, 42, SUCCESSOR_ID)
      await seedInstallationToken(kv, 42)
      const before = await accountState(db)
      const { rosterRequests } = stubExactInstallations({ 42: { accountLogin: "live-org", pages } })

      const response = await worker.fetch(deleteRequest(), env, ctx)

      expect(response.status).toBe(503)
      expect(await accountState(db)).toEqual(before)
      expect(kv._store.has(`auth_session:${SESSION_ID}`)).toBe(true)
      expect(rosterRequests.every((request) => request.authorization === "token ghs_42")).toBe(true)
    },
  )

  it.each([
    ["missing", { exactStatus: 404 }],
    [
      "malformed",
      {
        exactBody: { id: 84, account: { id: 900_042, login: "live-org", type: "Organization" } },
      },
    ],
    ["unavailable", { exactError: new Error("network unavailable") }],
  ] satisfies Array<[string, Pick<InstallationStub, "exactBody" | "exactStatus" | "exactError">]>)(
    "returns 503 without mutation when the exact App installation is %s",
    async (_case, exact) => {
      const { env, db, kv } = await makeEnv()
      await seedAccess(db, 42, CALLER_ID, { assigned: true })
      await seedAccess(db, 42, SUCCESSOR_ID)
      await seedInstallationToken(kv, 42)
      const before = await accountState(db)
      const { rosterRequests } = stubExactInstallations({
        42: { accountLogin: "live-org", pages: { 1: { body: [] } }, ...exact },
      })

      const response = await worker.fetch(deleteRequest(), env, ctx)

      expect(response.status).toBe(503)
      expect(await accountState(db)).toEqual(before)
      expect(kv._store.has(`auth_session:${SESSION_ID}`)).toBe(true)
      expect(rosterRequests).toEqual([])
    },
  )

  it("keeps every installation unchanged when one complete live roster lacks a reachable successor", async () => {
    const { env, db, kv } = await makeEnv()
    for (const installationId of [42, 84]) {
      await seedAccess(db, installationId, CALLER_ID, { assigned: true })
      await seedAccess(db, installationId, SUCCESSOR_ID)
      await seedInstallationToken(kv, installationId)
    }
    const before = await accountState(db)
    const members = [
      { id: Number(CALLER_ID), login: "octocat" },
      { id: Number(SUCCESSOR_ID), login: "successor" },
    ]
    const { rosterRequests } = stubExactInstallations({
      42: { accountLogin: "safe-org", pages: { 1: { body: members } } },
      84: { accountLogin: "unsafe-org", pages: { 1: { body: members.slice(0, 1) } } },
    })

    const response = await worker.fetch(deleteRequest(), env, ctx)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "account_delete_conflict", reason: "last_admin" })
    expect(await accountState(db)).toEqual(before)
    expect(kv._store.has(`auth_session:${SESSION_ID}`)).toBe(true)
    expect(rosterRequests).toContainEqual(
      expect.objectContaining({ installationId: 84, authorization: "token ghs_84" }),
    )
    expect(rosterRequests.every((request) => request.authorization === `token ghs_${request.installationId}`)).toBe(
      true,
    )
  })
})
