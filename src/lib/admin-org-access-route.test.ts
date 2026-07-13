import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { addOrgWorkspaceMember, removeOrgWorkspaceAccess } from "@/src/features/org-membership"
import { handleAdminOrgAccessRecoveryRoute } from "@/src/lib/admin-org-access-route"
import worker from "@/src/index"
import type { Env } from "@/src/shared/types/env"

const TOKEN = "operator-secret"
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
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0003_create_account_tenant_and_api_key.sql"))
  await db.exec(migration("0007_create_org_seat_assignment.sql"))
  await db.exec(migration("0022_create_org_workspace_access.sql"))
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, tier, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'team', 'acme', 'Organization', 't', 't')",
    )
    .run()
  return db
}

function request(body: unknown, token: string | null = TOKEN, contentType = "application/json"): Request {
  const headers = new Headers({ "content-type": contentType })
  if (token !== null) headers.set("authorization", `Bearer ${token}`)
  return new Request("https://api.sigilix.ai/admin/org-access/recover", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

function env(db: D1Database, kv: KVNamespace, overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_ADMIN_TOKEN: TOKEN,
    OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
    OPENCLAW_STATE: kv,
    SIGILIX_PLATFORM_DB: db,
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: "cached-token",
    ...overrides,
  } as unknown as Env
}

function envWithoutAdminToken(db: D1Database, kv: KVNamespace): Env {
  const value = env(db, kv)
  delete value.OPENCLAW_ADMIN_TOKEN
  return value
}

async function cacheInstallationToken(kv: KVNamespace): Promise<void> {
  await kv.put(
    "gh-installation-token:42",
    JSON.stringify({ token: "ghs_roster", expiresAt: Date.now() + 60 * 60 * 1000 }),
  )
}

function stubRoster(rows: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://api.github.com/orgs/acme/members?")) {
        return new Response(JSON.stringify(rows), { status })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

beforeEach(() => vi.restoreAllMocks())

describe("admin organization-access recovery", () => {
  it("fails closed when the operator token is missing or invalid", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await expect(
      handleAdminOrgAccessRecoveryRoute(
        request({ installationId: 42, githubUserId: "111" }),
        envWithoutAdminToken(db, kv),
      ).then((response) => response.status),
    ).resolves.toBe(503)
    await expect(
      handleAdminOrgAccessRecoveryRoute(
        request({ installationId: 42, githubUserId: "111" }, "wrong"),
        env(db, kv),
      ).then((response) => response.status),
    ).resolves.toBe(401)
  })

  it("requires JSON and a valid immutable target", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await expect(
      handleAdminOrgAccessRecoveryRoute(
        request({ installationId: 42, githubUserId: "111" }, TOKEN, "text/plain"),
        env(db, kv),
      ).then((response) => response.status),
    ).resolves.toBe(415)
    await expect(
      handleAdminOrgAccessRecoveryRoute(request({ installationId: 42, githubUserId: "alice" }), env(db, kv)).then(
        (response) => response.status,
      ),
    ).resolves.toBe(400)
  })

  it("cannot create access while the workspace-role rollout is disabled", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const response = await handleAdminOrgAccessRecoveryRoute(
      request({ installationId: 42, githubUserId: "111" }),
      env(db, kv, { OPENCLAW_ORG_MEMBERSHIP_MODE: "off" }),
    )
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "org_membership_disabled" })
  })

  it("requires a complete exact-installation roster proof", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    stubRoster([{ id: 222, login: "other" }])
    await expect(
      handleAdminOrgAccessRecoveryRoute(request({ installationId: 42, githubUserId: "111" }), env(db, kv)).then(
        (response) => response.status,
      ),
    ).resolves.toBe(404)

    stubRoster({ error: "unavailable" }, 503)
    await expect(
      handleAdminOrgAccessRecoveryRoute(request({ installationId: 42, githubUserId: "111" }), env(db, kv)).then(
        (response) => response.status,
      ),
    ).resolves.toBe(503)
  })

  it("intentionally restores a roster-proven tombstone and writes durable audit", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await cacheInstallationToken(kv)
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "111",
      nowIso: "2026-07-13T03:00:00.000Z",
      updatedBy: "old-admin",
    })
    await removeOrgWorkspaceAccess(db, {
      installationId: 42,
      githubUserId: "111",
      login: "octocat",
      nowIso: "2026-07-13T03:01:00.000Z",
      updatedBy: "old-admin",
    })
    stubRoster([{ id: 111, login: "octocat", avatar_url: "https://avatars.test/111" }])

    const response = await worker.fetch(request({ installationId: 42, githubUserId: "111" }), env(db, kv), ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      installationId: 42,
      githubUserId: "111",
      role: "admin",
      recovered: true,
    })
    expect(
      await db
        .prepare(
          "SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).toEqual({ role: "admin", revoked_at: null })
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM org_workspace_access_audit" +
            " WHERE installation_id = 42 AND action = 'operator_recovery'",
        )
        .first(),
    ).toEqual({ n: 1 })
  })
})
