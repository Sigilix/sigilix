// SIG-343 PR C Task 3 + Task 8 — d1-usage-ledger unit tests.
//
// Schema is owned by the migration; the shim applies it in beforeEach.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { appendUsage } from "@/src/features/tenancy/adapters/d1-usage-ledger"
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

const BASE_ARGS = {
  installationId: 10,
  repoId: 200,
  prNumber: 42,
  headSha: "abc123",
  modelCalls: 3,
  tokens: 1500,
  nowIso: "2026-01-01T00:00:00Z",
}

async function rowCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM usage_ledger").first<{ n: number }>()
  return row?.n ?? 0
}

describe("appendUsage", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    // usage_ledger has no FK to tenant/repo, so we can insert rows without seeding those tables.
  })

  it("inserts a row with all fields", async () => {
    await appendUsage(makeEnv(db), BASE_ARGS)

    expect(await rowCount(db)).toBe(1)

    const row = await db
      .prepare(
        "SELECT installation_id, repo_id, pr_number, head_sha, model_calls, tokens, created_at FROM usage_ledger LIMIT 1",
      )
      .first<{
        installation_id: number
        repo_id: number
        pr_number: number
        head_sha: string
        model_calls: number
        tokens: number
        created_at: string
      }>()
    expect(row?.installation_id).toBe(10)
    expect(row?.repo_id).toBe(200)
    expect(row?.pr_number).toBe(42)
    expect(row?.head_sha).toBe("abc123")
    expect(row?.model_calls).toBe(3)
    expect(row?.tokens).toBe(1500)
    expect(row?.created_at).toBe("2026-01-01T00:00:00Z")
  })

  it("duplicate (same installation/repo/pr/head) — INSERT OR IGNORE keeps exactly one row", async () => {
    await appendUsage(makeEnv(db), BASE_ARGS)
    await appendUsage(makeEnv(db), { ...BASE_ARGS, modelCalls: 99, tokens: 99999 })

    expect(await rowCount(db)).toBe(1)
  })

  it("new head_sha for the same pr — inserts a second distinct row", async () => {
    await appendUsage(makeEnv(db), BASE_ARGS)
    await appendUsage(makeEnv(db), { ...BASE_ARGS, headSha: "def456" })

    expect(await rowCount(db)).toBe(2)
  })

  it("empty headSha — skipped, no row inserted", async () => {
    await appendUsage(makeEnv(db), { ...BASE_ARGS, headSha: "" })
    expect(await rowCount(db)).toBe(0)
  })

  it("non-finite prNumber (NaN) — skipped, no row inserted", async () => {
    await appendUsage(makeEnv(db), { ...BASE_ARGS, prNumber: NaN })
    expect(await rowCount(db)).toBe(0)
  })

  it("non-finite repoId (Infinity) — skipped, no row inserted", async () => {
    await appendUsage(makeEnv(db), { ...BASE_ARGS, repoId: Infinity })
    expect(await rowCount(db)).toBe(0)
  })

  it("non-finite installationId — skipped, no row inserted", async () => {
    await appendUsage(makeEnv(db), { ...BASE_ARGS, installationId: NaN })
    expect(await rowCount(db)).toBe(0)
  })

  it("binding absent — resolves without throwing and inserts nothing", async () => {
    await expect(appendUsage(makeAbsentEnv(), BASE_ARGS)).resolves.toBeUndefined()
    expect(await rowCount(db)).toBe(0)
  })

  it("thrown query — no-op, never throws (fail-open)", async () => {
    await expect(appendUsage({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, BASE_ARGS)).resolves.toBeUndefined()
  })

  it("stores author_login when provided", async () => {
    await appendUsage(makeEnv(db), { ...BASE_ARGS, authorLogin: "octocat" })

    const row = await db
      .prepare("SELECT author_login FROM usage_ledger LIMIT 1")
      .first<{ author_login: string | null }>()
    expect(row?.author_login).toBe("octocat")
  })

  it("stores NULL author_login when omitted", async () => {
    await appendUsage(makeEnv(db), BASE_ARGS)

    const row = await db
      .prepare("SELECT author_login FROM usage_ledger LIMIT 1")
      .first<{ author_login: string | null }>()
    expect(row?.author_login).toBeNull()
  })

  it("duplicate dedupe is unchanged when authorLogin differs (first-write-wins)", async () => {
    await appendUsage(makeEnv(db), { ...BASE_ARGS, authorLogin: "alice" })
    await appendUsage(makeEnv(db), { ...BASE_ARGS, authorLogin: "bob" })

    expect(await rowCount(db)).toBe(1)
    const row = await db
      .prepare("SELECT author_login FROM usage_ledger LIMIT 1")
      .first<{ author_login: string | null }>()
    // INSERT OR IGNORE: first row wins on all columns
    expect(row?.author_login).toBe("alice")
  })
})
