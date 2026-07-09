// SIG-38 Task 2 — d1-rate-limit-read unit tests.
//
// Schema is owned by the migration; the shim's exec() applies it before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"
import { readRollingReviewCount } from "@/src/features/tenancy/adapters/d1-rate-limit-read"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
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

/** Insert a usage_ledger row directly. */
async function insertUsage(
  db: D1Database,
  args: {
    installationId: number
    repoId: number
    prNumber: number
    headSha: string
    authorLogin: string | null
    createdAt: string
  },
) {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, 1, 100, ?, ?)",
    )
    .bind(args.installationId, args.repoId, args.prNumber, args.headSha, args.authorLogin, args.createdAt)
    .run()
}

// ---------------------------------------------------------------------------
// readRollingReviewCount
// ---------------------------------------------------------------------------

describe("readRollingReviewCount", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
  })

  it("counts all rows for (installationId, authorLogin) within the window", async () => {
    for (let i = 1; i <= 5; i++) {
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: i,
        headSha: `sha${i}`,
        authorLogin: "alice",
        createdAt: `2026-06-01T0${i}:00:00.000Z`,
      })
    }

    const result = await readRollingReviewCount(makeEnv(db), {
      installationId: 1,
      authorLogin: "alice",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })

    expect(result).toMatchObject({ ok: true, count: 5 })
    if (!result.ok) return
    expect(result.windowRowsAscMs).toHaveLength(5)
    // Rows must be ascending in time
    const sorted = [...result.windowRowsAscMs].sort((a, b) => a - b)
    expect(result.windowRowsAscMs).toEqual(sorted)
  })

  it("sums cost_usd across in-window rows (sig-cost-based-metering)", async () => {
    // Two rows with explicit costs; one older row is legacy (cost defaults 0).
    await db
      .prepare(
        "INSERT INTO usage_ledger (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, cost_usd, author_login, created_at)" +
          " VALUES (9, 100, 1, 'a', 3, 1000, 0.25, 'carol', '2026-06-01T01:00:00.000Z')",
      )
      .run()
    await db
      .prepare(
        "INSERT INTO usage_ledger (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, cost_usd, author_login, created_at)" +
          " VALUES (9, 100, 2, 'b', 5, 2000, 0.75, 'carol', '2026-06-01T02:00:00.000Z')",
      )
      .run()
    // Legacy row inserted WITHOUT the cost column → defaults to 0, contributes nothing.
    await db
      .prepare(
        "INSERT INTO usage_ledger (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
          " VALUES (9, 100, 3, 'c', 1, 100, 'carol', '2026-06-01T03:00:00.000Z')",
      )
      .run()

    const result = await readRollingReviewCount(makeEnv(db), {
      installationId: 9,
      authorLogin: "carol",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(3)
    expect(result.costUsd).toBeCloseTo(1.0, 6) // 0.25 + 0.75 + 0 (legacy)
  })

  it("excludes rows with created_at strictly before sinceIso", async () => {
    // Old row (before the window) — must be excluded
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "old",
      authorLogin: "alice",
      createdAt: "2026-05-31T23:59:59.999Z",
    })
    // Row at the boundary (>= sinceIso) — must be included
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "new",
      authorLogin: "alice",
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const result = await readRollingReviewCount(makeEnv(db), {
      installationId: 1,
      authorLogin: "alice",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })

    expect(result).toMatchObject({ ok: true, count: 1 })
  })

  it("does not count rows for a different author in the same installation (per-developer isolation)", async () => {
    // alice — inside window
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-alice",
      authorLogin: "alice",
      createdAt: "2026-06-01T01:00:00.000Z",
    })
    // bob — same installation, same window — must NOT count for alice
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-bob",
      authorLogin: "bob",
      createdAt: "2026-06-01T02:00:00.000Z",
    })

    const result = await readRollingReviewCount(makeEnv(db), {
      installationId: 1,
      authorLogin: "alice",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })

    expect(result).toMatchObject({ ok: true, count: 1 })
  })

  it("does not count rows for a different installation", async () => {
    // Rows for installation 2 — must NOT appear when querying installation 1
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-other",
      authorLogin: "alice",
      createdAt: "2026-06-01T01:00:00.000Z",
    })

    const result = await readRollingReviewCount(makeEnv(db), {
      installationId: 1,
      authorLogin: "alice",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })

    expect(result).toMatchObject({ ok: true, count: 0 })
    if (!result.ok) return
    expect(result.windowRowsAscMs).toHaveLength(0)
  })

  it("count is the TRUE total; windowRowsAscMs is bounded by limit (caller sets limit = cap+burst+1)", async () => {
    // Seed 10 rows for alice
    for (let i = 1; i <= 10; i++) {
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: i,
        headSha: `sha${i}`,
        authorLogin: "alice",
        createdAt: `2026-06-01T${String(i).padStart(2, "0")}:00:00.000Z`,
      })
    }

    // limit=4 → count must be 10 (TRUE total), windowRowsAscMs bounded to 4
    const result = await readRollingReviewCount(makeEnv(db), {
      installationId: 1,
      authorLogin: "alice",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 4,
    })

    expect(result).toMatchObject({ ok: true, count: 10 })
    if (!result.ok) return
    expect(result.windowRowsAscMs).toHaveLength(4)
  })

  it("binding absent → {ok: false}", async () => {
    const result = await readRollingReviewCount(makeAbsentEnv(), {
      installationId: 1,
      authorLogin: "alice",
      sinceIso: "2026-06-01T00:00:00.000Z",
      limit: 10,
    })
    expect(result).toEqual({ ok: false })
  })

  it("thrown D1 → {ok: false}, NOT count:0 — caller must distinguish fault from genuine empty", async () => {
    const result = await readRollingReviewCount(
      { SIGILIX_PLATFORM_DB: makeBrokenDb() },
      { installationId: 1, authorLogin: "alice", sinceIso: "2026-06-01T00:00:00.000Z", limit: 10 },
    )
    expect(result).toEqual({ ok: false })
    // Explicitly not {ok:true, ...} — this is the sentinel contract
    expect(result).not.toMatchObject({ ok: true })
  })
})
