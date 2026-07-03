// sig-training-data-consent — the gate: fail-closed + isolation proofs.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { mayRetainForTraining, resolveConsent } from "@/src/features/training-consent/adapters/gate"
import { upsertConsentRecord } from "@/src/features/training-consent/adapters/consent-store"
import type { Env } from "@/src/shared/types/env"

const TENANT_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const CONSENT_SQL = readFileSync(
  new URL("../../../../migrations/0008_create_data_learning_consent.sql", import.meta.url),
  "utf8",
)

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(TENANT_SQL)
  await db.exec(CONSENT_SQL)
  return db
}

async function seedTenant(db: D1Database, installationId: number, tier: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(installationId, tier, now, now)
    .run()
}

function envWith(db: D1Database, mode: string | undefined): Env {
  return { SIGILIX_PLATFORM_DB: db, SIGILIX_TRAINING_RETENTION_MODE: mode } as unknown as Env
}

describe("mayRetainForTraining — master flag is a hard gate", () => {
  it("FALSE when the flag is off, even with explicit consent granted", async () => {
    const db = await makeDb()
    await upsertConsentRecord(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 1,
        consent: "granted",
        setBy: "admin",
        source: "portal-admin",
        planAtGrant: "pro",
        nowIso: "t",
      },
    )
    expect(await mayRetainForTraining(envWith(db, "off"), 1)).toBe(false)
    expect(await mayRetainForTraining(envWith(db, undefined), 1)).toBe(false)
    // Only the exact string "on" enables it.
    expect(await mayRetainForTraining(envWith(db, "ON"), 1)).toBe(false)
    expect(await mayRetainForTraining(envWith(db, "true"), 1)).toBe(false)
  })

  it("TRUE only when flag on AND consent granted", async () => {
    const db = await makeDb()
    await upsertConsentRecord(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 1,
        consent: "granted",
        setBy: "admin",
        source: "portal-admin",
        planAtGrant: "pro",
        nowIso: "t",
      },
    )
    expect(await mayRetainForTraining(envWith(db, "on"), 1)).toBe(true)
  })

  it("FALSE when flag on but consent explicitly denied", async () => {
    const db = await makeDb()
    await upsertConsentRecord(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 1, consent: "denied", setBy: "admin", source: "portal-admin", planAtGrant: "pro", nowIso: "t" },
    )
    expect(await mayRetainForTraining(envWith(db, "on"), 1)).toBe(false)
  })
})

describe("resolveConsent — explicit row wins, else fail-closed plan default", () => {
  it("uses the plan default when there is no explicit row", async () => {
    const db = await makeDb()
    await seedTenant(db, 10, "pro") // personal paid → opt-out
    await seedTenant(db, 11, "team") // team → opt-in
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, 10)).toBe("granted")
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, 11)).toBe("denied")
  })

  it("fail-closed: an unknown org (no tenant row, no consent row) → denied", async () => {
    const db = await makeDb()
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, 999)).toBe("denied")
  })

  it("fail-closed: a missing platform DB binding → denied", async () => {
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: undefined } as unknown as Env, 1)).toBe("denied")
  })

  it("fail-closed: invalid installation id → denied", async () => {
    const db = await makeDb()
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, 0)).toBe("denied")
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, -5)).toBe("denied")
  })
})

describe("isolation — one org's consent never resolves another's", () => {
  it("reading org B returns B's decision, never A's", async () => {
    const db = await makeDb()
    // A granted, B denied.
    await upsertConsentRecord(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 100, consent: "granted", setBy: "a", source: "portal-admin", planAtGrant: "pro", nowIso: "t" },
    )
    await upsertConsentRecord(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 200, consent: "denied", setBy: "b", source: "portal-admin", planAtGrant: "team", nowIso: "t" },
    )
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, 100)).toBe("granted")
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, 200)).toBe("denied")
    // A third org with no row at all is unaffected by either → fail-closed denied.
    expect(await resolveConsent({ SIGILIX_PLATFORM_DB: db }, 300)).toBe("denied")
  })
})
