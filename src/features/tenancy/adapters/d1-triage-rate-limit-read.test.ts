// SIG-38 free-launch caps — d1-triage-rate-limit-read unit tests.
//
// Mirrors d1-rate-limit-read.test.ts but against the separate
// `triage_usage_ledger` table (team_id-keyed, no installation/repo/PR shape).
// Schema is owned by the migration; the shim's exec() applies it before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { readRollingTriageCount } from "@/src/features/tenancy/adapters/d1-triage-rate-limit-read"
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

/** Insert a triage_usage_ledger row directly. */
async function insertTriage(db: D1Database, args: { teamId: string; issueId: string; createdAt: string }) {
  await db
    .prepare("INSERT INTO triage_usage_ledger (team_id, issue_id, created_at) VALUES (?, ?, ?)")
    .bind(args.teamId, args.issueId, args.createdAt)
    .run()
}

// ---------------------------------------------------------------------------
// readRollingTriageCount
// ---------------------------------------------------------------------------

describe("readRollingTriageCount", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("counts all rows for teamId within the window", async () => {
    for (let i = 1; i <= 5; i++) {
      await insertTriage(db, {
        teamId: "team-1",
        issueId: `issue-${i}`,
        createdAt: `2026-06-01T0${i}:00:00.000Z`,
      })
    }

    const result = await readRollingTriageCount(makeEnv(db), {
      teamId: "team-1",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })

    expect(result).toMatchObject({ ok: true, count: 5 })
    if (!result.ok) return
    expect(result.windowRowsAscMs).toHaveLength(5)
    const sorted = [...result.windowRowsAscMs].sort((a, b) => a - b)
    expect(result.windowRowsAscMs).toEqual(sorted)
  })

  it("excludes rows with created_at strictly before sinceIso", async () => {
    await insertTriage(db, { teamId: "team-1", issueId: "old", createdAt: "2026-05-31T23:59:59.999Z" })
    await insertTriage(db, { teamId: "team-1", issueId: "new", createdAt: "2026-06-01T00:00:00.000Z" })

    const result = await readRollingTriageCount(makeEnv(db), {
      teamId: "team-1",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })

    expect(result).toMatchObject({ ok: true, count: 1 })
  })

  it("does not count rows for a different team (per-team isolation)", async () => {
    await insertTriage(db, { teamId: "team-1", issueId: "issue-a", createdAt: "2026-06-01T01:00:00.000Z" })
    await insertTriage(db, { teamId: "team-2", issueId: "issue-b", createdAt: "2026-06-01T02:00:00.000Z" })

    const result = await readRollingTriageCount(makeEnv(db), {
      teamId: "team-1",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })

    expect(result).toMatchObject({ ok: true, count: 1 })
  })

  it("count is the TRUE total; windowRowsAscMs is bounded by limit (caller sets limit = cap+burst+1)", async () => {
    for (let i = 1; i <= 10; i++) {
      await insertTriage(db, {
        teamId: "team-1",
        issueId: `issue-${i}`,
        createdAt: `2026-06-01T${String(i).padStart(2, "0")}:00:00.000Z`,
      })
    }

    const result = await readRollingTriageCount(makeEnv(db), {
      teamId: "team-1",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 4,
    })

    expect(result).toMatchObject({ ok: true, count: 10 })
    if (!result.ok) return
    expect(result.windowRowsAscMs).toHaveLength(4)
  })

  it("binding absent → {ok: false}", async () => {
    const result = await readRollingTriageCount(makeAbsentEnv(), {
      teamId: "team-1",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })
    expect(result).toEqual({ ok: false })
  })

  it("thrown D1 → {ok: false}, NOT count:0 — caller must distinguish fault from genuine empty", async () => {
    const result = await readRollingTriageCount(
      { SIGILIX_PLATFORM_DB: makeBrokenDb() },
      { teamId: "team-1", sinceIso: "2026-06-01T00:00:00.000Z", limit: 10 },
    )
    expect(result).toEqual({ ok: false })
    expect(result).not.toMatchObject({ ok: true })
  })
})
