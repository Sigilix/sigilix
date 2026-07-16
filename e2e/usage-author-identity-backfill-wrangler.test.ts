import { describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, "..")
const WRANGLER = join(REPO_ROOT, "node_modules/.bin/wrangler")

interface MappingRow {
  installationId: number
  repoId: number
  prNumber: number
  authorGithubUserId: string
  expectedNullRows: number
}

function migration(name: string): string {
  return readFileSync(join(REPO_ROOT, "migrations", name), "utf8")
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

interface WranglerFixture {
  root: string
  migrations: string
  persist: string
  config: string
}

async function runWrangler(fixture: WranglerFixture, args: string[]): Promise<string> {
  const { stdout } = await exec(WRANGLER, [...args, "--config", fixture.config], {
    cwd: fixture.root,
    env: { ...process.env, CI: "1" },
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

async function makeFixture(): Promise<WranglerFixture> {
  const root = await mkdtemp(join(tmpdir(), "sigilix-m0030-"))
  const migrations = join(root, "migrations")
  const persist = join(root, "state")
  const config = join(root, "wrangler.toml")
  await mkdir(migrations)
  await mkdir(persist)
  await writeFile(
    config,
    `name = "sigilix-m0030-test"
compatibility_date = "2026-07-15"

[[d1_databases]]
binding = "DB"
database_name = "sigilix-platform"
database_id = "00000000-0000-0000-0000-000000000030"
migrations_dir = "migrations"
`,
  )
  for (const name of ["0001_create_tenant_repo_usage.sql", "0029_add_usage_author_github_identity.sql"]) {
    await copyFile(join(REPO_ROOT, "migrations", name), join(migrations, name))
  }
  const fixture = { root, migrations, persist, config }
  await runWrangler(fixture, ["d1", "migrations", "apply", "sigilix-platform", "--local", "--persist-to", persist])
  return fixture
}

function seedSql(mapping: MappingRow[], unexpectedMappedInstallation = false): string {
  const installations = [...new Set(mapping.map((row) => row.installationId)), 777_777_777]
  const repos = [...new Map(mapping.map((row) => [`${row.installationId}:${row.repoId}`, row])).values()]
  const usageRows: string[] = []
  for (const row of mapping) {
    for (let index = 0; index < row.expectedNullRows; index += 1) {
      usageRows.push(
        `(${row.installationId}, ${row.repoId}, ${row.prNumber}, ` +
          `'head-${row.installationId}-${row.repoId}-${row.prNumber}-${index}', 1, 100, ` +
          `'legacy-${row.prNumber}', '2026-07-01T00:00:00.000Z', NULL)`,
      )
    }
  }
  repos.push({
    installationId: 777_777_777,
    repoId: 9_007_199_000_000,
    prNumber: 1,
    authorGithubUserId: "1",
    expectedNullRows: 1,
  })
  usageRows.push(
    `(777777777, 9007199000000, 1, 'unmapped-installation-head', 1, 100, ` +
      `'unmapped', '2026-07-01T00:00:00.000Z', NULL)`,
  )
  if (unexpectedMappedInstallation) {
    const installationId = mapping[0]!.installationId
    repos.push({
      installationId,
      repoId: 9_007_199_000_001,
      prNumber: 1,
      authorGithubUserId: "1",
      expectedNullRows: 1,
    })
    usageRows.push(
      `(${installationId}, 9007199000001, 1, 'unexpected-head', 1, 100, ` +
        `'unexpected', '2026-07-01T00:00:00.000Z', NULL)`,
    )
  }
  return `
INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES
${installations.map((id) => `  (${id}, 'default', 't', 't')`).join(",\n")};
INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES
${repos.map((row) => `  (${row.repoId}, ${row.installationId}, 'fixture/repo-${row.repoId}', 't')`).join(",\n")};
INSERT INTO usage_ledger
  (installation_id, repo_id, pr_number, head_sha, model_calls, tokens,
   author_login, created_at, author_github_user_id)
VALUES
${usageRows.map((row) => `  ${row}`).join(",\n")};
`
}

async function seed(fixture: WranglerFixture, sql: string): Promise<void> {
  const path = join(fixture.root, "seed.sql")
  await writeFile(path, sql)
  await runWrangler(fixture, [
    "d1",
    "execute",
    "sigilix-platform",
    "--local",
    "--persist-to",
    fixture.persist,
    "--file",
    path,
  ])
}

async function query<T>(fixture: WranglerFixture, sql: string): Promise<T[]> {
  const stdout = await runWrangler(fixture, [
    "d1",
    "execute",
    "sigilix-platform",
    "--local",
    "--persist-to",
    fixture.persist,
    "--json",
    "--command",
    sql,
  ])
  const result = JSON.parse(stdout) as Array<{ success?: boolean; results?: T[] }>
  if (result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0].results)) {
    throw new Error("unexpected Wrangler query result")
  }
  return result[0].results
}

async function stage0030(fixture: WranglerFixture): Promise<void> {
  await copyFile(
    join(REPO_ROOT, "migrations/0030_backfill_usage_author_github_identity.sql"),
    join(fixture.migrations, "0030_backfill_usage_author_github_identity.sql"),
  )
}

describe("historical usage author identity through real Wrangler migrations", () => {
  const migration0030 = migration("0030_backfill_usage_author_github_identity.sql")
  const mapping = parseMapping(migration0030)

  it("applies the exact mapping and records a clean migration", async () => {
    const fixture = await makeFixture()
    try {
      await seed(fixture, seedSql(mapping))
      await stage0030(fixture)

      await runWrangler(fixture, [
        "d1",
        "migrations",
        "apply",
        "sigilix-platform",
        "--local",
        "--persist-to",
        fixture.persist,
      ])

      await expect(
        query(
          fixture,
          `SELECT
             SUM(CASE WHEN installation_id IN (134811639, 145489160)
                       AND author_github_user_id IS NULL THEN 1 ELSE 0 END) AS mapped_unresolved,
             SUM(CASE WHEN installation_id = 777777777
                       AND author_github_user_id IS NULL THEN 1 ELSE 0 END) AS unmapped_unresolved
           FROM usage_ledger`,
        ),
      ).resolves.toEqual([{ mapped_unresolved: 0, unmapped_unresolved: 1 }])
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name LIKE '0030_%'"),
      ).resolves.toEqual([{ applied: 1 }])
      await expect(
        query(
          fixture,
          "SELECT COUNT(*) AS objects FROM sqlite_master" +
            " WHERE name LIKE 'usage_author_identity_backfill_%_0030'" +
            " OR name = 'trg_usage_author_identity_backfill_guard_0030'",
        ),
      ).resolves.toEqual([{ objects: 0 }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 60_000)

  it("rolls back data and staging objects when a precondition fails", async () => {
    const fixture = await makeFixture()
    try {
      await seed(fixture, seedSql(mapping, true))
      await stage0030(fixture)

      await expect(
        runWrangler(fixture, [
          "d1",
          "migrations",
          "apply",
          "sigilix-platform",
          "--local",
          "--persist-to",
          fixture.persist,
        ]),
      ).rejects.toThrow(/migration_0030_preconditions/u)

      await expect(
        query(fixture, "SELECT COUNT(*) AS unresolved FROM usage_ledger WHERE author_github_user_id IS NULL"),
      ).resolves.toEqual([{ unresolved: 146 }])
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name LIKE '0030_%'"),
      ).resolves.toEqual([{ applied: 0 }])
      await expect(
        query(
          fixture,
          "SELECT COUNT(*) AS objects FROM sqlite_master" +
            " WHERE name LIKE 'usage_author_identity_backfill_%_0030'" +
            " OR name = 'trg_usage_author_identity_backfill_guard_0030'",
        ),
      ).resolves.toEqual([{ objects: 0 }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 60_000)
})
