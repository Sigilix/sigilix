import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { addOrgWorkspaceMember, removeOrgWorkspaceAccess } from "@/src/features/org-membership"
import { handleAdminOrgAccessBackfillRoute } from "@/src/lib/admin-org-access-route"
import worker from "@/src/index"
import type { Env } from "@/src/shared/types/env"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const TOKEN = "operator-secret"
const TEST_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMA==\n-----END PRIVATE KEY-----"
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const migration = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")

function makeKV(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const value = values.get(key)
      if (value === undefined) return null
      return type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  } as unknown as KVNamespace
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0003_create_account_tenant_and_api_key.sql",
    "0007_create_org_seat_assignment.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
  ]) {
    await db.exec(migration(name))
  }
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, tier, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'team', 'stale-name', 'Organization', 't', 't')",
    )
    .run()
  await db
    .prepare(
      "INSERT INTO account_tenant (github_user_id, installation_id, role, created_at)" +
        " VALUES ('111', 42, 'legacy-owner', 't'), ('222', 42, 'legacy-member', 't')," +
        " ('999', 42, 'legacy-admin', 't')",
    )
    .run()
  return db
}

function env(db: D1Database, kv: KVNamespace, overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_ADMIN_TOKEN: TOKEN,
    OPENCLAW_ORG_MEMBERSHIP_MODE: "off",
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: TEST_PRIVATE_KEY,
    ...overrides,
  } as unknown as Env
}

function request(apply: boolean, token = TOKEN): Request {
  return new Request("https://api.sigilix.ai/admin/org-access/backfill", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ installationId: 42, apply }),
  })
}

async function cacheInstallationToken(kv: KVNamespace): Promise<void> {
  await kv.put(
    "gh-installation-token:42",
    JSON.stringify({ token: "ghs_roster", expiresAt: Date.now() + 60 * 60 * 1000 }),
  )
}

function stubGitHub(options: { rosterStatus?: number; membershipUserId?: number } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "https://api.github.com/app/installations/42") {
        return Response.json({
          id: 42,
          account: { id: 9001, login: "live-org", type: "Organization" },
        })
      }
      if (url.startsWith("https://api.github.com/orgs/live-org/members?")) {
        return Response.json(
          options.rosterStatus === 503
            ? { error: "unavailable" }
            : [
                { id: 111, login: "owner", avatar_url: "" },
                { id: 222, login: "member", avatar_url: "" },
              ],
          { status: options.rosterStatus ?? 200 },
        )
      }
      const membership = /^https:\/\/api\.github\.com\/orgs\/live-org\/memberships\/(owner|member)$/.exec(url)
      if (membership) {
        const login = membership[1]!
        const expectedId = login === "owner" ? 111 : 222
        return Response.json({
          state: "active",
          role: login === "owner" ? "admin" : "member",
          user: { id: login === "owner" ? (options.membershipUserId ?? expectedId) : expectedId, login },
          organization: { id: 9001, login: "live-org" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

function stubPersonalGitHub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "https://api.github.com/app/installations/42") {
        return Response.json({ id: 42, account: { id: 111, login: "owner", type: "User" } })
      }
      if (url.startsWith("https://api.github.com/installation/repositories?")) {
        return Response.json({ repositories: [{ full_name: "owner/repo" }] })
      }
      if (url.startsWith("https://api.github.com/repos/owner/repo/collaborators?")) {
        return Response.json([
          { id: 111, login: "owner", avatar_url: "" },
          { id: 222, login: "member", avatar_url: "" },
        ])
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

async function counts(db: D1Database): Promise<{ access: number; audit: number }> {
  const access = await db.prepare("SELECT COUNT(*) AS n FROM org_workspace_access").first<{ n: number }>()
  const audit = await db.prepare("SELECT COUNT(*) AS n FROM org_workspace_access_audit").first<{ n: number }>()
  return { access: access?.n ?? -1, audit: audit?.n ?? -1 }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey)
  vi.spyOn(crypto.subtle, "sign").mockResolvedValue(new Uint8Array([1]).buffer)
})

describe("admin organization-access backfill", () => {
  it("dry-runs exact roster and live-role proof without writing", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    stubGitHub()

    const response = await handleAdminOrgAccessBackfillRoute(request(false), env(db, kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      installationId: 42,
      applied: false,
      ready: false,
      canApply: true,
      counts: {
        linked: 3,
        currentLinked: 2,
        staleLinked: 1,
        coveredCurrentLinked: 0,
        reachableAdmins: 0,
        liveAdminCandidates: 1,
      },
      actions: { bootstrapAdmin: true, seedMembers: 2 },
      bootstrapSelection: "lowest_live_admin_id",
    })
    await expect(counts(db)).resolves.toEqual({ access: 0, audit: 0 })
  })

  it("dispatches apply through the worker and returns a ready exact-installation state", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    stubGitHub()

    const response = await worker.fetch(request(true), env(db, kv), ctx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      installationId: 42,
      applied: true,
      ready: true,
      canApply: true,
      counts: { currentLinked: 2, coveredCurrentLinked: 2, reachableAdmins: 1 },
      actions: { bootstrapAdmin: false, seedMembers: 0 },
      bootstrapSelection: "existing_reachable_admin",
    })
    await expect(
      db.prepare("SELECT github_user_id, role, revoked_at FROM org_workspace_access ORDER BY github_user_id").all(),
    ).resolves.toMatchObject({
      results: [
        { github_user_id: "111", role: "admin", revoked_at: null },
        { github_user_id: "222", role: "member", revoked_at: null },
      ],
    })
  })

  it("preserves a revoked tombstone while covering it during apply", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "222",
      nowIso: "2026-07-16T00:00:00.000Z",
      updatedBy: "old-admin",
    })
    await removeOrgWorkspaceAccess(db, {
      installationId: 42,
      githubUserId: "222",
      nowIso: "2026-07-16T00:01:00.000Z",
      updatedBy: "old-admin",
      rosterSnapshot: { memberIds: ["111", "222"], sqlTokenSet: "|111|222|" },
    })
    stubGitHub()

    const response = await handleAdminOrgAccessBackfillRoute(request(true), env(db, kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ready: true, counts: { revokedCurrentLinked: 1 } })
    await expect(
      db
        .prepare(
          "SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '222'",
        )
        .first(),
    ).resolves.toEqual({ role: "member", revoked_at: "2026-07-16T00:01:00.000Z" })
  })

  it("promotes an existing active member when live GitHub proves the first admin", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "111",
      nowIso: "2026-07-16T00:00:00.000Z",
      updatedBy: "onboarding",
    })
    stubGitHub()

    const response = await handleAdminOrgAccessBackfillRoute(request(true), env(db, kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ready: true, counts: { reachableAdmins: 1 } })
    await expect(
      db
        .prepare(
          "SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ role: "admin", revoked_at: null })
  })

  it("uses the immutable installation owner as admin for a personal installation", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    stubPersonalGitHub()

    const response = await handleAdminOrgAccessBackfillRoute(request(true), env(db, kv))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ready: true, counts: { reachableAdmins: 1 } })
    await expect(
      db.prepare("SELECT role FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'").first(),
    ).resolves.toEqual({ role: "admin" })
  })

  it("refuses an apply with no current linked identities instead of reporting a fake mutation", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    stubGitHub({ rosterStatus: 200 })
    await db.prepare("DELETE FROM account_tenant WHERE installation_id = 42").run()

    const response = await handleAdminOrgAccessBackfillRoute(request(true), env(db, kv))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "org_access_backfill_not_ready" })
    await expect(counts(db)).resolves.toEqual({ access: 0, audit: 0 })
  })

  it("bounds legacy linked-identity enumeration before any role lookups or writes", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    stubGitHub()
    await db.batch(
      Array.from({ length: 98 }, (_, index) => String(1_000 + index)).map((githubUserId) =>
        db
          .prepare(
            "INSERT INTO account_tenant (github_user_id, installation_id, role, created_at) VALUES (?, 42, 'member', 't')",
          )
          .bind(githubUserId),
      ),
    )

    const response = await handleAdminOrgAccessBackfillRoute(request(false), env(db, kv))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: "linked_identity_limit_exceeded" })
    await expect(counts(db)).resolves.toEqual({ access: 0, audit: 0 })
  })

  it.each([
    ["an incomplete roster", { rosterStatus: 503 }, 503],
    ["a mismatched immutable membership identity", { membershipUserId: 333 }, 503],
  ])("fails closed without writes for %s", async (_case, options, status) => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    stubGitHub(options)

    const response = await handleAdminOrgAccessBackfillRoute(request(true), env(db, kv))

    expect(response.status).toBe(status)
    await expect(counts(db)).resolves.toEqual({ access: 0, audit: 0 })
  })

  it("requires the operator token and refuses backfill after managed membership is enabled", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await expect(
      handleAdminOrgAccessBackfillRoute(request(false, "wrong"), env(db, kv)).then((response) => response.status),
    ).resolves.toBe(401)
    await expect(
      handleAdminOrgAccessBackfillRoute(request(false), env(db, kv, { OPENCLAW_ORG_MEMBERSHIP_MODE: "on" })).then(
        (response) => response.status,
      ),
    ).resolves.toBe(409)
    await expect(counts(db)).resolves.toEqual({ access: 0, audit: 0 })
  })
})
