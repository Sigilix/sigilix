import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, "..")
const WRANGLER = join(REPO_ROOT, "node_modules/.bin/wrangler")
const MIGRATION_NAME = "0033_create_org_activity_seat_readiness.sql"

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
  const root = await mkdtemp(join(tmpdir(), "sigilix-m0033-"))
  const migrations = join(root, "migrations")
  const persist = join(root, "state")
  const config = join(root, "wrangler.toml")
  await mkdir(migrations)
  await mkdir(persist)
  await writeFile(
    config,
    `name = "sigilix-m0033-test"
compatibility_date = "2026-07-16"

[[d1_databases]]
binding = "DB"
database_name = "sigilix-platform"
database_id = "00000000-0000-0000-0000-000000000033"
migrations_dir = "migrations"
`,
  )
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0007_create_org_seat_assignment.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
    "0031_create_org_activity_seat_assignment.sql",
    "0032_extend_org_seat_billing_operation_activity_identity.sql",
  ]) {
    await copyFile(join(REPO_ROOT, "migrations", name), join(migrations, name))
  }
  const fixture = { root, migrations, persist, config }
  await applyMigrations(fixture)
  return fixture
}

async function stageReadinessMigration(fixture: WranglerFixture): Promise<void> {
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

function readinessSql(args: {
  installationId: number
  activationId: string
  leaseAcquiredAtMs: number
  cutoverAtMs: number
  snapshotRevision?: number
  source?: string
  schemaVersion?: number
  actorGithubUserId?: string
}): string {
  return `INSERT INTO org_activity_seat_readiness (
    installation_id, activation_id, activation_source, schema_version,
    cutover_at_ms, cutover_at, activated_by_actor_github_user_id,
    stripe_snapshot_revision, billing_lease_acquired_at_ms
  ) VALUES (
    ${args.installationId}, '${args.activationId}', '${args.source ?? "legacy_backfill_v1"}',
    ${args.schemaVersion ?? 1}, ${args.cutoverAtMs}, '2026-07-16T08:00:00.000Z',
    '${args.actorGithubUserId ?? "111"}', ${args.snapshotRevision ?? 1}, ${args.leaseAcquiredAtMs}
  )`
}

function operationSql(args: {
  installationId: number
  operationId: string
  state: "pending" | "committed" | "canceled"
  identityKind?: "legacy_login" | "managed_github" | "activity_github"
  idempotencyKey?: string
  revision?: number
}): string {
  const kind = args.identityKind ?? "legacy_login"
  const targetId = kind === "legacy_login" ? "NULL" : "'222'"
  const activityActorId = kind === "activity_github" ? "'222'" : "NULL"
  const terminal = args.state !== "pending"
  const stripeAppliedAt = args.state === "committed" ? "140" : "NULL"
  const completedAt = terminal ? "150" : "NULL"
  const errorCode = args.state === "canceled" ? "'canceled_before_cutover'" : "NULL"
  const nextAttempt = args.state === "pending" ? "160" : "NULL"
  const observed = args.state === "canceled" ? "NULL" : "1"
  return `INSERT INTO org_seat_billing_operation (
    operation_id, installation_id, revision, login, target_identity_kind,
    target_github_user_id, activity_actor_github_user_id, actor_login, target_is_admin,
    requested_assigned, previous_assigned, desired_quantity, state,
    stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
    idempotency_key, attempts, error_code, next_attempt_at_ms, created_at_ms,
    updated_at_ms, stripe_applied_at_ms, completed_at_ms
  ) VALUES (
    '${args.operationId}', ${args.installationId}, ${args.revision ?? 2}, 'target', '${kind}',
    ${targetId}, ${activityActorId}, 'actor', 0,
    1, 0, 1, '${args.state}', 'sub_${args.installationId}', 'si_${args.installationId}',
    ${observed}, '${args.idempotencyKey ?? args.operationId}', 0, ${errorCode}, ${nextAttempt},
    120, 150, ${stripeAppliedAt}, ${completedAt}
  )`
}

async function seedInstallations(fixture: WranglerFixture): Promise<void> {
  await execute(
    fixture,
    `INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES
      (42, 'pro', 't', 't'), (43, 'pro', 't', 't'), (99, 'pro', 't', 't');
     INSERT INTO stripe_seat_subscription (
       installation_id, stripe_customer_id, stripe_subscription_id,
       stripe_subscription_item_id, stripe_price_id, subscription_status,
       observed_quantity, derived_quantity, revision, snapshot_state,
       last_refreshed_at_ms, created_at_ms, updated_at_ms
     ) VALUES
       (42, 'cus_42', 'sub_42', 'si_42', 'price_42', 'active', 1, 1, 1, 'ready', 1, 1, 1),
       (43, 'cus_43', 'sub_43', 'si_43', 'price_43', 'active', 1, 1, 1, 'ready', 1, 1, 1),
       (99, 'cus_99', 'sub_99', 'si_99', 'price_99', 'active', 1, 1, 1, 'ready', 1, 1, 1);
     INSERT INTO org_seat_billing_lease
       (installation_id, lease_token, acquired_at_ms, expires_at_ms) VALUES
       (42, 'lease-42', 100, 200), (43, 'lease-43', 300, 400), (99, 'lease-99', 100, 200);`,
  )
}

describe("organization activity-seat readiness through real Wrangler migrations", () => {
  it("creates one exact-installation cutover boundary and closes every legacy write path", async () => {
    const fixture = await makeFixture()
    try {
      await seedInstallations(fixture)
      await stageReadinessMigration(fixture)
      await applyMigrations(fixture)

      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 42,
            activationId: "wrong-lease",
            leaseAcquiredAtMs: 101,
            cutoverAtMs: 150,
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 43,
            activationId: "expired-lease",
            leaseAcquiredAtMs: 300,
            cutoverAtMs: 400,
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 43,
            activationId: "wrong-actor-id",
            leaseAcquiredAtMs: 300,
            cutoverAtMs: 350,
            actorGithubUserId: "00111",
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 43,
            activationId: "wrong-snapshot",
            leaseAcquiredAtMs: 300,
            cutoverAtMs: 350,
            snapshotRevision: 2,
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 43,
            activationId: "wrong-source",
            leaseAcquiredAtMs: 300,
            cutoverAtMs: 350,
            source: "manual",
          }),
        ),
      ).rejects.toThrow()
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 43,
            activationId: "wrong-schema",
            leaseAcquiredAtMs: 300,
            cutoverAtMs: 350,
            schemaVersion: 2,
          }),
        ),
      ).rejects.toThrow()

      await execute(fixture, operationSql({ installationId: 43, operationId: "op-active-43", state: "pending" }))
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 43,
            activationId: "active-operation",
            leaseAcquiredAtMs: 300,
            cutoverAtMs: 350,
          }),
        ),
      ).rejects.toThrow()

      await execute(
        fixture,
        "INSERT INTO org_seat_assignment" +
          " (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (42, 'legacy-admin', 1, 1, 'before', 'actor')",
      )
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 42,
            activationId: "assigned-legacy",
            leaseAcquiredAtMs: 100,
            cutoverAtMs: 150,
          }),
        ),
      ).rejects.toThrow()

      await execute(fixture, "UPDATE org_seat_assignment SET assigned = 0 WHERE installation_id = 42")
      await execute(fixture, operationSql({ installationId: 42, operationId: "op-terminal-42", state: "canceled" }))
      await execute(
        fixture,
        readinessSql({
          installationId: 42,
          activationId: "cutover-42",
          leaseAcquiredAtMs: 100,
          cutoverAtMs: 150,
        }),
      )
      await expect(
        execute(
          fixture,
          readinessSql({
            installationId: 99,
            activationId: "cutover-42",
            leaseAcquiredAtMs: 100,
            cutoverAtMs: 150,
          }),
        ),
      ).rejects.toThrow()

      await expect(
        query(
          fixture,
          "SELECT installation_id, activation_source, schema_version," +
            " billing_lease_acquired_at_ms FROM org_activity_seat_readiness",
        ),
      ).resolves.toEqual([
        {
          installation_id: 42,
          activation_source: "legacy_backfill_v1",
          schema_version: 1,
          billing_lease_acquired_at_ms: 100,
        },
      ])
      await expect(
        execute(
          fixture,
          "INSERT INTO org_seat_assignment" +
            " (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
            " VALUES (42, 'after-cutover', 0, 0, 'after', 'actor')",
        ),
      ).rejects.toThrow(/legacy seat assignment is closed/u)
      await expect(
        execute(fixture, "UPDATE org_seat_assignment SET updated_at = 'after' WHERE installation_id = 42"),
      ).rejects.toThrow(/legacy seat assignment is closed/u)
      await expect(execute(fixture, "DELETE FROM org_seat_assignment WHERE installation_id = 42")).rejects.toThrow(
        /legacy seat assignment is closed/u,
      )
      await expect(
        execute(
          fixture,
          operationSql({
            installationId: 42,
            operationId: "op-new-legacy-42",
            state: "pending",
          }),
        ),
      ).rejects.toThrow(/legacy seat billing operation is closed/u)
      await expect(
        execute(
          fixture,
          `UPDATE org_seat_billing_operation SET state = 'pending', error_code = NULL,
           next_attempt_at_ms = 160, completed_at_ms = NULL, stripe_observed_quantity = 1
         WHERE operation_id = 'op-terminal-42'`,
        ),
      ).rejects.toThrow(/legacy seat billing operation is closed/u)

      await execute(
        fixture,
        "INSERT INTO org_seat_assignment" +
          " (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
          " VALUES (99, 'still-legacy', 1, 0, 'after', 'actor')",
      )
      await execute(
        fixture,
        operationSql({
          installationId: 99,
          operationId: "op-legacy-99",
          state: "pending",
        }),
      )
      await execute(
        fixture,
        operationSql({
          installationId: 42,
          operationId: "op-managed-42",
          state: "pending",
          identityKind: "managed_github",
          revision: 3,
        }),
      )
      await expect(
        query(
          fixture,
          "SELECT installation_id, target_identity_kind, state FROM org_seat_billing_operation" +
            " WHERE operation_id IN ('op-legacy-99', 'op-managed-42') ORDER BY installation_id",
        ),
      ).resolves.toEqual([
        { installation_id: 42, target_identity_kind: "managed_github", state: "pending" },
        { installation_id: 99, target_identity_kind: "legacy_login", state: "pending" },
      ])

      await expect(
        execute(fixture, "UPDATE org_activity_seat_readiness SET activation_id = 'changed' WHERE installation_id = 42"),
      ).rejects.toThrow(/readiness is immutable/u)
      await expect(
        execute(fixture, "DELETE FROM org_activity_seat_readiness WHERE installation_id = 42"),
      ).rejects.toThrow(/readiness is immutable/u)
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 1 }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)
})
