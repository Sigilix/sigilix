import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { commandSql, operationSql } from "./org-activity-seat-command-state-migration-fixture"

const exec = promisify(execFile)
const REPO_ROOT = resolve(import.meta.dirname, "..")
const WRANGLER = join(REPO_ROOT, "node_modules/.bin/wrangler")
const MIGRATION_NAME = "0035_create_org_activity_seat_command_state.sql"
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
  const root = await mkdtemp(join(tmpdir(), "sigilix-m0035-"))
  const migrations = join(root, "migrations")
  const persist = join(root, "state")
  const config = join(root, "wrangler.toml")
  await mkdir(migrations)
  await mkdir(persist)
  await writeFile(
    config,
    `name = "sigilix-m0035-test"
compatibility_date = "2026-07-16"

[[d1_databases]]
binding = "DB"
database_name = "sigilix-platform"
database_id = "00000000-0000-0000-0000-000000000035"
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
    "0033_create_org_activity_seat_readiness.sql",
    "0034_create_org_activity_seat_command.sql",
  ]) {
    await copyFile(join(REPO_ROOT, "migrations", name), join(migrations, name))
  }
  const fixture = { root, migrations, persist, config }
  await applyMigrations(fixture)
  return fixture
}

async function stage0035(fixture: WranglerFixture): Promise<void> {
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

async function seedBefore0035(fixture: WranglerFixture): Promise<void> {
  await execute(
    fixture,
    `INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES
       (42, 'pro', 't', 't'), (43, 'pro', 't', 't');
     INSERT INTO stripe_seat_subscription (
       installation_id, stripe_customer_id, stripe_subscription_id,
       stripe_subscription_item_id, stripe_price_id, subscription_status,
       observed_quantity, derived_quantity, revision, snapshot_state,
       last_refreshed_at_ms, created_at_ms, updated_at_ms
     ) VALUES
       (42, 'cus_42', 'sub_42', 'si_42', 'price_42', 'active', 2, 2, 1, 'ready', 1, 1, 1),
       (43, 'cus_43', 'sub_43', 'si_43', 'price_43', 'active', 2, 2, 1, 'ready', 1, 1, 1);
     INSERT INTO org_seat_billing_lease
       (installation_id, lease_token, acquired_at_ms, expires_at_ms) VALUES
       (42, 'lease-42', 10, 1000), (43, 'lease-43', 10, 1000);
     INSERT INTO org_activity_seat_readiness (
       installation_id, activation_id, activation_source, schema_version,
       cutover_at_ms, cutover_at, activated_by_actor_github_user_id,
       stripe_snapshot_revision, billing_lease_acquired_at_ms
     ) VALUES (42, 'ready-42', 'legacy_backfill_v1', 1, 50,
       '2026-07-16T00:00:00.050Z', '900', 1, 10);
     INSERT INTO org_workspace_access (
       installation_id, github_user_id, role, created_at, updated_at, revoked_at,
       updated_by, last_audit_id, last_action
     ) VALUES
       (42, '111', 'member', 't', 't', NULL, 'actor', 'audit-111', 'member_added_or_regranted'),
       (42, '222', 'member', 't', 't', NULL, 'actor', 'audit-222', 'member_added_or_regranted'),
       (42, '444', 'member', 't', 't', 't', 'actor', 'audit-444', 'access_removed');
     INSERT INTO org_workspace_seat_assignment (
       installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by
     ) VALUES
       (42, '111', 1, 'one', 't', 't', 'actor'),
       (42, '222', 0, 'two', 't', 't', 'actor'),
       (42, '444', 1, 'four', 't', 't', 'actor');
     INSERT INTO org_activity_seat_assignment (
       installation_id, github_user_id, assigned, is_admin, last_known_login,
       created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login
     ) VALUES
       (42, '111', 0, 0, 'one', 't', 't', '900', 'actor'),
       (42, '333', 1, 0, 'three', 't', 't', '900', 'actor'),
       (42, '555', 0, 0, 'five', 't', 't', '900', 'actor'),
       (43, '666', 1, 0, 'six', 't', 't', '900', 'actor');
     ${commandSql({ deliveryId: "delivery-before", payload: "a".repeat(64), targetId: "777" })};`,
  )
}

describe("organization activity command state through real Wrangler migrations", () => {
  // Cloudflare shared builds exceed 120s here because this case intentionally uses many isolated Wrangler writes.
  it("backfills and owns exact-scope command handoff without changing immutable evidence", async () => {
    const fixture = await makeFixture()
    try {
      await seedBefore0035(fixture)
      const ledgerBefore = await query<Record<string, unknown>>(
        fixture,
        "SELECT * FROM org_activity_seat_command ORDER BY delivery_id",
      )
      await stage0035(fixture)
      await applyMigrations(fixture)

      await expect(
        query(
          fixture,
          `SELECT delivery_id, state, attempts, next_attempt_at_ms,
                  created_at_ms, updated_at_ms, terminal_at_ms
             FROM org_activity_seat_command_state`,
        ),
      ).resolves.toEqual([
        {
          delivery_id: "delivery-before",
          state: "pending",
          attempts: 0,
          next_attempt_at_ms: 100,
          created_at_ms: 100,
          updated_at_ms: 100,
          terminal_at_ms: null,
        },
      ])

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-after",
          payload: "c".repeat(64),
          targetId: "333",
          receivedAtMs: 200,
        }),
      )
      await expect(
        query(
          fixture,
          "SELECT delivery_id, state, next_attempt_at_ms FROM org_activity_seat_command_state ORDER BY delivery_id",
        ),
      ).resolves.toEqual([
        { delivery_id: "delivery-after", state: "pending", next_attempt_at_ms: 200 },
        { delivery_id: "delivery-before", state: "pending", next_attempt_at_ms: 100 },
      ])

      await expect(
        query(
          fixture,
          `SELECT installation_id, github_user_id, effective_assigned,
                  has_explicit_zero, effective_status
             FROM org_activity_ready_effective_seat
            ORDER BY github_user_id`,
        ),
      ).resolves.toEqual([
        {
          installation_id: 42,
          github_user_id: "111",
          effective_assigned: 1,
          has_explicit_zero: 1,
          effective_status: "assigned",
        },
        {
          installation_id: 42,
          github_user_id: "222",
          effective_assigned: 0,
          has_explicit_zero: 1,
          effective_status: "manual_unassign",
        },
        {
          installation_id: 42,
          github_user_id: "333",
          effective_assigned: 1,
          has_explicit_zero: 0,
          effective_status: "assigned",
        },
        {
          installation_id: 42,
          github_user_id: "555",
          effective_assigned: 0,
          has_explicit_zero: 1,
          effective_status: "manual_unassign",
        },
      ])

      await execute(
        fixture,
        `UPDATE org_activity_seat_command_state SET
           attempts = 1, next_attempt_at_ms = 250, last_error_code = 'lease_busy', updated_at_ms = 210
         WHERE delivery_id = 'delivery-after'`,
      )
      await expect(
        execute(
          fixture,
          "UPDATE org_activity_seat_command_state SET attempts = 0 WHERE delivery_id = 'delivery-after'",
        ),
      ).rejects.toThrow(/state lifecycle is immutable/u)

      for (const [deliveryId, targetId, resolution, repositoryAuthorizedAtMs] of [
        ["delivery-false-pre-cutover", "990", "pre_cutover", null],
        ["delivery-false-manual", "991", "manual_unassign", 270],
        ["delivery-false-applied", "992", "already_assigned", 280],
      ] as const) {
        await execute(
          fixture,
          commandSql({
            deliveryId,
            payload: targetId.repeat(22).slice(0, 64),
            targetId,
            receivedAtMs: 260,
          }),
        )
        const state = resolution === "already_assigned" ? "applied" : "ignored"
        await expect(
          execute(
            fixture,
            `UPDATE org_activity_seat_command_state SET
               state = '${state}', resolution = '${resolution}',
               repository_authorized_at_ms = ${repositoryAuthorizedAtMs ?? "NULL"},
               next_attempt_at_ms = NULL, updated_at_ms = 290, terminal_at_ms = 290
             WHERE delivery_id = '${deliveryId}'`,
          ),
        ).rejects.toThrow(/terminal outcome lacks exact command proof/u)
      }

      await execute(
        fixture,
        operationSql({ operationId: "op-wrong-tenant", installationId: 43, targetId: "777", revision: 2 }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-wrong-kind",
          installationId: 42,
          kind: "managed_github",
          targetId: "777",
          state: "canceled",
          revision: 2,
        }),
      )
      for (const operationId of ["op-wrong-tenant", "op-wrong-kind"]) {
        await expect(
          execute(
            fixture,
            `UPDATE org_activity_seat_command_state SET
               state = 'delegated', operation_id = '${operationId}',
               repository_authorized_at_ms = 220, next_attempt_at_ms = NULL,
               last_error_code = NULL, updated_at_ms = 220, terminal_at_ms = 220
             WHERE delivery_id = 'delivery-before'`,
          ),
        ).rejects.toThrow(/operation link is outside exact command authority/u)
      }
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'wrong_tenant',
           next_attempt_at_ms = NULL, updated_at_ms = 450, completed_at_ms = 450
         WHERE operation_id = 'op-wrong-tenant'`,
      )

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-manual",
          payload: "d".repeat(64),
          targetId: "222",
          receivedAtMs: 300,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-manual",
          installationId: 42,
          targetId: "222",
          createdAtMs: 305,
          revision: 3,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-manual',
             repository_authorized_at_ms = 300, next_attempt_at_ms = NULL,
             updated_at_ms = 310, terminal_at_ms = 310
           WHERE delivery_id = 'delivery-manual'`,
        ),
      ).rejects.toThrow(/operation link is outside exact command authority/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'manual_unassign',
           next_attempt_at_ms = NULL, updated_at_ms = 315, completed_at_ms = 315
         WHERE operation_id = 'op-manual'`,
      )
      await execute(
        fixture,
        `UPDATE org_activity_seat_command_state SET
           state = 'ignored', resolution = 'manual_unassign', repository_authorized_at_ms = 320,
           next_attempt_at_ms = NULL, updated_at_ms = 320, terminal_at_ms = 320
         WHERE delivery_id = 'delivery-manual'`,
      )

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-equal-cutover",
          payload: "e".repeat(64),
          targetId: "888",
          receivedAtMs: 50,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-equal-cutover",
          installationId: 42,
          targetId: "888",
          createdAtMs: 325,
          revision: 4,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-equal-cutover',
             repository_authorized_at_ms = 320, next_attempt_at_ms = NULL,
             updated_at_ms = 330, terminal_at_ms = 330
           WHERE delivery_id = 'delivery-equal-cutover'`,
        ),
      ).rejects.toThrow(/operation link is outside exact command authority/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'pre_cutover',
           next_attempt_at_ms = NULL, updated_at_ms = 335, completed_at_ms = 335
         WHERE operation_id = 'op-equal-cutover'`,
      )
      await execute(
        fixture,
        `UPDATE org_activity_seat_command_state SET
           state = 'ignored', resolution = 'pre_cutover', next_attempt_at_ms = NULL,
           updated_at_ms = 340, terminal_at_ms = 340
         WHERE delivery_id = 'delivery-equal-cutover'`,
      )

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-wrong-subscription",
          payload: "2".repeat(64),
          targetId: "889",
          receivedAtMs: 340,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-wrong-subscription",
          installationId: 42,
          targetId: "889",
          subscriptionId: "sub_43",
          createdAtMs: 350,
          revision: 5,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-wrong-subscription',
             repository_authorized_at_ms = 345, next_attempt_at_ms = NULL,
             updated_at_ms = 360, terminal_at_ms = 360
           WHERE delivery_id = 'delivery-wrong-subscription'`,
        ),
      ).rejects.toThrow(/operation link is outside exact command authority/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'provider_mismatch',
           next_attempt_at_ms = NULL, updated_at_ms = 365, completed_at_ms = 365
         WHERE operation_id = 'op-wrong-subscription'`,
      )

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-wrong-item",
          payload: "3".repeat(64),
          targetId: "890",
          receivedAtMs: 360,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-wrong-item",
          installationId: 42,
          targetId: "890",
          subscriptionItemId: "si_43",
          createdAtMs: 370,
          revision: 6,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-wrong-item',
             repository_authorized_at_ms = 365, next_attempt_at_ms = NULL,
             updated_at_ms = 380, terminal_at_ms = 380
           WHERE delivery_id = 'delivery-wrong-item'`,
        ),
      ).rejects.toThrow(/operation link is outside exact command authority/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'provider_mismatch',
           next_attempt_at_ms = NULL, updated_at_ms = 385, completed_at_ms = 385
         WHERE operation_id = 'op-wrong-item'`,
      )

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-stripe-applied",
          payload: "4".repeat(64),
          targetId: "891",
          receivedAtMs: 380,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-stripe-applied",
          installationId: 42,
          targetId: "891",
          createdAtMs: 390,
          revision: 7,
        }),
      )
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'stripe_applied',
           stripe_observed_quantity = desired_quantity, stripe_applied_at_ms = 395,
           updated_at_ms = 395 WHERE operation_id = 'op-stripe-applied'`,
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-stripe-applied',
             repository_authorized_at_ms = 385, next_attempt_at_ms = NULL,
             updated_at_ms = 400, terminal_at_ms = 400
           WHERE delivery_id = 'delivery-stripe-applied'`,
        ),
      ).rejects.toThrow(/operation link is outside exact command authority/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'already_applied',
           stripe_observed_quantity = NULL, stripe_applied_at_ms = NULL,
           next_attempt_at_ms = NULL, updated_at_ms = 405, completed_at_ms = 405
         WHERE operation_id = 'op-stripe-applied'`,
      )

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-reversed-authorization",
          payload: "5".repeat(64),
          targetId: "892",
          receivedAtMs: 410,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-reversed-authorization",
          installationId: 42,
          targetId: "892",
          createdAtMs: 425,
          revision: 8,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-reversed-authorization',
             repository_authorized_at_ms = 440, next_attempt_at_ms = NULL,
             updated_at_ms = 440, terminal_at_ms = 430
           WHERE delivery_id = 'delivery-reversed-authorization'`,
        ),
      ).rejects.toThrow(/operation link is outside exact command authority/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'bad_chronology',
           next_attempt_at_ms = NULL, updated_at_ms = 445, completed_at_ms = 445
         WHERE operation_id = 'op-reversed-authorization'`,
      )

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-operation-after-handoff",
          payload: "6".repeat(64),
          targetId: "893",
          receivedAtMs: 450,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-after-handoff",
          installationId: 42,
          targetId: "893",
          createdAtMs: 460,
          revision: 9,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-after-handoff',
             repository_authorized_at_ms = 455, next_attempt_at_ms = NULL,
             updated_at_ms = 458, terminal_at_ms = 458
           WHERE delivery_id = 'delivery-operation-after-handoff'`,
        ),
      ).rejects.toThrow(/operation link is outside exact command authority/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET state = 'canceled', error_code = 'bad_chronology',
           next_attempt_at_ms = NULL, updated_at_ms = 465, completed_at_ms = 465
         WHERE operation_id = 'op-after-handoff'`,
      )

      await execute(
        fixture,
        operationSql({
          operationId: "op-correct",
          installationId: 42,
          targetId: "777",
          createdAtMs: 480,
          revision: 10,
        }),
      )
      await execute(
        fixture,
        `UPDATE org_activity_seat_command_state SET
           state = 'delegated', operation_id = 'op-correct',
           repository_authorized_at_ms = 470, next_attempt_at_ms = NULL,
           last_error_code = NULL, updated_at_ms = 490, terminal_at_ms = 490
         WHERE delivery_id = 'delivery-before'`,
      )
      await expect(
        execute(
          fixture,
          "UPDATE org_activity_seat_command_state SET updated_at_ms = 491 WHERE delivery_id = 'delivery-before'",
        ),
      ).rejects.toThrow(/terminal state is immutable/u)
      await expect(
        execute(fixture, "DELETE FROM org_activity_seat_command_state WHERE delivery_id = 'delivery-before'"),
      ).rejects.toThrow(/command state cannot be deleted/u)
      await expect(
        execute(
          fixture,
          `INSERT OR REPLACE INTO org_activity_seat_command_state
             (delivery_id, state, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
           VALUES ('delivery-before', 'pending', 0, 300, 300, 300)`,
        ),
      ).rejects.toThrow(/command state already exists/u)
      await expect(
        execute(
          fixture,
          `UPDATE org_seat_billing_operation SET
             installation_id = 43, revision = 11, desired_quantity = 99,
             stripe_subscription_id = 'sub_43', stripe_subscription_item_id = 'si_43',
             actor_login = 'changed-actor', target_is_admin = 1, created_at_ms = 481
           WHERE operation_id = 'op-correct'`,
        ),
      ).rejects.toThrow(/activity seat billing operation authority is immutable/u)
      await expect(
        execute(
          fixture,
          operationSql({
            operationId: "op-correct",
            installationId: 42,
            targetId: "777",
            createdAtMs: 480,
            revision: 10,
          }).replace("INSERT INTO", "INSERT OR IGNORE INTO"),
        ),
      ).resolves.toEqual(expect.any(String))
      await expect(
        execute(
          fixture,
          operationSql({
            operationId: "op-correct",
            installationId: 42,
            targetId: "777",
            subscriptionItemId: "si_43",
            createdAtMs: 480,
            revision: 10,
          }).replace("INSERT INTO", "INSERT OR REPLACE INTO"),
        ),
      ).resolves.toEqual(expect.any(String))
      await expect(
        query(
          fixture,
          `SELECT installation_id, revision, desired_quantity, stripe_subscription_id,
                  stripe_subscription_item_id, actor_login, target_is_admin, created_at_ms
             FROM org_seat_billing_operation WHERE operation_id = 'op-correct'`,
        ),
      ).resolves.toEqual([
        {
          installation_id: 42,
          revision: 10,
          desired_quantity: 3,
          stripe_subscription_id: "sub_42",
          stripe_subscription_item_id: "si_42",
          actor_login: "actor",
          target_is_admin: 0,
          created_at_ms: 480,
        },
      ])
      await expect(
        execute(fixture, "DELETE FROM org_seat_billing_operation WHERE operation_id = 'op-correct'"),
      ).rejects.toThrow(/activity seat billing operation cannot be deleted/u)
      await execute(
        fixture,
        operationSql({
          operationId: "op-link-thief",
          installationId: 42,
          kind: "managed_github",
          targetId: "778",
          state: "canceled",
          createdAtMs: 520,
          revision: 11,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE OR REPLACE org_seat_billing_operation
              SET operation_id = 'op-correct'
            WHERE operation_id = 'op-link-thief'`,
        ),
      ).rejects.toThrow(/activity seat billing operation unique authority cannot be replaced/u)

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-duplicate-operation",
          payload: "f".repeat(64),
          targetId: "777",
          receivedAtMs: 350,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE OR REPLACE org_activity_seat_command_state SET
             state = 'delegated', operation_id = 'op-correct',
             repository_authorized_at_ms = 470, next_attempt_at_ms = NULL,
             updated_at_ms = 510, terminal_at_ms = 510
           WHERE delivery_id = 'delivery-duplicate-operation'`,
        ),
      ).rejects.toThrow(/operation link cannot be transferred/u)
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET
           state = 'stripe_applied', stripe_observed_quantity = desired_quantity,
           attempts = 1, next_attempt_at_ms = 520, updated_at_ms = 520,
           stripe_applied_at_ms = 520
         WHERE operation_id = 'op-correct'`,
      )
      await execute(
        fixture,
        `UPDATE org_seat_billing_operation SET
           state = 'committed', attempts = 2, next_attempt_at_ms = NULL,
           updated_at_ms = 530, completed_at_ms = 530
         WHERE operation_id = 'op-correct'`,
      )
      await expect(
        query(
          fixture,
          `SELECT state, stripe_observed_quantity, attempts, stripe_applied_at_ms,
                  completed_at_ms
             FROM org_seat_billing_operation WHERE operation_id = 'op-correct'`,
        ),
      ).resolves.toEqual([
        {
          state: "committed",
          stripe_observed_quantity: 3,
          attempts: 2,
          stripe_applied_at_ms: 520,
          completed_at_ms: 530,
        },
      ])

      await execute(
        fixture,
        operationSql({
          operationId: "op-unlinked-activity",
          installationId: 42,
          targetId: "894",
          createdAtMs: 540,
          revision: 12,
        }),
      )
      await execute(
        fixture,
        operationSql({
          operationId: "op-update-replacement",
          installationId: 42,
          kind: "managed_github",
          targetId: "898",
          state: "canceled",
          createdAtMs: 545,
          revision: 15,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE OR REPLACE org_seat_billing_operation
              SET revision = 12
            WHERE operation_id = 'op-update-replacement'`,
        ),
      ).rejects.toThrow(/activity seat billing operation unique authority cannot be replaced/u)
      for (const replacement of [
        operationSql({
          operationId: "op-idempotency-replacement",
          installationId: 42,
          kind: "managed_github",
          targetId: "895",
          state: "canceled",
          idempotencyKey: "op-unlinked-activity-key",
          createdAtMs: 550,
          revision: 13,
        }),
        operationSql({
          operationId: "op-revision-replacement",
          installationId: 42,
          kind: "managed_github",
          targetId: "896",
          state: "canceled",
          createdAtMs: 560,
          revision: 12,
        }),
        operationSql({
          operationId: "op-active-replacement",
          installationId: 42,
          kind: "managed_github",
          targetId: "897",
          createdAtMs: 570,
          revision: 14,
        }),
      ]) {
        await expect(execute(fixture, replacement.replace("INSERT INTO", "INSERT OR REPLACE INTO"))).resolves.toEqual(
          expect.any(String),
        )
      }
      await expect(
        query(
          fixture,
          `SELECT operation_id, target_identity_kind, state, revision, idempotency_key
             FROM org_seat_billing_operation
            WHERE operation_id IN (
              'op-unlinked-activity', 'op-idempotency-replacement',
              'op-revision-replacement', 'op-active-replacement'
            ) ORDER BY operation_id`,
        ),
      ).resolves.toEqual([
        {
          operation_id: "op-unlinked-activity",
          target_identity_kind: "activity_github",
          state: "pending",
          revision: 12,
          idempotency_key: "op-unlinked-activity-key",
        },
      ])

      await execute(
        fixture,
        commandSql({
          deliveryId: "delivery-invalid-shape",
          payload: "1".repeat(64),
          targetId: "999",
          receivedAtMs: 370,
        }),
      )
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             repository_authorized_at_ms = 375, updated_at_ms = 375
           WHERE delivery_id = 'delivery-invalid-shape'`,
        ),
      ).rejects.toThrow(/CHECK constraint failed/u)
      await expect(
        execute(
          fixture,
          `UPDATE org_activity_seat_command_state SET
             state = 'applied', resolution = 'already_assigned', next_attempt_at_ms = NULL,
             updated_at_ms = 380, terminal_at_ms = 380
           WHERE delivery_id = 'delivery-invalid-shape'`,
        ),
      ).rejects.toThrow(/terminal outcome lacks exact command proof/u)

      await execute(
        fixture,
        `UPDATE org_activity_seat_command_state SET
           state = 'applied', resolution = 'already_assigned', repository_authorized_at_ms = 240,
           next_attempt_at_ms = NULL, last_error_code = NULL, updated_at_ms = 240, terminal_at_ms = 240
         WHERE delivery_id = 'delivery-after'`,
      )
      await expect(
        query(fixture, "SELECT delivery_id, state, resolution, operation_id FROM org_activity_seat_command_state"),
      ).resolves.toEqual(
        expect.arrayContaining([
          {
            delivery_id: "delivery-before",
            state: "delegated",
            resolution: null,
            operation_id: "op-correct",
          },
          {
            delivery_id: "delivery-after",
            state: "applied",
            resolution: "already_assigned",
            operation_id: null,
          },
        ]),
      )

      await expect(
        query(fixture, "SELECT * FROM org_activity_seat_command WHERE delivery_id = 'delivery-before'"),
      ).resolves.toEqual(ledgerBefore)
      await expect(
        query(
          fixture,
          `SELECT name, type FROM sqlite_master
            WHERE name IN (
              'org_activity_seat_command_state',
              'org_activity_ready_effective_seat',
              'idx_org_activity_seat_command_state_due',
              'idx_org_activity_seat_command_consumer_scope',
              'trg_org_activity_seat_billing_operation_authority_immutable',
              'trg_org_activity_seat_billing_operation_collision_update',
              'trg_org_activity_seat_billing_operation_no_delete',
              'trg_org_activity_seat_billing_operation_no_reinsert',
              'trg_org_activity_seat_command_state_lifecycle',
              'trg_org_activity_seat_command_state_no_reinsert',
              'trg_org_activity_seat_command_state_seed',
              'trg_org_activity_seat_command_state_operation_link_update',
              'trg_org_activity_seat_command_state_operation_no_transfer',
              'trg_org_activity_seat_command_state_terminal_immutable',
              'trg_org_activity_seat_command_state_terminal_outcome',
              'trg_org_activity_seat_command_state_no_delete'
            ) ORDER BY name`,
        ),
      ).resolves.toEqual([
        { name: "idx_org_activity_seat_command_consumer_scope", type: "index" },
        { name: "idx_org_activity_seat_command_state_due", type: "index" },
        { name: "org_activity_ready_effective_seat", type: "view" },
        { name: "org_activity_seat_command_state", type: "table" },
        { name: "trg_org_activity_seat_billing_operation_authority_immutable", type: "trigger" },
        { name: "trg_org_activity_seat_billing_operation_collision_update", type: "trigger" },
        { name: "trg_org_activity_seat_billing_operation_no_delete", type: "trigger" },
        { name: "trg_org_activity_seat_billing_operation_no_reinsert", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_lifecycle", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_no_delete", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_no_reinsert", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_operation_link_update", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_operation_no_transfer", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_seed", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_terminal_immutable", type: "trigger" },
        { name: "trg_org_activity_seat_command_state_terminal_outcome", type: "trigger" },
      ])
      await expect(query(fixture, "PRAGMA foreign_key_check")).resolves.toEqual([])
      await expect(
        query(
          fixture,
          `SELECT "from" AS source_column, "table" AS target_table,
                  on_update, on_delete
             FROM pragma_foreign_key_list('org_activity_seat_command_state')`,
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          {
            source_column: "operation_id",
            target_table: "org_seat_billing_operation",
            on_update: "RESTRICT",
            on_delete: "RESTRICT",
          },
        ]),
      )
      await expect(query(fixture, "PRAGMA quick_check")).resolves.toEqual([{ quick_check: "ok" }])
      await expect(applyMigrations(fixture)).resolves.toMatch(/No migrations to apply/u)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 300_000)

  it("rolls back a partial state migration and succeeds on retry", async () => {
    const fixture = await makeFixture()
    try {
      await execute(
        fixture,
        "CREATE TABLE migration_index_conflict (id INTEGER);" +
          " CREATE INDEX idx_org_activity_seat_command_state_due ON migration_index_conflict(id)",
      )
      await stage0035(fixture)

      await expect(applyMigrations(fixture)).rejects.toThrow(/idx_org_activity_seat_command_state_due/u)
      await expect(
        query(
          fixture,
          "SELECT COUNT(*) AS objects FROM sqlite_master" +
            " WHERE name IN ('org_activity_seat_command_state','org_activity_ready_effective_seat')",
        ),
      ).resolves.toEqual([{ objects: 0 }])
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 0 }])

      await execute(fixture, "DROP INDEX idx_org_activity_seat_command_state_due")
      await expect(applyMigrations(fixture)).resolves.toMatch(new RegExp(MIGRATION_NAME, "u"))
      await expect(
        query(fixture, "SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '" + MIGRATION_NAME + "'"),
      ).resolves.toEqual([{ applied: 1 }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)
})
