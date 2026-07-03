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
  await db.exec(MIGRATION_SEAT_SQL)
  return db
}

async function seedSession(kv: KVNamespace, sessionId: string, login: string, githubUserId: number): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

async function insertTenant(db: D1Database, installationId: number, accountLogin: string | null = null) {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, created_at, updated_at)" +
        " VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')" +
        " ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login",
    )
    .bind(installationId, accountLogin)
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
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
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
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

function baseEnv(kv: KVNamespace, db: D1Database): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    SIGILIX_PLATFORM_DB: db,
  } as unknown as Env
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

  it("target must be a member: unknown login → 404", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = baseEnv(kv, db)
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api")
    // No activity for "ghost" → not a member.

    const res = await handleOrgSeatRoute(seatReq("sess-1", 1, "ghost", { assigned: true }), env, undefined, 1, "ghost")
    expect(res.status).toBe(404)
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

  it("end-to-end via the worker entrypoint: the POST route is registered and CORS-wrapped", async () => {
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
