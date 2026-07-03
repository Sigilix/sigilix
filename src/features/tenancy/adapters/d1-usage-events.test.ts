// SIG-303 — usage_events write + read adapter tests.
// Schema is owned by the migration; the shim applies it in beforeEach.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { appendUsageEvent } from "@/src/features/tenancy/adapters/d1-usage-events"
import {
  readUsageEventCount,
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
