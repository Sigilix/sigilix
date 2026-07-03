// sig-training-data-consent — retainForTraining: gate no-op + redact-before-store.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { makeR2 } from "@/src/features/training-consent/adapters/r2-fake.test-helpers"
import { retainForTraining } from "@/src/features/training-consent/adapters/retain"
import { upsertConsentRecord } from "@/src/features/training-consent/adapters/consent-store"
import type { TrainingRecord } from "@/src/features/training-consent/domain/types"
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

async function grant(db: D1Database, installationId: number): Promise<void> {
  await upsertConsentRecord(
    { SIGILIX_PLATFORM_DB: db },
    { installationId, consent: "granted", setBy: "admin", source: "portal-admin", planAtGrant: "pro", nowIso: "t" },
  )
}

const secretRecord: TrainingRecord = {
  kind: "chat",
  id: "r1",
  payload: "my key is sk-abcdefghijklmnop1234 and email a@b.com",
}

describe("retainForTraining — the gate short-circuits", () => {
  it("no-ops when the master flag is OFF (nothing stored), even with consent granted", async () => {
    const db = await makeDb()
    await grant(db, 1)
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "off",
    } as unknown as Env
    const wrote = await retainForTraining(env, 1, secretRecord)
    expect(wrote).toBe(false)
    expect(store.size).toBe(0)
  })

  it("no-ops when consent is denied (flag on)", async () => {
    const db = await makeDb()
    await upsertConsentRecord(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 1, consent: "denied", setBy: "admin", source: "portal-admin", planAtGrant: "pro", nowIso: "t" },
    )
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "on",
    } as unknown as Env
    expect(await retainForTraining(env, 1, secretRecord)).toBe(false)
    expect(store.size).toBe(0)
  })
})

describe("retainForTraining — redaction runs BEFORE the store", () => {
  it("stores only a redacted payload when the gate is open", async () => {
    const db = await makeDb()
    await grant(db, 1)
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "on",
    } as unknown as Env

    const wrote = await retainForTraining(env, 1, secretRecord)
    expect(wrote).toBe(true)
    expect(store.size).toBe(1)

    const stored = [...store.values()][0]!
    // The raw secret + email must NOT have reached the store.
    expect(stored).not.toContain("sk-abcdefghijklmnop1234")
    expect(stored).not.toContain("a@b.com")
    expect(stored).toContain("[REDACTED]")
    // And it landed in the caller's own partition.
    expect([...store.keys()][0]!).toMatch(/^installation\/1\//)
  })
})
