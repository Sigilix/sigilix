import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { decodeOrgSeatBillingOperationRow } from "@/src/features/billing/domain/seat-reconciliation"

const exec = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, "..")
const WRANGLER = join(REPO_ROOT, "node_modules/.bin/wrangler")
const MIGRATION_NAME = "0032_extend_org_seat_billing_operation_activity_identity.sql"

const OLD_OPERATION_COLUMNS = [
  "operation_id",
  "installation_id",
  "revision",
  "login",
  "requested_assigned",
  "previous_assigned",
  "desired_quantity",
  "state",
  "stripe_subscription_id",
  "stripe_subscription_item_id",
  "stripe_observed_quantity",
  "idempotency_key",
  "attempts",
  "error_code",
  "next_attempt_at_ms",
  "created_at_ms",
  "updated_at_ms",
  "stripe_applied_at_ms",
  "completed_at_ms",
  "actor_login",
  "target_is_admin",
  "target_identity_kind",
  "target_github_user_id",
] as const

const OPERATION_OBJECTS = [
  "idx_org_seat_billing_operation_active",
  "idx_org_seat_billing_operation_activity_target",
  "idx_org_seat_billing_operation_history",
  "idx_org_seat_billing_operation_managed_target",
  "idx_org_seat_billing_operation_recovery",
  "idx_org_seat_billing_operation_revision",
  "org_seat_billing_operation",
  "trg_org_seat_billing_operation_active_context_insert",
  "trg_org_seat_billing_operation_active_context_update",
  "trg_org_seat_billing_operation_target_identity_insert",
  "trg_org_seat_billing_operation_target_identity_update",
  "trg_org_seat_billing_operation_target_immutable",
] as const

const UNCHANGED_OPERATION_OBJECTS = [
  "idx_org_seat_billing_operation_active",
  "idx_org_seat_billing_operation_history",
  "idx_org_seat_billing_operation_managed_target",
  "idx_org_seat_billing_operation_recovery",
  "idx_org_seat_billing_operation_revision",
  "trg_org_seat_billing_operation_active_context_insert",
  "trg_org_seat_billing_operation_active_context_update",
] as const

type OperationState = "pending" | "stripe_applied" | "committed" | "failed" | "canceled"
type OldIdentityKind = "legacy_login" | "managed_github"

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
  const root = await mkdtemp(join(tmpdir(), "sigilix-m0032-"))
  const migrations = join(root, "migrations")
  const persist = join(root, "state")
  const config = join(root, "wrangler.toml")
  await mkdir(migrations)
  await mkdir(persist)
  await writeFile(
    config,
    `name = "sigilix-m0032-test"
compatibility_date = "2026-07-15"

[[d1_databases]]
binding = "DB"
database_name = "sigilix-platform"
database_id = "00000000-0000-0000-0000-000000000032"
migrations_dir = "migrations"
`,
  )
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
    "0031_create_org_activity_seat_assignment.sql",
  ]) {
    await copyFile(join(REPO_ROOT, "migrations", name), join(migrations, name))
  }
  const fixture = { root, migrations, persist, config }
  await applyMigrations(fixture)
  return fixture
}

async function stage0032(fixture: WranglerFixture): Promise<void> {
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

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL"
  if (typeof value === "number") return String(value)
  return `'${value.replaceAll("'", "''")}'`
}

function oldOperationValues(kind: OldIdentityKind, state: OperationState, index: number): string {
  const installationId = 101 + index
  const desiredQuantity = 10 + index
  const active = state === "pending" || state === "stripe_applied"
  const stripeApplied = state === "stripe_applied" || state === "committed"
  const terminal = state === "committed" || state === "failed" || state === "canceled"
  const failed = state === "failed" || state === "canceled"
  const values: Array<string | number | null> = [
    `${kind}-${state}`,
    installationId,
    index + 1,
    `${kind}-${state}-login`,
    1,
    0,
    desiredQuantity,
    state,
    `sub-${index}`,
    `si-${index}`,
    state === "pending" ? desiredQuantity - 1 : stripeApplied ? desiredQuantity : null,
    `idem-${kind}-${state}`,
    index,
    failed ? `${state}-reason` : null,
    active ? 1_000 + index : null,
    100 + index,
    200 + index,
    stripeApplied ? 300 + index : null,
    terminal ? 400 + index : null,
    active ? `actor-${index}` : null,
    active ? index % 2 : null,
    kind,
    kind === "managed_github" ? String(2_000 + index) : null,
  ]
  return `(${values.map(sqlValue).join(", ")})`
}

async function seedOldOperations(fixture: WranglerFixture): Promise<void> {
  const tenantIds = [...Array.from({ length: 10 }, (_, index) => 101 + index), 200, 201, 202, 203, 204, 205]
  await execute(
    fixture,
    `INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES ${tenantIds
      .map((id) => `(${id}, 'teams', 't', 't')`)
      .join(", ")}`,
  )
  const states: OperationState[] = ["pending", "stripe_applied", "committed", "failed", "canceled"]
  const rows = states.flatMap((state, stateIndex) =>
    (["legacy_login", "managed_github"] as const).map((kind, kindIndex) =>
      oldOperationValues(kind, state, stateIndex * 2 + kindIndex),
    ),
  )
  await execute(
    fixture,
    `INSERT INTO org_seat_billing_operation (${OLD_OPERATION_COLUMNS.join(", ")}) VALUES ${rows.join(", ")}`,
  )
}

function pendingOldOperation(args: {
  operationId: string
  installationId: number
  revision: number
  kind: OldIdentityKind
  targetGithubUserId?: string
}): string {
  const target = args.kind === "managed_github" ? sqlValue(args.targetGithubUserId ?? "700") : "NULL"
  return `INSERT INTO org_seat_billing_operation (
    operation_id, installation_id, revision, login, requested_assigned, previous_assigned,
    desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
    stripe_observed_quantity, idempotency_key, attempts, next_attempt_at_ms,
    created_at_ms, updated_at_ms, actor_login, target_is_admin,
    target_identity_kind, target_github_user_id
  ) VALUES (
    '${args.operationId}', ${args.installationId}, ${args.revision}, 'old-writer', 1, 0,
    2, 'pending', 'sub-old', 'si-old', 1, 'idem-${args.operationId}', 0, 2,
    1, 1, 'owner', 0, '${args.kind}', ${target}
  )`
}

function activityOperation(args: {
  operationId: string
  installationId: number
  revision: number
  targetGithubUserId?: string | null
  actorGithubUserId?: string | null
  state?: "pending" | "canceled"
}): string {
  const state = args.state ?? "pending"
  const pending = state === "pending"
  return `INSERT INTO org_seat_billing_operation (
    operation_id, installation_id, revision, login, requested_assigned, previous_assigned,
    desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
    stripe_observed_quantity, idempotency_key, attempts, error_code, next_attempt_at_ms,
    created_at_ms, updated_at_ms, stripe_applied_at_ms, completed_at_ms,
    actor_login, target_is_admin, target_identity_kind, target_github_user_id,
    activity_actor_github_user_id
  ) VALUES (
    '${args.operationId}', ${args.installationId}, ${args.revision}, 'activity-user', 1, 0,
    2, '${state}', 'sub-activity', 'si-activity', ${pending ? "1" : "NULL"},
    'idem-${args.operationId}', 0, ${pending ? "NULL" : "'canceled-for-test'"},
    ${pending ? "2" : "NULL"}, 1, 1, NULL, ${pending ? "NULL" : "3"},
    ${pending ? "'activity-admin'" : "NULL"}, ${pending ? "0" : "NULL"},
    'activity_github', ${sqlValue(args.targetGithubUserId === undefined ? "800" : args.targetGithubUserId)},
    ${sqlValue(args.actorGithubUserId === undefined ? "900" : args.actorGithubUserId)}
  )`
}

function withoutActivityActor<T extends Record<string, unknown>>(row: T): Omit<T, "activity_actor_github_user_id"> {
  const copy = { ...row }
  delete copy.activity_actor_github_user_id
  return copy
}

describe("activity identity in durable seat operations through real Wrangler migrations", () => {
  it("preserves old operations and enforces one fail-closed identity union", async () => {
    const fixture = await makeFixture()
    try {
      await seedOldOperations(fixture)
      const before = await query<Record<string, unknown>>(
        fixture,
        `SELECT ${OLD_OPERATION_COLUMNS.join(", ")} FROM org_seat_billing_operation ORDER BY operation_id`,
      )
      const beforeColumns = await query<Record<string, unknown>>(
        fixture,
        "PRAGMA table_info(org_seat_billing_operation)",
      )
      const beforeForeignKeys = await query<Record<string, unknown>>(
        fixture,
        "PRAGMA foreign_key_list(org_seat_billing_operation)",
      )
      const beforeUnchangedObjects = await query<Record<string, unknown>>(
        fixture,
        `SELECT name, type, sql FROM sqlite_master
          WHERE name IN (${UNCHANGED_OPERATION_OBJECTS.map(sqlValue).join(", ")}) ORDER BY name`,
      )

      await stage0032(fixture)
      await applyMigrations(fixture)

      const after = await query<Record<string, unknown>>(
        fixture,
        `SELECT ${OLD_OPERATION_COLUMNS.join(", ")}, activity_actor_github_user_id
           FROM org_seat_billing_operation ORDER BY operation_id`,
      )
      expect(after.map(withoutActivityActor)).toEqual(before)
      expect(after.every((row) => row.activity_actor_github_user_id === null)).toBe(true)

      const columns = await query<Record<string, unknown>>(fixture, "PRAGMA table_info(org_seat_billing_operation)")
      expect(columns.map((column) => column.name)).toEqual([...OLD_OPERATION_COLUMNS, "activity_actor_github_user_id"])
      expect(columns.slice(0, OLD_OPERATION_COLUMNS.length)).toEqual(beforeColumns)
      expect(columns.find((column) => column.name === "target_identity_kind")?.dflt_value).toBe("'legacy_login'")
      expect(columns.find((column) => column.name === "activity_actor_github_user_id")?.dflt_value).toBeNull()

      await expect(
        query(
          fixture,
          `SELECT name, type FROM sqlite_master WHERE name IN (${OPERATION_OBJECTS.map(sqlValue).join(", ")})
             ORDER BY name`,
        ),
      ).resolves.toEqual(
        [...OPERATION_OBJECTS].sort().map((name) => ({
          name,
          type: name.startsWith("idx_") ? "index" : name.startsWith("trg_") ? "trigger" : "table",
        })),
      )

      const tableSql = await query<{ sql: string }>(
        fixture,
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'org_seat_billing_operation'",
      )
      expect(tableSql[0]?.sql).toContain("'legacy_login', 'managed_github', 'activity_github'")
      expect(tableSql[0]?.sql).toContain("activity_actor_github_user_id")

      const namedIndexes = (
        await query<{ name: string; unique: number; partial: number }>(
          fixture,
          "PRAGMA index_list(org_seat_billing_operation)",
        )
      )
        .filter((index) => index.name.startsWith("idx_"))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, unique, partial }) => ({ name, unique, partial }))
      expect(namedIndexes).toEqual([
        { name: "idx_org_seat_billing_operation_active", unique: 1, partial: 1 },
        { name: "idx_org_seat_billing_operation_activity_target", unique: 0, partial: 1 },
        { name: "idx_org_seat_billing_operation_history", unique: 0, partial: 0 },
        { name: "idx_org_seat_billing_operation_managed_target", unique: 0, partial: 1 },
        { name: "idx_org_seat_billing_operation_recovery", unique: 0, partial: 1 },
        { name: "idx_org_seat_billing_operation_revision", unique: 1, partial: 0 },
      ])
      await expect(query(fixture, "PRAGMA foreign_key_list(org_seat_billing_operation)")).resolves.toContainEqual(
        expect.objectContaining({ table: "tenant", from: "installation_id", to: "installation_id" }),
      )
      await expect(query(fixture, "PRAGMA foreign_key_list(org_seat_billing_operation)")).resolves.toEqual(
        beforeForeignKeys,
      )
      await expect(
        query(
          fixture,
          `SELECT name, type, sql FROM sqlite_master
            WHERE name IN (${UNCHANGED_OPERATION_OBJECTS.map(sqlValue).join(", ")}) ORDER BY name`,
        ),
      ).resolves.toEqual(beforeUnchangedObjects)
      await expect(
        query(
          fixture,
          `SELECT name FROM sqlite_master WHERE type = 'table'
            AND name IN ('org_activity_seat_assignment', 'org_workspace_seat_assignment') ORDER BY name`,
        ),
      ).resolves.toEqual([{ name: "org_activity_seat_assignment" }, { name: "org_workspace_seat_assignment" }])

      await expect(
        execute(
          fixture,
          `UPDATE org_seat_billing_operation
              SET state = 'stripe_applied', stripe_observed_quantity = desired_quantity,
                  stripe_applied_at_ms = 500, next_attempt_at_ms = 501
            WHERE operation_id = 'legacy_login-pending'`,
        ),
      ).resolves.toBeDefined()
      await expect(
        execute(
          fixture,
          `UPDATE org_seat_billing_operation
              SET state = 'committed', completed_at_ms = 502, next_attempt_at_ms = NULL
            WHERE operation_id = 'managed_github-stripe_applied'`,
        ),
      ).resolves.toBeDefined()

      await expect(
        execute(fixture, activityOperation({ operationId: "blocked-by-legacy", installationId: 101, revision: 50 })),
      ).rejects.toThrow()
      await expect(
        execute(fixture, activityOperation({ operationId: "activity-active", installationId: 200, revision: 1 })),
      ).resolves.toBeDefined()
      const oldWorkerActivity = await query<Record<string, unknown>>(
        fixture,
        `SELECT ${OLD_OPERATION_COLUMNS.join(", ")} FROM org_seat_billing_operation
          WHERE operation_id = 'activity-active'`,
      )
      expect(decodeOrgSeatBillingOperationRow(oldWorkerActivity[0])).toBeNull()
      await expect(
        execute(
          fixture,
          pendingOldOperation({
            operationId: "legacy-blocked",
            installationId: 200,
            revision: 2,
            kind: "legacy_login",
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          pendingOldOperation({
            operationId: "managed-active",
            installationId: 201,
            revision: 1,
            kind: "managed_github",
          }),
        ),
      ).resolves.toBeDefined()
      await expect(
        execute(fixture, activityOperation({ operationId: "activity-blocked", installationId: 201, revision: 2 })),
      ).rejects.toThrow()

      await expect(
        execute(
          fixture,
          "UPDATE org_seat_billing_operation SET activity_actor_github_user_id = '901' WHERE operation_id = 'activity-active'",
        ),
      ).rejects.toThrow(/target identity is immutable/u)
      await expect(
        execute(
          fixture,
          "UPDATE org_seat_billing_operation SET target_github_user_id = '801' WHERE operation_id = 'activity-active'",
        ),
      ).rejects.toThrow(/target identity is immutable/u)
      await expect(
        execute(
          fixture,
          `UPDATE org_seat_billing_operation
              SET state = 'stripe_applied', stripe_observed_quantity = desired_quantity,
                  stripe_applied_at_ms = 3, next_attempt_at_ms = 4
            WHERE operation_id = 'activity-active'`,
        ),
      ).resolves.toBeDefined()
      await expect(
        execute(
          fixture,
          `UPDATE org_seat_billing_operation
              SET state = 'committed', completed_at_ms = 5, next_attempt_at_ms = NULL
            WHERE operation_id = 'activity-active'`,
        ),
      ).resolves.toBeDefined()

      await expect(
        execute(
          fixture,
          pendingOldOperation({
            operationId: "old-legacy-compatible",
            installationId: 200,
            revision: 2,
            kind: "legacy_login",
          }),
        ),
      ).resolves.toBeDefined()
      await expect(
        execute(
          fixture,
          pendingOldOperation({
            operationId: "old-managed-compatible",
            installationId: 203,
            revision: 1,
            kind: "managed_github",
          }),
        ),
      ).resolves.toBeDefined()

      for (const invalid of ["0", "01", "not-a-number", "9007199254740992"]) {
        await expect(
          execute(
            fixture,
            activityOperation({
              operationId: `bad-target-${invalid}`,
              installationId: 204,
              revision: 1,
              targetGithubUserId: invalid,
            }),
          ),
        ).rejects.toThrow()
        await expect(
          execute(
            fixture,
            activityOperation({
              operationId: `bad-actor-${invalid}`,
              installationId: 204,
              revision: 1,
              actorGithubUserId: invalid,
            }),
          ),
        ).rejects.toThrow()
      }
      await expect(
        execute(
          fixture,
          activityOperation({
            operationId: "missing-target",
            installationId: 204,
            revision: 1,
            targetGithubUserId: null,
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          activityOperation({
            operationId: "missing-actor",
            installationId: 204,
            revision: 1,
            actorGithubUserId: null,
          }),
        ),
      ).rejects.toThrow()

      await expect(
        execute(
          fixture,
          `${pendingOldOperation({ operationId: "legacy-with-activity-actor", installationId: 204, revision: 1, kind: "legacy_login" })}
           RETURNING operation_id`,
        ),
      ).resolves.toBeDefined()
      await expect(
        execute(
          fixture,
          "UPDATE org_seat_billing_operation SET activity_actor_github_user_id = '999'" +
            " WHERE operation_id = 'legacy-with-activity-actor'",
        ),
      ).rejects.toThrow()

      await expect(
        execute(
          fixture,
          activityOperation({ operationId: "activity-terminal", installationId: 202, revision: 1, state: "canceled" }),
        ),
      ).resolves.toBeDefined()
      await expect(
        execute(
          fixture,
          pendingOldOperation({
            operationId: "revision-collision",
            installationId: 202,
            revision: 1,
            kind: "legacy_login",
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          pendingOldOperation({ operationId: "revision-next", installationId: 202, revision: 2, kind: "legacy_login" }),
        ),
      ).resolves.toBeDefined()

      await expect(query(fixture, "PRAGMA foreign_key_check")).resolves.toEqual([])
      await expect(query(fixture, "PRAGMA quick_check")).resolves.toEqual([{ quick_check: "ok" }])
      await expect(applyMigrations(fixture)).resolves.toMatch(/No migrations to apply/u)
      await expect(query(fixture, "SELECT COUNT(*) AS rows FROM org_seat_billing_operation")).resolves.toEqual([
        { rows: 17 },
      ])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
    // Cloudflare Workers Builds measured about 4.2x slower on the same
    // real-Wrangler path; 240s covers the 38-52s local range with headroom.
  }, 240_000)

  it("rolls back a late object collision and succeeds unchanged on retry", async () => {
    const fixture = await makeFixture()
    try {
      await seedOldOperations(fixture)
      const before = await query<Record<string, unknown>>(
        fixture,
        `SELECT ${OLD_OPERATION_COLUMNS.join(", ")} FROM org_seat_billing_operation ORDER BY operation_id`,
      )
      await execute(
        fixture,
        "CREATE TABLE migration_index_conflict (id INTEGER);" +
          " CREATE INDEX idx_org_seat_billing_operation_activity_target ON migration_index_conflict(id)",
      )
      await stage0032(fixture)

      await expect(applyMigrations(fixture)).rejects.toThrow(/idx_org_seat_billing_operation_activity_target/u)
      await expect(
        query<{ name: string }>(fixture, "PRAGMA table_info(org_seat_billing_operation)"),
      ).resolves.not.toContainEqual({ name: "activity_actor_github_user_id" })
      await expect(
        query(
          fixture,
          `SELECT ${OLD_OPERATION_COLUMNS.join(", ")} FROM org_seat_billing_operation ORDER BY operation_id`,
        ),
      ).resolves.toEqual(before)
      await expect(
        query(
          fixture,
          "SELECT tbl_name FROM sqlite_master WHERE type = 'index'" +
            " AND name = 'idx_org_seat_billing_operation_activity_target'",
        ),
      ).resolves.toEqual([{ tbl_name: "migration_index_conflict" }])
      await expect(
        query(fixture, `SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '${MIGRATION_NAME}'`),
      ).resolves.toEqual([{ applied: 0 }])
      await expect(
        query(
          fixture,
          "SELECT COUNT(*) AS objects FROM sqlite_master" +
            " WHERE name IN ('idx_org_seat_billing_operation_active'," +
            " 'idx_org_seat_billing_operation_managed_target'," +
            " 'trg_org_seat_billing_operation_target_immutable')",
        ),
      ).resolves.toEqual([{ objects: 3 }])

      await execute(fixture, "DROP INDEX idx_org_seat_billing_operation_activity_target")
      await expect(applyMigrations(fixture)).resolves.toMatch(new RegExp(MIGRATION_NAME, "u"))
      await expect(
        query(fixture, `SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '${MIGRATION_NAME}'`),
      ).resolves.toEqual([{ applied: 1 }])
      await expect(
        query(
          fixture,
          `SELECT ${OLD_OPERATION_COLUMNS.join(", ")} FROM org_seat_billing_operation ORDER BY operation_id`,
        ),
      ).resolves.toEqual(before)
      await expect(
        query<{ name: string }>(fixture, "PRAGMA table_info(org_seat_billing_operation)"),
      ).resolves.toContainEqual(expect.objectContaining({ name: "activity_actor_github_user_id" }))
      await expect(query(fixture, "PRAGMA foreign_key_check")).resolves.toEqual([])
      await expect(query(fixture, "PRAGMA quick_check")).resolves.toEqual([{ quick_check: "ok" }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 90_000)
})
