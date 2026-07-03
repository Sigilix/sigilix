// sig-training-retention-wiring — the shared call-site wrapper: proves the
// flag-first NO-OP (nothing built, no I/O) with the retention flag off, and the
// gate + redact-before-store behaviour when it is on. Because every new capture
// site funnels through these two functions, this suite is the central proof that
// each wiring is inert by default and correct when enabled.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { makeR2 } from "@/src/features/training-consent/adapters/r2-fake.test-helpers"
import { upsertConsentRecord } from "@/src/features/training-consent/adapters/consent-store"
import { upsertTenantAndRepo } from "@/src/features/tenancy"
import { retainTrainingRecord, retainTrainingRecordForRepo } from "@/src/lib/training-retention/retain-training"
import type { TrainingRecord } from "@/src/features/training-consent"
import type { Env } from "@/src/shared/types/env"

const TENANT_SQL = readFileSync(
  new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const CONSENT_SQL = readFileSync(
  new URL("../../../migrations/0008_create_data_learning_consent.sql", import.meta.url),
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

async function deny(db: D1Database, installationId: number): Promise<void> {
  await upsertConsentRecord(
    { SIGILIX_PLATFORM_DB: db },
    { installationId, consent: "denied", setBy: "admin", source: "portal-admin", planAtGrant: "pro", nowIso: "t" },
  )
}

async function seedRepo(db: D1Database, installationId: number, fullName: string): Promise<void> {
  await upsertTenantAndRepo({ SIGILIX_PLATFORM_DB: db }, { installationId, repoId: 555, fullName, nowIso: "t" })
}

const SECRET_RECORD: TrainingRecord = {
  kind: "review-finding",
  id: "r1",
  payload: "leak sk-abcdefghijklmnop1234 and a@b.com here",
  meta: { owner: "octo", repo: "repo" },
}

/** A build closure that fails the test if it is ever invoked — proves the record
 *  is NOT constructed on the flag-off path (lazy no-op). */
function buildMustNotRun(): TrainingRecord {
  throw new Error("record build must not run when the retention flag is off")
}

/** A D1 stub whose every access throws — proves NO tenancy lookup happens on the
 *  flag-off path (retainTrainingRecordForRepo must return before touching D1). */
function explodingDb(): D1Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("D1 must not be touched when the retention flag is off")
      },
    },
  ) as unknown as D1Database
}

describe("retainTrainingRecord — flag-first no-op (known installation)", () => {
  it("flag OFF: returns false, builds nothing, writes nothing", async () => {
    const db = await makeDb()
    await grant(db, 1)
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "off",
    } as unknown as Env
    // buildMustNotRun would throw if invoked — the flag-off short-circuit must
    // return before it (and before any consent/store I/O).
    expect(await retainTrainingRecord(env, 1, buildMustNotRun)).toBe(false)
    expect(store.size).toBe(0)
  })

  it("flag ON + consent granted: stores a REDACTED record in the caller's partition", async () => {
    const db = await makeDb()
    await grant(db, 7)
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "on",
    } as unknown as Env
    expect(await retainTrainingRecord(env, 7, () => SECRET_RECORD)).toBe(true)
    expect(store.size).toBe(1)
    const stored = [...store.values()][0]!
    expect(stored).not.toContain("sk-abcdefghijklmnop1234")
    expect(stored).not.toContain("a@b.com")
    expect(stored).toContain("[REDACTED]")
    expect([...store.keys()][0]!).toMatch(/^installation\/7\//)
  })

  it("flag ON + consent DENIED: writes nothing", async () => {
    const db = await makeDb()
    await deny(db, 3)
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "on",
    } as unknown as Env
    expect(await retainTrainingRecord(env, 3, () => SECRET_RECORD)).toBe(false)
    expect(store.size).toBe(0)
  })
})

describe("retainTrainingRecordForRepo — flag-first no-op (repo coordinates)", () => {
  it("flag OFF: returns false, does NOT touch D1, builds nothing, writes nothing", async () => {
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: explodingDb(),
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "off",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 9 }),
    } as unknown as Env
    // The exploding D1 would throw if a tenancy lookup ran; buildMustNotRun would
    // throw if a record were built. Neither happens ⇒ true flag-off no-op.
    expect(await retainTrainingRecordForRepo(env, "octo", "repo", buildMustNotRun)).toBe(false)
    expect(store.size).toBe(0)
  })

  it("flag ON + consent granted: resolves installation from D1 and stores redacted", async () => {
    const db = await makeDb()
    await seedRepo(db, 42, "octo/repo")
    await grant(db, 42)
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "on",
    } as unknown as Env
    expect(await retainTrainingRecordForRepo(env, "octo", "repo", () => SECRET_RECORD)).toBe(true)
    expect(store.size).toBe(1)
    const stored = [...store.values()][0]!
    expect(stored).not.toContain("sk-abcdefghijklmnop1234")
    expect(stored).toContain("[REDACTED]")
    expect([...store.keys()][0]!).toMatch(/^installation\/42\//)
  })

  it("flag ON + consent DENIED: writes nothing", async () => {
    const db = await makeDb()
    await seedRepo(db, 42, "octo/repo")
    await deny(db, 42)
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "on",
    } as unknown as Env
    expect(await retainTrainingRecordForRepo(env, "octo", "repo", () => SECRET_RECORD)).toBe(false)
    expect(store.size).toBe(0)
  })

  it("flag ON + unresolvable repo: writes nothing (no installation)", async () => {
    const db = await makeDb()
    await grant(db, 42) // consent exists, but the repo has no registry row / map entry
    const { bucket, store } = makeR2()
    const env = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_TRAINING_DATA: bucket,
      SIGILIX_TRAINING_RETENTION_MODE: "on",
    } as unknown as Env
    expect(await retainTrainingRecordForRepo(env, "ghost", "repo", () => SECRET_RECORD)).toBe(false)
    expect(store.size).toBe(0)
  })
})
