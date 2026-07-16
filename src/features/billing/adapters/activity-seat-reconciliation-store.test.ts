import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { commitActivityOrgSeatExpansion } from "./activity-seat-reconciliation-store"
import { acquireOrgSeatBillingLease, commitOrgSeatExpansion } from "./d1-seat-reconciliation-store"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

function migration(name: string): string {
  return readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")
}

function env(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

async function seedDb(): Promise<D1Database> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
    "0031_create_org_activity_seat_assignment.sql",
    "0032_extend_org_seat_billing_operation_activity_identity.sql",
  ]) {
    await db.exec(migration(name))
  }
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, tier, created_at, updated_at)" +
        " VALUES (42, 'pro', 't', 't'), (43, 'pro', 't', 't')",
    )
    .run()
  await db
    .prepare(
      `INSERT INTO stripe_seat_subscription
        (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         stripe_price_id, subscription_status, observed_quantity, derived_quantity, revision,
         snapshot_state, last_refreshed_at_ms, created_at_ms, updated_at_ms)
       VALUES
        (42, 'cus_42', 'sub_42', 'si_42', 'price_42', 'active', 1, 1, 1, 'ready', 1, 1, 1),
        (43, 'cus_43', 'sub_43', 'si_43', 'price_43', 'active', 1, 1, 1, 'ready', 1, 1, 1)`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO org_seat_billing_operation
        (operation_id, installation_id, revision, login, target_identity_kind,
         target_github_user_id, activity_actor_github_user_id, actor_login, target_is_admin,
         requested_assigned, previous_assigned, desired_quantity, state,
         stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
         idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms,
         stripe_applied_at_ms)
       VALUES
        ('op-activity', 42, 2, 'Target-Renamed', 'activity_github', '222', '333', 'Actor-Renamed', 0,
         1, 0, 2, 'stripe_applied', 'sub_42', 'si_42', 2, 'seat-42-activity', 0, 3, 1, 2, 2),
        ('op-legacy', 43, 2, 'legacy-target', 'legacy_login', NULL, NULL, 'legacy-actor', 0,
         1, 0, 2, 'stripe_applied', 'sub_43', 'si_43', 2, 'seat-43-legacy', 0, 3, 1, 2, 2)`,
    )
    .run()
  await db
    .prepare(
      `INSERT INTO org_activity_seat_assignment
        (installation_id, github_user_id, assigned, is_admin, last_known_login,
         created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login)
       VALUES (42, '222', 0, 1, 'old-target', 'created-original', 'updated-original', '444', 'old-actor')`,
    )
    .run()
  await expect(
    acquireOrgSeatBillingLease(env(db), { installationId: 42, token: "activity-lease", nowMs: 10, ttlMs: 100 }),
  ).resolves.toMatchObject({ kind: "acquired" })
  await expect(
    acquireOrgSeatBillingLease(env(db), { installationId: 43, token: "legacy-lease", nowMs: 10, ttlMs: 100 }),
  ).resolves.toMatchObject({ kind: "acquired" })
  return db
}

function activityArgs() {
  return {
    installationId: 42,
    operationId: "op-activity",
    revision: 2,
    providerQuantity: 3,
    nowIso: "2026-07-16T02:00:00.000Z",
    leaseToken: "activity-lease",
    leaseAcquiredAtMs: 10,
    nowMs: 10,
  }
}

describe("activity D1 seat reconciliation store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = await seedDb()
  })

  it("fails closed across lease, revision, quantity, and identity mismatches", async () => {
    const args = activityArgs()
    await expect(commitActivityOrgSeatExpansion(env(db), { ...args, leaseToken: "stale" })).resolves.toEqual({
      kind: "conflict",
    })
    await expect(commitActivityOrgSeatExpansion(env(db), { ...args, revision: 3 })).resolves.toEqual({
      kind: "conflict",
    })
    await expect(commitActivityOrgSeatExpansion(env(db), { ...args, providerQuantity: 1 })).resolves.toEqual({
      kind: "conflict",
    })
    await expect(
      commitActivityOrgSeatExpansion(env(db), {
        ...args,
        installationId: 43,
        operationId: "op-legacy",
        leaseToken: "legacy-lease",
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(commitOrgSeatExpansion(env(db), args)).resolves.toEqual({ kind: "conflict" })

    await expect(
      db
        .prepare(
          `SELECT assigned, is_admin, last_known_login, created_at, updated_at,
                  updated_by_actor_github_user_id, updated_by_actor_login
             FROM org_activity_seat_assignment WHERE installation_id = 42 AND github_user_id = '222'`,
        )
        .first(),
    ).resolves.toEqual({
      assigned: 0,
      is_admin: 1,
      last_known_login: "old-target",
      created_at: "created-original",
      updated_at: "updated-original",
      updated_by_actor_github_user_id: "444",
      updated_by_actor_login: "old-actor",
    })

    await expect(commitActivityOrgSeatExpansion(env(db), args)).resolves.toEqual({
      kind: "committed",
      snapshotRevision: 2,
      quantity: 3,
    })
    await expect(
      db
        .prepare(
          `SELECT assigned, is_admin, last_known_login, created_at, updated_at,
                  updated_by_actor_github_user_id, updated_by_actor_login
             FROM org_activity_seat_assignment WHERE installation_id = 42 AND github_user_id = '222'`,
        )
        .first(),
    ).resolves.toEqual({
      assigned: 1,
      is_admin: 1,
      last_known_login: "Target-Renamed",
      created_at: "created-original",
      updated_at: "2026-07-16T02:00:00.000Z",
      updated_by_actor_github_user_id: "333",
      updated_by_actor_login: "Actor-Renamed",
    })
  })

  it("rolls back every projection when a downstream statement fails, then retries", async () => {
    await db.exec(
      `CREATE TRIGGER reject_activity_update BEFORE UPDATE ON org_activity_seat_assignment
       BEGIN SELECT RAISE(ABORT, 'forced activity projection failure'); END;`,
    )

    await expect(commitActivityOrgSeatExpansion(env(db), activityArgs())).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    })
    await expect(
      db.prepare("SELECT assigned, updated_at FROM org_activity_seat_assignment WHERE installation_id = 42").first(),
    ).resolves.toEqual({ assigned: 0, updated_at: "updated-original" })
    await expect(
      db.prepare("SELECT observed_quantity, revision FROM stripe_seat_subscription WHERE installation_id = 42").first(),
    ).resolves.toEqual({ observed_quantity: 1, revision: 1 })
    await expect(
      db
        .prepare("SELECT state, completed_at_ms FROM org_seat_billing_operation WHERE operation_id = 'op-activity'")
        .first(),
    ).resolves.toEqual({ state: "stripe_applied", completed_at_ms: null })

    await db.exec("DROP TRIGGER reject_activity_update")
    await expect(commitActivityOrgSeatExpansion(env(db), activityArgs())).resolves.toEqual({
      kind: "committed",
      snapshotRevision: 2,
      quantity: 3,
    })
  })
})
