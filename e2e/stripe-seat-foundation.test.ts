import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  acquireOrgSeatBillingLease,
  deriveBillableSeatQuantity,
  readTenantBillingState,
  releaseOrgSeatBillingLease,
} from "@/src/features/billing"
import type { Env } from "@/src/shared/types/env"

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
}

function env(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function brokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 failure")
    },
  } as unknown as D1Database
}

describe("Stripe seat reconciliation D1 foundation", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    for (const name of [
      "0001_create_tenant_repo_usage.sql",
      "0007_create_org_seat_assignment.sql",
      "0011_add_tenant_subscription_status.sql",
      "0012_add_tenant_billing_source.sql",
      "0020_create_stripe_seat_reconciliation.sql",
    ]) {
      await db.exec(migration(name))
    }
    for (const id of [42, 43]) {
      await db
        .prepare(
          "INSERT INTO tenant (installation_id, tier, billing_source, subscription_status, created_at, updated_at)" +
            " VALUES (?, 'teams', 'stripe', 'active', 't', 't')",
        )
        .bind(id)
        .run()
    }
  })

  it("proves quantity semantics, isolation, operation exclusion, lease recovery, and D1 faults", async () => {
    const usage = db.prepare(
      `INSERT INTO usage_ledger
        (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)
       VALUES (?, 1, ?, ?, 1, 1, ?, 't')`,
    )
    await usage.bind(42, 1, "a", "Alice").run()
    await usage.bind(42, 2, "b", "alice").run()
    await usage.bind(42, 3, "c", "bob").run()
    await usage.bind(43, 4, "d", "mallory").run()
    await usage.bind(42, 5, "e", "   ").run()
    await db
      .prepare(
        `INSERT INTO org_seat_assignment
          (installation_id, login, assigned, is_admin, updated_at)
         VALUES (?, ?, ?, 0, 't')`,
      )
      .bind(42, "bob", 0)
      .run()
    await db
      .prepare(
        `INSERT INTO org_seat_assignment
          (installation_id, login, assigned, is_admin, updated_at)
         VALUES (?, ?, ?, 0, 't')`,
      )
      .bind(42, "carol", 1)
      .run()
    await db
      .prepare(
        `INSERT INTO org_seat_assignment
          (installation_id, login, assigned, is_admin, updated_at)
         VALUES (42, '   ', 1, 0, 't')`,
      )
      .run()

    await expect(deriveBillableSeatQuantity(env(db), 42)).resolves.toEqual({ kind: "ok", quantity: 2 })
    await expect(deriveBillableSeatQuantity(env(db), 43)).resolves.toEqual({ kind: "ok", quantity: 1 })
    await expect(deriveBillableSeatQuantity(env(db), 404)).resolves.toEqual({ kind: "missing" })
    await expect(readTenantBillingState(env(db), 42)).resolves.toMatchObject({ kind: "stripe-active" })

    const insertOperation = db.prepare(
      `INSERT INTO org_seat_billing_operation
        (operation_id, installation_id, revision, login, requested_assigned, previous_assigned,
         desired_quantity, state, stripe_subscription_id, stripe_subscription_item_id,
         stripe_observed_quantity, idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 42, ?, 'bob', 0, 1, 2, ?, 'sub_42', 'si_42', 3, ?, 0, 2, 1, 1)`,
    )
    await insertOperation.bind("op-a", 1, "pending", "idem-a").run()
    const intent = await db
      .prepare(
        `SELECT login, requested_assigned, previous_assigned, desired_quantity,
                stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity
           FROM org_seat_billing_operation WHERE operation_id = 'op-a'`,
      )
      .first()
    expect(intent).toEqual({
      login: "bob",
      requested_assigned: 0,
      previous_assigned: 1,
      desired_quantity: 2,
      stripe_subscription_id: "sub_42",
      stripe_subscription_item_id: "si_42",
      stripe_observed_quantity: 3,
    })
    await expect(insertOperation.bind("op-active", 2, "pending", "idem-active").run()).rejects.toThrow()
    await expect(insertOperation.bind("op-invalid", 2, "abandoned", "idem-invalid").run()).rejects.toThrow()
    await db
      .prepare(
        `UPDATE org_seat_billing_operation
            SET state = 'committed', stripe_observed_quantity = desired_quantity,
                stripe_applied_at_ms = 2, completed_at_ms = 3, next_attempt_at_ms = NULL
          WHERE operation_id = 'op-a'`,
      )
      .run()
    await expect(insertOperation.bind("op-sparse", 2, "stripe_applied", "idem-sparse").run()).rejects.toThrow()
    await expect(insertOperation.bind("op-revision", 1, "pending", "idem-revision").run()).rejects.toThrow()
    await expect(insertOperation.bind("op-b", 2, "pending", "idem-b").run()).resolves.toMatchObject({
      success: true,
    })

    await expect(
      acquireOrgSeatBillingLease(env(db), { installationId: 42, token: "a", nowMs: 1, ttlMs: 10 }),
    ).resolves.toMatchObject({ kind: "acquired" })
    await expect(
      acquireOrgSeatBillingLease(env(db), { installationId: 42, token: "b", nowMs: 5, ttlMs: 10 }),
    ).resolves.toMatchObject({ kind: "busy" })
    await expect(
      acquireOrgSeatBillingLease(env(db), { installationId: 42, token: "b", nowMs: 11, ttlMs: 10 }),
    ).resolves.toMatchObject({ kind: "acquired" })
    await expect(
      releaseOrgSeatBillingLease(env(db), { installationId: 42, token: "a", acquiredAtMs: 1 }),
    ).resolves.toEqual({ kind: "not_owner" })
    await expect(
      releaseOrgSeatBillingLease(env(db), { installationId: 42, token: "b", acquiredAtMs: 11 }),
    ).resolves.toEqual({ kind: "released" })

    await expect(deriveBillableSeatQuantity({}, 42)).resolves.toEqual({ kind: "error", reason: "unavailable" })
    await expect(readTenantBillingState({ SIGILIX_PLATFORM_DB: brokenDb() }, 42)).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    })

    await db
      .prepare(
        `INSERT INTO org_seat_assignment
          (installation_id, login, assigned, is_admin, updated_at)
         VALUES (42, 'Carol', 0, 0, 't')`,
      )
      .run()
    await expect(deriveBillableSeatQuantity(env(db), 42)).resolves.toEqual({ kind: "error", reason: "invalid_row" })
    await db.prepare("DELETE FROM org_seat_assignment WHERE installation_id = 42 AND login = 'Carol'").run()
    await expect(deriveBillableSeatQuantity(env(db), 42)).resolves.toEqual({ kind: "ok", quantity: 2 })

    await db
      .prepare(
        `INSERT INTO org_seat_assignment
          (installation_id, login, assigned, is_admin, updated_at)
         VALUES (42, 'invalid-assignment', 7, 0, 't')`,
      )
      .run()
    await expect(deriveBillableSeatQuantity(env(db), 42)).resolves.toEqual({ kind: "error", reason: "invalid_row" })
  })
})
