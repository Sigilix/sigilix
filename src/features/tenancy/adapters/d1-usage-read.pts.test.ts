// SIG-583 (PTS M0): readPtsSessionUsageSince — per-tenant token-cost of the
// agentic SESSION meters (coding_agent + chatbot) from usage_events. Schema is
// owned by the migrations; the shim's exec() applies them before each test.

import { describe, it, expect, beforeEach } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { readPtsSessionUsageSince } from "@/src/features/tenancy/adapters/d1-usage-read"
import type { Env } from "@/src/shared/types/env"

const SQL_0001 = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const SQL_0004 = readFileSync(new URL("../../../../migrations/0004_create_usage_events.sql", import.meta.url), "utf8")
const SQL_0015 = readFileSync(
  new URL("../../../../migrations/0015_add_cost_usd_to_usage_events.sql", import.meta.url),
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

async function insertTenant(db: D1Database, installationId: number, login: string) {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, 'Organization', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .bind(installationId, login)
    .run()
}

async function insertEvent(
  db: D1Database,
  args: { meter: string; installationId: number; tokens: number; costUsd: number; createdAt: string; eventId?: string },
) {
  await db
    .prepare(
      "INSERT INTO usage_events (meter, installation_id, user_key, surface, event_id, tokens, cost_usd, created_at)" +
        " VALUES (?, ?, 'gh:1', 'portal', ?, ?, ?, ?)",
    )
    .bind(args.meter, args.installationId, args.eventId ?? null, args.tokens, args.costUsd, args.createdAt)
    .run()
}

describe("readPtsSessionUsageSince (SIG-583 PTS M0)", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(SQL_0001)
    await db.exec(SQL_0004)
    await db.exec(SQL_0015)
  })

  it("sums tokens + cost + session count per tenant for the session meters, joined to account metadata", async () => {
    await insertTenant(db, 100, "acme")
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 100,
      tokens: 1000,
      costUsd: 0.02,
      createdAt: "2026-06-10T00:00:00.000Z",
      eventId: "e1",
    })
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 100,
      tokens: 2500,
      costUsd: 0.05,
      createdAt: "2026-06-11T00:00:00.000Z",
      eventId: "e2",
    })
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 200,
      tokens: 400,
      costUsd: 0.01,
      createdAt: "2026-06-12T00:00:00.000Z",
      eventId: "e3",
    })

    const result = await readPtsSessionUsageSince(makeEnv(db), "2026-06-01T00:00:00.000Z")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const acme = result.rows.find((r) => r.installationId === 100)
    expect(acme).toMatchObject({ installationId: 100, accountLogin: "acme", sessions: 2, tokens: 3500, costUsd: 0.07 })
    const other = result.rows.find((r) => r.installationId === 200)
    expect(other).toMatchObject({ installationId: 200, accountLogin: null, sessions: 1, tokens: 400 })
  })

  it("EXCLUDES non-session meters (slack / linear_triage) — those aren't PTS sessions", async () => {
    await insertTenant(db, 100, "acme")
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 100,
      tokens: 100,
      costUsd: 0.01,
      createdAt: "2026-06-10T00:00:00.000Z",
      eventId: "s1",
    })
    await insertEvent(db, {
      meter: "slack",
      installationId: 100,
      tokens: 9999,
      costUsd: 9.99,
      createdAt: "2026-06-10T00:00:00.000Z",
      eventId: "s2",
    })
    await insertEvent(db, {
      meter: "linear_triage",
      installationId: 100,
      tokens: 8888,
      costUsd: 8.88,
      createdAt: "2026-06-10T00:00:00.000Z",
      eventId: "s3",
    })

    const result = await readPtsSessionUsageSince(makeEnv(db), "2026-06-01T00:00:00.000Z")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ sessions: 1, tokens: 100 }) // slack/linear excluded
  })

  it("groups org-less seat runs (installation_id=0) into a single blended bucket with a null login", async () => {
    // Seat meters are keyed by user_key; org-less runs are written with installation_id=0.
    await insertEvent(db, {
      meter: "coding_agent",
      installationId: 0,
      tokens: 100,
      costUsd: 0.01,
      createdAt: "2026-06-10T00:00:00.000Z",
      eventId: "u1",
    })
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 0,
      tokens: 200,
      costUsd: 0.02,
      createdAt: "2026-06-11T00:00:00.000Z",
      eventId: "u2",
    })

    const result = await readPtsSessionUsageSince(makeEnv(db), "2026-06-01T00:00:00.000Z")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ installationId: 0, accountLogin: null, sessions: 2, tokens: 300 })
  })

  it("respects the since window", async () => {
    await insertTenant(db, 100, "acme")
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 100,
      tokens: 100,
      costUsd: 0.01,
      createdAt: "2026-05-01T00:00:00.000Z",
      eventId: "old",
    })
    await insertEvent(db, {
      meter: "chatbot",
      installationId: 100,
      tokens: 200,
      costUsd: 0.02,
      createdAt: "2026-06-10T00:00:00.000Z",
      eventId: "new",
    })

    const result = await readPtsSessionUsageSince(makeEnv(db), "2026-06-01T00:00:00.000Z")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0]).toMatchObject({ sessions: 1, tokens: 200 }) // only the in-window row
  })

  it("absent binding → {ok:true, rows:[]} (dark, legitimately empty)", async () => {
    const result = await readPtsSessionUsageSince({}, "2026-06-01T00:00:00.000Z")
    expect(result).toEqual({ ok: true, rows: [] })
  })

  it("D1 error → {ok:false} (a fault, NOT 'no usage')", async () => {
    const result = await readPtsSessionUsageSince({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, "2026-06-01T00:00:00.000Z")
    expect(result).toEqual({ ok: false })
  })
})
