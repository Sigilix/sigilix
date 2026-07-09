// sig-github-marketplace-billing — marketplace_subscription D1 store unit tests.
// Schema owned by migration 0013; the shim applies it before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  upsertMarketplaceSubscription,
  readMarketplaceSubscriptionByLogin,
} from "@/src/features/billing/adapters/marketplace-subscription-store"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0013_create_marketplace_subscription.sql", import.meta.url),
  "utf8",
)

function makeEnv(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

describe("marketplace-subscription-store", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("inserts then reads back a subscription by login (case-insensitive)", async () => {
    await upsertMarketplaceSubscription(
      makeEnv(db),
      { accountId: 1, accountLogin: "Acme", tier: "pro", seats: 5, status: "active" },
      "2026-01-01T00:00:00Z",
    )
    const row = await readMarketplaceSubscriptionByLogin(makeEnv(db), "acme")
    expect(row).toEqual({ accountId: 1, accountLogin: "Acme", tier: "pro", seats: 5, status: "active" })
  })

  it("upserts by account_id — a later event overwrites tier/seats/status/login", async () => {
    await upsertMarketplaceSubscription(
      makeEnv(db),
      { accountId: 2, accountLogin: "beta", tier: "pro", seats: 3, status: "active" },
      "2026-01-01T00:00:00Z",
    )
    await upsertMarketplaceSubscription(
      makeEnv(db),
      { accountId: 2, accountLogin: "beta-renamed", tier: "teams", seats: 20, status: "active" },
      "2026-02-01T00:00:00Z",
    )
    const row = await readMarketplaceSubscriptionByLogin(makeEnv(db), "beta-renamed")
    expect(row).toMatchObject({ accountId: 2, tier: "teams", seats: 20 })
    // only one row (upsert, not insert)
    const count = await db.prepare("SELECT COUNT(*) AS n FROM marketplace_subscription").first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it("stores null seats", async () => {
    await upsertMarketplaceSubscription(
      makeEnv(db),
      { accountId: 3, accountLogin: "gamma", tier: "max", seats: null, status: "active" },
      "2026-01-01T00:00:00Z",
    )
    const row = await readMarketplaceSubscriptionByLogin(makeEnv(db), "gamma")
    expect(row?.seats).toBeNull()
  })

  it("read returns null for an unknown login", async () => {
    expect(await readMarketplaceSubscriptionByLogin(makeEnv(db), "nobody")).toBeNull()
  })

  it("upsert is a no-op (never throws) when accountId is non-positive", async () => {
    await expect(
      upsertMarketplaceSubscription(
        makeEnv(db),
        { accountId: 0, accountLogin: "x", tier: "pro", seats: null, status: "active" },
        "2026-01-01T00:00:00Z",
      ),
    ).resolves.toBeUndefined()
    const count = await db.prepare("SELECT COUNT(*) AS n FROM marketplace_subscription").first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it("fails soft on an absent binding / broken DB (never throws)", async () => {
    await expect(
      upsertMarketplaceSubscription(
        {},
        { accountId: 9, accountLogin: "z", tier: "pro", seats: null, status: "active" },
        "2026-01-01T00:00:00Z",
      ),
    ).resolves.toBeUndefined()
    await expect(
      upsertMarketplaceSubscription(
        { SIGILIX_PLATFORM_DB: makeBrokenDb() },
        { accountId: 9, accountLogin: "z", tier: "pro", seats: null, status: "active" },
        "2026-01-01T00:00:00Z",
      ),
    ).resolves.toBeUndefined()
    expect(await readMarketplaceSubscriptionByLogin({}, "z")).toBeNull()
    expect(await readMarketplaceSubscriptionByLogin({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, "z")).toBeNull()
  })
})
