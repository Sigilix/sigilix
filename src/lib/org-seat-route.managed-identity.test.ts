import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const INSTALLATION_ID = 1
const ACTOR_ID = "111"
const ACTOR_USER_ID = "managed-seat-actor"
const TARGET_ID = "222"
const SESSION_ID = "managed-seat-session"
const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(29))
const NOW = "2026-07-15T00:00:00.000Z"
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
    "0006_create_user_identity.sql",
    "0007_create_org_seat_assignment.sql",
    "0011_add_tenant_subscription_status.sql",
    "0012_add_tenant_billing_source.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
    "0032_extend_org_seat_billing_operation_activity_identity.sql",
  ]) {
    await db.exec(migration(name))
  }
  await db
    .prepare(
      `INSERT INTO user_identity
        (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES (?, ?, '["github"]', ?, ?)`,
    )
    .bind(ACTOR_USER_ID, ACTOR_ID, NOW, NOW)
    .run()
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, 'acme', 'Organization', ?, ?)",
    )
    .bind(INSTALLATION_ID, NOW, NOW)
    .run()
  return db
}

async function seedAccess(db: D1Database, githubUserId: string, role: "admin" | "member"): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, revoked_at, created_at, updated_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, NULL, ?, ?, 'test-seed', ?, ?)`,
    )
    .bind(
      INSTALLATION_ID,
      githubUserId,
      role,
      NOW,
      NOW,
      `managed-seat-${githubUserId}`,
      role === "admin" ? "bootstrap_admin" : "member_added_or_regranted",
    )
    .run()
}

async function setup(targetAccess = true): Promise<{ db: D1Database; env: Env }> {
  const db = await makeDb()
  const kv = makeKV()
  await createSession({
    kv,
    sessionId: SESSION_ID,
    login: "owner",
    githubUserId: Number(ACTOR_ID),
    userId: ACTOR_USER_ID,
    accessToken: "ghu_actor",
    encryptionKeyB64url: ENC_KEY,
  })
  await kv.put(
    `gh-installation-token:${INSTALLATION_ID}`,
    JSON.stringify({ token: "ghs_roster", expiresAt: Date.now() + 60 * 60 * 1000 }),
  )
  await seedAccess(db, ACTOR_ID, "admin")
  if (targetAccess) await seedAccess(db, TARGET_ID, "member")
  return {
    db,
    env: {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token",
    } as unknown as Env,
  }
}

type RosterPage = Array<{ id: number; login: string }> | { status: number }

function stubGitHub(
  pages: Record<number, RosterPage>,
  account: { type: string; login: string } = { type: "Organization", login: "acme" },
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            installations: [{ id: INSTALLATION_ID, account }],
          }),
          { status: 200 },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify([{ role: "member", state: "active", organization: { login: "acme" } }]), {
          status: 200,
        })
      }
      if (url.startsWith("https://api.github.com/orgs/acme/members?")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1")
        const result = pages[page] ?? []
        return Array.isArray(result)
          ? new Response(JSON.stringify(result), { status: 200 })
          : new Response(JSON.stringify({ message: "roster unavailable" }), { status: result.status })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

function request(memberKey: string, assigned: boolean): Request {
  return new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${encodeURIComponent(memberKey)}/seat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${SESSION_ID}` },
    body: JSON.stringify({ assigned }),
  })
}

async function readManagedSeat(db: D1Database, githubUserId = TARGET_ID) {
  return db
    .prepare(
      "SELECT assigned, last_known_login FROM org_workspace_seat_assignment" +
        " WHERE installation_id = ? AND github_user_id = ?",
    )
    .bind(INSTALLATION_ID, githubUserId)
    .first<{ assigned: number; last_known_login: string | null }>()
}

afterEach(() => vi.unstubAllGlobals())

describe("managed organization seat identity through worker.fetch", () => {
  it("uses the numeric account id and refreshes only its display login", async () => {
    const { db, env } = await setup()
    await db
      .prepare(
        `INSERT INTO org_workspace_seat_assignment
          (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
         VALUES (?, ?, 1, 'old-name', ?, ?, 'seed')`,
      )
      .bind(INSTALLATION_ID, TARGET_ID, NOW, NOW)
      .run()
    stubGitHub({ 1: [{ id: Number(TARGET_ID), login: "new-name" }] })

    const response = await worker.fetch(request(TARGET_ID, false), env, ctx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      installationId: INSTALLATION_ID,
      githubUserId: TARGET_ID,
      login: "new-name",
      assigned: false,
    })
    await expect(readManagedSeat(db)).resolves.toEqual({ assigned: 0, last_known_login: "new-name" })
  })

  it("rejects a roster target without active stored access", async () => {
    const { db, env } = await setup(false)
    stubGitHub({ 1: [{ id: Number(TARGET_ID), login: "no-access" }] })

    const response = await worker.fetch(request(TARGET_ID, true), env, ctx)

    expect(response.status).toBe(404)
    await expect(readManagedSeat(db)).resolves.toBeNull()
  })

  it("rejects a positive immutable-id match from a partial roster before any seat write", async () => {
    const { db, env } = await setup()
    const firstPage = [
      { id: Number(TARGET_ID), login: "partial-match" },
      ...Array.from({ length: 99 }, (_, index) => ({ id: 1000 + index, login: `member-${index}` })),
    ]
    stubGitHub({ 1: firstPage, 2: { status: 503 } })

    const response = await worker.fetch(request(TARGET_ID, true), env, ctx)

    expect(response.status).toBe(503)
    await expect(readManagedSeat(db)).resolves.toBeNull()
  })

  it("uses the exact live account instead of stale tenant metadata", async () => {
    const { db, env } = await setup()
    await db
      .prepare("UPDATE tenant SET account_login = 'stale-org', account_type = 'Organization' WHERE installation_id = ?")
      .bind(INSTALLATION_ID)
      .run()
    stubGitHub({ 1: [{ id: Number(TARGET_ID), login: "current-name" }] })

    const response = await worker.fetch(request(TARGET_ID, true), env, ctx)

    expect(response.status).toBe(200)
    await expect(readManagedSeat(db)).resolves.toEqual({ assigned: 1, last_known_login: "current-name" })
  })

  it("rejects an invalid live account before any seat or billing mutation", async () => {
    const { db, env } = await setup()
    stubGitHub({ 1: [{ id: Number(TARGET_ID), login: "current-name" }] }, { type: "Enterprise", login: "acme" })

    const response = await worker.fetch(request(TARGET_ID, true), env, ctx)

    expect(response.status).toBe(503)
    await expect(readManagedSeat(db)).resolves.toBeNull()
    await expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM org_seat_billing_operation WHERE installation_id = ?")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ n: 0 })
  })

  it("does not let activity-only login evidence mutate a managed seat", async () => {
    const { db, env } = await setup(false)
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (101, ?, 'acme/api', ?)")
      .bind(INSTALLATION_ID, NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO usage_ledger
          (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)
         VALUES (?, 101, 1, 'sha-activity', 1, 10, 'activity-only', ?)`,
      )
      .bind(INSTALLATION_ID, NOW)
      .run()
    stubGitHub({ 1: [] })

    const response = await worker.fetch(request("activity-only", true), env, ctx)

    expect(response.status).toBe(404)
    await expect(readManagedSeat(db)).resolves.toBeNull()
    await expect(
      db
        .prepare("SELECT 1 AS present FROM org_seat_assignment WHERE installation_id = ? AND login = 'activity-only'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toBeNull()
  })

  it("keeps exact-roster login addressing as display-only compatibility", async () => {
    const { db, env } = await setup()
    stubGitHub({ 1: [{ id: Number(TARGET_ID), login: "Current-Name" }] })

    const response = await worker.fetch(request("current-name", true), env, ctx)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      githubUserId: TARGET_ID,
      login: "Current-Name",
      assigned: true,
    })
    await expect(readManagedSeat(db)).resolves.toEqual({ assigned: 1, last_known_login: "Current-Name" })
  })
})
