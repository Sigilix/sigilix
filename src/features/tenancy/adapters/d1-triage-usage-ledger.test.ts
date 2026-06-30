// SIG-38 free-launch caps — d1-triage-usage-ledger unit tests.
//
// Mirrors d1-usage-ledger.test.ts but against the separate triage_usage_ledger
// table. Schema is owned by the migration; the shim applies it in beforeEach.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { appendTriageUsage } from "@/src/features/tenancy/adapters/d1-triage-usage-ledger"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0002_create_triage_usage_ledger.sql", import.meta.url),
  "utf8",
)

function makeEnv(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function makeAbsentEnv(): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return {}
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

const BASE_ARGS = {
  teamId: "team-1",
  issueId: "issue-1",
  nowIso: "2026-01-01T00:00:00Z",
}

async function rowCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM triage_usage_ledger").first<{ n: number }>()
  return row?.n ?? 0
}

describe("appendTriageUsage", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("inserts a row with all fields", async () => {
    await appendTriageUsage(makeEnv(db), BASE_ARGS)

    expect(await rowCount(db)).toBe(1)

    const row = await db
      .prepare("SELECT team_id, issue_id, created_at FROM triage_usage_ledger LIMIT 1")
      .first<{ team_id: string; issue_id: string; created_at: string }>()
    expect(row?.team_id).toBe("team-1")
    expect(row?.issue_id).toBe("issue-1")
    expect(row?.created_at).toBe("2026-01-01T00:00:00Z")
  })

  it("duplicate (same team/issue) — INSERT OR IGNORE keeps exactly one row", async () => {
    await appendTriageUsage(makeEnv(db), BASE_ARGS)
    await appendTriageUsage(makeEnv(db), { ...BASE_ARGS, nowIso: "2026-01-01T01:00:00Z" })

    expect(await rowCount(db)).toBe(1)
  })

  it("new issueId for the same team — inserts a second distinct row", async () => {
    await appendTriageUsage(makeEnv(db), BASE_ARGS)
    await appendTriageUsage(makeEnv(db), { ...BASE_ARGS, issueId: "issue-2" })

    expect(await rowCount(db)).toBe(2)
  })

  it("same issueId for a different team — inserts a second distinct row (per-team independence)", async () => {
    await appendTriageUsage(makeEnv(db), BASE_ARGS)
    await appendTriageUsage(makeEnv(db), { ...BASE_ARGS, teamId: "team-2" })

    expect(await rowCount(db)).toBe(2)
  })

  it("empty teamId — skipped, no row inserted", async () => {
    await appendTriageUsage(makeEnv(db), { ...BASE_ARGS, teamId: "" })
    expect(await rowCount(db)).toBe(0)
  })

  it("empty issueId — skipped, no row inserted", async () => {
    await appendTriageUsage(makeEnv(db), { ...BASE_ARGS, issueId: "" })
    expect(await rowCount(db)).toBe(0)
  })

  it("binding absent — resolves without throwing and inserts nothing", async () => {
    await expect(appendTriageUsage(makeAbsentEnv(), BASE_ARGS)).resolves.toBeUndefined()
    expect(await rowCount(db)).toBe(0)
  })

  it("thrown query — no-op, never throws (fail-open)", async () => {
    await expect(appendTriageUsage({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, BASE_ARGS)).resolves.toBeUndefined()
  })
})
