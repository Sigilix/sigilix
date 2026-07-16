import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, "..")
const WRANGLER = join(REPO_ROOT, "node_modules/.bin/wrangler")
const MIGRATION_NAME = "0031_create_org_activity_seat_assignment.sql"

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
  const root = await mkdtemp(join(tmpdir(), "sigilix-m0031-"))
  const migrations = join(root, "migrations")
  const persist = join(root, "state")
  const config = join(root, "wrangler.toml")
  await mkdir(migrations)
  await mkdir(persist)
  await writeFile(
    config,
    `name = "sigilix-m0031-test"
compatibility_date = "2026-07-15"

[[d1_databases]]
binding = "DB"
database_name = "sigilix-platform"
database_id = "00000000-0000-0000-0000-000000000031"
migrations_dir = "migrations"
`,
  )
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0029_add_usage_author_github_identity.sql",
    "0030_backfill_usage_author_github_identity.sql",
  ]) {
    await copyFile(join(REPO_ROOT, "migrations", name), join(migrations, name))
  }
  const fixture = { root, migrations, persist, config }
  await applyMigrations(fixture)
  return fixture
}

async function applyMigrations(fixture: WranglerFixture): Promise<string> {
  return runWrangler(fixture, [
    "d1",
    "migrations",
    "apply",
    "sigilix-platform",
    "--local",
    "--persist-to",
    fixture.persist,
  ])
}

async function stage0031(fixture: WranglerFixture): Promise<void> {
  await copyFile(join(REPO_ROOT, "migrations", MIGRATION_NAME), join(fixture.migrations, MIGRATION_NAME))
}

async function execute(fixture: WranglerFixture, sql: string): Promise<string> {
  return runWrangler(fixture, [
    "d1",
    "execute",
    "sigilix-platform",
    "--local",
    "--persist-to",
    fixture.persist,
    "--command",
    sql,
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

function insertAssignment(
  installationId: number,
  githubUserId: string,
  assigned = 1,
  isAdmin = 1,
  actorGithubUserId = "111",
): string {
  return `INSERT INTO org_activity_seat_assignment (
    installation_id, github_user_id, assigned, is_admin, last_known_login,
    created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login
  ) VALUES (
    ${installationId}, '${githubUserId}', ${assigned}, ${isAdmin}, 'old-name',
    '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z',
    '${actorGithubUserId}', 'admin-name'
  )`
}

describe("organization activity seat identity through real Wrangler migrations", () => {
  // Cloudflare Workers Builds can run this real-Wrangler path past 60 seconds.
  it("applies an exact-installation immutable assignment schema", async () => {
    const fixture = await makeFixture()
    try {
      await execute(
        fixture,
        "INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES" +
          " (42, 'default', 't', 't'), (99, 'default', 't', 't')",
      )
      await stage0031(fixture)
      await applyMigrations(fixture)

      await execute(fixture, insertAssignment(42, "222"))
      await execute(fixture, insertAssignment(99, "222"))

      await expect(
        query(
          fixture,
          `SELECT installation_id, github_user_id, assigned, is_admin, last_known_login,
                  updated_by_actor_github_user_id, updated_by_actor_login
             FROM org_activity_seat_assignment
            ORDER BY installation_id`,
        ),
      ).resolves.toEqual([
        {
          installation_id: 42,
          github_user_id: "222",
          assigned: 1,
          is_admin: 1,
          last_known_login: "old-name",
          updated_by_actor_github_user_id: "111",
          updated_by_actor_login: "admin-name",
        },
        {
          installation_id: 99,
          github_user_id: "222",
          assigned: 1,
          is_admin: 1,
          last_known_login: "old-name",
          updated_by_actor_github_user_id: "111",
          updated_by_actor_login: "admin-name",
        },
      ])

      await execute(
        fixture,
        `UPDATE org_activity_seat_assignment
            SET last_known_login = 'new-name', assigned = 0, is_admin = 0,
                updated_at = '2026-07-16T01:00:00.000Z',
                updated_by_actor_github_user_id = '333',
                updated_by_actor_login = 'next-admin'
          WHERE installation_id = 42 AND github_user_id = '222'`,
      )
      await expect(
        query(
          fixture,
          `SELECT assigned, is_admin, last_known_login, updated_by_actor_github_user_id
             FROM org_activity_seat_assignment
            WHERE installation_id = 42 AND github_user_id = '222'`,
        ),
      ).resolves.toEqual([
        {
          assigned: 0,
          is_admin: 0,
          last_known_login: "new-name",
          updated_by_actor_github_user_id: "333",
        },
      ])

      await expect(execute(fixture, insertAssignment(42, "222"))).rejects.toThrow()
      for (const githubUserId of ["0", "01", "not-a-number", "9007199254740992"]) {
        await expect(execute(fixture, insertAssignment(42, githubUserId))).rejects.toThrow()
      }
      await expect(execute(fixture, insertAssignment(42, "444", 2))).rejects.toThrow()
      await expect(execute(fixture, insertAssignment(42, "444", 1, 2))).rejects.toThrow()
      await expect(execute(fixture, insertAssignment(42, "444", 1, 1, "0"))).rejects.toThrow()
      await expect(execute(fixture, insertAssignment(777, "444"))).rejects.toThrow()
      await expect(execute(fixture, insertAssignment(9_007_199_254_740_992, "444"))).rejects.toThrow()
      await expect(
        execute(
          fixture,
          "UPDATE org_activity_seat_assignment SET github_user_id = '444'" +
            " WHERE installation_id = 42 AND github_user_id = '222'",
        ),
      ).rejects.toThrow(/identity is immutable/u)
      await expect(
        execute(
          fixture,
          "UPDATE org_activity_seat_assignment SET installation_id = 99" +
            " WHERE installation_id = 42 AND github_user_id = '222'",
        ),
      ).rejects.toThrow(/identity is immutable/u)
      await expect(
        execute(
          fixture,
          "UPDATE org_activity_seat_assignment SET created_at = 'later'" +
            " WHERE installation_id = 42 AND github_user_id = '222'",
        ),
      ).rejects.toThrow(/identity is immutable/u)

      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 1 }])
      await expect(
        query(
          fixture,
          `SELECT name, type FROM sqlite_master
            WHERE name IN (
              'org_activity_seat_assignment',
              'idx_org_activity_seat_assignment_scan',
              'trg_org_activity_seat_assignment_identity_immutable'
            ) ORDER BY name`,
        ),
      ).resolves.toEqual([
        { name: "idx_org_activity_seat_assignment_scan", type: "index" },
        { name: "org_activity_seat_assignment", type: "table" },
        { name: "trg_org_activity_seat_assignment_identity_immutable", type: "trigger" },
      ])
      await expect(query(fixture, "PRAGMA foreign_key_check")).resolves.toEqual([])
      await expect(query(fixture, "PRAGMA quick_check")).resolves.toEqual([{ quick_check: "ok" }])

      await expect(applyMigrations(fixture)).resolves.toMatch(/No migrations to apply/u)
      await expect(query(fixture, "SELECT COUNT(*) AS rows FROM org_activity_seat_assignment")).resolves.toEqual([
        { rows: 2 },
      ])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)

  it("rolls back a partial 0031 attempt and succeeds on retry", async () => {
    const fixture = await makeFixture()
    try {
      await execute(
        fixture,
        "CREATE TABLE migration_index_conflict (id INTEGER);" +
          " CREATE INDEX idx_org_activity_seat_assignment_scan ON migration_index_conflict(id)",
      )
      await stage0031(fixture)

      await expect(applyMigrations(fixture)).rejects.toThrow(/idx_org_activity_seat_assignment_scan/u)
      await expect(
        query(
          fixture,
          "SELECT COUNT(*) AS objects FROM sqlite_master" +
            " WHERE name IN ('org_activity_seat_assignment'," +
            " 'trg_org_activity_seat_assignment_identity_immutable')",
        ),
      ).resolves.toEqual([{ objects: 0 }])
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 0 }])

      await execute(fixture, "DROP INDEX idx_org_activity_seat_assignment_scan")
      await expect(applyMigrations(fixture)).resolves.toMatch(new RegExp(MIGRATION_NAME, "u"))
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 1 }])
      await expect(
        query(fixture, "SELECT COUNT(*) AS tables FROM sqlite_master WHERE name = 'org_activity_seat_assignment'"),
      ).resolves.toEqual([{ tables: 1 }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 60_000)
})
