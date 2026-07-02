// sig-workspace-prs — readRecentWorkspacePrs unit tests.
//
// Schema is owned by the migration; the shim's exec() applies it before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { readRecentWorkspacePrs } from "@/src/features/tenancy/adapters/d1-workspace-prs-read"
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

/** Throws on any operation — simulates a genuine D1 outage/fault. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

/** repo.installation_id FK-references tenant(installation_id) — seed the tenant row first. */
async function insertTenant(db: D1Database, installationId: number) {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, created_at, updated_at)" +
        " VALUES (?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')" +
        " ON CONFLICT(installation_id) DO NOTHING",
    )
    .bind(installationId)
    .run()
}

async function insertRepo(db: D1Database, repoId: number, installationId: number, fullName: string) {
  await insertTenant(db, installationId)
  await db
    .prepare(
      "INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
    )
    .bind(repoId, installationId, fullName)
    .run()
}

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

describe("readRecentWorkspacePrs", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("joins repo.full_name and returns rows newest-first for the scoped installation", async () => {
    await insertRepo(db, 100, 1, "acme/api")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 2,
      headSha: "sha-b",
      authorLogin: "octocat",
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    const result = await readRecentWorkspacePrs(makeEnv(db), [1])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((r) => r.prNumber)).toEqual([2, 1])
    expect(result.rows[0]).toEqual({
      repo: "acme/api",
      prNumber: 2,
      headSha: "sha-b",
      authorLogin: "octocat",
      createdAt: "2026-06-02T00:00:00.000Z",
    })
  })

  it("scopes to the given installation ids — a different tenant's rows never appear", async () => {
    await insertRepo(db, 100, 1, "acme/api")
    await insertRepo(db, 200, 2, "other-org/secret")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-secret",
      authorLogin: "someone-else",
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    const result = await readRecentWorkspacePrs(makeEnv(db), [1])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.repo).toBe("acme/api")
  })

  it("scopes across multiple installation ids when the caller has several", async () => {
    await insertRepo(db, 100, 1, "acme/api")
    await insertRepo(db, 200, 2, "acme/worker")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-b",
      authorLogin: "octocat",
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    const result = await readRecentWorkspacePrs(makeEnv(db), [1, 2])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(2)
  })

  it('"all" sentinel (legacy global key) returns rows across every installation', async () => {
    await insertRepo(db, 100, 1, "acme/api")
    await insertRepo(db, 200, 2, "other-org/repo")
    await insertUsage(db, {
      installationId: 1,
      repoId: 100,
      prNumber: 1,
      headSha: "sha-a",
      authorLogin: "octocat",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    await insertUsage(db, {
      installationId: 2,
      repoId: 200,
      prNumber: 1,
      headSha: "sha-b",
      authorLogin: "someone-else",
      createdAt: "2026-06-02T00:00:00.000Z",
    })

    const result = await readRecentWorkspacePrs(makeEnv(db), "all")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(2)
  })

  it("an empty installation id array short-circuits to [] without touching D1", async () => {
    const result = await readRecentWorkspacePrs(makeEnv(db), [])
    expect(result).toEqual({ ok: true, rows: [] })
  })

  it("binding absent -> {ok: true, rows: []}", async () => {
    const result = await readRecentWorkspacePrs(makeAbsentEnv(), [1])
    expect(result).toEqual({ ok: true, rows: [] })
  })

  it("thrown D1 error -> {ok: false}, not an empty success", async () => {
    const result = await readRecentWorkspacePrs({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, [1])
    expect(result).toEqual({ ok: false })
    expect(result).not.toMatchObject({ ok: true })
  })

  it("caps the result at 100 rows, newest-first", async () => {
    await insertRepo(db, 100, 1, "acme/api")
    const base = Date.parse("2026-06-01T00:00:00.000Z")
    for (let i = 0; i < 120; i++) {
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: i,
        headSha: `sha-${i}`,
        authorLogin: "octocat",
        createdAt: new Date(base + i * 1000).toISOString(),
      })
    }
    const result = await readRecentWorkspacePrs(makeEnv(db), [1])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toHaveLength(100)
    // Newest-first (the 100 most recent of the 120 inserted rows).
    expect(result.rows[0]!.prNumber).toBe(119)
    expect(result.rows[99]!.prNumber).toBe(20)
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1]!.createdAt >= result.rows[i]!.createdAt).toBe(true)
    }
  })
})
