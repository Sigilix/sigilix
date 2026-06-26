// SIG-343 PR C Task 2 + Task 8 — d1-tenant-store unit tests.
//
// Schema is owned by the migration; no ensureSchema here.
// The shim's exec() applies the migration SQL before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { upsertTenantAndRepo, readTenantConfig } from "@/src/features/tenancy/adapters/d1-tenant-store"
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

describe("upsertTenantAndRepo", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("creates a tenant row and a repo row on first call", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 1,
      repoId: 100,
      fullName: "acme/widgets",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const tenant = await db
      .prepare("SELECT installation_id, concurrency_cap FROM tenant WHERE installation_id = ?")
      .bind(1)
      .first<{ installation_id: number; concurrency_cap: number | null }>()
    expect(tenant?.installation_id).toBe(1)
    expect(tenant?.concurrency_cap).toBeNull() // nullable — no schema DEFAULT

    const repo = await db
      .prepare("SELECT full_name, updated_at FROM repo WHERE repo_id = ?")
      .bind(100)
      .first<{ full_name: string; updated_at: string }>()
    expect(repo?.full_name).toBe("acme/widgets")
    expect(repo?.updated_at).toBe("2026-01-01T00:00:00Z")
  })

  it("re-upsert refreshes repo.full_name + updated_at but preserves operator-tuned concurrency_cap", async () => {
    // First call
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 1,
      repoId: 100,
      fullName: "acme/old-name",
      nowIso: "2026-01-01T00:00:00Z",
    })

    // Operator tunes the cap
    await db.prepare("UPDATE tenant SET concurrency_cap = ? WHERE installation_id = ?").bind(5, 1).run()

    // Second call with a different name
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 1,
      repoId: 100,
      fullName: "acme/new-name",
      nowIso: "2026-06-01T00:00:00Z",
    })

    // COALESCE upsert must have left concurrency_cap alone (untouched by DO UPDATE)
    const tenant = await db
      .prepare("SELECT concurrency_cap FROM tenant WHERE installation_id = ?")
      .bind(1)
      .first<{ concurrency_cap: number }>()
    expect(tenant?.concurrency_cap).toBe(5)

    // ON CONFLICT DO UPDATE must have refreshed repo fields
    const repo = await db
      .prepare("SELECT full_name, updated_at FROM repo WHERE repo_id = ?")
      .bind(100)
      .first<{ full_name: string; updated_at: string }>()
    expect(repo?.full_name).toBe("acme/new-name")
    expect(repo?.updated_at).toBe("2026-06-01T00:00:00Z")
  })

  it("binding absent — resolves without throwing and inserts nothing", async () => {
    await expect(
      upsertTenantAndRepo(makeAbsentEnv(), {
        installationId: 1,
        repoId: 100,
        fullName: "acme/widgets",
        nowIso: "2026-01-01T00:00:00Z",
      }),
    ).resolves.toBeUndefined()

    // Nothing was written to the real db
    const count = await db.prepare("SELECT COUNT(*) AS n FROM tenant").first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it("thrown query — no-op, never throws (fail-open)", async () => {
    await expect(
      upsertTenantAndRepo(
        { SIGILIX_PLATFORM_DB: makeBrokenDb() },
        {
          installationId: 1,
          repoId: 100,
          fullName: "acme/widgets",
          nowIso: "2026-01-01T00:00:00Z",
        },
      ),
    ).resolves.toBeUndefined()
  })

  it("first insert stores account_login and account_type", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 10,
      repoId: 1000,
      fullName: "acme/repo",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "acme-org",
      accountType: "Organization",
    })

    const tenant = await db
      .prepare("SELECT account_login, account_type FROM tenant WHERE installation_id = ?")
      .bind(10)
      .first<{ account_login: string; account_type: string }>()
    expect(tenant?.account_login).toBe("acme-org")
    expect(tenant?.account_type).toBe("Organization")
  })

  it("re-upsert with changed accountLogin updates account_login but preserves operator-set concurrency_cap", async () => {
    // First insert
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 11,
      repoId: 1100,
      fullName: "beta/repo",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "beta-old",
      accountType: "Organization",
    })

    // Operator tunes the cap
    await db.prepare("UPDATE tenant SET concurrency_cap = ? WHERE installation_id = ?").bind(7, 11).run()

    // Re-upsert with a renamed account login
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 11,
      repoId: 1100,
      fullName: "beta/repo",
      nowIso: "2026-06-01T00:00:00Z",
      accountLogin: "beta-new",
      accountType: "Organization",
    })

    const tenant = await db
      .prepare("SELECT account_login, concurrency_cap FROM tenant WHERE installation_id = ?")
      .bind(11)
      .first<{ account_login: string; concurrency_cap: number }>()
    // COALESCE upsert refreshes the login
    expect(tenant?.account_login).toBe("beta-new")
    // operator-tuned cap is preserved
    expect(tenant?.concurrency_cap).toBe(7)
  })

  it("re-upsert with undefined accountLogin does NOT overwrite stored login (COALESCE)", async () => {
    // First insert with a known login
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 12,
      repoId: 1200,
      fullName: "gamma/repo",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "gamma-org",
      accountType: "Organization",
    })

    // Re-upsert without accountLogin (e.g. from a stale-head requeue that omits it)
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 12,
      repoId: 1200,
      fullName: "gamma/repo",
      nowIso: "2026-06-01T00:00:00Z",
    })

    const tenant = await db
      .prepare("SELECT account_login FROM tenant WHERE installation_id = ?")
      .bind(12)
      .first<{ account_login: string }>()
    // COALESCE(NULL, existing) must preserve the existing login
    expect(tenant?.account_login).toBe("gamma-org")
  })
})

describe("readTenantConfig", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("returns {cap, dailyBudget} for a tenant with both fields set", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 3,
      repoId: 300,
      fullName: "acme/api",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await db
      .prepare("UPDATE tenant SET concurrency_cap = ?, daily_budget = ? WHERE installation_id = ?")
      .bind(8, 1000, 3)
      .run()

    const cfg = await readTenantConfig(makeEnv(db), 3)
    expect(cfg).toEqual({ cap: 8, dailyBudget: 1000 })
  })

  it("returns {cap: null, dailyBudget: null} for a freshly-registered tenant (columns are NULL)", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 4,
      repoId: 400,
      fullName: "acme/fresh",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const cfg = await readTenantConfig(makeEnv(db), 4)
    expect(cfg).toEqual({ cap: null, dailyBudget: null })
  })

  it("returns null for an unknown (missing) tenant", async () => {
    const cfg = await readTenantConfig(makeEnv(db), 99999)
    expect(cfg).toBeNull()
  })

  it("binding absent — returns null without throwing", async () => {
    await expect(readTenantConfig(makeAbsentEnv(), 1)).resolves.toBeNull()
  })

  it("thrown query — returns null without throwing (fail-open)", async () => {
    await expect(readTenantConfig({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, 1)).resolves.toBeNull()
  })
})
