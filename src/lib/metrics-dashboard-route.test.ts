// sig-metrics-dashboard — GET /v1/metrics/dashboard tests.
//
// Mirrors org-overview-route.test.ts's harness (makeD1 + migration SQL, KV
// session seeding, GitHub /user/installations stubbing, api-key D1 seeding) and
// borrows metrics-fp-rate-route.test.ts's telemetry + review-memory KV seeding
// shapes for the finding-level (acceptanceRate/severity/category) assertions.
// The CORS-preflight test drives the real worker entrypoint to prove the path
// is registered in index.ts's isPortalCorsPath.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleMetricsDashboardRoute, type MetricsDashboardResponse } from "@/src/lib/metrics-dashboard-route"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { computeFid } from "@/src/lib/review-memory/marker"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const DAY = 86_400_000

const MIGRATION_USAGE_SQL = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_API_KEY_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
const MIGRATION_USAGE_EVENTS_SQL = readFileSync(
  new URL("../../migrations/0004_create_usage_events.sql", import.meta.url),
  "utf8",
)

/** KV stub: string store + `get(key,"json")` parse + a single-page `list`. */
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
    list: async ({ prefix }: { prefix?: string } = {}) => {
      const keys = [...store.keys()].filter((k) => (prefix ? k.startsWith(prefix) : true)).map((name) => ({ name }))
      return { keys, list_complete: true, cursor: undefined }
    },
  } as unknown as KVNamespace
}

function seedKv(kv: KVNamespace, key: string, obj: unknown): Promise<void> {
  return kv.put(key, JSON.stringify(obj))
}

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_USAGE_SQL)
  await db.exec(MIGRATION_API_KEY_SQL)
  await db.exec(MIGRATION_USAGE_EVENTS_SQL)
  return db
}

/** Append one chatbot usage_events row (SIG-303 metering) for a seat. */
async function insertChatbotEvent(
  db: D1Database,
  args: { userKey: string; installationId?: number; createdAt: string },
) {
  await db
    .prepare(
      "INSERT INTO usage_events (meter, installation_id, user_key, surface, event_id, created_at)" +
        " VALUES ('chatbot', ?, ?, 'portal', NULL, ?)",
    )
    .bind(args.installationId ?? 0, args.userKey, args.createdAt)
    .run()
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
  await insertTenant(db, installationId, null)
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
  return new Request(`https://x/v1/metrics/dashboard${query}`, { headers })
}

function reqWithBearer(token: string, query = ""): Request {
  return new Request(`https://x/v1/metrics/dashboard${query}`, { headers: { authorization: `Bearer ${token}` } })
}

/** Stub GET /user/installations (the ONLY GitHub call this route makes). */
function stubInstallations(ids: number[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(JSON.stringify({ total_count: ids.length, installations: ids.map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleMetricsDashboardRoute (GET /v1/metrics/dashboard)", () => {
  it("401 with neither a session nor a bearer api key", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env
    const res = await handleMetricsDashboardRoute(reqWithSession(null), env)
    expect(res.status).toBe(401)
  })

  it("400 on an unsupported window", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1])
    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=45d"), env)
    expect(res.status).toBe(400)
  })

  it("window filtering: rows outside the window are excluded", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1])
    await insertRepo(db, 100, 1, "octocat/api")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "s1",
      authorLogin: "octocat",
      createdAt: iso(2 * DAY),
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "s2",
      authorLogin: "octocat",
      createdAt: iso(60 * DAY),
    })

    const res30 = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=30d"), env)
    const b30 = (await res30.json()) as MetricsDashboardResponse
    expect(b30.window).toBe("30d")
    expect(b30.mergedPrs.total).toBe(1) // only the 2-day-old PR

    const res90 = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=90d"), env)
    const b90 = (await res90.json()) as MetricsDashboardResponse
    expect(b90.mergedPrs.total).toBe(2) // both PRs
  })

  it("tenant isolation: another installation's repos/users/PRs never appear", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1]) // owns installation 1 only
    await insertRepo(db, 100, 1, "octocat/api")
    await insertRepo(db, 200, 2, "other-org/secret")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "s1",
      authorLogin: "octocat",
      createdAt: iso(1 * DAY),
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "s2",
      authorLogin: "secret-agent",
      createdAt: iso(1 * DAY),
    })

    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=30d"), env)
    const b = (await res.json()) as MetricsDashboardResponse
    expect(b.activeRepos).toBe(1)
    expect(b.activeUsers.assigned).toBe(1)
    expect(b.facets.repos.map((r) => r.name)).toEqual(["octocat/api"])
    expect(b.facets.users.map((u) => u.login)).toEqual(["octocat"])
    expect(b.facets.users.some((u) => u.login === "secret-agent")).toBe(false)
  })

  it("null for fields with no instrumented source (medianTime/pipelineFailures); teams facet is empty", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1])
    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1"), env)
    const b = (await res.json()) as MetricsDashboardResponse
    // chatUsage is instrumented (usage_events, meter='chatbot'): with no events
    // for this seat it is a real 0, never null — null is reserved for a fault.
    expect(b.chatUsage).toEqual({ runs: 0, prevRuns: 0 })
    expect(b.medianTime).toBeNull()
    expect(b.toolFindings).toBeNull()
    expect(b.pipelineFailures).toBeNull()
    expect(b.facets.teams).toEqual([])
  })

  it("chatUsage: counts the caller's OWN chatbot seat events, with a previous-window delta", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1])

    // The caller's seat is gh:111 (githubUserId). Two runs in the last 30d, one
    // in the preceding 30d window (30–60d ago), and one 90d ago (outside both).
    await insertChatbotEvent(db, { userKey: "gh:111", createdAt: iso(2 * DAY) })
    await insertChatbotEvent(db, { userKey: "gh:111", createdAt: iso(10 * DAY) })
    await insertChatbotEvent(db, { userKey: "gh:111", createdAt: iso(45 * DAY) })
    await insertChatbotEvent(db, { userKey: "gh:111", createdAt: iso(90 * DAY) })
    // Another seat's runs must NEVER be counted for this caller (tenant safety).
    await insertChatbotEvent(db, { userKey: "gh:999", createdAt: iso(1 * DAY) })
    // A non-chatbot meter for this seat must not be counted either.
    await db
      .prepare(
        "INSERT INTO usage_events (meter, installation_id, user_key, surface, event_id, created_at)" +
          " VALUES ('coding_agent', 0, 'gh:111', 'cli', NULL, ?)",
      )
      .bind(iso(1 * DAY))
      .run()

    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=30d"), env)
    const b = (await res.json()) as MetricsDashboardResponse
    // 2 in the current 30d window; 1 in the preceding 30d window (the 45d row).
    expect(b.chatUsage).toEqual({ runs: 2, prevRuns: 1 })
  })

  it("toolFindings: banded from the RunnerToolMetrics DO, scoped to owned repos", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    // The caller owns installation 1 / octocat/api; a foreign repo's tool rows
    // must never be summed in (tenant isolation).
    await insertRepo(db, 100, 1, "octocat/api")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "s1",
      authorLogin: "octocat",
      createdAt: iso(1 * DAY),
    })
    const cannedQuery = {
      window: { days: 30, startDay: "", endDay: "" },
      manifestReceipts: 0,
      toolRows: 0,
      tools: [],
      latestByRepo: [
        // owned → counted: semgrep (security → sast) + eslint (logic → linter)
        {
          owner: "octocat",
          repo: "api",
          toolId: "semgrep",
          enabled: true,
          status: "produced",
          runCount: 1,
          resultCount: 3,
          lastSeenAt: iso(1 * DAY),
        },
        {
          owner: "octocat",
          repo: "api",
          toolId: "eslint",
          enabled: true,
          status: "produced",
          runCount: 1,
          resultCount: 5,
          lastSeenAt: iso(1 * DAY),
        },
        // owned, non-catalog but shape-safe id → other
        {
          owner: "octocat",
          repo: "api",
          toolId: "customtool",
          enabled: true,
          status: "produced",
          runCount: 1,
          resultCount: 2,
          lastSeenAt: iso(1 * DAY),
        },
        // owned but NOT produced (disabled) → must be excluded
        {
          owner: "octocat",
          repo: "api",
          toolId: "trivy",
          enabled: false,
          status: "disabled",
          runCount: 0,
          resultCount: 50,
          lastSeenAt: iso(1 * DAY),
        },
        // FOREIGN repo → must be excluded
        {
          owner: "other-org",
          repo: "secret",
          toolId: "semgrep",
          enabled: true,
          status: "produced",
          runCount: 1,
          resultCount: 99,
          lastSeenAt: iso(1 * DAY),
        },
      ],
    }
    const RUNNER_TOOL_METRICS_DO = {
      idFromName: (name: string) => name,
      get: () => ({ query: async () => cannedQuery }),
    }
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
      RUNNER_TOOL_METRICS_DO,
    } as unknown as Env
    stubInstallations([1])
    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=30d"), env)
    const b = (await res.json()) as MetricsDashboardResponse
    // 99 (foreign repo) and 50 (disabled tool) both excluded.
    expect(b.toolFindings).toEqual({ sast: 3, linter: 5, other: 2 })

    // 90d exceeds the DO's own window clamp → the tile stays honestly empty
    // rather than showing a 30d sum under a 90d label.
    const res90 = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=90d"), env)
    const b90 = (await res90.json()) as MetricsDashboardResponse
    expect(b90.toolFindings).toBeNull()
  })

  it("fail-soft on a D1 read error: 200 with zeroed metrics, never a 500", async () => {
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
    stubInstallations([1])
    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const b = (await res.json()) as MetricsDashboardResponse
    expect(b.activeRepos).toBe(0)
    expect(b.mergedPrs.total).toBe(0)
    expect(b.facets.repos).toEqual([])
    expect(b.reviewComments.posted).toBe(0)
  })

  it("acceptanceRate + severity/category math over the KV corpus", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1])
    await insertRepo(db, 100, 1, "octocat/api")

    const now = Date.now()
    const reverseTs = 9_999_999_999_999 - (now - 1 * DAY)
    const f1 = { path: "a.ts", line: 10, headline: "bug1", score: 5 } // critical / logic
    const f2 = { path: "b.ts", line: 20, headline: "bug2", score: 3 } // minor / security
    await seedKv(kv, `ensemble-review-telemetry:${reverseTs}:octocat/api#100`, {
      owner: "octocat",
      repo: "api",
      prNumber: 100,
      synthesizer: {
        verdict: { findings: [f1, f2] },
        provenance: { findings: [{ sourceSpecialists: ["logic"] }, { sourceSpecialists: ["security"] }] },
      },
    })
    const fid1 = await computeFid({ ruleId: null, path: f1.path, line: f1.line, headline: f1.headline })
    await seedKv(kv, "review-memory:octocat/api:cat:logic", {
      schemaVersion: 1,
      category: "logic",
      lastUpdatedTs: new Date(now).toISOString(),
      signals: [
        {
          ts: new Date(now).toISOString(),
          prNumber: 100,
          commentId: 555,
          fid: fid1,
          kind: "dismissed-textual",
          dismissReason: "not-a-bug",
        },
      ],
    })

    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=90d"), env)
    const b = (await res.json()) as MetricsDashboardResponse
    expect(b.reviewComments.posted).toBe(2)
    expect(b.reviewComments.acceptanceRate).toBe(0.5) // 1 of 2 dismissed
    expect(b.reviewerTimeSavedHours).toBeCloseTo((1 * 5) / 60, 6) // 1 accepted * 5min/60

    const crit = b.severity.find((s) => s.key === "critical")!
    expect(crit).toMatchObject({ posted: 1, accepted: 0 })
    const minor = b.severity.find((s) => s.key === "minor")!
    expect(minor).toMatchObject({ posted: 1, accepted: 1 })

    const correctness = b.category.find((c) => c.key === "functionalCorrectness")!
    expect(correctness).toMatchObject({ posted: 1, accepted: 0 })
    const security = b.category.find((c) => c.key === "security")!
    expect(security).toMatchObject({ posted: 1, accepted: 1 })
    // dataIntegrity has no producing specialist — never fabricated.
    expect(b.category.some((c) => c.key === "dataIntegrity")).toBe(false)
  })

  it("filter by repo narrows the aggregation to that repo", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1])
    await insertRepo(db, 100, 1, "octocat/api")
    await insertRepo(db, 101, 1, "octocat/web")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "s1",
      authorLogin: "octocat",
      createdAt: iso(1 * DAY),
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 101,
      prNumber: 1,
      headSha: "s2",
      authorLogin: "octocat",
      createdAt: iso(1 * DAY),
    })

    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=30d&repo=octocat/api"), env)
    const b = (await res.json()) as MetricsDashboardResponse
    expect(b.activeRepos).toBe(1)
    expect(b.mergedPrs.total).toBe(1)
    // Facets still list ALL owned repos (so the UI can change the filter).
    expect(b.facets.repos.map((r) => r.name).sort()).toEqual(["octocat/api", "octocat/web"])
  })

  it("filter by user narrows to that user's activity", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1])
    await insertRepo(db, 100, 1, "octocat/api")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "s1",
      authorLogin: "alice",
      createdAt: iso(1 * DAY),
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "s2",
      authorLogin: "bob",
      createdAt: iso(1 * DAY),
    })

    const res = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=30d&user=alice"), env)
    const b = (await res.json()) as MetricsDashboardResponse
    expect(b.activeUsers.assigned).toBe(1)
    expect(b.mergedPrs.total).toBe(1) // only alice's PR
    // Facets still list both users.
    expect(b.facets.users.map((u) => u.login).sort()).toEqual(["alice", "bob"])
  })

  it("cross-tenant repo/user in a filter is ignored (no leak, narrows to nothing)", async () => {
    const db = await makeDb()
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: db,
    } as unknown as Env
    stubInstallations([1]) // owns installation 1 only
    await insertRepo(db, 100, 1, "octocat/api")
    await insertRepo(db, 200, 2, "other-org/secret")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "s1",
      authorLogin: "octocat",
      createdAt: iso(1 * DAY),
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "s2",
      authorLogin: "secret-agent",
      createdAt: iso(1 * DAY),
    })

    // Filtering for a repo the caller doesn't own → ignored → narrows to none.
    const resRepo = await handleMetricsDashboardRoute(
      reqWithSession("sess-1", "?window=30d&repo=other-org/secret"),
      env,
    )
    const bRepo = (await resRepo.json()) as MetricsDashboardResponse
    expect(bRepo.activeRepos).toBe(0)
    expect(bRepo.mergedPrs.total).toBe(0)

    // Filtering for a user the caller doesn't own → ignored → narrows to none.
    const resUser = await handleMetricsDashboardRoute(reqWithSession("sess-1", "?window=30d&user=secret-agent"), env)
    const bUser = (await resUser.json()) as MetricsDashboardResponse
    expect(bUser.activeUsers.assigned).toBe(0)
    expect(bUser.mergedPrs.total).toBe(0)
    // And the foreign tenant's data never surfaces in facets either.
    expect(bUser.facets.users.some((u) => u.login === "secret-agent")).toBe(false)
    expect(bRepo.facets.repos.some((r) => r.name === "other-org/secret")).toBe(false)
  })

  it("api-key path: scoped to the key's own installation", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SIGILIX_API_KEY: "global-shared",
    } as unknown as Env
    const plaintext = "sigilix_live_metrics"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 1,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await insertRepo(db, 100, 1, "acme/api")
    await insertRepo(db, 200, 2, "other-org/secret")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "s1",
      authorLogin: "dev",
      createdAt: iso(1 * DAY),
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "s2",
      authorLogin: "someone-else",
      createdAt: iso(1 * DAY),
    })

    const res = await handleMetricsDashboardRoute(reqWithBearer(plaintext, "?window=30d"), env)
    expect(res.status).toBe(200)
    const b = (await res.json()) as MetricsDashboardResponse
    expect(b.activeRepos).toBe(1)
    expect(b.facets.repos.map((r) => r.name)).toEqual(["acme/api"])
    expect(b.facets.users.map((u) => u.login)).toEqual(["dev"])
  })

  it("CORS preflight: OPTIONS /v1/metrics/dashboard from an allowlisted origin returns the grant", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const req = new Request("https://x/v1/metrics/dashboard", {
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
