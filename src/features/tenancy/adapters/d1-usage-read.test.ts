// SIG-543 PR D Task 2 — d1-usage-read unit tests.
//
// Schema is owned by the migration; the shim's exec() applies it before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"
import { readTenantUsageSince, readUsageRollupSince } from "@/src/features/tenancy/adapters/d1-usage-read"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

function makeEnv(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function makeAbsentEnv(): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return {}
}

/** Throws on any operation — simulates a D1 error to verify fail-open behaviour. */
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

/** Insert a tenant row directly (no repo required for usage-read queries). */
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
// readTenantUsageSince
// ---------------------------------------------------------------------------

describe("readTenantUsageSince", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
  })

  it("sums model_calls, tokens and counts reviews within the time window", async () => {
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "aaa",
      modelCalls: 3,
      tokens: 500,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "bbb",
      modelCalls: 5,
      tokens: 800,
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    const result = await readTenantUsageSince(makeEnv(db), 1, "2026-06-01T00:00:00.000Z")
    expect(result).toEqual({ ok: true, modelCalls: 8, tokens: 1300, reviews: 2, costUsd: 0 })
  })

  it("excludes rows with created_at strictly before sinceIso", async () => {
    // Row before the window
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "old",
      modelCalls: 10,
      tokens: 1000,
      createdAt: "2026-05-31T23:59:59.999Z",
    })
    // Row at the boundary (should be included: >= sinceIso)
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "new",
      modelCalls: 2,
      tokens: 200,
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const result = await readTenantUsageSince(makeEnv(db), 1, "2026-06-01T00:00:00.000Z")
    expect(result).toEqual({ ok: true, modelCalls: 2, tokens: 200, reviews: 1, costUsd: 0 })
  })

  it("returns {ok:true, 0,0,0} when genuinely no rows exist for the tenant in the window", async () => {
    const result = await readTenantUsageSince(makeEnv(db), 999, "2026-01-01T00:00:00.000Z")
    expect(result).toEqual({ ok: true, modelCalls: 0, tokens: 0, reviews: 0, costUsd: 0 })
  })

  it("binding absent → {ok: false}", async () => {
    const result = await readTenantUsageSince(makeAbsentEnv(), 1, "2026-01-01T00:00:00.000Z")
    expect(result).toEqual({ ok: false })
  })

  it("thrown D1 → {ok: false}, NOT zeros — caller must distinguish fault from genuine empty", async () => {
    const result = await readTenantUsageSince({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, 1, "2026-01-01T00:00:00.000Z")
    expect(result).toEqual({ ok: false })
    // Explicitly not {ok:true, ...} — this is the sentinel contract
    expect(result).not.toMatchObject({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// readUsageRollupSince
// ---------------------------------------------------------------------------

describe("readUsageRollupSince", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
  })

  it("returns one row per tenant with summed usage and joined account fields", async () => {
    await insertTenant(db, 1, "acme-org", "Organization")
    await insertTenant(db, 2, "beta-user", "User")

    // Tenant 1: two reviews
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
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    // Tenant 2: one review
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "b1",
      modelCalls: 2,
      tokens: 300,
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const result = await readUsageRollupSince(makeEnv(db), "2026-01-01T00:00:00.000Z")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tenants).toHaveLength(2)

    const row1 = result.tenants.find((r) => r.installationId === 1)!
    expect(row1).toMatchObject({
      installationId: 1,
      modelCalls: 8,
      tokens: 1300,
      reviews: 2,
      accountLogin: "acme-org",
      accountType: "Organization",
    })

    const row2 = result.tenants.find((r) => r.installationId === 2)!
    expect(row2).toMatchObject({
      installationId: 2,
      modelCalls: 2,
      tokens: 300,
      reviews: 1,
      accountLogin: "beta-user",
      accountType: "User",
    })
  })

  it("installationId filter narrows result to a single tenant", async () => {
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

    const result = await readUsageRollupSince(makeEnv(db), "2026-01-01T00:00:00.000Z", 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tenants).toHaveLength(1)
    expect(result.tenants[0]!.installationId).toBe(1)
  })

  it("excludes rows older than sinceIso", async () => {
    await insertTenant(db, 1, "acme-org", "Organization")

    // Old row (before window)
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "old",
      modelCalls: 100,
      tokens: 10000,
      createdAt: "2026-05-31T23:59:59.999Z",
    })
    // Row at boundary (included)
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "new",
      modelCalls: 1,
      tokens: 50,
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const result = await readUsageRollupSince(makeEnv(db), "2026-06-01T00:00:00.000Z")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tenants).toHaveLength(1)
    expect(result.tenants[0]).toMatchObject({ installationId: 1, modelCalls: 1, tokens: 50, reviews: 1 })
  })

  it("binding absent → {ok:true, tenants:[]} (dark = legitimately empty, not a fault)", async () => {
    const result = await readUsageRollupSince(makeAbsentEnv(), "2026-01-01T00:00:00.000Z")
    expect(result).toEqual({ ok: true, tenants: [] })
  })

  it("thrown D1 → {ok:false} — distinguishable from genuine-empty", async () => {
    const result = await readUsageRollupSince({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, "2026-01-01T00:00:00.000Z")
    expect(result).toEqual({ ok: false })
    // Must NOT look like success — callers must not treat a D1 fault as "no tenants"
    expect(result).not.toMatchObject({ ok: true })
  })
})
