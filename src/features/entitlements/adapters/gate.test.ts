// sig-free-tier-entitlements — the gate: mode semantics, fail-closed, isolation.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { resolveEntitlement } from "@/src/features/entitlements/adapters/gate"
import type { Env } from "@/src/shared/types/env"

const TENANT_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(TENANT_SQL)
  return db
}

async function seedTenant(db: D1Database, installationId: number, tier: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(installationId, tier, now, now)
    .run()
}

function envWith(db: D1Database | undefined, mode: string | undefined): Env {
  return { SIGILIX_PLATFORM_DB: db, OPENCLAW_ENTITLEMENTS_MODE: mode } as unknown as Env
}

describe("resolveEntitlement — mode off is a strict no-op", () => {
  it("never reads D1 and never blocks, even for a free tenant", async () => {
    // No DB binding at all — proves off does not touch D1.
    const dec = await resolveEntitlement(envWith(undefined, "off"), { installationId: 1, feature: "ci_triage" })
    expect(dec.blocked).toBe(false)
    expect(dec.wouldBlock).toBe(false)
    expect(dec.mode).toBe("off")
  })
  it("off is also the default for an unset flag", async () => {
    const dec = await resolveEntitlement(envWith(undefined, undefined), { installationId: 1, feature: "slack" })
    expect(dec.blocked).toBe(false)
    expect(dec.wouldBlock).toBe(false)
  })
})

describe("resolveEntitlement — enforce gates un-entitled tiers", () => {
  it("allows pro/teams/max/ultra/enterprise for every feature", async () => {
    const db = await makeDb()
    await seedTenant(db, 10, "pro")
    await seedTenant(db, 11, "max")
    await seedTenant(db, 12, "ultra")
    await seedTenant(db, 13, "teams")
    // enterprise is the CONTRACT top tier — a manually-set enterprise tenant is FULLY
    // entitled (it must not fail closed).
    await seedTenant(db, 14, "enterprise")
    for (const id of [10, 11, 12, 13, 14]) {
      for (const feature of ["ci_triage", "slack", "linear", "cli_byok"] as const) {
        const dec = await resolveEntitlement(envWith(db, "enforce"), { installationId: id, feature })
        expect(dec.entitled).toBe(true)
        expect(dec.blocked).toBe(false)
      }
    }
  })

  it("blocks free/individual/team and any unknown tier", async () => {
    const db = await makeDb()
    await seedTenant(db, 20, "free")
    await seedTenant(db, 21, "individual")
    await seedTenant(db, 22, "team")
    await seedTenant(db, 23, "gibberish")
    for (const id of [20, 21, 22, 23]) {
      const dec = await resolveEntitlement(envWith(db, "enforce"), { installationId: id, feature: "slack" })
      expect(dec.entitled).toBe(false)
      expect(dec.blocked).toBe(true)
    }
  })

  it("blocks an absent tenant row (unknown plan) — fail-closed", async () => {
    const db = await makeDb()
    const dec = await resolveEntitlement(envWith(db, "enforce"), { installationId: 999, feature: "linear" })
    expect(dec.plan).toBeNull()
    expect(dec.blocked).toBe(true)
  })

  it("blocks when the platform DB binding is absent — fail-closed", async () => {
    const dec = await resolveEntitlement(envWith(undefined, "enforce"), { installationId: 1, feature: "ci_triage" })
    expect(dec.entitled).toBe(false)
    expect(dec.blocked).toBe(true)
  })
})

describe("resolveEntitlement — shadow logs but never blocks", () => {
  it("un-entitled tenant → wouldBlock, not blocked", async () => {
    const db = await makeDb()
    await seedTenant(db, 30, "free")
    const dec = await resolveEntitlement(envWith(db, "shadow"), { installationId: 30, feature: "slack" })
    expect(dec.entitled).toBe(false)
    expect(dec.blocked).toBe(false)
    expect(dec.wouldBlock).toBe(true)
  })
  it("entitled tenant → neither blocked nor wouldBlock", async () => {
    const db = await makeDb()
    await seedTenant(db, 31, "pro")
    const dec = await resolveEntitlement(envWith(db, "shadow"), { installationId: 31, feature: "slack" })
    expect(dec.blocked).toBe(false)
    expect(dec.wouldBlock).toBe(false)
  })
})

describe("resolveEntitlement — tenant isolation", () => {
  it("reads only the row for the installation it was handed", async () => {
    const db = await makeDb()
    await seedTenant(db, 40, "pro") // entitled neighbor
    await seedTenant(db, 41, "free") // un-entitled subject
    const entitledDec = await resolveEntitlement(envWith(db, "enforce"), { installationId: 40, feature: "linear" })
    const blockedDec = await resolveEntitlement(envWith(db, "enforce"), { installationId: 41, feature: "linear" })
    expect(entitledDec.plan).toBe("pro")
    expect(entitledDec.blocked).toBe(false)
    expect(blockedDec.plan).toBe("free")
    expect(blockedDec.blocked).toBe(true)
  })
})
