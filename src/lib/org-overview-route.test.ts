// sig-org-overview — GET /v1/org/overview tests.
// Mirrors workspace-prs-route.test.ts's harness: makeD1 + migration SQL, KV
// session seeding, GitHub fetch stubbing (installations + org memberships, the
// two calls resolveUserRole makes), and api-key D1 seeding. The CORS-preflight
// test drives the real worker entrypoint to prove the path is registered in
// index.ts's isPortalCorsPath.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { RosterResult } from "@/src/lib/org-members-roster"

// sig-org-members: the admin branch merges the GitHub roster via
// fetchInstallationRoster. Mock it so these tests drive the merge without a real
// App token; the default is an empty roster (no-op) so the pre-existing
// activity-only assertions below are unaffected.
const rosterMock = vi.fn<(...a: unknown[]) => Promise<RosterResult>>(async () => ({
  members: [],
  source: "none",
}))
vi.mock("@/src/lib/org-members-roster", () => ({
  fetchInstallationRoster: (...a: unknown[]) => rosterMock(...a),
}))

import { handleOrgOverviewRoute, type OrgOverviewResponse } from "@/src/lib/org-overview-route"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
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

/** repo.installation_id FK-references tenant(installation_id) — seed the tenant row first. */
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

async function insertRepo(
  db: D1Database,
  repoId: number,
  installationId: number,
  fullName: string,
  accountLogin: string | null = null,
) {
  await insertTenant(db, installationId, accountLogin)
  await db
    .prepare(
      "INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
    )
    .bind(repoId, installationId, fullName)
    .run()
}

async function insertUsage(
  db: D1Database,
  args: {
    installationId: number
    repoId: number
    prNumber: number
    headSha: string
    authorLogin: string | null
    createdAt: string
  },
) {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, 1, 100, ?, ?)",
    )
    .bind(args.installationId, args.repoId, args.prNumber, args.headSha, args.authorLogin, args.createdAt)
    .run()
}

function reqWithSession(sessionId: string | null, query = ""): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(`https://x/v1/org/overview${query}`, { headers })
}

function reqWithBearer(token: string): Request {
  return new Request("https://x/v1/org/overview", { headers: { authorization: `Bearer ${token}` } })
}

/**
 * Stub the two GitHub calls resolveUserRole + the route make:
 *   GET /user/installations         → { installations: [{ id, account }] }
 *   GET /user/memberships/orgs      → [] (or supplied)
 * `account.type: "User"` + a login matching the session login makes the caller
 * an ADMIN (owns a personal install); "Organization" with no admin membership
 * makes them a MEMBER.
 */
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

afterEach(() => {
  vi.unstubAllGlobals()
  rosterMock.mockReset()
  rosterMock.mockResolvedValue({ members: [], source: "none" })
})

describe("handleOrgOverviewRoute (GET /v1/org/overview)", () => {
  it("401 with neither a session nor a bearer api key", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
    const res = await handleOrgOverviewRoute(reqWithSession(null), env)
    expect(res.status).toBe(401)
  })

  it("admin session: full seat list scoped to the caller's own installation, own seat marked admin", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_PER_SEAT_PRICE: "20",
    } as unknown as Env
    // Personal install owned by the session user → admin.
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api", "octocat")
    // Caller's own reviews (different casing, twice) + another author.
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-1",
      authorLogin: "OCTOCAT",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-2",
      authorLogin: "octocat",
      createdAt: "2026-06-05T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 3,
      headSha: "sha-3",
      authorLogin: "contributor",
      createdAt: "2026-06-03T00:00:00.000Z",
    })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse

    expect(body.role).toBe("admin")
    expect(body.org).toMatchObject({ account: "octocat", installationId: 1, plan: "free" })
    expect(body.billing).toEqual({ model: "per-seat", perSeatMonthly: 20, note: "per-seat monthly (USD)" })
    expect(body.seatCount).toBe(2)

    // Newest-active-first: octocat (last active 06-05) before contributor (06-03).
    expect(body.seats.map((s) => s.login.toLowerCase())).toEqual(["octocat", "contributor"])
    const own = body.seats.find((s) => s.login.toLowerCase() === "octocat")!
    expect(own.role).toBe("admin")
    expect(own.reviews).toBe(2) // both casings summed
    expect(own.lastActiveAt).toBe("2026-06-05T00:00:00.000Z")
    const other = body.seats.find((s) => s.login === "contributor")!
    expect(other.role).toBe("member")
  })

  it("org.plan reflects the installation's REAL tenant.tier (paid org reads its true plan, not 'free')", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })
    await insertTenant(db, 1, "octocat")
    // A paid tenant — the Organization page must read "ultra", never a blanket "free".
    await db.prepare("UPDATE tenant SET tier = 'ultra' WHERE installation_id = 1").run()

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.org.plan).toBe("ultra")
  })

  it("admin session: merges the GitHub roster — active seats keep their state, roster-only members appended unassigned", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api", "octocat")
    // One active author (has usage).
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-1",
      authorLogin: "octocat",
      createdAt: "2026-06-05T00:00:00.000Z",
    })
    // Roster: the active author (with an avatar) + a never-active org member.
    rosterMock.mockResolvedValue({
      members: [
        { login: "Octocat", avatarUrl: "https://avatars/octocat" },
        { login: "newbie", avatarUrl: "https://avatars/newbie" },
      ],
      source: "org",
    })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse

    expect(rosterMock).toHaveBeenCalledWith(env, 1, "octocat", expect.any(String))
    const byLogin = Object.fromEntries(body.seats.map((s) => [s.login.toLowerCase(), s]))
    // Active seat: assigned (derived), avatar picked up from the roster.
    expect(byLogin["octocat"]).toMatchObject({ assigned: true, reviews: 1, avatarUrl: "https://avatars/octocat" })
    // Roster-only member: appended, no activity, default UNASSIGNED.
    expect(byLogin["newbie"]).toMatchObject({
      assigned: false,
      reviews: 0,
      lastActiveAt: "",
      avatarUrl: "https://avatars/newbie",
    })
    expect(body.seatCount).toBe(2)
    expect(body.assignedSeatCount).toBe(1) // only the active seat is billed
  })

  it("admin session: an explicit org_seat_assignment override flips a roster-only member to assigned", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })
    await insertRepo(db, 100, 1, "octocat/api", "octocat")
    // An admin has explicitly ASSIGNED a seat to a never-active member.
    await db
      .prepare(
        "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at)" +
          " VALUES (1, 'newbie', 1, 0, '2026-06-01T00:00:00.000Z')",
      )
      .run()
    rosterMock.mockResolvedValue({ members: [{ login: "newbie", avatarUrl: "" }], source: "org" })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as OrgOverviewResponse
    const newbie = body.seats.find((s) => s.login === "newbie")!
    expect(newbie.assigned).toBe(true) // override wins over the roster-only default
    expect(body.assignedSeatCount).toBe(1)
  })

  it("admin session: a failed roster fetch (empty) still 200s with the activity-derived seats (fail-soft)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "Octocat" } }] })
    await insertRepo(db, 100, 1, "octocat/api", "octocat")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-1",
      authorLogin: "octocat",
      createdAt: "2026-06-05T00:00:00.000Z",
    })
    rosterMock.mockResolvedValue({ members: [], source: "org", reason: "org_members_unavailable" })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.seats.map((s) => s.login)).toEqual(["octocat"]) // unchanged
    expect(body.seatCount).toBe(1)
  })

  it("member session: the GitHub roster is NEVER fetched (no cross-member disclosure)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "quiet-dev", 222)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "pem",
    } as unknown as Env
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })
    await insertRepo(db, 100, 1, "acme/api", "acme")

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    expect(rosterMock).not.toHaveBeenCalled()
  })

  it("member session: limited shape — only the caller's own seat, no other members' data", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "quiet-dev", 222)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    // Org install, caller is NOT an admin of it → member.
    stubGitHub({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })

    await insertRepo(db, 100, 1, "acme/api", "acme")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "quiet-dev",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-b",
      authorLogin: "boss",
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse

    expect(body.role).toBe("member")
    // Real total is exposed, but only the caller's own seat is returned.
    expect(body.seatCount).toBe(2)
    expect(body.seats.map((s) => s.login)).toEqual(["quiet-dev"])
    // No other member's login leaks.
    expect(body.seats.some((s) => s.login === "boss")).toBe(false)
    // Billing is the placeholder only (no per-seat price configured).
    expect(body.billing).toEqual({ model: "per-seat", perSeatMonthly: null, note: "billing at launch" })
    expect(body.nextCursor).toBeUndefined()
  })

  it("cross-installation isolation: seats from another installation never appear", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    // Caller owns installation 1 only.
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api", "octocat")
    await insertRepo(db, 200, 2, "other-org/secret", "other-org")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    // Installation 2's seat — must NEVER surface for an installation-1 caller.
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-secret",
      authorLogin: "secret-agent",
      createdAt: "2026-06-09T00:00:00.000Z",
    })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.org.installationId).toBe(1)
    expect(body.seats.map((s) => s.login)).toEqual(["octocat"])
    expect(body.seats.some((s) => s.login === "secret-agent")).toBe(false)
  })

  it("pagination: cursor + limit page through the seat list, nextCursor while more remain", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "admin-user", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "admin-user" } }] })

    await insertRepo(db, 100, 1, "acme/api", "acme")
    const base = Date.parse("2026-06-01T00:00:00.000Z")
    // 5 distinct seats, each with a distinct (ascending) last-active time.
    for (let i = 0; i < 5; i++) {
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: i,
        headSha: `sha-${i}`,
        authorLogin: `dev-${i}`,
        createdAt: new Date(base + i * 60_000).toISOString(),
      })
    }

    // Page 1: limit 2 → newest two (dev-4, dev-3), nextCursor present.
    const res1 = await handleOrgOverviewRoute(reqWithSession("sess-1", "?limit=2"), env)
    const body1 = (await res1.json()) as OrgOverviewResponse
    expect(body1.seatCount).toBe(5)
    expect(body1.seats.map((s) => s.login)).toEqual(["dev-4", "dev-3"])
    expect(body1.nextCursor).toBeDefined()

    // Page 2: follow the cursor → next two (dev-2, dev-1), still more.
    const res2 = await handleOrgOverviewRoute(
      reqWithSession("sess-1", `?limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`),
      env,
    )
    const body2 = (await res2.json()) as OrgOverviewResponse
    expect(body2.seats.map((s) => s.login)).toEqual(["dev-2", "dev-1"])
    expect(body2.nextCursor).toBeDefined()

    // Page 3: last one (dev-0), no more.
    const res3 = await handleOrgOverviewRoute(
      reqWithSession("sess-1", `?limit=2&cursor=${encodeURIComponent(body2.nextCursor!)}`),
      env,
    )
    const body3 = (await res3.json()) as OrgOverviewResponse
    expect(body3.seats.map((s) => s.login)).toEqual(["dev-0"])
    expect(body3.nextCursor).toBeUndefined()
  })

  it("de-duplication + newest-active-first ordering across authors", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "acme/api", "acme")
    // "alice" appears 3 times (different casing) — collapses to one seat, reviews=3,
    // latest activity 06-10. "bob" once at 06-04.
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-1",
      authorLogin: "alice",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-2",
      authorLogin: "Alice",
      createdAt: "2026-06-10T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 3,
      headSha: "sha-3",
      authorLogin: "ALICE",
      createdAt: "2026-06-05T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 4,
      headSha: "sha-4",
      authorLogin: "bob",
      createdAt: "2026-06-04T00:00:00.000Z",
    })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.seatCount).toBe(2)
    const alice = body.seats.find((s) => s.login.toLowerCase() === "alice")!
    expect(alice.reviews).toBe(3)
    expect(alice.lastActiveAt).toBe("2026-06-10T00:00:00.000Z")
    // alice (06-10) is newest-active → ordered before bob (06-04).
    expect(body.seats.map((s) => s.login.toLowerCase())).toEqual(["alice", "bob"])
  })

  it("api-key path: a per-installation key scopes seats to its own installation (treated as admin)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    } as unknown as Env

    const plaintext = "sigilix_live_org_overview"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 1,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })

    await insertRepo(db, 100, 1, "acme/api", "acme")
    await insertRepo(db, 200, 2, "other-org/secret", "other-org")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-secret",
      authorLogin: "someone-else",
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    const res = await handleOrgOverviewRoute(reqWithBearer(plaintext), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.role).toBe("admin")
    expect(body.org.installationId).toBe(1)
    expect(body.seats.map((s) => s.login)).toEqual(["octocat"])
    // No user identity on the api-key path → no seat is marked admin.
    expect(body.seats.every((s) => s.role === "member")).toBe(true)
  })

  it("fail-soft on a D1 read error: 200 with an empty seat list, never a 500", async () => {
    // Session path (KV-only auth — never touches D1) so the fault under test is
    // isolated to the usage_ledger read, not auth.
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const brokenDb = {
      prepare() {
        throw new Error("simulated D1 error")
      },
    } as unknown as D1Database
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: brokenDb,
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.seats).toEqual([])
    expect(body.seatCount).toBe(0)
  })

  it("?installationId= ownership guard: a requested-but-not-owned installation never becomes the scope", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    // Caller owns installation 1 only — installation 2 belongs to someone else.
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api", "octocat")
    await insertRepo(db, 200, 2, "other-org/secret", "other-org")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-secret",
      authorLogin: "secret-agent",
      createdAt: "2026-06-09T00:00:00.000Z",
    })

    // Ask for installation 2 (not owned) — must fall back to the caller's own
    // installation 1, never scope to (or read the account_login of) 2.
    const res = await handleOrgOverviewRoute(reqWithSession("sess-1", "?installationId=2"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.org.installationId).toBe(1)
    expect(body.org.account).toBe("octocat")
    expect(body.seats.map((s) => s.login)).toEqual(["octocat"])
    expect(body.seats.some((s) => s.login === "secret-agent")).toBe(false)
  })

  it("degraded auth path (decrypt failure) never leaks a foreign installation's account via ?installationId=", async () => {
    const db = await makeDb()
    const kv = makeKV()
    // Session was encrypted under ENC_KEY, but the env is configured with a
    // different key — decryptAccessToken must throw (AES-GCM auth-tag
    // mismatch), driving resolveSessionScope's decrypt-failure branch.
    const WRONG_ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: WRONG_ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env

    // A victim tenant that must never be disclosed through the degraded path.
    await insertTenant(db, 999, "victim-org")

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const res = await handleOrgOverviewRoute(reqWithSession("sess-1", "?installationId=999"), env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as OrgOverviewResponse
      expect(body.role).toBe("member")
      expect(body.org.installationId).toBe(0)
      // Must NOT resolve to the victim's account — a genuinely empty panel.
      expect(body.org.account).toBe("")
      expect(body.seats).toEqual([])
      expect(body.seatCount).toBe(0)
    } finally {
      errSpy.mockRestore()
    }
  })

  it("assigned overrides: an unassigned seat is reflected as assigned=false + drops assignedSeatCount", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHub({ installations: [{ id: 1, account: { type: "User", login: "octocat" } }] })

    await insertRepo(db, 100, 1, "octocat/api", "octocat")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-1",
      authorLogin: "octocat",
      createdAt: "2026-06-05T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-2",
      authorLogin: "contributor",
      createdAt: "2026-06-03T00:00:00.000Z",
    })
    // Persisted unassign override for "contributor" (case-insensitive key).
    await db
      .prepare(
        "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (1, 'contributor', 0, 0, '2026-06-06T00:00:00.000Z', 'octocat')",
      )
      .run()

    const res = await handleOrgOverviewRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as OrgOverviewResponse
    expect(body.seatCount).toBe(2)
    expect(body.assignedSeatCount).toBe(1) // contributor no longer billed
    const contributor = body.seats.find((s) => s.login === "contributor")!
    expect(contributor.assigned).toBe(false)
    const own = body.seats.find((s) => s.login.toLowerCase() === "octocat")!
    expect(own.assigned).toBe(true)
  })

  it("CORS preflight: OPTIONS /v1/org/overview from an allowlisted portal origin returns the CORS grant", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const req = new Request("https://x/v1/org/overview", {
      method: "OPTIONS",
      headers: { origin: "https://app.sigilix.ai" },
    })
    const res = await worker.fetch(req, env, ctx)
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-allow-methods")).toContain("GET")
  })
})
