// Managed-access contract for GET /v1/org/overview. Kept separate from the
// legacy overview suite so the role/privacy matrix remains focused and both
// test files stay below the repository's 1,000-line limit.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { RosterResult } from "@/src/lib/org-members-roster"

const rosterMock = vi.fn<(...args: unknown[]) => Promise<RosterResult>>(async () => ({
  members: [],
  complete: true,
  source: "none",
}))
vi.mock("@/src/lib/org-members-roster", () => ({
  fetchInstallationRoster: (...args: unknown[]) => rosterMock(...args),
}))

import { handleOrgOverviewRoute, type OrgOverviewResponse } from "@/src/lib/org-overview-route"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import {
  addOrgWorkspaceMember,
  bootstrapFirstOrgAdmin,
  removeOrgWorkspaceAccess,
  setOrgWorkspaceRole,
} from "@/src/features/org-membership"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const GLOBAL_KEY = "global-shared-secret-token"

const MIGRATION_USAGE_SQL = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_API_KEY_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SEAT_SQL = readFileSync(
  new URL("../../migrations/0007_create_org_seat_assignment.sql", import.meta.url),
  "utf8",
)
const MIGRATION_STRIPE_SEATS_SQL = readFileSync(
  new URL("../../migrations/0020_create_stripe_seat_reconciliation.sql", import.meta.url),
  "utf8",
)
const MIGRATION_ORG_ACCESS_SQL = readFileSync(
  new URL("../../migrations/0022_create_org_workspace_access.sql", import.meta.url),
  "utf8",
)
const MIGRATION_STRIPE_SEAT_CONTEXT_SQL = readFileSync(
  new URL("../../migrations/0023_add_org_seat_billing_operation_context.sql", import.meta.url),
  "utf8",
)
const MIGRATION_MANAGED_SEAT_SQL = readFileSync(
  new URL("../../migrations/0028_create_org_workspace_seat_assignment.sql", import.meta.url),
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
  await db.exec(MIGRATION_USAGE_SQL)
  await db.exec(MIGRATION_API_KEY_SQL)
  await db.exec(MIGRATION_SEAT_SQL)
  await db.exec(MIGRATION_STRIPE_SEATS_SQL)
  await db.exec(MIGRATION_ORG_ACCESS_SQL)
  await db.exec(MIGRATION_STRIPE_SEAT_CONTEXT_SQL)
  await db.exec(MIGRATION_MANAGED_SEAT_SQL)
  return db
}

async function seedSession(kv: KVNamespace, sessionId: string, login: string, githubUserId?: number): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    ...(githubUserId !== undefined ? { githubUserId } : {}),
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

async function seedWorkspaceAccess(
  db: D1Database,
  installationId: number,
  githubUserId: string,
  role: "admin" | "member" = "member",
): Promise<void> {
  const nowIso = "2026-07-13T00:00:00.000Z"
  if (role === "admin") {
    const result = await bootstrapFirstOrgAdmin(db, {
      installationId,
      githubUserId,
      nowIso,
      updatedBy: "test",
    })
    if (result === "bootstrapped") return
  }
  await addOrgWorkspaceMember(db, { installationId, githubUserId, nowIso, updatedBy: "test" })
  if (role === "admin") {
    const result = await setOrgWorkspaceRole(db, {
      installationId,
      githubUserId,
      role,
      nowIso: "2026-07-13T00:00:01.000Z",
      updatedBy: "test",
    })
    if (result.status !== "updated") throw new Error(`failed to seed admin: ${result.status}`)
  }
}

async function insertTenant(
  db: D1Database,
  installationId: number,
  accountLogin: string,
  accountType: "Organization" | "User",
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .bind(installationId, accountLogin, accountType)
    .run()
}

async function insertUsage(
  db: D1Database,
  args: {
    installationId: number
    repoId: number
    prNumber: number
    authorLogin: string
    createdAt: string
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO repo (repo_id, installation_id, full_name, updated_at)" +
        " VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z') ON CONFLICT(repo_id) DO NOTHING",
    )
    .bind(args.repoId, args.installationId, `acme/repo-${args.repoId}`)
    .run()
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, 1, 100, ?, ?)",
    )
    .bind(args.installationId, args.repoId, args.prNumber, `sha-${args.prNumber}`, args.authorLogin, args.createdAt)
    .run()
}

function requestWithSession(sessionId: string): Request {
  return new Request("https://x/v1/org/overview", {
    headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
  })
}

function requestWithBearer(token: string): Request {
  return new Request("https://x/v1/org/overview", { headers: { authorization: `Bearer ${token}` } })
}

function stubGitHub(options: {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships?: Array<{ role: string; state: string; organization: { login: string } }>
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({ total_count: options.installations.length, installations: options.installations }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify(options.memberships ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  rosterMock.mockReset()
  rosterMock.mockResolvedValue({ members: [], complete: true, source: "none" })
})

describe("org overview managed access", () => {
  it("rejects a managed non-GitHub session before token, GitHub, roster, or org reads", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "email-user")
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const res = await handleOrgOverviewRoute(requestWithSession("sess-1"), env)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "github_account_required" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rosterMock).not.toHaveBeenCalled()
  })

  it("uses the shared zero-admin bootstrap policy on a first managed overview", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "first-admin", 111)
    await insertTenant(db, 1, "first-admin", "User")
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "first-admin" } }] })
    rosterMock.mockResolvedValue({
      members: [{ githubUserId: "111", login: "first-admin", avatarUrl: "" }],
      complete: true,
      source: "collaborators",
    })

    const res = await handleOrgOverviewRoute(requestWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.role).toBe("admin")
    expect(body.seats[0]).toMatchObject({ githubUserId: "111", role: "admin", accessState: "active" })
    await expect(
      db
        .prepare(
          "SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = 1 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ role: "admin", revoked_at: null })
  })

  it("uses the stored viewer role, so a live GitHub admin stored as member never sees the roster", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    await seedWorkspaceAccess(db, 1, "999", "admin")
    await seedWorkspaceAccess(db, 1, "111", "member")
    await insertTenant(db, 1, "Octocat", "User")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      authorLogin: "Octocat",
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      authorLogin: "other-member",
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })

    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const res = await worker.fetch(requestWithSession("sess-1"), env, ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.role).toBe("member")
    expect(body.seats.map((seat) => seat.login.toLowerCase())).toEqual(["octocat"])
    expect(rosterMock).not.toHaveBeenCalled()
  })

  it("joins exact stored roles and active/available states by immutable roster id", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "stored-admin", 111)
    await seedWorkspaceAccess(db, 1, "111", "admin")
    await seedWorkspaceAccess(db, 1, "222", "admin")
    await seedWorkspaceAccess(db, 1, "444", "member")
    const removed = await removeOrgWorkspaceAccess(db, {
      installationId: 1,
      githubUserId: "444",
      nowIso: "2026-07-13T00:00:02.000Z",
      updatedBy: "test",
    })
    expect(removed.status).toBe("removed")
    await seedWorkspaceAccess(db, 2, "555", "admin")
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })
    rosterMock.mockResolvedValue({
      members: [
        { githubUserId: "111", login: "stored-admin", avatarUrl: "" },
        { githubUserId: "222", login: "second-admin", avatarUrl: "" },
        { githubUserId: "333", login: "new-member", avatarUrl: "" },
        { githubUserId: "444", login: "revoked-member", avatarUrl: "" },
        { githubUserId: "555", login: "foreign-admin-id", avatarUrl: "" },
      ],
      complete: true,
      source: "org",
    })

    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const res = await worker.fetch(requestWithSession("sess-1"), env, ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.role).toBe("admin")
    const byId = Object.fromEntries(body.seats.map((seat) => [seat.githubUserId, seat]))
    expect(byId["111"]).toMatchObject({ identityProvenance: "roster", accessState: "active", role: "admin" })
    expect(byId["222"]).toMatchObject({ identityProvenance: "roster", accessState: "active", role: "admin" })
    expect(byId["333"]).toMatchObject({ identityProvenance: "roster", accessState: "available", role: "member" })
    expect(byId["444"]).toMatchObject({ identityProvenance: "roster", accessState: "available", role: "member" })
    expect(byId["555"]).toMatchObject({ identityProvenance: "roster", accessState: "available", role: "member" })
  })

  it("uses only canonical active-access seats for managed assignment and survives a login rename", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "stored-admin", 111)
    await seedWorkspaceAccess(db, 1, "111", "admin")
    await seedWorkspaceAccess(db, 1, "222", "member")
    await seedWorkspaceAccess(db, 1, "444", "member")
    expect(
      (
        await removeOrgWorkspaceAccess(db, {
          installationId: 1,
          githubUserId: "444",
          nowIso: "2026-07-13T00:00:02.000Z",
          updatedBy: "test",
        })
      ).status,
    ).toBe("removed")
    await seedWorkspaceAccess(db, 2, "222", "member")
    await insertTenant(db, 1, "acme", "Organization")
    await insertTenant(db, 2, "other", "Organization")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      authorLogin: "old-name",
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    await db
      .prepare(
        `INSERT INTO org_workspace_seat_assignment
          (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
         VALUES (1, '111', 1, 'stored-admin', 't', 't', 'test'),
                (1, '222', 1, 'old-name', 't', 't', 'test'),
                (1, '444', 1, 'revoked-name', 't', 't', 'test'),
                (2, '222', 0, 'foreign-name', 't', 't', 'test')`,
      )
      .run()
    await db
      .prepare(
        "INSERT INTO org_seat_assignment" +
          " (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (1, 'new-name', 0, 0, 't', 'legacy')",
      )
      .run()
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })
    rosterMock.mockResolvedValue({
      members: [
        { githubUserId: "111", login: "stored-admin", avatarUrl: "" },
        { githubUserId: "222", login: "new-name", avatarUrl: "" },
        { githubUserId: "333", login: "available-name", avatarUrl: "" },
        { githubUserId: "444", login: "revoked-name", avatarUrl: "" },
      ],
      complete: true,
      source: "org",
    })

    const res = await handleOrgOverviewRoute(requestWithSession("sess-1"), env)

    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    const byId = Object.fromEntries(
      body.seats.filter((seat) => seat.githubUserId !== undefined).map((seat) => [seat.githubUserId, seat]),
    )
    expect(byId["111"]).toMatchObject({ assigned: true, accessState: "active" })
    expect(byId["222"]).toMatchObject({ login: "new-name", assigned: true, accessState: "active" })
    expect(byId["333"]).toMatchObject({ assigned: false, accessState: "available" })
    expect(byId["444"]).toMatchObject({ assigned: false, accessState: "available" })
    expect(body.seats.find((seat) => seat.login === "old-name")).toMatchObject({ assigned: false })
    expect(body.assignedSeatCount).toBe(2)
  })

  it("fails closed when canonical managed seat billing state cannot be read", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "stored-admin", 111)
    await seedWorkspaceAccess(db, 1, "111", "admin")
    await insertTenant(db, 1, "stored-admin", "User")
    const seatBrokenDb = {
      prepare(sql: string) {
        if (sql.includes("FROM org_workspace_seat_assignment AS seat")) {
          throw new Error("simulated managed-seat failure")
        }
        return db.prepare(sql)
      },
    } as unknown as D1Database
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: seatBrokenDb,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "stored-admin" } }] })
    rosterMock.mockResolvedValue({
      members: [{ githubUserId: "111", login: "stored-admin", avatarUrl: "" }],
      complete: true,
      source: "collaborators",
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      const res = await handleOrgOverviewRoute(requestWithSession("sess-1"), env)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "seat_billing_unavailable" })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("org-overview-managed-seat-read-failed"))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("keeps an incomplete roster read-only unless exact stored access is active", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "stored-admin", 111)
    await seedWorkspaceAccess(db, 1, "111", "admin")
    await seedWorkspaceAccess(db, 1, "222", "member")
    await insertTenant(db, 1, "stored-admin", "User")
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "stored-admin" } }] })
    rosterMock.mockResolvedValue({
      members: [
        { githubUserId: "222", login: "active-partial-member", avatarUrl: "" },
        { githubUserId: "333", login: "partial-member", avatarUrl: "" },
      ],
      complete: false,
      source: "collaborators",
      reason: "collaborators_unavailable",
    })

    const res = await handleOrgOverviewRoute(requestWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    const byId = Object.fromEntries(body.seats.map((seat) => [seat.githubUserId, seat]))
    expect(byId["222"]).toMatchObject({ role: "member", accessState: "active" })
    expect(byId["333"]).toMatchObject({ githubUserId: "333", identityProvenance: "roster", role: "member" })
    expect(byId["333"]).not.toHaveProperty("accessState")
  })

  it("fails closed when the post-authorization access list cannot be read", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "stored-admin", 111)
    await seedWorkspaceAccess(db, 1, "111", "admin")
    await insertTenant(db, 1, "stored-admin", "User")
    const listBrokenDb = {
      prepare(sql: string) {
        if (sql.includes("ORDER BY github_user_id")) throw new Error("simulated access-list failure")
        return db.prepare(sql)
      },
    } as unknown as D1Database
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: listBrokenDb,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "stored-admin" } }] })
    rosterMock.mockResolvedValue({
      members: [{ githubUserId: "111", login: "stored-admin", avatarUrl: "" }],
      complete: true,
      source: "collaborators",
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      const res = await handleOrgOverviewRoute(requestWithSession("sess-1"), env)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "org_access_unavailable" })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("org-overview-access-list-failed"))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("enriches a managed api key only from its exact installation access rows", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const plaintext = "sigilix_live_managed_overview"
    await insertTenant(db, 1, "acme", "Organization")
    await seedWorkspaceAccess(db, 1, "111", "admin")
    await insertApiKey(db, {
      id: "key-managed",
      keyHash: await sha256Hex(plaintext),
      installationId: 1,
      createdBy: "111",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    rosterMock.mockResolvedValue({
      members: [
        { githubUserId: "111", login: "admin", avatarUrl: "" },
        { githubUserId: "222", login: "candidate", avatarUrl: "" },
      ],
      complete: true,
      source: "org",
    })

    const res = await handleOrgOverviewRoute(requestWithBearer(plaintext), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    const byId = Object.fromEntries(body.seats.map((seat) => [seat.githubUserId, seat]))
    expect(byId["111"]).toMatchObject({ role: "admin", accessState: "active" })
    expect(byId["222"]).toMatchObject({ role: "member", accessState: "available" })
  })
})
