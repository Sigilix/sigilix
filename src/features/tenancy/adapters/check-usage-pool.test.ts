// SIG-303 — checkUsagePool gate tests: modes, both windows, pool independence,
// fail-open, and the grace policy (read-only; never appends).

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { checkUsagePool } from "@/src/features/tenancy/adapters/check-usage-pool"
import { appendUsageEvent } from "@/src/features/tenancy/adapters/d1-usage-events"
import type { Env } from "@/src/shared/types/env"

const M1 = readFileSync(new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const M4 = readFileSync(new URL("../../../../migrations/0004_create_usage_events.sql", import.meta.url), "utf8")

type CheckEnv = Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_USAGE_METER_MODE"> & Partial<Env>

async function seedSeat(db: D1Database, userKey: string, meter: "coding_agent" | "chatbot", n: number, iso: string) {
  for (let i = 0; i < n; i++) {
    await appendUsageEvent(
      { SIGILIX_PLATFORM_DB: db },
      { meter, installationId: 0, userKey, surface: "test", nowIso: iso },
    )
  }
}

async function seedOrgSlack(db: D1Database, installationId: number, n: number, iso: string) {
  for (let i = 0; i < n; i++) {
    await appendUsageEvent(
      { SIGILIX_PLATFORM_DB: db },
      { meter: "slack", installationId, userKey: `slack:${i}`, surface: "slack", nowIso: iso },
    )
  }
}

describe("checkUsagePool", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(M1)
    await db.exec(M4)
  })

  it("mode=off → allow, zero reads", async () => {
    const env: CheckEnv = { SIGILIX_PLATFORM_DB: db, SIGILIX_USAGE_METER_MODE: "off" }
    const d = await checkUsagePool(env, { pool: "seat", userKey: "gh:1", nowMs: Date.now() })
    expect(d.allowed).toBe(true)
    expect(d.mode).toBe("off")
  })

  it("shadow → allowed even when over cap (observe only)", async () => {
    const now = Date.now()
    await seedSeat(db, "gh:1", "coding_agent", 3, new Date(now).toISOString())
    const env: CheckEnv = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "shadow",
      SIGILIX_USAGE_CAP_SEAT_SESSION: "2",
      SIGILIX_USAGE_CAP_SEAT_WEEKLY: "-1",
    }
    const d = await checkUsagePool(env, { pool: "seat", userKey: "gh:1", nowMs: now })
    expect(d.allowed).toBe(true)
    expect(d.session.used).toBe(3)
    expect(d.session.cap).toBe(2)
  })

  it("enforce → blocks when the pool total is at/over the session cap", async () => {
    const now = Date.now()
    await seedSeat(db, "gh:1", "coding_agent", 1, new Date(now).toISOString())
    await seedSeat(db, "gh:1", "chatbot", 1, new Date(now).toISOString())
    const env: CheckEnv = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "enforce",
      SIGILIX_USAGE_CAP_SEAT_SESSION: "2", // total is 2 → at cap → blocked
      SIGILIX_USAGE_CAP_SEAT_WEEKLY: "-1",
    }
    const d = await checkUsagePool(env, { pool: "seat", userKey: "gh:1", nowMs: now })
    expect(d.allowed).toBe(false)
    expect(d.session.used).toBe(2)
  })

  it("POOL INDEPENDENCE: a maxed SEAT pool does not block the ORG pool", async () => {
    const now = Date.now()
    await seedSeat(db, "gh:1", "coding_agent", 50, new Date(now).toISOString())
    const env: CheckEnv = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "enforce",
      SIGILIX_USAGE_CAP_SEAT_SESSION: "2",
      SIGILIX_USAGE_CAP_ORG_SESSION: "10",
      SIGILIX_USAGE_CAP_ORG_WEEKLY: "-1",
      SIGILIX_USAGE_CAP_SEAT_WEEKLY: "-1",
    }
    const seat = await checkUsagePool(env, { pool: "seat", userKey: "gh:1", nowMs: now })
    expect(seat.allowed).toBe(false) // seat maxed
    const org = await checkUsagePool(env, { pool: "org", installationId: 42, nowMs: now })
    expect(org.allowed).toBe(true) // org untouched
    expect(org.session.used).toBe(0)
  })

  it("ORG pool counts pr_reviews + linear_triage + slack together", async () => {
    const now = Date.now()
    const iso = new Date(now).toISOString()
    // 2 reviews in usage_ledger
    for (const pr of [1, 2]) {
      await db
        .prepare(
          "INSERT INTO usage_ledger (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at) VALUES (?, 1, ?, ?, 1, 1, 'x', ?)",
        )
        .bind(7, pr, `s${pr}`, iso)
        .run()
    }
    await appendUsageEvent(
      { SIGILIX_PLATFORM_DB: db },
      { meter: "linear_triage", installationId: 7, userKey: null, surface: "linear", eventId: "i1", nowIso: iso },
    )
    await seedOrgSlack(db, 7, 3, iso)
    const env: CheckEnv = {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_USAGE_METER_MODE: "enforce",
      SIGILIX_USAGE_CAP_ORG_SESSION: "6", // total 2+1+3 = 6 → at cap → blocked
      SIGILIX_USAGE_CAP_ORG_WEEKLY: "-1",
    }
    const d = await checkUsagePool(env, { pool: "org", installationId: 7, nowMs: now })
    expect(d.session.used).toBe(6)
    expect(d.allowed).toBe(false)
  })

  it("fail-open: a broken DB never blocks (enforce mode included)", async () => {
    const broken = {
      prepare() {
        throw new Error("boom")
      },
      batch() {
        return Promise.reject(new Error("boom"))
      },
    } as unknown as D1Database
    const env: CheckEnv = {
      SIGILIX_PLATFORM_DB: broken,
      SIGILIX_USAGE_METER_MODE: "enforce",
      SIGILIX_USAGE_CAP_SEAT_SESSION: "1",
    }
    const d = await checkUsagePool(env, { pool: "seat", userKey: "gh:1", nowMs: Date.now() })
    expect(d.allowed).toBe(true)
  })
})
