// SIG-303 — usage_events write + read adapter tests.
// Schema is owned by the migration; the shim applies it in beforeEach.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"
import { appendUsageEvent, updateUsageEventCost } from "@/src/features/tenancy/adapters/d1-usage-events"
import {
  readUsageEventCount,
  readUsageEventCostSince,
  readUsageEventAuthorBreakdown,
} from "@/src/features/tenancy/adapters/d1-usage-events-read"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0004_create_usage_events.sql", import.meta.url),
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
    batch() {
      return Promise.reject(new Error("simulated D1 error"))
    },
    exec() {
      return Promise.reject(new Error("simulated D1 error"))
    },
  } as unknown as D1Database
}

describe("appendUsageEvent + readUsageEventCount", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
  })

  it("writing a row makes the seat count move", async () => {
    const env = makeEnv(db)
    const before = await readUsageEventCount(env, {
      meter: "chatbot",
      userKey: "gh:1",
      sinceIso: "2000-01-01T00:00:00.000Z",
    })
    expect(before).toEqual({ ok: true, count: 0 })
    await appendUsageEvent(env, {
      meter: "chatbot",
      installationId: 0,
      userKey: "gh:1",
      surface: "portal",
      nowIso: new Date().toISOString(),
    })
    const after = await readUsageEventCount(env, {
      meter: "chatbot",
      userKey: "gh:1",
      sinceIso: "2000-01-01T00:00:00.000Z",
    })
    expect(after).toEqual({ ok: true, count: 1 })
  })

  it("org and seat scopes are queried independently by different columns", async () => {
    const env = makeEnv(db)
    const now = new Date().toISOString()
    await appendUsageEvent(env, {
      meter: "slack",
      installationId: 7,
      userKey: "slack:U1",
      surface: "slack",
      nowIso: now,
    })
    // org rollup by installation_id
    expect(
      await readUsageEventCount(env, { meter: "slack", installationId: 7, sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: true, count: 1 })
    // a different installation sees nothing (tenant isolation)
    expect(
      await readUsageEventCount(env, { meter: "slack", installationId: 8, sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: true, count: 0 })
    // a seat meter query for a different meter is 0 (pool independence at the read)
    expect(
      await readUsageEventCount(env, {
        meter: "coding_agent",
        userKey: "slack:U1",
        sinceIso: "2000-01-01T00:00:00.000Z",
      }),
    ).toEqual({ ok: true, count: 0 })
  })

  it("event_id dedups redeliveries; NULL event_id never dedups", async () => {
    const env = makeEnv(db)
    const now = new Date().toISOString()
    await appendUsageEvent(env, {
      meter: "linear_triage",
      installationId: 3,
      userKey: null,
      surface: "linear",
      eventId: "issue-1",
      nowIso: now,
    })
    await appendUsageEvent(env, {
      meter: "linear_triage",
      installationId: 3,
      userKey: null,
      surface: "linear",
      eventId: "issue-1",
      nowIso: now,
    })
    expect(
      await readUsageEventCount(env, {
        meter: "linear_triage",
        installationId: 3,
        sinceIso: "2000-01-01T00:00:00.000Z",
      }),
    ).toEqual({ ok: true, count: 1 })
    // No event_id → each insert is a distinct row.
    await appendUsageEvent(env, {
      meter: "slack",
      installationId: 3,
      userKey: "slack:X",
      surface: "slack",
      nowIso: now,
    })
    await appendUsageEvent(env, {
      meter: "slack",
      installationId: 3,
      userKey: "slack:X",
      surface: "slack",
      nowIso: now,
    })
    expect(
      await readUsageEventCount(env, { meter: "slack", installationId: 3, sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: true, count: 2 })
  })

  it("author breakdown buckets NULL user_key under 'unattributed' and sorts desc", async () => {
    const env = makeEnv(db)
    const now = new Date().toISOString()
    await appendUsageEvent(env, {
      meter: "slack",
      installationId: 5,
      userKey: "slack:A",
      surface: "slack",
      nowIso: now,
    })
    await appendUsageEvent(env, {
      meter: "slack",
      installationId: 5,
      userKey: "slack:A",
      surface: "slack",
      nowIso: now,
    })
    await appendUsageEvent(env, { meter: "slack", installationId: 5, userKey: null, surface: "slack", nowIso: now })
    const res = await readUsageEventAuthorBreakdown(env, {
      meter: "slack",
      installationId: 5,
      sinceIso: "2000-01-01T00:00:00.000Z",
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.authors[0]).toEqual({ userKey: "slack:A", count: 2 })
      expect(res.authors.find((a) => a.userKey === "unattributed")?.count).toBe(1)
    }
  })

  it("write fails open on a broken DB (no throw); read returns the fault sentinel", async () => {
    const brokenEnv = makeEnv(makeBrokenDb())
    await expect(
      appendUsageEvent(brokenEnv, {
        meter: "chatbot",
        installationId: 0,
        userKey: "gh:1",
        surface: "portal",
        nowIso: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined()
    expect(
      await readUsageEventCount(brokenEnv, { meter: "chatbot", userKey: "gh:1", sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: false })
  })

  it("absent binding: write no-ops, read returns {ok:false}", async () => {
    const env: Pick<Env, "SIGILIX_PLATFORM_DB"> = {}
    await expect(
      appendUsageEvent(env, {
        meter: "chatbot",
        installationId: 0,
        userKey: "gh:1",
        surface: "portal",
        nowIso: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined()
    expect(
      await readUsageEventCount(env, { meter: "chatbot", userKey: "gh:1", sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: false })
  })
})

describe("usage_events cost (sig-cost-based-metering)", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
  })

  it("append with tokens+cost, then read the summed cost for the seat", async () => {
    const env = makeEnv(db)
    const now = new Date().toISOString()
    await appendUsageEvent(env, {
      meter: "coding_agent",
      installationId: 0,
      userKey: "gh:5",
      surface: "cli",
      tokens: 200_000,
      costUsd: 0.4,
      nowIso: now,
    })
    const res = await readUsageEventCostSince(env, {
      meter: "coding_agent",
      userKey: "gh:5",
      sinceIso: "2000-01-01T00:00:00.000Z",
    })
    expect(res).toEqual({ ok: true, costUsd: 0.4 })
  })

  it("updateUsageEventCost late-binds tokens+cost onto an existing event by (meter,event_id)", async () => {
    const env = makeEnv(db)
    const now = new Date().toISOString()
    // Appended at run-start with NO usage yet (cost defaults 0).
    await appendUsageEvent(env, {
      meter: "chatbot",
      installationId: 0,
      userKey: "gh:6",
      surface: "portal",
      eventId: "run-xyz",
      nowIso: now,
    })
    expect(
      await readUsageEventCostSince(env, { meter: "chatbot", userKey: "gh:6", sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: true, costUsd: 0 })

    // Later, at completion, the DO stamps the real spend.
    await updateUsageEventCost(env, { meter: "chatbot", eventId: "run-xyz", tokens: 500_000, costUsd: 0.95 })
    expect(
      await readUsageEventCostSince(env, { meter: "chatbot", userKey: "gh:6", sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: true, costUsd: 0.95 })
    // Count is unchanged — the update only touches usage, not identity.
    expect(
      await readUsageEventCount(env, { meter: "chatbot", userKey: "gh:6", sinceIso: "2000-01-01T00:00:00.000Z" }),
    ).toEqual({ ok: true, count: 1 })
  })

  it("updateUsageEventCost with a blank eventId is a no-op", async () => {
    const env = makeEnv(db)
    await expect(
      updateUsageEventCost(env, { meter: "chatbot", eventId: "  ", tokens: 1, costUsd: 1 }),
    ).resolves.toBeUndefined()
  })

  it("updateUsageEventCost userKey scope refuses to bind a FOREIGN seat's event (tenant safety)", async () => {
    const env = makeEnv(db)
    const now = new Date().toISOString()
    const win = { meter: "coding_agent" as const, sinceIso: "2000-01-01T00:00:00.000Z" }
    // Seat gh:222 owns the row keyed by this (client-generated) correlation id.
    await appendUsageEvent(env, {
      meter: "coding_agent",
      installationId: 0,
      userKey: "gh:222",
      surface: "cli",
      eventId: "corr-victim",
      nowIso: now,
    })

    // An ATTACKER seat gh:111 reports the same (guessed) correlation id, scoped to ITS
    // own seat. The user_key scope means the UPDATE matches nothing — gh:222 is untouched.
    await updateUsageEventCost(env, {
      meter: "coding_agent",
      eventId: "corr-victim",
      tokens: 999_999,
      costUsd: 9.99,
      userKey: "gh:111",
    })
    expect(await readUsageEventCostSince(env, { ...win, userKey: "gh:222" })).toEqual({ ok: true, costUsd: 0 })

    // The rightful owner gh:222 reports it → binds, scoped to its own seat.
    await updateUsageEventCost(env, {
      meter: "coding_agent",
      eventId: "corr-victim",
      tokens: 10,
      costUsd: 0.5,
      userKey: "gh:222",
    })
    expect(await readUsageEventCostSince(env, { ...win, userKey: "gh:222" })).toEqual({ ok: true, costUsd: 0.5 })
  })
})
