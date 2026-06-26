// SIG-543 PR D Task 5 — GET /metrics/tenant-usage route tests.
//
// Uses the d1-sqlite-shim + 0001 migration (same pattern as d1-usage-read.test.ts)
// so reads exercise the real SQL against an in-memory SQLite.

import { describe, expect, it, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleTenantUsageMetricsRoute } from "@/src/lib/metrics-tenant-usage-route"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

const TOKEN = "metrics-token"

function makeEnv(db?: D1Database, overrides: { [K in keyof Env]?: Env[K] | undefined } = {}): Env {
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    ...(db !== undefined ? { SIGILIX_PLATFORM_DB: db } : {}),
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) => new Request(url, auth ? { headers: { authorization: auth } } : undefined)

const authed = (url: string) => get(url, `Bearer ${TOKEN}`)

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function insertTenant(
  db: D1Database,
  installationId: number,
  accountLogin: string | null,
  accountType: string | null,
) {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .bind(installationId, accountLogin, accountType)
    .run()
}

async function insertUsage(
  db: D1Database,
  args: {
    installationId: number
    repoId: number
    prNumber: number
    headSha: string
    modelCalls: number
    tokens: number
    createdAt: string
  },
) {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(args.installationId, args.repoId, args.prNumber, args.headSha, args.modelCalls, args.tokens, args.createdAt)
    .run()
}

// ---------------------------------------------------------------------------
// Auth / env guard tests
// ---------------------------------------------------------------------------

describe("handleTenantUsageMetricsRoute — auth / env", () => {
  it("503 when OPENCLAW_VALIDATION_METRICS_TOKEN is unset", async () => {
    const env = makeEnv(undefined, { OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage"), env)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("metrics_endpoint_not_configured")
  })

  it("401 when bearer token is missing", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(get("https://x/metrics/tenant-usage"), env)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("unauthorized")
  })

  it("401 when bearer token is wrong", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(get("https://x/metrics/tenant-usage", "Bearer wrong-token"), env)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// installationId param validation
// ---------------------------------------------------------------------------

describe("handleTenantUsageMetricsRoute — installationId param", () => {
  it("400 when installationId=0 (must be positive)", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage?installationId=0"), env)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("invalid_installation_id")
  })

  it("400 when installationId is negative", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage?installationId=-5"), env)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_installation_id")
  })

  it("400 when installationId is non-numeric", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage?installationId=abc"), env)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_installation_id")
  })

  it("400 on Number()-coercible-but-not-strict-digit installationId (1e3, 0x10)", async () => {
    const env = makeEnv()
    for (const bad of ["1e3", "0x10", " 5 "]) {
      const res = await handleTenantUsageMetricsRoute(
        authed(`https://x/metrics/tenant-usage?installationId=${encodeURIComponent(bad)}`),
        env,
      )
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_installation_id")
    }
  })
})

// ---------------------------------------------------------------------------
// Window param clamping
// ---------------------------------------------------------------------------

describe("handleTenantUsageMetricsRoute — window param clamping", () => {
  it("defaults to 30 days when window is absent", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { window_days: number }
    expect(body.window_days).toBe(30)
  })

  it("clamps to MAX_WINDOW_DAYS (90) when ?window= exceeds the maximum", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage?window=999"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { window_days: number }
    expect(body.window_days).toBe(90)
  })

  it("falls back to default (30) when ?window= is non-numeric / invalid", async () => {
    const env = makeEnv()
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage?window=abc"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { window_days: number }
    expect(body.window_days).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// Data / rollup tests (D1-backed)
// ---------------------------------------------------------------------------

describe("handleTenantUsageMetricsRoute — data / rollup", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("200 with all tenants and correct per-tenant sums in-window", async () => {
    await insertTenant(db, 1, "acme-org", "Organization")
    await insertTenant(db, 2, "beta-user", "User")

    // Tenant 1: two reviews in-window
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "a1",
      modelCalls: 3,
      tokens: 500,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "a2",
      modelCalls: 5,
      tokens: 800,
      createdAt: "2026-06-15T00:00:00.000Z",
    })

    // Tenant 2: one review in-window
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "b1",
      modelCalls: 2,
      tokens: 300,
      createdAt: "2026-06-10T00:00:00.000Z",
    })

    const env = makeEnv(db)
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage?window=90"), env)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      window_days: number
      tenants: Array<{
        installationId: number
        modelCalls: number
        tokens: number
        reviews: number
        accountLogin: string | null
        accountType: string | null
      }>
    }
    expect(body.window_days).toBe(90)
    expect(body.tenants).toHaveLength(2)

    const t1 = body.tenants.find((t) => t.installationId === 1)!
    expect(t1).toMatchObject({
      installationId: 1,
      modelCalls: 8,
      tokens: 1300,
      reviews: 2,
      accountLogin: "acme-org",
      accountType: "Organization",
    })

    const t2 = body.tenants.find((t) => t.installationId === 2)!
    expect(t2).toMatchObject({
      installationId: 2,
      modelCalls: 2,
      tokens: 300,
      reviews: 1,
      accountLogin: "beta-user",
      accountType: "User",
    })
  })

  it("?installationId=<n> narrows to only that tenant's row", async () => {
    await insertTenant(db, 1, "acme-org", "Organization")
    await insertTenant(db, 2, "beta-user", "User")

    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "a1",
      modelCalls: 3,
      tokens: 500,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "b1",
      modelCalls: 2,
      tokens: 300,
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const env = makeEnv(db)
    const res = await handleTenantUsageMetricsRoute(
      authed("https://x/metrics/tenant-usage?window=90&installationId=1"),
      env,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as { tenants: Array<{ installationId: number }> }
    expect(body.tenants).toHaveLength(1)
    expect(body.tenants[0]!.installationId).toBe(1)
  })

  it("200 with tenants:[] when SIGILIX_PLATFORM_DB is absent (binding absent = legitimately empty, not a fault)", async () => {
    // No db passed → binding absent → readUsageRollupSince returns {ok:true, tenants:[]}
    const env = makeEnv(undefined)
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tenants: unknown[] }
    expect(body.tenants).toEqual([])
  })

  it("503 usage_read_unavailable when D1 throws (fault is distinguishable from genuine-empty)", async () => {
    // Broken DB → readUsageRollupSince returns {ok:false} → route must NOT return 200
    const brokenDb: D1Database = {
      prepare() {
        throw new Error("simulated D1 error")
      },
      batch() {
        return Promise.reject(new Error("simulated D1 error"))
      },
      exec() {
        return Promise.reject(new Error("simulated D1 error"))
      },
    } as unknown as D1Database

    const env = makeEnv(brokenDb)
    const res = await handleTenantUsageMetricsRoute(authed("https://x/metrics/tenant-usage"), env)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("usage_read_unavailable")
  })
})
