import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { addOrgWorkspaceMember, bootstrapFirstOrgAdmin, readOrgWorkspaceAccess } from "@/src/features/org-membership"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const INSTALLATION_ID = 42
const ACTOR_ID = 111
const TARGET_ID = "222"
const SESSION_ID = "org-member-e2e"
const SESSION_COOKIE = "__Host-sigilix_session"
const PORTAL_ORIGIN = "https://app.sigilix.ai"
const SEEDED_AT = "2026-07-15T00:00:00.000Z"
const TEST_ROSTER_SNAPSHOT = {
  memberIds: [String(ACTOR_ID), TARGET_ID],
  sqlTokenSet: `|${ACTOR_ID}|${TARGET_ID}|`,
} as const
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(23))
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

async function makeEnv(): Promise<{ env: Env; db: D1Database }> {
  const db = makeD1()
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0003_create_account_tenant_and_api_key.sql"))
  await db.exec(migration("0007_create_org_seat_assignment.sql"))
  await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
  await db.exec(migration("0022_create_org_workspace_access.sql"))
  await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
  await db.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, 'acme', 'Organization', 't', 't')",
    )
    .bind(INSTALLATION_ID)
    .run()

  const kv = makeKV()
  await createSession({
    kv,
    sessionId: SESSION_ID,
    login: "owner",
    githubUserId: ACTOR_ID,
    accessToken: "ghu_actor",
    encryptionKeyB64url: ENC_KEY,
  })
  await kv.put(
    `gh-installation-token:${INSTALLATION_ID}`,
    JSON.stringify({ token: "ghs_roster", expiresAt: Date.now() + 60 * 60 * 1000 }),
  )

  return {
    db,
    env: {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_PORTAL_ORIGIN: PORTAL_ORIGIN,
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token",
    } as unknown as Env,
  }
}

function stubGitHub(
  options: {
    accountLogin?: string
    rosterMembers?: unknown[]
    rosterStatus?: number
  } = {},
): void {
  const accountLogin = options.accountLogin ?? "acme"
  const rosterMembers = options.rosterMembers ?? [
    { id: ACTOR_ID, login: "owner" },
    { id: Number(TARGET_ID), login: "target" },
  ]
  const rosterStatus = options.rosterStatus ?? 200
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account: { type: "Organization", login: accountLogin } }],
          }),
          { status: 200 },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(
          JSON.stringify([{ role: "admin", state: "active", organization: { login: accountLogin } }]),
          { status: 200 },
        )
      }
      if (url.startsWith(`https://api.github.com/orgs/${accountLogin}/members?`)) {
        return new Response(JSON.stringify(rosterStatus === 200 ? rosterMembers : { error: "roster unavailable" }), {
          status: rosterStatus,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

async function seedStoredAccess(db: D1Database, githubUserId: string, role: "admin" | "member"): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, ?, ?, NULL, 'test-seed', ?, ?)`,
    )
    .bind(
      INSTALLATION_ID,
      githubUserId,
      role,
      SEEDED_AT,
      SEEDED_AT,
      `seed-${githubUserId}-${role}`,
      role === "admin" ? "bootstrap_admin" : "member_added_or_regranted",
    )
    .run()
}

async function seedRemovalArtifacts(db: D1Database, githubUserId: string, login: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_seat_assignment
        (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
       VALUES (?, ?, 1, ?, ?, ?, 'test-seed')`,
    )
    .bind(INSTALLATION_ID, githubUserId, login, SEEDED_AT, SEEDED_AT)
    .run()
  await db
    .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(`key-${githubUserId}`, `hash-${githubUserId}`, INSTALLATION_ID, githubUserId, SEEDED_AT)
    .run()
}

afterEach(() => vi.unstubAllGlobals())

describe("organization member mutation end to end", () => {
  it("authenticates, bootstraps the exact admin, proves the roster target, and persists through worker.fetch", async () => {
    const { env, db } = await makeEnv()
    stubGitHub()
    const request = new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
        origin: PORTAL_ORIGIN,
      },
      body: JSON.stringify({ githubUserId: TARGET_ID }),
    })

    const response = await worker.fetch(request, env, ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, String(ACTOR_ID))).resolves.toMatchObject({
      role: "admin",
      revokedAt: null,
    })
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      role: "member",
      revokedAt: null,
      updatedBy: `github:${ACTOR_ID}`,
    })
  })

  it("uses the exact live installation account when stored tenant metadata is stale", async () => {
    const { env, db } = await makeEnv()
    await seedStoredAccess(db, String(ACTOR_ID), "admin")
    await db
      .prepare("UPDATE tenant SET account_login = 'stale-org' WHERE installation_id = ?")
      .bind(INSTALLATION_ID)
      .run()
    stubGitHub({ accountLogin: "live-org" })

    const response = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
          origin: PORTAL_ORIGIN,
        },
        body: JSON.stringify({ githubUserId: TARGET_ID }),
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      role: "member",
      revokedAt: null,
    })
  })

  it("removes a renamed member by immutable identity without crossing installations", async () => {
    const { env, db } = await makeEnv()
    await db
      .prepare(
        "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
          " VALUES (99, 'other', 'Organization', ?, ?)",
      )
      .bind(SEEDED_AT, SEEDED_AT)
      .run()
    await expect(
      bootstrapFirstOrgAdmin(db, {
        installationId: INSTALLATION_ID,
        githubUserId: String(ACTOR_ID),
        nowIso: SEEDED_AT,
        updatedBy: `github:${ACTOR_ID}`,
        rosterSnapshot: TEST_ROSTER_SNAPSHOT,
      }),
    ).resolves.toBe("bootstrapped")
    await addOrgWorkspaceMember(db, {
      installationId: INSTALLATION_ID,
      githubUserId: TARGET_ID,
      nowIso: SEEDED_AT,
      updatedBy: `github:${ACTOR_ID}`,
    })
    await addOrgWorkspaceMember(db, {
      installationId: 99,
      githubUserId: TARGET_ID,
      nowIso: SEEDED_AT,
      updatedBy: "github:999",
    })
    await db
      .prepare(
        `INSERT INTO org_workspace_seat_assignment
          (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
         VALUES (?, ?, 1, 'old-name', ?, ?, ?), (99, ?, 1, 'other-name', ?, ?, 'github:999')`,
      )
      .bind(INSTALLATION_ID, TARGET_ID, SEEDED_AT, SEEDED_AT, `github:${ACTOR_ID}`, TARGET_ID, SEEDED_AT, SEEDED_AT)
      .run()
    await db
      .prepare(
        "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (?, 'old-name', 1, 0, ?, ?)",
      )
      .bind(INSTALLATION_ID, SEEDED_AT, `github:${ACTOR_ID}`)
      .run()
    for (const [id, installationId] of [
      ["target-key", INSTALLATION_ID],
      ["foreign-target-key", 99],
    ] as const) {
      await db
        .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, `hash-${id}`, installationId, TARGET_ID, SEEDED_AT)
        .run()
    }
    stubGitHub({ rosterMembers: [{ id: Number(TARGET_ID), login: "new-name" }] })
    const request = new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
        origin: PORTAL_ORIGIN,
      },
    })

    const response = await worker.fetch(request, env, ctx)

    expect(response.status).toBe(200)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      revokedAt: expect.any(String),
    })
    await expect(db.prepare("SELECT revoked_at FROM api_key WHERE id = 'target-key'").first()).resolves.toEqual({
      revoked_at: expect.any(String),
    })
    await expect(db.prepare("SELECT revoked_at FROM api_key WHERE id = 'foreign-target-key'").first()).resolves.toEqual(
      { revoked_at: null },
    )
    await expect(
      db
        .prepare("SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = ? AND github_user_id = ?")
        .bind(INSTALLATION_ID, TARGET_ID)
        .first(),
    ).resolves.toEqual({ assigned: 0 })
    await expect(
      db
        .prepare("SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 99 AND github_user_id = ?")
        .bind(TARGET_ID)
        .first(),
    ).resolves.toEqual({ assigned: 1 })
  })

  it("refuses to remove the last reachable admin and leaves access, keys, and seats untouched", async () => {
    const { env, db } = await makeEnv()
    await seedStoredAccess(db, String(ACTOR_ID), "admin")
    await seedStoredAccess(db, TARGET_ID, "admin")
    await seedRemovalArtifacts(db, String(ACTOR_ID), "owner")
    stubGitHub({ rosterMembers: [{ id: ACTOR_ID, login: "owner" }] })

    const response = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${ACTOR_ID}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
          origin: PORTAL_ORIGIN,
        },
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(409)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, String(ACTOR_ID))).resolves.toMatchObject({
      role: "admin",
      revokedAt: null,
    })
    await expect(db.prepare(`SELECT revoked_at FROM api_key WHERE id = 'key-${ACTOR_ID}'`).first()).resolves.toEqual({
      revoked_at: null,
    })
    await expect(
      db
        .prepare("SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = ? AND github_user_id = ?")
        .bind(INSTALLATION_ID, String(ACTOR_ID))
        .first(),
    ).resolves.toEqual({ assigned: 1 })
  })

  it("fails a DELETE closed on an incomplete App roster without mutating the member", async () => {
    const { env, db } = await makeEnv()
    await seedStoredAccess(db, String(ACTOR_ID), "admin")
    await seedStoredAccess(db, TARGET_ID, "member")
    await seedRemovalArtifacts(db, TARGET_ID, "target")
    stubGitHub({ rosterStatus: 500 })

    const response = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
          origin: PORTAL_ORIGIN,
        },
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(503)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      role: "member",
      revokedAt: null,
    })
    await expect(db.prepare(`SELECT revoked_at FROM api_key WHERE id = 'key-${TARGET_ID}'`).first()).resolves.toEqual({
      revoked_at: null,
    })
    await expect(
      db
        .prepare("SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = ? AND github_user_id = ?")
        .bind(INSTALLATION_ID, TARGET_ID)
        .first(),
    ).resolves.toEqual({ assigned: 1 })
  })

  it("fails a PATCH closed on an incomplete App roster without changing the stored role", async () => {
    const { env, db } = await makeEnv()
    await seedStoredAccess(db, String(ACTOR_ID), "admin")
    await seedStoredAccess(db, TARGET_ID, "member")
    stubGitHub({ rosterStatus: 500 })

    const response = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
          origin: PORTAL_ORIGIN,
        },
        body: JSON.stringify({ role: "admin" }),
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(503)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      role: "member",
      revokedAt: null,
    })
  })

  it("fails a PATCH closed on a malformed 200 App roster without changing the stored role", async () => {
    const { env, db } = await makeEnv()
    await seedStoredAccess(db, String(ACTOR_ID), "admin")
    await seedStoredAccess(db, TARGET_ID, "member")
    stubGitHub({
      rosterMembers: [
        { id: ACTOR_ID, login: "owner" },
        { id: Number(TARGET_ID), login: "target" },
        { login: "missing-immutable-id" },
      ],
    })

    const response = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
          origin: PORTAL_ORIGIN,
        },
        body: JSON.stringify({ role: "admin" }),
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "org_roster_unavailable" })
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      role: "member",
      revokedAt: null,
    })
  })

  it("removes a departed stored member absent from a complete App roster", async () => {
    const { env, db } = await makeEnv()
    await seedStoredAccess(db, String(ACTOR_ID), "admin")
    await seedStoredAccess(db, TARGET_ID, "member")
    await seedRemovalArtifacts(db, TARGET_ID, "old-target")
    stubGitHub({ rosterMembers: [{ id: ACTOR_ID, login: "owner" }] })

    const response = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${SESSION_ID}`,
          origin: PORTAL_ORIGIN,
        },
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(200)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      revokedAt: expect.any(String),
    })
    await expect(db.prepare(`SELECT revoked_at FROM api_key WHERE id = 'key-${TARGET_ID}'`).first()).resolves.toEqual({
      revoked_at: expect.any(String),
    })
    await expect(
      db
        .prepare("SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = ? AND github_user_id = ?")
        .bind(INSTALLATION_ID, TARGET_ID)
        .first(),
    ).resolves.toEqual({ assigned: 0 })
  })

  it("serializes concurrent reachable-admin demotions through worker.fetch and retains one admin", async () => {
    const { env, db } = await makeEnv()
    await seedStoredAccess(db, String(ACTOR_ID), "admin")
    await seedStoredAccess(db, TARGET_ID, "admin")
    const secondSessionId = "org-member-e2e-second-admin"
    await createSession({
      kv: env.OPENCLAW_STATE!,
      sessionId: secondSessionId,
      login: "target",
      githubUserId: Number(TARGET_ID),
      accessToken: "ghu_second_admin",
      encryptionKeyB64url: ENC_KEY,
    })
    stubGitHub()

    const demote = (sessionId: string, githubUserId: string) =>
      worker.fetch(
        new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${githubUserId}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: `${SESSION_COOKIE}=${sessionId}`,
            origin: PORTAL_ORIGIN,
          },
          body: JSON.stringify({ role: "member" }),
        }),
        env,
        ctx,
      )

    const responses = await Promise.all([demote(SESSION_ID, String(ACTOR_ID)), demote(secondSessionId, TARGET_ID)])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const activeAdmins = await db
      .prepare(
        "SELECT github_user_id FROM org_workspace_access" +
          " WHERE installation_id = ? AND role = 'admin' AND revoked_at IS NULL",
      )
      .bind(INSTALLATION_ID)
      .all<{ github_user_id: string }>()
    expect(activeAdmins.results).toHaveLength(1)
    expect([String(ACTOR_ID), TARGET_ID]).toContain(activeAdmins.results[0]?.github_user_id)
  })
})
