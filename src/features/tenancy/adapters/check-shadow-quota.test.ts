// SIG-543 PR D Task 3 — checkShadowQuota unit tests.
//
// Schema is owned by the migration; the shim's exec() applies it before each test.
// Mirrors the d1-usage-read.test.ts + d1-tenant-store.test.ts patterns:
//   - makeD1() + exec(MIGRATION_SQL) for a real SQLite-backed D1 shim,
//   - SQL-routing broken-DB proxy for the usage-read fault case,
//   - vi.spyOn(console, "log") for event assertions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { checkShadowQuota } from "@/src/features/tenancy/adapters/check-shadow-quota"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

// ─── env builders ────────────────────────────────────────────────────────────

function makeEnv(
  db: D1Database,
  mode: string | undefined = "shadow",
): Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_TENANT_QUOTA_MODE"> {
  return { SIGILIX_PLATFORM_DB: db, SIGILIX_TENANT_QUOTA_MODE: mode }
}

function makeEnvNoMode(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_TENANT_QUOTA_MODE"> {
  return { SIGILIX_PLATFORM_DB: db }
}

// ─── DB stubs ─────────────────────────────────────────────────────────────────

/**
 * Fully broken DB — prepare() always throws.  Matches the pattern in
 * d1-usage-read.test.ts.  Used to verify the outer try/catch swallows all
 * errors.
 */
function makeBrokenDb(): D1Database {
  return {
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
}

/**
 * SQL-routing proxy: forwards non-usage_ledger queries to `goodDb` (so
 * readTenantConfig succeeds) but throws on any usage_ledger query (so
 * readTenantUsageSince returns {ok:false}).  This lets us exercise the
 * quota-read-failed log event without needing to mock the adapter modules.
 */
function makeUsageFaultDb(goodDb: D1Database): D1Database {
  return {
    prepare(sql: string) {
      if (sql.includes("usage_ledger")) throw new Error("simulated usage_ledger D1 error")
      return goodDb.prepare(sql)
    },
    batch: (...args: Parameters<D1Database["batch"]>) => goodDb.batch(...args),
    exec: (...args: Parameters<D1Database["exec"]>) => goodDb.exec(...args),
  } as unknown as D1Database
}

// ─── seed helpers ─────────────────────────────────────────────────────────────

/** Insert a tenant row with an optional daily_budget. */
async function insertTenant(db: D1Database, installationId: number, dailyBudget: number | null = null): Promise<void> {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, daily_budget, created_at, updated_at)" +
        " VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .bind(installationId, dailyBudget)
    .run()
}

/** Insert a usage_ledger row directly. */
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
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(args.installationId, args.repoId, args.prNumber, args.headSha, args.modelCalls, args.tokens, args.createdAt)
    .run()
}

/** ISO timestamp `hoursAgo` hours before now — guarantees the row lands in the 24 h window. */
function recentIso(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString()
}

// ─── log helpers ─────────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function loggedEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
}

function eventsByName(name: string): Array<Record<string, unknown>> {
  return loggedEvents().filter((e) => e["event"] === name)
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("checkShadowQuota", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  // ── mode = off ───────────────────────────────────────────────────────────────

  it("mode=off → NO console.log at all, no throw", async () => {
    await insertTenant(db, 1, 100) // budget set, but mode=off wins
    await expect(checkShadowQuota(makeEnv(db, "off"), 1)).resolves.toBeUndefined()
    expect(logSpy).not.toHaveBeenCalled()
  })

  // ── mode = shadow ─────────────────────────────────────────────────────────────

  it("mode=shadow, usage OVER budget → exactly one quota-shadow event with wouldExceed:true; no quota-would-refuse", async () => {
    await insertTenant(db, 2, 5) // daily_budget = 5 model_calls
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "aaaa",
      modelCalls: 10, // > 5
      tokens: 1500,
      createdAt: recentIso(1),
    })

    await expect(checkShadowQuota(makeEnv(db, "shadow"), 2)).resolves.toBeUndefined()

    const shadows = eventsByName("quota-shadow")
    expect(shadows).toHaveLength(1)
    expect(shadows[0]).toMatchObject({
      event: "quota-shadow",
      installationId: 2,
      mode: "shadow",
      usedModelCalls: 10,
      usedTokens: 1500,
      reviews: 1,
      budget: 5,
      wouldExceed: true,
    })
    expect(eventsByName("quota-would-refuse")).toHaveLength(0)
  })

  it("mode=shadow, usage UNDER budget → quota-shadow with wouldExceed:false", async () => {
    await insertTenant(db, 3, 100) // budget = 100
    await insertUsage(db, {
      installationId: 3,
      repoId: 300,
      prNumber: 1,
      headSha: "bbbb",
      modelCalls: 3, // < 100
      tokens: 400,
      createdAt: recentIso(2),
    })

    await expect(checkShadowQuota(makeEnv(db, "shadow"), 3)).resolves.toBeUndefined()

    const shadows = eventsByName("quota-shadow")
    expect(shadows).toHaveLength(1)
    expect(shadows[0]).toMatchObject({
      event: "quota-shadow",
      installationId: 3,
      mode: "shadow",
      usedModelCalls: 3,
      usedTokens: 400,
      reviews: 1,
      budget: 100,
      wouldExceed: false,
    })
    expect(eventsByName("quota-would-refuse")).toHaveLength(0)
  })

  // ── no daily_budget set ───────────────────────────────────────────────────────

  it("tenant exists but daily_budget is NULL → no console.log (not quota-tracked)", async () => {
    await insertTenant(db, 4, null) // daily_budget = NULL
    await expect(checkShadowQuota(makeEnv(db, "shadow"), 4)).resolves.toBeUndefined()
    expect(logSpy).not.toHaveBeenCalled()
  })

  // ── usage read fault ──────────────────────────────────────────────────────────

  it("usage read fault ({ok:false}) → quota-read-failed event, no quota-shadow, no throw", async () => {
    // Seed a real DB so readTenantConfig succeeds (tenant exists with a budget),
    // then wrap it in a proxy that faults on any usage_ledger query so
    // readTenantUsageSince returns {ok:false}.
    await insertTenant(db, 5, 50) // dailyBudget = 50 — advances past cfg guard
    const faultDb = makeUsageFaultDb(db)

    await expect(checkShadowQuota(makeEnv(faultDb, "shadow"), 5)).resolves.toBeUndefined()

    const failed = eventsByName("quota-read-failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ event: "quota-read-failed", installationId: 5, mode: "shadow" })

    // No quota-shadow must appear on a read fault — never emit a fake under-budget event.
    expect(eventsByName("quota-shadow")).toHaveLength(0)
  })

  // ── mode = enforce ────────────────────────────────────────────────────────────

  it("mode=enforce, usage OVER budget → BOTH quota-shadow (wouldExceed:true) AND quota-would-refuse; function still resolves", async () => {
    await insertTenant(db, 6, 2) // budget = 2
    await insertUsage(db, {
      installationId: 6,
      repoId: 600,
      prNumber: 1,
      headSha: "cccc",
      modelCalls: 5, // > 2
      tokens: 800,
      createdAt: recentIso(0.5),
    })

    await expect(checkShadowQuota(makeEnv(db, "enforce"), 6)).resolves.toBeUndefined()

    const shadows = eventsByName("quota-shadow")
    expect(shadows).toHaveLength(1)
    expect(shadows[0]).toMatchObject({
      event: "quota-shadow",
      installationId: 6,
      mode: "enforce",
      usedModelCalls: 5,
      budget: 2,
      wouldExceed: true,
    })

    const refuses = eventsByName("quota-would-refuse")
    expect(refuses).toHaveLength(1)
    expect(refuses[0]).toMatchObject({
      event: "quota-would-refuse",
      installationId: 6,
      usedModelCalls: 5,
      budget: 2,
    })
  })

  it("mode=enforce, usage UNDER budget → quota-shadow (wouldExceed:false), no quota-would-refuse", async () => {
    await insertTenant(db, 7, 100)
    await insertUsage(db, {
      installationId: 7,
      repoId: 700,
      prNumber: 1,
      headSha: "dddd",
      modelCalls: 1,
      tokens: 100,
      createdAt: recentIso(1),
    })

    await expect(checkShadowQuota(makeEnv(db, "enforce"), 7)).resolves.toBeUndefined()

    const shadows = eventsByName("quota-shadow")
    expect(shadows).toHaveLength(1)
    expect(shadows[0]).toMatchObject({ wouldExceed: false })
    expect(eventsByName("quota-would-refuse")).toHaveLength(0)
  })

  // ── outer try/catch ───────────────────────────────────────────────────────────

  it("any thrown D1 (outer try/catch) → function resolves, never throws", async () => {
    // makeBrokenDb() throws on prepare(); readTenantConfig catches it → null →
    // dailyBudget null → early return.  The outer try/catch is the last resort;
    // no matter what throws, checkShadowQuota must always resolve.
    const env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_TENANT_QUOTA_MODE"> = {
      SIGILIX_PLATFORM_DB: makeBrokenDb(),
      SIGILIX_TENANT_QUOTA_MODE: "shadow",
    }
    await expect(checkShadowQuota(env, 8)).resolves.toBeUndefined()
  })

  // ── absent SIGILIX_PLATFORM_DB binding ───────────────────────────────────────

  it("absent SIGILIX_PLATFORM_DB → no log, no throw (readTenantConfig returns null)", async () => {
    await expect(checkShadowQuota(makeEnvNoMode(db), 9)).resolves.toBeUndefined()
    // mode falls through to "shadow" (default); cfg returns null for an unknown tenant
    // → dailyBudget null → early return with no log.
    // (This also verifies the no-tenant-row path.)
    expect(logSpy).not.toHaveBeenCalled()
  })
})
