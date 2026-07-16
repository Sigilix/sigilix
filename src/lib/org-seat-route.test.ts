// sig seat management — POST /v1/org/:installationId/members/:login/seat tests.
// Mirrors org-overview-route.test.ts's harness: makeD1 + migration SQL, KV
// session seeding, and GitHub fetch stubbing (installations + org memberships,
// the two calls isAdminOfInstallation makes). The worker-entrypoint cases prove
// the route + CORS path are registered in index.ts.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleOrgSeatRoute, type SeatMutationResponse } from "@/src/lib/org-seat-route"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))

const MIGRATION_USAGE_SQL = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SEAT_SQL = readFileSync(
  new URL("../../migrations/0007_create_org_seat_assignment.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SUBSCRIPTION_STATUS_SQL = readFileSync(
  new URL("../../migrations/0011_add_tenant_subscription_status.sql", import.meta.url),
  "utf8",
)
const MIGRATION_BILLING_SOURCE_SQL = readFileSync(
  new URL("../../migrations/0012_add_tenant_billing_source.sql", import.meta.url),
  "utf8",
)
const MIGRATION_STRIPE_SEATS_SQL = readFileSync(
  new URL("../../migrations/0020_create_stripe_seat_reconciliation.sql", import.meta.url),
  "utf8",
)
const MIGRATION_STRIPE_SEAT_CONTEXT_SQL = readFileSync(
  new URL("../../migrations/0023_add_org_seat_billing_operation_context.sql", import.meta.url),
  "utf8",
)
const migration = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
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
  await db.exec(migration("0006_create_user_identity.sql"))
  await db.exec(MIGRATION_SUBSCRIPTION_STATUS_SQL)
  await db.exec(MIGRATION_BILLING_SOURCE_SQL)
  await db.exec(MIGRATION_SEAT_SQL)
  await db.exec(MIGRATION_STRIPE_SEATS_SQL)
  await db.exec(MIGRATION_STRIPE_SEAT_CONTEXT_SQL)
  await db.exec(migration("0022_create_org_workspace_access.sql"))
  await db.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
  await db.exec(migration("0032_extend_org_seat_billing_operation_activity_identity.sql"))
  await db.exec(
    `INSERT INTO user_identity (user_id, github_user_id, providers, created_at, last_login_at) VALUES
            ('seat-user-111', '111', '["github"]', 't', 't'),
            ('seat-user-222', '222', '["github"]', 't', 't')`,
  )
  return db
}

async function seedOrgAccess(
  db: D1Database,
  args: { installationId: number; githubUserId: string; role: "admin" | "member"; revokedAt?: string | null },
): Promise<void> {
  const nowIso = "2026-07-13T00:00:00.000Z"
  const revokedAt = args.revokedAt ?? null
  await db
    .prepare(
      "INSERT INTO org_workspace_access" +
        " (installation_id, github_user_id, role, created_at, updated_at, revoked_at," +
        " updated_by, last_audit_id, last_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      args.installationId,
      args.githubUserId,
      args.role,
      nowIso,
      nowIso,
      revokedAt,
      "test-seed",
      `seat-test-${args.installationId}-${args.githubUserId}-${revokedAt === null ? "active" : "revoked"}`,
      revokedAt === null ? "bootstrap_admin" : "access_removed",
    )
    .run()
}

async function seedSession(
  kv: KVNamespace,
  sessionId: string,
  login: string,
  githubUserId: number,
  tokens: {
    accessToken?: string
    refreshToken?: string
    accessTokenExpiresAt?: number
    refreshTokenExpiresAt?: number
  } = {},
): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId,
    userId: `seat-user-${githubUserId}`,
    accessToken: tokens.accessToken ?? "ghu_test_token",
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt: tokens.accessTokenExpiresAt } : {}),
    ...(tokens.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } : {}),
    encryptionKeyB64url: ENC_KEY,
  })
}

async function insertTenant(
  db: D1Database,
  installationId: number,
  accountLogin: string | null = null,
  accountType: string | null = null,
) {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')" +
        " ON CONFLICT(installation_id) DO UPDATE SET" +
        " account_login = excluded.account_login, account_type = excluded.account_type",
    )
    .bind(installationId, accountLogin, accountType)
    .run()
}

async function seedStripeSeatCapacity(db: D1Database, installationId: number, quantity: number): Promise<void> {
  await db
    .prepare(
      "UPDATE tenant SET tier = 'pro', subscription_status = 'active', billing_source = 'stripe'" +
        " WHERE installation_id = ?",
    )
    .bind(installationId)
    .run()
  await db
    .prepare(
      `INSERT INTO stripe_seat_subscription
        (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         stripe_price_id, subscription_status, observed_quantity, derived_quantity, revision,
         snapshot_state, last_refreshed_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'price_pro_monthly', 'active', ?, ?, 1, 'ready', 1000, 1000, 1000)`,
    )
    .bind(installationId, `cus_${installationId}`, `sub_${installationId}`, `si_${installationId}`, quantity, quantity)
    .run()
}

async function insertRepo(db: D1Database, repoId: number, installationId: number, fullName: string) {
  await insertTenant(db, installationId)
  await db
    .prepare(
      "INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
    )
    .bind(repoId, installationId, fullName)
    .run()
}

/** Seed one usage_ledger row so `authorLogin` counts as a MEMBER of the installation. */
async function insertMemberActivity(
  db: D1Database,
  args: { installationId: number; repoId: number; prNumber: number; authorLogin: string },
) {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, 1, 100, ?, '2026-06-01T00:00:00.000Z')",
    )
    .bind(args.installationId, args.repoId, args.prNumber, `sha-${args.prNumber}`, args.authorLogin)
    .run()
}

interface SeatRow {
  assigned: number
  is_admin: number
  updated_by: string | null
}

async function readSeatRow(db: D1Database, installationId: number, loginKey: string): Promise<SeatRow | null> {
  return db
    .prepare("SELECT assigned, is_admin, updated_by FROM org_seat_assignment WHERE installation_id = ? AND login = ?")
    .bind(installationId, loginKey)
    .first<SeatRow>()
}

function seatReq(sessionId: string | null, installationId: number | string, login: string, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(`https://x/v1/org/${installationId}/members/${encodeURIComponent(login)}/seat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

/** Stub the two GitHub calls isAdminOfInstallation makes (installations + memberships). */
function stubGitHub(opts: {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships?: Array<{ role: string; state: string; organization: { login: string } }>
  orgMemberPages?: Record<number, Array<{ id: number; login: string; avatar_url?: string }> | { status: number }>
  requiredUserToken?: string
  refresh?: { accessToken: string; refreshToken: string }
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://github.com/login/oauth/access_token" && opts.refresh) {
        return new Response(
          JSON.stringify({
            access_token: opts.refresh.accessToken,
            refresh_token: opts.refresh.refreshToken,
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/installations?")) {
        if (opts.requiredUserToken) {
          const headers = new Headers(init?.headers)
          if (headers.get("authorization") !== `Bearer ${opts.requiredUserToken}`) {
            return new Response(JSON.stringify({ message: "bad credentials" }), { status: 401 })
          }
        }
        return new Response(
          JSON.stringify({ total_count: opts.installations.length, installations: opts.installations }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
        return new Response(JSON.stringify(opts.memberships ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.startsWith("https://api.github.com/orgs/acme/members?")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1")
        const result = opts.orgMemberPages?.[page] ?? []
        if (!Array.isArray(result)) {
          return new Response(JSON.stringify({ message: "roster unavailable" }), { status: result.status })
        }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

function baseEnv(kv: KVNamespace, db?: D1Database): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    ...(db ? { SIGILIX_PLATFORM_DB: db } : {}),
  } as unknown as Env
}

async function enableAppRoster(kv: KVNamespace): Promise<void> {
  await kv.put(
    "gh-installation-token:1",
    JSON.stringify({ token: "ghs_roster", expiresAt: Date.now() + 60 * 60 * 1000 }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleOrgSeatRoute (POST /v1/org/:installationId/members/:login/seat)", () => {
  it("401 without a session", async () => {
    const db = await makeDb()
    const env = baseEnv(makeKV(), db)
    const res = await handleOrgSeatRoute(seatReq(null, 1, "dev", { assigned: true }), env, undefined, 1, "dev")
    expect(res.status).toBe(401)
  })

  it("400 on a malformed body (assigned not a boolean)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    // No fetch needed — body parse fails before auth.
    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "dev", { assigned: "yes" }), env, undefined, 1, "dev")
    expect(res.status).toBe(400)
  })

  it("415s a non-JSON managed request before GitHub access or first-admin bootstrap", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-csrf", "octocat", 111)
    const env = { ...baseEnv(kv, db), OPENCLAW_ORG_MEMBERSHIP_MODE: "on" } as Env
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const request = new Request("https://x/v1/org/1/members/dev/seat", {
      method: "POST",
      headers: { "content-type": "text/plain", cookie: `${SESSION_COOKIE}=sess-csrf` },
      body: JSON.stringify({ assigned: true }),
    })

    const res = await handleOrgSeatRoute(request, env, undefined, 1, "dev")

    expect(res.status).toBe(415)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(db.prepare("SELECT COUNT(*) AS n FROM org_workspace_access").first<{ n: number }>()).resolves.toEqual({
      n: 0,
    })
  })

  it("admin assigns a member's seat → 200 + persisted assigned=1", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "dev" })

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "dev", { assigned: true }), env, undefined, 1, "dev")
    expect(res.status).toBe(200)
    const body = (await res.json()) as SeatMutationResponse
    expect(body).toMatchObject({ installationId: 1, login: "dev", assigned: true })
    expect(typeof body.updatedAt).toBe("string")

    const row = await readSeatRow(db, 1, "dev")
    expect(row?.assigned).toBe(1)
    expect(row?.is_admin).toBe(0) // dev is not the caller → not marked admin
    expect(row?.updated_by).toBe("octocat")
  })

  it("admin unassigns a non-admin member's seat → 200 + persisted assigned=0", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "dev" })

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "dev", { assigned: false }), env, undefined, 1, "dev")
    expect(res.status).toBe(200)
    const body = (await res.json()) as SeatMutationResponse
    expect(body.assigned).toBe(false)

    const row = await readSeatRow(db, 1, "dev")
    expect(row?.assigned).toBe(0)
  })

  it("admin gate: a MEMBER of the installation is denied with 403 (per-installation check)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "quiet-dev", 222)
    const env = baseEnv(kv, db)
    // Org install where the caller is only a MEMBER → not an admin of it.
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })

    await insertRepo(db, 100, 1, "acme/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "other" })

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "other", { assigned: false }), env, undefined, 1, "other")
    expect(res.status).toBe(403)
    // Nothing was written.
    expect(await readSeatRow(db, 1, "other")).toBeNull()
  })

  it("tenant isolation: cannot mutate an installation the caller doesn't own → 403, no cross-tenant write", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    // Caller owns installation 1 only — installation 2 belongs to someone else.
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 200, 2, "other-org/secret")
    await insertMemberActivity(db, { installationId: 2, repoId: 200, prNumber: 1, authorLogin: "secret-agent" })

    const res = await handleOrgSeatRoute(
      seatReq("sess-1", 2, "secret-agent", { assigned: false }),
      env,
      undefined,
      2,
      "secret-agent",
    )
    expect(res.status).toBe(403)
    // No override row was written for the foreign installation.
    expect(await readSeatRow(db, 2, "secret-agent")).toBeNull()
  })

  it("target membership cannot be verified without tenant roster metadata → 503", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api")
    // No activity for "ghost", and this legacy tenant has no roster metadata.

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "ghost", { assigned: true }), env, undefined, 1, "ghost")
    expect(res.status).toBe(503)
  })

  it("admin assigns and unassigns a roster-only member with no activity", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: [{ id: 222, login: "Newbie", avatar_url: "https://avatars.test/newbie" }] },
    })

    const assign = await handleOrgSeatRoute(
      seatReq("sess-1", 1, "newbie", { assigned: true }),
      env,
      undefined,
      1,
      "newbie",
    )

    expect(assign.status).toBe(200)
    expect((await readSeatRow(db, 1, "newbie"))?.assigned).toBe(1)

    const unassign = await handleOrgSeatRoute(
      seatReq("sess-1", 1, "newbie", { assigned: false }),
      env,
      undefined,
      1,
      "newbie",
    )
    expect(unassign.status).toBe(200)
    expect((await readSeatRow(db, 1, "newbie"))?.assigned).toBe(0)
  })

  it("complete App roster miss → 404 and no seat write", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: [{ id: 333, login: "someone-else" }] },
    })

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "ghost", { assigned: true }), env, undefined, 1, "ghost")

    expect(res.status).toBe(404)
    expect(await readSeatRow(db, 1, "ghost")).toBeNull()
  })

  it("partial App roster miss is uncertain → 503", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1000, login: `member-${i}` }))
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: firstPage, 2: { status: 503 } },
    })

    const res = await handleOrgSeatRoute(
      seatReq("sess-1", 1, "newbie", { assigned: true }),
      env,
      undefined,
      1,
      "newbie",
    )

    expect(res.status).toBe(503)
    expect(await readSeatRow(db, 1, "newbie")).toBeNull()
  })

  it("a target returned before a later roster page fails is not enough for a billing write → 503", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1000,
      login: i === 0 ? "newbie" : `member-${i}`,
    }))
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: firstPage, 2: { status: 503 } },
    })

    const res = await handleOrgSeatRoute(
      seatReq("sess-1", 1, "newbie", { assigned: true }),
      env,
      undefined,
      1,
      "newbie",
    )

    expect(res.status).toBe(503)
    expect(await readSeatRow(db, 1, "newbie")).toBeNull()
  })

  it("missing SIGILIX_PLATFORM_DB → 503 rather than a false success or 404", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv)
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "dev", { assigned: true }), env, undefined, 1, "dev")

    expect(res.status).toBe(503)
  })

  it("D1 membership-read failure → 503 rather than 404", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const brokenDb = {
      prepare(sql: string) {
        if (sql === "SELECT user_id, github_user_id FROM user_identity WHERE user_id = ?") {
          return {
            bind: () => ({ first: async () => ({ user_id: "seat-user-111", github_user_id: "111" }) }),
          }
        }
        throw new Error("D1 unavailable")
      },
    } as unknown as D1Database
    const env = baseEnv(kv, brokenDb)
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "dev", { assigned: true }), env, undefined, 1, "dev")

    expect(res.status).toBe(503)
  })

  it("refreshes an expired GitHub user token before the per-installation admin gate", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111, {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: Date.now() - 1_000,
      refreshTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    })
    await insertRepo(db, 100, 1, "octocat/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "dev" })
    const env = {
      ...baseEnv(kv, db),
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    } as Env
    stubGitHub({
      installations: [{ id: 1, account: { type: "User", login: "octocat" } }],
      requiredUserToken: "refreshed-token",
      refresh: { accessToken: "refreshed-token", refreshToken: "rotated-refresh-token" },
    })

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "dev", { assigned: true }), env, undefined, 1, "dev")

    expect(res.status).toBe(200)
    expect((await readSeatRow(db, 1, "dev"))?.assigned).toBe(1)
  })

  it("last-admin guard: an admin cannot unassign the last assigned admin seat → 409", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    // octocat owns the personal install → verified admin; acting on their OWN seat.
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "octocat" })

    const res = await handleOrgSeatRoute(
      seatReq("sess-1", 1, "octocat", { assigned: false }),
      env,
      undefined,
      1,
      "octocat",
    )
    expect(res.status).toBe(409)
    // The self-lockout was refused — no unassign persisted.
    expect(await readSeatRow(db, 1, "octocat")).toBeNull()
  })

  it("last-admin guard allows unassigning an admin when another admin seat remains assigned", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "octocat" })
    // A SECOND known-admin seat, currently assigned — so unassigning the caller
    // is not the last admin seat.
    await db
      .prepare(
        "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (1, 'co-admin', 1, 1, '2026-06-01T00:00:00.000Z', 'octocat')",
      )
      .run()

    const res = await handleOrgSeatRoute(
      seatReq("sess-1", 1, "octocat", { assigned: false }),
      env,
      undefined,
      1,
      "octocat",
    )
    expect(res.status).toBe(200)
    expect((await readSeatRow(db, 1, "octocat"))?.assigned).toBe(0)
  })

  it("last-admin guard protects a STORED admin seat (not just the caller's own) → 409", async () => {
    const db = await makeDb()
    const kv = makeKV()
    // Caller "boss" is a verified org admin but holds no seat row of their own;
    // "co-admin" is the only stored, assigned admin seat.
    await seedSession(kv, "sess-1", "boss", 111)
    const env = baseEnv(kv, db)
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
    })

    await insertRepo(db, 100, 1, "acme/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "co-admin" })
    await db
      .prepare(
        "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (1, 'co-admin', 1, 1, '2026-06-01T00:00:00.000Z', 'boss')",
      )
      .run()

    const res = await handleOrgSeatRoute(
      seatReq("sess-1", 1, "co-admin", { assigned: false }),
      env,
      undefined,
      1,
      "co-admin",
    )
    expect(res.status).toBe(409)
    // Unchanged — the last stored admin seat is still assigned.
    expect((await readSeatRow(db, 1, "co-admin"))?.assigned).toBe(1)
  })

  it("end-to-end via worker.fetch: rollout-off keeps the live GitHub admin path", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "dev" })

    const req = new Request("https://x/v1/org/1/members/dev/seat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=sess-1`,
        origin: "https://app.sigilix.ai",
      },
      body: JSON.stringify({ assigned: false }),
    })
    const res = await worker.fetch(req, env, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect((await readSeatRow(db, 1, "dev"))?.assigned).toBe(0)
  })

  it("end-to-end via worker.fetch: rollout-off uses the exact live account instead of stale tenant metadata", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-live-account", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "stale-org", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: [{ id: 222, login: "newbie" }] },
    })

    const res = await worker.fetch(seatReq("sess-live-account", 1, "newbie", { assigned: true }), env, ctx)

    expect(res.status).toBe(200)
    expect((await readSeatRow(db, 1, "newbie"))?.assigned).toBe(1)
  })

  it("end-to-end via worker.fetch: managed access rejects a revoked stored admin before the seat write", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-revoked", "octocat", 111)
    await seedOrgAccess(db, {
      installationId: 1,
      githubUserId: "111",
      role: "admin",
      revokedAt: "2026-07-13T00:01:00.000Z",
    })
    await insertRepo(db, 100, 1, "octocat/api")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "dev" })
    const env = { ...baseEnv(kv, db), OPENCLAW_ORG_MEMBERSHIP_MODE: "on" } as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    // The caller remains a live GitHub admin. The stored revocation must still
    // be authoritative while managed membership is enabled.
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    const res = await worker.fetch(
      new Request("https://x/v1/org/1/members/dev/seat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=sess-revoked`,
          origin: "https://app.sigilix.ai",
        },
        body: JSON.stringify({ assigned: false }),
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect(await readSeatRow(db, 1, "dev")).toBeNull()
  })

  it("end-to-end via worker.fetch: a roster-only member can be assigned", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: [{ id: 222, login: "newbie" }] },
    })
    const req = new Request("https://x/v1/org/1/members/newbie/seat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=sess-1`,
        origin: "https://app.sigilix.ai",
      },
      body: JSON.stringify({ assigned: true }),
    })

    const res = await worker.fetch(req, env, ctx)

    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect((await readSeatRow(db, 1, "newbie"))?.assigned).toBe(1)
  })

  it("end-to-end via worker.fetch: a complete roster miss 404s without writing", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: [{ id: 333, login: "someone-else" }] },
    })
    const req = new Request("https://x/v1/org/1/members/ghost/seat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=sess-1` },
      body: JSON.stringify({ assigned: true }),
    })

    const res = await worker.fetch(req, env, ctx)

    expect(res.status).toBe(404)
    expect(await readSeatRow(db, 1, "ghost")).toBeNull()
  })

  it("end-to-end via worker.fetch: an incomplete roster miss 503s without writing", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "boss", 111)
    await enableAppRoster(kv)
    await insertTenant(db, 1, "acme", "Organization")
    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
    } as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: {
        1: Array.from({ length: 100 }, (_, i) => ({ id: i + 1000, login: `member-${i}` })),
        2: { status: 503 },
      },
    })
    const req = new Request("https://x/v1/org/1/members/ghost/seat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=sess-1` },
      body: JSON.stringify({ assigned: true }),
    })

    const res = await worker.fetch(req, env, ctx)

    expect(res.status).toBe(503)
    expect(await readSeatRow(db, 1, "ghost")).toBeNull()
  })

  it("end-to-end via worker.fetch: assigning beyond purchased capacity expands the exact Stripe item before the seat commits", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-billing", "boss", 111)
    await enableAppRoster(kv)
    await insertRepo(db, 100, 1, "acme/api")
    await insertTenant(db, 1, "acme", "Organization")
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 1, authorLogin: "dev-one" })
    await insertMemberActivity(db, { installationId: 1, repoId: 100, prNumber: 2, authorLogin: "dev-two" })
    await seedStripeSeatCapacity(db, 1, 2)

    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      orgMemberPages: { 1: [{ id: 222, login: "newbie" }] },
    })
    const githubFetch = vi.mocked(globalThis.fetch)
    const stripePosts: Array<{ path: string; body: URLSearchParams; idempotencyKey: string | null }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.startsWith("https://api.stripe.com/v1/subscription_items?")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "si_1",
                  quantity: 2,
                  price: {
                    id: "price_pro_monthly",
                    lookup_key: null,
                    nickname: null,
                    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
                  },
                },
              ],
              has_more: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url === "https://api.stripe.com/v1/subscription_items/si_1" && init?.method === "POST") {
          const headers = new Headers(init.headers)
          const body = new URLSearchParams(String(init.body))
          stripePosts.push({ path: new URL(url).pathname, body, idempotencyKey: headers.get("idempotency-key") })
          return new Response(JSON.stringify({ id: "si_1", quantity: 3 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return githubFetch(input, init)
      }),
    )

    const env = {
      ...baseEnv(kv, db),
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-avoids-key-use",
      SIGILIX_STRIPE_SECRET_KEY: "sk_test_secret",
      SIGILIX_STRIPE_PRICE_PRO: "price_pro_monthly",
      OPENCLAW_JOBS: { send: vi.fn(async () => undefined) },
    } as unknown as Env
    const waits: Promise<unknown>[] = []
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise)
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext

    const res = await worker.fetch(
      new Request("https://x/v1/org/1/members/newbie/seat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=sess-billing`,
          origin: "https://app.sigilix.ai",
        },
        body: JSON.stringify({ assigned: true }),
      }),
      env,
      ctx,
    )
    await Promise.all(waits)

    expect(res.status).toBe(200)
    expect(stripePosts).toHaveLength(1)
    expect(stripePosts[0]?.path).toBe("/v1/subscription_items/si_1")
    expect(stripePosts[0]?.body.get("quantity")).toBe("3")
    expect(stripePosts[0]?.body.get("proration_behavior")).toBe("create_prorations")
    expect(stripePosts[0]?.idempotencyKey).toMatch(/^sigilix-seat-/)
    expect((await readSeatRow(db, 1, "newbie"))?.assigned).toBe(1)
    await expect(
      db
        .prepare(
          "SELECT observed_quantity, derived_quantity, snapshot_state FROM stripe_seat_subscription" +
            " WHERE installation_id = 1",
        )
        .first(),
    ).resolves.toMatchObject({ observed_quantity: 3, derived_quantity: 3, snapshot_state: "ready" })
    await expect(
      db.prepare("SELECT state, desired_quantity FROM org_seat_billing_operation WHERE installation_id = 1").first(),
    ).resolves.toMatchObject({ state: "committed", desired_quantity: 3 })
  })
  it("CORS preflight: OPTIONS on the seat path from an allowlisted portal origin returns the CORS grant", async () => {
    const env = { OPENCLAW_STATE: makeKV() } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const req = new Request("https://x/v1/org/1/members/dev/seat", {
      method: "OPTIONS",
      headers: { origin: "https://app.sigilix.ai" },
    })
    const res = await worker.fetch(req, env, ctx)
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })
})
