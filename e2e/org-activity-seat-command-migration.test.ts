import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, "..")
const WRANGLER = join(REPO_ROOT, "node_modules/.bin/wrangler")
const MIGRATION_NAME = "0034_create_org_activity_seat_command.sql"

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

async function makeFixture(): Promise<WranglerFixture> {
  const root = await mkdtemp(join(tmpdir(), "sigilix-m0034-"))
  const migrations = join(root, "migrations")
  const persist = join(root, "state")
  const config = join(root, "wrangler.toml")
  await mkdir(migrations)
  await mkdir(persist)
  await writeFile(
    config,
    `name = "sigilix-m0034-test"
compatibility_date = "2026-07-16"

[[d1_databases]]
binding = "DB"
database_name = "sigilix-platform"
database_id = "00000000-0000-0000-0000-000000000034"
migrations_dir = "migrations"
`,
  )
  await copyFile(
    join(REPO_ROOT, "migrations", "0001_create_tenant_repo_usage.sql"),
    join(migrations, "0001_create_tenant_repo_usage.sql"),
  )
  const fixture = { root, migrations, persist, config }
  await applyMigrations(fixture)
  return fixture
}

async function stage0034(fixture: WranglerFixture): Promise<void> {
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

function insertCommand(args: {
  deliveryId: string
  payloadSha256: string
  installationId?: number
  repositoryId?: number
  prNumber?: number
  action?: string
  targetId?: string
  actorId?: string
  association?: string
  receivedAtMs?: number
}): string {
  return `INSERT INTO org_activity_seat_command (
    delivery_id, payload_sha256, installation_id, repository_id, pr_number,
    head_sha, action, target_github_user_id, target_login,
    actor_github_user_id, actor_login, author_association, received_at_ms
  ) VALUES (
    '${args.deliveryId}', '${args.payloadSha256}', ${args.installationId ?? 42},
    ${args.repositoryId ?? 9001}, ${args.prNumber ?? 7}, '${"b".repeat(40)}',
    '${args.action ?? "opened"}', '${args.targetId ?? "111"}', 'target',
    '${args.actorId ?? "222"}', 'actor', '${args.association ?? "MEMBER"}',
    ${args.receivedAtMs ?? 1000}
  )`
}

describe("organization activity command ledger through real Wrangler migrations", () => {
  it("applies immutable exact-installation webhook evidence", async () => {
    const fixture = await makeFixture()
    try {
      await execute(
        fixture,
        "INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES" +
          " (42, 'default', 't', 't'), (99, 'default', 't', 't')",
      )
      await stage0034(fixture)
      await applyMigrations(fixture)

      await execute(fixture, insertCommand({ deliveryId: "delivery-1", payloadSha256: "a".repeat(64) }))
      await execute(
        fixture,
        insertCommand({
          deliveryId: "delivery-2",
          payloadSha256: "c".repeat(64),
          installationId: 99,
        }),
      )

      await expect(
        query(
          fixture,
          `SELECT delivery_id, installation_id, repository_id, pr_number, action,
                  target_github_user_id, actor_github_user_id, author_association,
                  received_at_ms
             FROM org_activity_seat_command ORDER BY installation_id`,
        ),
      ).resolves.toEqual([
        {
          delivery_id: "delivery-1",
          installation_id: 42,
          repository_id: 9001,
          pr_number: 7,
          action: "opened",
          target_github_user_id: "111",
          actor_github_user_id: "222",
          author_association: "MEMBER",
          received_at_ms: 1000,
        },
        {
          delivery_id: "delivery-2",
          installation_id: 99,
          repository_id: 9001,
          pr_number: 7,
          action: "opened",
          target_github_user_id: "111",
          actor_github_user_id: "222",
          author_association: "MEMBER",
          received_at_ms: 1000,
        },
      ])

      await expect(
        execute(fixture, insertCommand({ deliveryId: "delivery-1", payloadSha256: "d".repeat(64) })),
      ).rejects.toThrow()
      await expect(
        execute(fixture, insertCommand({ deliveryId: "delivery-3", payloadSha256: "a".repeat(64) })),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          insertCommand({ deliveryId: "delivery-null", payloadSha256: "3".repeat(64) }).replace(
            "'delivery-null'",
            "NULL",
          ),
        ),
      ).rejects.toThrow()
      for (const [deliveryId, overrides] of [
        ["fractional-repo", { repositoryId: 9001.5 }],
        ["fractional-pr", { prNumber: 7.5 }],
        ["fractional-received", { receivedAtMs: 1000.5 }],
      ] as const) {
        await expect(
          execute(
            fixture,
            insertCommand({
              deliveryId,
              payloadSha256: `${deliveryId.length}`.padStart(64, "0"),
              ...overrides,
            }),
          ),
        ).rejects.toThrow()
      }
      for (const targetId of ["0", "01", "not-a-number", "9007199254740992"]) {
        await expect(
          execute(
            fixture,
            insertCommand({
              deliveryId: `bad-target-${targetId}`,
              payloadSha256: "e".repeat(63) + String(targetId.length % 10),
              targetId,
            }),
          ),
        ).rejects.toThrow()
      }
      await expect(
        execute(
          fixture,
          insertCommand({ deliveryId: "bad-action", payloadSha256: "f".repeat(64), action: "reopened" }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          insertCommand({ deliveryId: "bad-association", payloadSha256: "1".repeat(64), association: "COLLABORATOR" }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          insertCommand({ deliveryId: "missing-tenant", payloadSha256: "2".repeat(64), installationId: 777 }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          "UPDATE org_activity_seat_command SET target_login = 'renamed' WHERE delivery_id = 'delivery-1'",
        ),
      ).rejects.toThrow(/command is immutable/u)
      await expect(
        execute(fixture, "DELETE FROM org_activity_seat_command WHERE delivery_id = 'delivery-1'"),
      ).rejects.toThrow(/command is immutable/u)
      await expect(
        execute(
          fixture,
          insertCommand({
            deliveryId: "delivery-1",
            payloadSha256: "4".repeat(64),
            targetId: "333",
          }).replace("INSERT INTO", "INSERT OR REPLACE INTO"),
        ),
      ).rejects.toThrow(/command already exists/u)

      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 1 }])
      await expect(
        query(
          fixture,
          `SELECT name, type FROM sqlite_master
            WHERE name IN (
              'org_activity_seat_command',
              'idx_org_activity_seat_command_installation_received',
              'idx_org_activity_seat_command_repository_pr',
              'trg_org_activity_seat_command_no_reinsert',
              'trg_org_activity_seat_command_no_update',
              'trg_org_activity_seat_command_no_delete'
            ) ORDER BY name`,
        ),
      ).resolves.toEqual([
        { name: "idx_org_activity_seat_command_installation_received", type: "index" },
        { name: "idx_org_activity_seat_command_repository_pr", type: "index" },
        { name: "org_activity_seat_command", type: "table" },
        { name: "trg_org_activity_seat_command_no_delete", type: "trigger" },
        { name: "trg_org_activity_seat_command_no_reinsert", type: "trigger" },
        { name: "trg_org_activity_seat_command_no_update", type: "trigger" },
      ])
      await expect(query(fixture, "PRAGMA foreign_key_check")).resolves.toEqual([])
      await expect(query(fixture, "PRAGMA quick_check")).resolves.toEqual([{ quick_check: "ok" }])
      await expect(applyMigrations(fixture)).resolves.toMatch(/No migrations to apply/u)
      await expect(query(fixture, "SELECT COUNT(*) AS rows FROM org_activity_seat_command")).resolves.toEqual([
        { rows: 2 },
      ])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)

  it("rolls back a partial 0034 attempt and succeeds on retry", async () => {
    const fixture = await makeFixture()
    try {
      await execute(
        fixture,
        "CREATE TABLE migration_index_conflict (id INTEGER);" +
          " CREATE INDEX idx_org_activity_seat_command_repository_pr ON migration_index_conflict(id)",
      )
      await stage0034(fixture)

      await expect(applyMigrations(fixture)).rejects.toThrow(/idx_org_activity_seat_command_repository_pr/u)
      await expect(
        query(
          fixture,
          "SELECT COUNT(*) AS objects FROM sqlite_master" +
            " WHERE name IN ('org_activity_seat_command'," +
            " 'idx_org_activity_seat_command_installation_received'," +
            " 'trg_org_activity_seat_command_no_update')",
        ),
      ).resolves.toEqual([{ objects: 0 }])
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 0 }])

      await execute(fixture, "DROP INDEX idx_org_activity_seat_command_repository_pr")
      await expect(applyMigrations(fixture)).resolves.toMatch(new RegExp(MIGRATION_NAME, "u"))
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 1 }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)
})
