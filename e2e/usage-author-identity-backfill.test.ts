import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const migration = (name: string): string => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")

interface MappingRow {
  installationId: number
  repoId: number
  prNumber: number
  authorGithubUserId: string
  expectedNullRows: number
}

function parseMapping(sql: string): MappingRow[] {
  const values = sql.match(/-- mapping-values-start([\s\S]*?)-- mapping-values-end/u)?.[1]
  if (!values) throw new Error("migration 0030 mapping markers are missing")
  return [...values.matchAll(/\((\d+), (\d+), (\d+), '(\d+)', (\d+)\)/gu)].map((match) => ({
    installationId: Number(match[1]),
    repoId: Number(match[2]),
    prNumber: Number(match[3]),
    authorGithubUserId: match[4]!,
    expectedNullRows: Number(match[5]),
  }))
}

async function seedGroup(
  db: D1Database,
  row: MappingRow,
  count = row.expectedNullRows,
  identity: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO tenant
        (installation_id, tier, created_at, updated_at)
       VALUES (?, 'default', 't', 't')`,
    )
    .bind(row.installationId)
    .run()
  await db
    .prepare(
      `INSERT OR IGNORE INTO repo
        (repo_id, installation_id, full_name, updated_at)
       VALUES (?, ?, ?, 't')`,
    )
    .bind(row.repoId, row.installationId, `fixture/repo-${row.repoId}`)
    .run()
  for (let index = 0; index < count; index += 1) {
    await db
      .prepare(
        `INSERT INTO usage_ledger
          (installation_id, repo_id, pr_number, head_sha, model_calls, tokens,
           author_login, created_at, author_github_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.installationId,
        row.repoId,
        row.prNumber,
        `head-${row.installationId}-${row.repoId}-${row.prNumber}-${index}`,
        index + 1,
        100 + index,
        `legacy-login-${row.prNumber}`,
        `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        identity,
      )
      .run()
  }
}

async function unresolvedCount(db: D1Database, installationId?: number): Promise<number> {
  const statement = installationId
    ? db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_ledger" + " WHERE author_github_user_id IS NULL AND installation_id = ?",
        )
        .bind(installationId)
    : db.prepare("SELECT COUNT(*) AS count FROM usage_ledger WHERE author_github_user_id IS NULL")
  const row = await statement.first<{ count: number }>()
  return row?.count ?? 0
}

describe("historical usage author identity data migration", () => {
  let db: D1Database
  let migration0030: string
  let mapping: MappingRow[]

  beforeEach(async () => {
    db = makeD1()
    await db.exec(migration("0001_create_tenant_repo_usage.sql"))
    await db.exec(migration("0029_add_usage_author_github_identity.sql"))
    migration0030 = migration("0030_backfill_usage_author_github_identity.sql")
    mapping = parseMapping(migration0030)
  })

  it("resolves the exact 86-group production shape without changing usage evidence", async () => {
    expect(mapping).toHaveLength(86)
    expect(mapping.reduce((sum, row) => sum + row.expectedNullRows, 0)).toBe(144)
    expect(new Set(mapping.map((row) => row.authorGithubUserId)).size).toBe(3)

    for (const row of mapping) await seedGroup(db, row)
    expect(await unresolvedCount(db)).toBe(144)

    await expect(db.exec(migration0030)).resolves.toBeDefined()

    expect(await unresolvedCount(db)).toBe(0)
    await expect(
      db
        .prepare(
          `SELECT COUNT(*) AS rows, COUNT(DISTINCT author_github_user_id) AS authors,
                  SUM(model_calls) AS model_calls, SUM(tokens) AS tokens
             FROM usage_ledger`,
        )
        .first(),
    ).resolves.toEqual({ rows: 144, authors: 3, model_calls: 241, tokens: 14_497 })
    await expect(db.exec(migration0030)).resolves.toBeDefined()
  })

  it("aborts before mutation when a mapped installation contains an unexpected unresolved PR", async () => {
    const mapped = mapping[0]!
    await seedGroup(db, mapped)
    await seedGroup(db, { ...mapped, prNumber: 9_999_999, expectedNullRows: 1 })

    await expect(db.exec(migration0030)).rejects.toThrow(/migration_0030_preconditions/u)

    expect(await unresolvedCount(db, mapped.installationId)).toBe(mapped.expectedNullRows + 1)
  })

  it("aborts on count drift or conflicting identity and leaves every NULL untouched", async () => {
    const countDriftDb = makeD1()
    await countDriftDb.exec(migration("0001_create_tenant_repo_usage.sql"))
    await countDriftDb.exec(migration("0029_add_usage_author_github_identity.sql"))
    const mapped = mapping[0]!
    await seedGroup(countDriftDb, mapped, mapped.expectedNullRows + 1)

    await expect(countDriftDb.exec(migration0030)).rejects.toThrow(/migration_0030_preconditions/u)
    expect(await unresolvedCount(countDriftDb)).toBe(mapped.expectedNullRows + 1)

    const conflictDb = makeD1()
    await conflictDb.exec(migration("0001_create_tenant_repo_usage.sql"))
    await conflictDb.exec(migration("0029_add_usage_author_github_identity.sql"))
    await seedGroup(conflictDb, mapped)
    await conflictDb
      .prepare(
        `UPDATE usage_ledger
            SET author_github_user_id = '999'
          WHERE installation_id = ? AND repo_id = ? AND pr_number = ?
            AND head_sha = ?`,
      )
      .bind(
        mapped.installationId,
        mapped.repoId,
        mapped.prNumber,
        `head-${mapped.installationId}-${mapped.repoId}-${mapped.prNumber}-0`,
      )
      .run()

    await expect(conflictDb.exec(migration0030)).rejects.toThrow(/migration_0030_identity_conflict/u)
    expect(await unresolvedCount(conflictDb)).toBe(mapped.expectedNullRows - 1)
  })

  it("is a no-op on fresh state and does not claim an unmapped installation", async () => {
    await expect(db.exec(migration0030)).resolves.toBeDefined()

    const otherInstallation = { ...mapping[0]!, installationId: 777_777_777, expectedNullRows: 1 }
    await seedGroup(db, otherInstallation)
    await expect(db.exec(migration0030)).resolves.toBeDefined()

    expect(await unresolvedCount(db, otherInstallation.installationId)).toBe(1)
  })
})
