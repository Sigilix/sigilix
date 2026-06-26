// SIG-343 PR C Task 6 — resolveTenantCap unit tests.
//
// Schema is owned by the migration; the shim's exec() applies it before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { upsertTenantAndRepo } from "@/src/features/tenancy/adapters/d1-tenant-store"
import { resolveTenantCap } from "@/src/features/tenancy/adapters/resolve-tenant-cap"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

function makeEnv(db: D1Database, capStr?: string): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    SIGILIX_TENANT_CONCURRENCY_CAP: capStr,
  } as unknown as Env
}

function makeEnvNoDb(capStr?: string): Env {
  return { SIGILIX_TENANT_CONCURRENCY_CAP: capStr } as unknown as Env
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

describe("resolveTenantCap", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("D1 has operator-set cap → returns that cap", async () => {
    await upsertTenantAndRepo(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 1, repoId: 100, fullName: "acme/core", nowIso: "2026-01-01T00:00:00Z" },
    )
    // Operator tunes to 5
    await db.prepare("UPDATE tenant SET concurrency_cap = ? WHERE installation_id = ?").bind(5, 1).run()

    const cap = await resolveTenantCap(makeEnv(db, "2"), 1)
    expect(cap).toBe(5)
  })

  it("tenant missing → falls back to env cap (SIGILIX_TENANT_CONCURRENCY_CAP)", async () => {
    // No row for installationId 99 — D1 returns null, env cap is 3
    const cap = await resolveTenantCap(makeEnv(db, "3"), 99)
    expect(cap).toBe(3)
  })

  it("D1 binding absent → falls back to env cap", async () => {
    const cap = await resolveTenantCap(makeEnvNoDb("4"), 1)
    expect(cap).toBe(4)
  })

  it("D1 binding absent + env cap unset → falls back to default cap (2)", async () => {
    const cap = await resolveTenantCap(makeEnvNoDb(undefined), 1)
    expect(cap).toBe(2) // resolveFairnessConfig default
  })

  it("D1 throws → fail-open: returns env cap", async () => {
    const env = { SIGILIX_PLATFORM_DB: makeBrokenDb(), SIGILIX_TENANT_CONCURRENCY_CAP: "6" } as unknown as Env
    const cap = await resolveTenantCap(env, 1)
    expect(cap).toBe(6)
  })

  it("freshly-registered tenant (cap=NULL) → falls back to env cap, not hard-coded 2", async () => {
    await upsertTenantAndRepo(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 2, repoId: 200, fullName: "acme/api", nowIso: "2026-01-01T00:00:00Z" },
    )
    // concurrency_cap is NULL after registration; env cap is 10
    const cap = await resolveTenantCap(makeEnv(db, "10"), 2)
    expect(cap).toBe(10) // env cap, because D1 returned null
  })
})
