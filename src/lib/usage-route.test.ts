// SIG-303 full usage metering — GET /v1/usage tests (two-pool contract).
// Mirrors org-overview-route.test.ts's harness: makeD1 + migration SQL, KV session
// seeding, GitHub /user/installations stubbing, api-key D1 seeding. Proves the two
// pools (ORG: pr_reviews+linear_triage+slack; SEAT: coding_agent+chatbot) are
// INDEPENDENT, window-separated, and tenant-isolated. The CORS-preflight test drives
// the real worker entrypoint to prove the path is registered in isPortalCorsPath.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"
import { handleUsageRoute, type UsageResponse } from "@/src/lib/usage-route"
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
const MIGRATION_EVENTS_SQL = readFileSync(
  new URL("../../migrations/0004_create_usage_events.sql", import.meta.url),
  "utf8",
)
const MIGRATION_IDENTITY_SQL = readFileSync(
  new URL("../../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SUBSCRIPTION_STATUS_SQL = readFileSync(
  new URL("../../migrations/0011_add_tenant_subscription_status.sql", import.meta.url),
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
  await db.exec(MIGRATION_EVENTS_SQL)
  await db.exec(MIGRATION_IDENTITY_SQL)
  await db.exec(MIGRATION_SUBSCRIPTION_STATUS_SQL)
  await applyCostMigrations(db)
  const insertIdentity = db.prepare(
    `INSERT INTO user_identity
     (user_id, github_user_id, providers, created_at, last_login_at)
     VALUES (?, ?, '["github"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  )
  for (const githubUserId of [111, 222, 333, 444, 555]) {
    await insertIdentity.bind(`user-${githubUserId}`, String(githubUserId)).run()
  }
  return db
}

async function seedSession(kv: KVNamespace, sessionId: string, login: string, githubUserId: number): Promise<void> {
  await createSession({
    kv,
    sessionId,
    userId: `user-${githubUserId}`,
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

async function insertReview(
  db: D1Database,
  args: {
    installationId: number
    prNumber: number
    authorLogin: string | null
    createdAt: string
    costUsd?: number
  },
) {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at, cost_usd)" +
        " VALUES (?, 100, ?, ?, 1, 100, ?, ?, ?)",
    )
    .bind(
      args.installationId,
      args.prNumber,
      `sha-${args.prNumber}`,
      args.authorLogin,
      args.createdAt,
      args.costUsd ?? 0,
    )
    .run()
}

async function insertEvent(
  db: D1Database,
  args: {
    meter: string
    installationId?: number
    userKey?: string | null
    surface?: string
    eventId?: string | null
    createdAt: string
  },
) {
  await db
    .prepare(
      "INSERT INTO usage_events (meter, installation_id, user_key, surface, event_id, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      args.meter,
      args.installationId ?? 0,
      args.userKey ?? null,
      args.surface ?? "test",
      args.eventId ?? null,
      args.createdAt,
    )
    .run()
}

function reqWithSession(sessionId: string | null, query = ""): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(`https://x/v1/usage${query}`, { headers })
}

function reqWithBearer(token: string, query = ""): Request {
  return new Request(`https://x/v1/usage${query}`, { headers: { authorization: `Bearer ${token}` } })
}

function stubInstallations(installations: Array<{ id: number }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(JSON.stringify({ total_count: installations.length, installations }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

function stubGitHubRole(opts: {
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

/**
 * Like {@link stubGitHubRole} but ALSO answers `GET /users/:login` (used by the
 * admin per-member SEAT drill to resolve a login → github numeric id via
 * resolveGithubAuthors). `users` maps login → id.
 */
function stubGitHubRoleWithUsers(opts: {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships?: Array<{ role: string; state: string; organization: { login: string } }>
  users?: Record<string, number>
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
      const userMatch = url.match(/^https:\/\/api\.github\.com\/users\/([^/?]+)$/)
      if (userMatch) {
        const login = decodeURIComponent(userMatch[1] ?? "")
        const id = opts.users?.[login]
        if (id === undefined) return new Response("{}", { status: 404 })
        return new Response(JSON.stringify({ login, id, avatar_url: `https://avatars/${id}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

async function insertAccountTenant(db: D1Database, githubUserId: number, installationId: number) {
  await db
    .prepare(
      "INSERT INTO account_tenant (github_user_id, installation_id, role, created_at)" +
        " VALUES (?, ?, 'member', '2026-01-01T00:00:00.000Z')",
    )
    .bind(String(githubUserId), installationId)
    .run()
}

const HOUR = 60 * 60 * 1000
// Pin "now" to a Wednesday noon UTC so the FIXED weekly window (resets Mon 09:00
// UTC) is deterministic: the anchor is Mon 2026-07-06T09:00Z, and events at
// now-1h…now-10h all land after it. Only Date is faked (timers stay real so async
// works). A dedicated test steps back before the anchor to prove the boundary.
const NOW = new Date("2026-07-08T12:00:00.000Z") // Wednesday
const MONDAY_ANCHOR = "2026-07-06T09:00:00.000Z"
const NEXT_MONDAY_ANCHOR = "2026-07-13T09:00:00.000Z"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("handleUsageRoute (GET /v1/usage) — SIG-303 two pools", () => {
  it("401 with neither a session nor a bearer api key", async () => {
    const db = await makeDb()
    const env = { OPENCLAW_STATE: makeKV(), SIGILIX_PLATFORM_DB: db } as unknown as Env
    const res = await handleUsageRoute(reqWithSession(null), env)
    expect(res.status).toBe(401)
  })

  it("session path defaults to the SEAT pool: coding_agent + chatbot for the caller", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "shadow",
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "octocat")

    const now = Date.now()
    // SEAT events for this user (gh:111): 2 coding_agent + 1 chatbot in the 5h window,
    // + 1 old coding_agent (weekly only).
    await insertEvent(db, { meter: "coding_agent", userKey: "gh:111", createdAt: new Date(now - HOUR).toISOString() })
    await insertEvent(db, {
      meter: "coding_agent",
      userKey: "gh:111",
      createdAt: new Date(now - 2 * HOUR).toISOString(),
    })
    await insertEvent(db, { meter: "chatbot", userKey: "gh:111", createdAt: new Date(now - HOUR).toISOString() })
    await insertEvent(db, {
      meter: "coding_agent",
      userKey: "gh:111",
      createdAt: new Date(now - 10 * HOUR).toISOString(),
    })

    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const res = await worker.fetch(reqWithSession("sess-1"), env, ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as UsageResponse

    expect(body.scope).toBe("user")
    expect(body.mode).toBe("shadow")
    expect(body.account).toBe("octocat")
    expect(Object.keys(body.meters).sort()).toEqual(["chatbot", "coding_agent"])

    expect(body.meters.coding_agent!.session.used).toBe(2)
    expect(body.meters.coding_agent!.weekly.used).toBe(3) // includes the old one
    expect(body.meters.chatbot!.session.used).toBe(1)
    expect(body.meters.chatbot!.weekly.used).toBe(1)

    // Pool totals = sum across the pool's meters; limit = the shared SEAT cap.
    expect(body.totals.session.used).toBe(3) // 2 coding_agent + 1 chatbot
    expect(body.totals.weekly.used).toBe(4)
    expect(body.totals.session.limit).toBe(40) // DEFAULT_POOL_CAPS.seat.session
    expect(body.totals.weekly.limit).toBe(200) // DEFAULT_POOL_CAPS.seat.weekly (headline)
    expect(body.windows.session.window_label).toBe("5h")
    expect(body.windows.weekly.window_label).toBe("Mon 9:00")

    // sig-cost-based-metering: the cost dimension + burn transparency are present.
    expect(body.cost.session).toHaveProperty("used_usd")
    expect(body.cost.session).toHaveProperty("budget_usd")
    expect(body.cost.session).toHaveProperty("remaining_usd")
    expect(body.cost.session).toHaveProperty("remaining_pct")
    expect(body.cost.weekly).toHaveProperty("budget_usd")
    // Every model is available on every tier — the burn table is transparency, not a gate.
    expect(body.model_burn.map((m) => m.model)).toContain("astraeus")
    expect(body.model_burn.find((m) => m.model === "boreas")?.relative).toBe(1)
    expect(body).toHaveProperty("hint") // null unless the budget is running low
  })

  it("plan reflects the installation's REAL tenant.tier, not the OPENCLAW_PLAN default", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "octocat")
    // A paid tenant — the usage panel header must read "ultra", never a blanket "free".
    await db.prepare("UPDATE tenant SET tier = 'ultra' WHERE installation_id = 1").run()

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.plan).toBe("ultra")
  })

  it("reports the full effective seat budget for an active Pro subscriber", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "enforce",
      SIGILIX_RATE_LIMIT_MODE: "enforce",
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "octocat")
    await db.prepare("UPDATE tenant SET tier = 'pro', subscription_status = 'active' WHERE installation_id = 1").run()

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse

    expect(body.cost.session).toMatchObject({
      budget_usd: 3.75,
      budget_state: "limited",
      budget_applies_to_used: true,
    })
    expect(body.cost.weekly.budget_usd).toBe(15)
    expect(body.enforcement).toEqual({
      usage_pool_mode: "enforce",
      pr_review_mode: "enforce",
      cost_budget_scope: "seat",
      cost_windows: { session: true, weekly: true },
      volume: "full",
    })
  })

  it.each(["trialing", null])("reports the reduced effective seat budget for Pro status %s", async (status) => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "octocat")
    await db
      .prepare("UPDATE tenant SET tier = 'pro', subscription_status = ? WHERE installation_id = 1")
      .bind(status)
      .run()

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse

    expect(body.cost.session.budget_usd).toBe(1.875)
    expect(body.cost.weekly.budget_usd).toBe(7.5)
    expect(body.enforcement.volume).toBe("reduced")
  })

  it("distinguishes an unbounded Enterprise seat from a non-applicable org budget", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "Octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "octocat")
    await db
      .prepare("UPDATE tenant SET tier = 'enterprise', subscription_status = 'active' WHERE installation_id = 1")
      .run()

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse

    expect(body.cost.session).toMatchObject({
      budget_usd: null,
      budget_state: "unbounded",
      budget_applies_to_used: true,
    })
    expect(body.enforcement).toMatchObject({ cost_budget_scope: "seat", volume: "full" })
  })

  it("does not compare an unfiltered org aggregate to one author's budget", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      SIGILIX_RATE_LIMIT_MODE: "enforce",
    } as unknown as Env
    const plaintext = "sigilix_usage_truth_key"
    await insertApiKey(db, {
      id: "key-usage-truth",
      keyHash: await sha256Hex(plaintext),
      installationId: 9,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertTenant(db, 9, "acme")
    await db.prepare("UPDATE tenant SET tier = 'pro', subscription_status = 'active' WHERE installation_id = 9").run()
    const createdAt = new Date(Date.now() - HOUR).toISOString()
    await insertReview(db, { installationId: 9, prNumber: 1, authorLogin: "dev-a", createdAt, costUsd: 0.5 })
    await insertReview(db, { installationId: 9, prNumber: 2, authorLogin: "dev-b", createdAt, costUsd: 0.75 })

    const aggregateRes = await handleUsageRoute(reqWithBearer(plaintext, "?scope=org"), env)
    const aggregate = (await aggregateRes.json()) as UsageResponse
    expect(aggregate.cost.session).toMatchObject({
      used_usd: 1.25,
      budget_usd: null,
      remaining_usd: null,
      pct: null,
      budget_state: "not_applicable",
      budget_applies_to_used: false,
    })
    expect(aggregate.enforcement).toEqual({
      usage_pool_mode: "shadow",
      pr_review_mode: "enforce",
      cost_budget_scope: "author",
      cost_windows: { session: false, weekly: false },
      volume: "full",
    })

    const authorRes = await handleUsageRoute(reqWithBearer(plaintext, "?scope=org&author=dev-a"), env)
    const author = (await authorRes.json()) as UsageResponse
    expect(author.cost.session).toMatchObject({
      used_usd: 0.5,
      budget_usd: 3.75,
      budget_state: "limited",
      budget_applies_to_used: true,
    })
    expect(author.enforcement.cost_windows).toEqual({ session: true, weekly: false })
  })

  it("POOL INDEPENDENCE: org-automation events never move a dev's SEAT counters", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "dev", 222)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 5 }])
    await insertTenant(db, 5, "acme")

    const now = Date.now()
    // ORG-pool activity in this installation: a review, a triage, a slack event.
    await insertReview(db, {
      installationId: 5,
      prNumber: 1,
      authorLogin: "dev",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    await insertEvent(db, { meter: "linear_triage", installationId: 5, createdAt: new Date(now - HOUR).toISOString() })
    await insertEvent(db, {
      meter: "slack",
      installationId: 5,
      userKey: "slack:U1",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    // The dev's OWN seat use.
    await insertEvent(db, { meter: "chatbot", userKey: "gh:222", createdAt: new Date(now - HOUR).toISOString() })

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user")
    // ORG activity must NOT bleed into the seat pool — only the 1 chatbot counts.
    expect(body.totals.session.used).toBe(1)
    expect(body.meters.chatbot!.session.used).toBe(1)
    expect(body.meters.coding_agent!.session.used).toBe(0)
  })

  it("api-key admin ?scope=org: ORG pool = pr_reviews + linear_triage + slack; SEAT use never counts", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    } as unknown as Env
    const plaintext = "sigilix_live_org_key"
    await insertApiKey(db, {
      id: "key-org",
      keyHash: await sha256Hex(plaintext),
      installationId: 9,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertTenant(db, 9, "acme")

    const now = Date.now()
    // ORG activity in installation 9: 2 reviews, 1 triage, 3 slack (5h window).
    await insertReview(db, {
      installationId: 9,
      prNumber: 1,
      authorLogin: "dev-a",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    await insertReview(db, {
      installationId: 9,
      prNumber: 2,
      authorLogin: "dev-b",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    await insertEvent(db, { meter: "linear_triage", installationId: 9, createdAt: new Date(now - HOUR).toISOString() })
    for (const u of ["slack:U1", "slack:U2", "slack:U1"]) {
      await insertEvent(db, {
        meter: "slack",
        installationId: 9,
        userKey: u,
        createdAt: new Date(now - HOUR).toISOString(),
      })
    }
    // A SEAT event (coding_agent) — must NOT count toward the org pool.
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 9,
      userKey: "inst:9",
      createdAt: new Date(now - HOUR).toISOString(),
    })

    const res = await handleUsageRoute(reqWithBearer(plaintext, "?scope=org&installationId=9"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("org")
    expect(Object.keys(body.meters).sort()).toEqual(["linear_triage", "pr_reviews", "slack"])
    expect(body.meters.pr_reviews!.session.used).toBe(2)
    expect(body.meters.linear_triage!.session.used).toBe(1)
    expect(body.meters.slack!.session.used).toBe(3)
    // Pool total = 2 + 1 + 3 = 6; the seat coding_agent event is excluded.
    expect(body.totals.session.used).toBe(6)
    expect(body.totals.session.limit).toBe(20) // DEFAULT_POOL_CAPS.org.session
    expect(body.totals.weekly.limit).toBe(100)
    // The org author breakdown surfaces who triggered slack usage.
    expect(body.authors).toBeDefined()
    const u1 = body.authors!.find((a) => a.user_key === "slack:U1")
    expect(u1?.session).toBe(2)
  })

  it("WINDOW SEPARATION: an event older than 5h counts weekly but not session", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "dev", 333)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertEvent(db, { meter: "coding_agent", userKey: "gh:333", createdAt: new Date(now - HOUR).toISOString() })
    await insertEvent(db, {
      meter: "coding_agent",
      userKey: "gh:333",
      createdAt: new Date(now - 10 * HOUR).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.meters.coding_agent!.session.used).toBe(1)
    expect(body.meters.coding_agent!.weekly.used).toBe(2)
    expect(body.meters.coding_agent!.session.pct).toBe(Math.round((1 / 40) * 100))
  })

  it("SEAT tenant isolation: another dev's coding_agent never counts", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "dev", 444)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertEvent(db, { meter: "coding_agent", userKey: "gh:444", createdAt: new Date(now - HOUR).toISOString() })
    await insertEvent(db, { meter: "coding_agent", userKey: "gh:999", createdAt: new Date(now - HOUR).toISOString() })

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.totals.session.used).toBe(1)
  })

  it("ORG tenant isolation: another installation's slack/triage never counts", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
    } as unknown as Env
    const plaintext = "sigilix_iso_key"
    await insertApiKey(db, {
      id: "key-iso",
      keyHash: await sha256Hex(plaintext),
      installationId: 1,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertEvent(db, {
      meter: "slack",
      installationId: 1,
      userKey: "slack:A",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    await insertEvent(db, {
      meter: "slack",
      installationId: 2,
      userKey: "slack:B",
      createdAt: new Date(now - HOUR).toISOString(),
    })

    const res = await handleUsageRoute(reqWithBearer(plaintext, "?scope=org&installationId=1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("org")
    expect(body.meters.slack!.session.used).toBe(1)
  })

  it("MEMBER session with ?scope=org → falls back to their own SEAT (never the org aggregate)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "quiet-dev", 222)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHubRole({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [],
    })
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertEvent(db, {
      meter: "slack",
      installationId: 1,
      userKey: "slack:boss",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    await insertEvent(db, { meter: "chatbot", userKey: "gh:222", createdAt: new Date(now - HOUR).toISOString() })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=org"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user") // downgraded to self seat
    expect(Object.keys(body.meters).sort()).toEqual(["chatbot", "coding_agent"])
    expect(body.totals.session.used).toBe(1) // only their own chatbot; org slack excluded
  })

  it("P1: a MEMBER of org B who owns a PERSONAL install is DENIED org-B scope (scoped admin check)", async () => {
    // The caller owns a personal install (→ aggregate resolveUserRole would say
    // "admin"), but is only a MEMBER of org B. The scoped isAdminOfInstallation(B)
    // must return false → the request is downgraded to the caller's own seat and
    // org B's aggregate + per-author breakdown are NOT leaked.
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    // Owns personal install id 2; is a plain member (no admin membership) of org B (install id 1).
    stubGitHubRole({
      installations: [
        { id: 2, account: { type: "User", login: "octocat" } },
        { id: 1, account: { type: "Organization", login: "org-b" } },
      ],
      memberships: [{ role: "member", state: "active", organization: { login: "org-b" } }],
    })
    await insertTenant(db, 1, "org-b")
    const now = Date.now()
    // Org B activity that must stay hidden from this non-admin.
    await insertEvent(db, {
      meter: "slack",
      installationId: 1,
      userKey: "slack:boss",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    await insertEvent(db, { meter: "chatbot", userKey: "gh:111", createdAt: new Date(now - HOUR).toISOString() })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=org&installationId=1&author=boss"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user") // DENIED org scope → downgraded to self seat
    expect(Object.keys(body.meters).sort()).toEqual(["chatbot", "coding_agent"])
    expect(body.meters.slack).toBeUndefined() // org meters never returned
    expect(body.authors).toBeUndefined() // per-author breakdown never returned
    expect(body.totals.session.used).toBe(1) // only the caller's own chatbot
  })

  it("ADMIN of the queried org (via active org-admin membership) → org scope granted", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHubRole({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
    })
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    await insertEvent(db, {
      meter: "slack",
      installationId: 1,
      userKey: "slack:U1",
      createdAt: new Date(now - HOUR).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=org"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("org")
    expect(body.meters.slack!.session.used).toBe(1)
  })

  it("FIXED weekly reset: an event before this week's Monday-09:00 anchor is not counted; resets_at = next Monday 09:00", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "dev", 555)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "acme")
    // One event AFTER the Monday anchor (in-window) and one BEFORE it (previous week).
    await insertEvent(db, { meter: "chatbot", userKey: "gh:555", createdAt: "2026-07-07T10:00:00.000Z" }) // Tue, after Mon 9am
    await insertEvent(db, { meter: "chatbot", userKey: "gh:555", createdAt: "2026-07-06T08:59:59.000Z" }) // just before Mon 9am → prior week

    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.meters.chatbot!.weekly.used).toBe(1) // only the post-anchor event counts
    expect(body.windows.weekly.resets_at).toBe(NEXT_MONDAY_ANCHOR)
    expect(body.windows.weekly.window_label).toBe("Mon 9:00")
    expect(body.totals.since_weekly).toBe(MONDAY_ANCHOR)
  })

  it("enforce mode is reflected in the response `mode`", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "dev", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "enforce",
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "acme")
    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.mode).toBe("enforce")
  })

  it("tunable caps: env overrides the default pool caps", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "dev", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_CAP_SEAT_SESSION: "5",
      SIGILIX_USAGE_CAP_SEAT_WEEKLY: "-1", // negative → no cap (usage-only)
    } as unknown as Env
    stubInstallations([{ id: 1 }])
    await insertTenant(db, 1, "acme")
    const res = await handleUsageRoute(reqWithSession("sess-1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.totals.session.limit).toBe(5)
    expect(body.totals.weekly.limit).toBeNull() // no cap → null (no bar fill)
    expect(body.totals.weekly.pct).toBeNull()
  })

  it("SIG-303 admin per-member SEAT drill: ?scope=user&author=<login> returns THAT member's coding_agent + chatbot", async () => {
    const db = await makeDb()
    const kv = makeKV()
    // Admin of org 1 (acme) drilling into member "member-dev" (github id 555).
    await seedSession(kv, "sess-1", "admin-dev", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHubRoleWithUsers({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      users: { "member-dev": 555 },
    })
    await insertTenant(db, 1, "acme")
    await insertAccountTenant(db, 555, 1) // the member is linked to org 1
    const now = Date.now()
    // The member's seat events, attributed to org 1 (developer id + org linkage).
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 1,
      userKey: "gh:555",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 1,
      userKey: "gh:555",
      createdAt: new Date(now - 2 * HOUR).toISOString(),
    })
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 1,
      userKey: "gh:555",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    // TENANT-SAFETY: the SAME member's usage in ANOTHER org (2) must NEVER count.
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 2,
      userKey: "gh:555",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    // The admin's OWN seat activity must NOT bleed into the member drill.
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 1,
      userKey: "gh:111",
      createdAt: new Date(now - HOUR).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=user&author=member-dev&installationId=1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user")
    expect(body.meters.coding_agent!.session.used).toBe(2) // org-1 only; org-2 excluded
    expect(body.meters.chatbot!.session.used).toBe(1)
    expect(body.totals.session.used).toBe(3) // never the admin's own gh:111
  })

  it("SIG-303 member drill is tenant-safe: a login NOT linked to the admin's org returns zeros", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "admin-dev", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubGitHubRoleWithUsers({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      users: { outsider: 777 },
    })
    await insertTenant(db, 1, "acme")
    const now = Date.now()
    // The outsider has seat events, but is NOT linked to org 1 → must read as zero.
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 2,
      userKey: "gh:777",
      createdAt: new Date(now - HOUR).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=user&author=outsider&installationId=1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user")
    expect(body.totals.session.used).toBe(0)
  })

  it("SIG-303 member drill DENIED for a non-admin: ?scope=user&author yields a ZEROED seat (never the caller's own numbers relabeled)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "member-dev", 555)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    // A plain member of org 1 (not admin) tries to drill into another member.
    stubGitHubRoleWithUsers({
      installations: [{ id: 1, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
      users: { "admin-dev": 111 },
    })
    await insertTenant(db, 1, "acme")
    await insertAccountTenant(db, 111, 1)
    const now = Date.now()
    // The target admin's seat usage — must NOT be revealed to the non-admin.
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 1,
      userKey: "gh:111",
      createdAt: new Date(now - HOUR).toISOString(),
    })
    // The caller's OWN seat usage — must NOT be shown mislabeled under the member.
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 1,
      userKey: "gh:555",
      createdAt: new Date(now - HOUR).toISOString(),
    })

    const res = await handleUsageRoute(reqWithSession("sess-1", "?scope=user&author=admin-dev&installationId=1"), env)
    const body = (await res.json()) as UsageResponse
    expect(body.scope).toBe("user")
    // Neither the admin's gh:111 NOR the caller's own gh:555 — a zeroed drill.
    expect(body.meters.chatbot!.session.used).toBe(0)
    expect(body.meters.coding_agent!.session.used).toBe(0)
    expect(body.totals.session.used).toBe(0)
  })

  it("CORS preflight: OPTIONS /v1/usage from an allowlisted portal origin returns the CORS grant", async () => {
    const env = { OPENCLAW_STATE: makeKV() } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const req = new Request("https://x/v1/usage", { method: "OPTIONS", headers: { origin: "https://app.sigilix.ai" } })
    const res = await worker.fetch(req, env, ctx)
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-allow-methods")).toContain("GET")
  })
})
