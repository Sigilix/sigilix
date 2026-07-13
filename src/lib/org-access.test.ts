import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { requireOrgAccess, type OrgAccessEnv } from "@/src/lib/org-access"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(17))
const INSTALLATION_ID = 42
const GITHUB_USER_ID = "111"
const ACCOUNT_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const ACCESS_SQL = readFileSync(
  new URL("../../migrations/0022_create_org_workspace_access.sql", import.meta.url),
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
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(ACCOUNT_SQL)
  await db.exec(ACCESS_SQL)
  return db
}

async function seedSession(
  kv: KVNamespace,
  options: { sessionId?: string; login?: string; githubUserId?: number } = {},
): Promise<void> {
  await createSession({
    kv,
    sessionId: options.sessionId ?? "s1",
    login: options.login ?? "octocat",
    ...(options.githubUserId !== undefined ? { githubUserId: options.githubUserId } : {}),
    accessToken: "ghu_test",
    encryptionKeyB64url: ENC_KEY,
  })
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
  const installationId = options.installationId ?? INSTALLATION_ID
  const githubUserId = options.githubUserId ?? GITHUB_USER_ID
  const now = "2026-07-13T00:00:00.000Z"
  await db
    .prepare(
      "INSERT INTO org_workspace_access" +
        " (installation_id, github_user_id, role, created_at, updated_at, revoked_at," +
        " updated_by, last_audit_id, last_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

function request(sessionId = "s1"): Request {
  return new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members`, {
    headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
  })
}

function env(kv: KVNamespace, options: { db?: D1Database; mode?: "off" | "on" | null } = {}): OrgAccessEnv {
  const out = {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
  } as unknown as OrgAccessEnv
  if (options.db !== undefined) out.SIGILIX_PLATFORM_DB = options.db
  if (options.mode !== null) out.OPENCLAW_ORG_MEMBERSHIP_MODE = options.mode ?? "on"
  return out
}

function stubGitHub(options: { visibleInstallationId?: number; liveRole?: "admin" | "member" } = {}): void {
  const visibleInstallationId = options.visibleInstallationId ?? INSTALLATION_ID
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
        const memberships =
          liveRole === "admin" ? [{ role: "admin", state: "active", organization: { login: "acme" } }] : []
        return new Response(JSON.stringify(memberships), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("requireOrgAccess", () => {
  it("rejects unsafe installation ids before reading the session", async () => {
    const result = await requireOrgAccess(
      request(),
      env(makeKV(), { mode: null }),
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
      { requiredRole: "member" },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(400)
  })

  it("denies a stored admin when the token cannot see that exact installation", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, { githubUserId: 111 })
    await seedStoredAccess(db, { installationId: INSTALLATION_ID, role: "admin" })
    stubGitHub({ visibleInstallationId: 99, liveRole: "admin" })

    const result = await requireOrgAccess(request(), env(kv, { db }), undefined, INSTALLATION_ID, {
      requiredRole: "member",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
  })

  it("never reuses a stored admin role from another installation", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, { githubUserId: 111 })
    await seedStoredAccess(db, { installationId: 99, role: "admin" })
    stubGitHub({ visibleInstallationId: INSTALLATION_ID, liveRole: "member" })

    const result = await requireOrgAccess(request(), env(kv, { db }), undefined, INSTALLATION_ID, {
      requiredRole: "member",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
    await expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM org_workspace_access WHERE installation_id = ?")
        .bind(INSTALLATION_ID)
        .first<{ n: number }>(),
    ).resolves.toEqual({ n: 0 })
  })

  it("denies an active stored member when the route requires admin", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, { githubUserId: 111 })
    await seedStoredAccess(db)
    stubGitHub({ liveRole: "member" })

    const result = await requireOrgAccess(request(), env(kv, { db }), undefined, INSTALLATION_ID, {
      requiredRole: "admin",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
  })

  it("uses a promoted stored admin even when the exact live GitHub role is member", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, { githubUserId: 111 })
    await seedStoredAccess(db, { role: "admin" })
    stubGitHub({ liveRole: "member" })

    const result = await requireOrgAccess(request(), env(kv, { db }), undefined, INSTALLATION_ID, {
      requiredRole: "admin",
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result).toMatchObject({
        installationId: INSTALLATION_ID,
        githubUserId: GITHUB_USER_ID,
        login: "octocat",
        role: "admin",
        accessToken: "ghu_test",
      })
    }
  })

  it("always denies a revoked row without first-admin bootstrap resurrecting it", async () => {
    const kv = makeKV()
    const db = await makeDb()
    const revokedAt = "2026-07-13T01:00:00.000Z"
    await seedSession(kv, { githubUserId: 111 })
    await seedStoredAccess(db, { role: "admin", revokedAt })
    stubGitHub({ liveRole: "admin" })

    const result = await requireOrgAccess(request(), env(kv, { db }), undefined, INSTALLATION_ID, {
      requiredRole: "member",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
    await expect(
      db
        .prepare("SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = ? AND github_user_id = ?")
        .bind(INSTALLATION_ID, GITHUB_USER_ID)
        .first(),
    ).resolves.toEqual({ role: "admin", revoked_at: revokedAt })
  })

  it("atomically promotes an existing stored member as the first admin, then re-reads it", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, { githubUserId: 111 })
    await seedStoredAccess(db)
    stubGitHub({ liveRole: "admin" })

    const result = await requireOrgAccess(request(), env(kv, { db }), undefined, INSTALLATION_ID, {
      requiredRole: "admin",
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.role).toBe("admin")
    await expect(
      db
        .prepare("SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = ? AND github_user_id = ?")
        .bind(INSTALLATION_ID, GITHUB_USER_ID)
        .first(),
    ).resolves.toEqual({ role: "admin", revoked_at: null })
  })

  it("serializes a first-admin conflict and authorizes only the exact stored winner", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv, { sessionId: "s1", login: "octocat", githubUserId: 111 })
    await seedSession(kv, { sessionId: "s2", login: "hubot", githubUserId: 222 })
    stubGitHub({ liveRole: "admin" })

    const results = await Promise.all([
      requireOrgAccess(request("s1"), env(kv, { db }), undefined, INSTALLATION_ID, { requiredRole: "admin" }),
      requireOrgAccess(request("s2"), env(kv, { db }), undefined, INSTALLATION_ID, { requiredRole: "admin" }),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.response.status === 403)).toHaveLength(1)
    const rows = await db
      .prepare(
        "SELECT github_user_id, role FROM org_workspace_access" +
          " WHERE installation_id = ? AND revoked_at IS NULL ORDER BY github_user_id",
      )
      .bind(INSTALLATION_ID)
      .all<{ github_user_id: string; role: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]?.role).toBe("admin")
    const winner = results.find((result) => result.ok)
    expect(rows.results[0]?.github_user_id).toBe(winner?.ok ? winner.githubUserId : undefined)
  })

  it("fails closed before GitHub or D1 when the session has no stable GitHub user id", async () => {
    const kv = makeKV()
    const db = await makeDb()
    await seedSession(kv)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await requireOrgAccess(request(), env(kv, { db }), undefined, INSTALLATION_ID, {
      requiredRole: "member",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      await expect(result.response.json()).resolves.toEqual({ error: "github_account_required" })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("defaults rollout-off to the exact live GitHub role without requiring D1", async () => {
    const kv = makeKV()
    await seedSession(kv, { githubUserId: 111 })
    stubGitHub({ liveRole: "admin" })

    const result = await requireOrgAccess(request(), env(kv, { mode: null }), undefined, INSTALLATION_ID, {
      requiredRole: "admin",
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.role).toBe("admin")
  })
})
