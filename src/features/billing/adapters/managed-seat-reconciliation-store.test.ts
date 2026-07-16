import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  acquireOrgSeatBillingLease,
  markOrgSeatExpansionStripeApplied,
  readStripeSeatSubscription,
  writeStripeSeatSubscriptionSnapshot,
} from "./d1-seat-reconciliation-store"
import {
  cancelActiveManagedOrgSeatBillingOperation,
  commitManagedOrgSeatExpansion,
  createPendingManagedOrgSeatExpansion,
  deriveManagedBillableSeatQuantity,
  readManagedOrgSeatAssignment,
  writeLocalManagedOrgSeatAssignment,
} from "./managed-seat-reconciliation-store"
import type { Env } from "@/src/shared/types/env"

function migration(name: string): string {
  return readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")
}

function env(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

async function seedAccess(
  db: D1Database,
  args: { installationId?: number; githubUserId: string; role?: "admin" | "member" },
): Promise<void> {
  const installationId = args.installationId ?? 42
  await db
    .prepare(
      `INSERT INTO org_workspace_access
         (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
          updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', NULL,
               'github:owner', ?, 'member_added_or_regranted')`,
    )
    .bind(installationId, args.githubUserId, args.role ?? "member", `audit-${installationId}-${args.githubUserId}`)
    .run()
}

async function seedAssignment(
  db: D1Database,
  args: {
    installationId?: number
    githubUserId: string
    assigned?: boolean
    lastKnownLogin?: string
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_seat_assignment
         (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', 'github:owner')`,
    )
    .bind(args.installationId ?? 42, args.githubUserId, args.assigned === false ? 0 : 1, args.lastKnownLogin ?? null)
    .run()
}

async function revokeAccess(db: D1Database, installationId: number, githubUserId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE org_workspace_access SET
         revoked_at = '2026-07-15T01:00:00.000Z', updated_at = '2026-07-15T01:00:00.000Z',
         updated_by = 'github:owner', last_audit_id = ?, last_action = 'access_removed'
       WHERE installation_id = ? AND github_user_id = ?`,
    )
    .bind(`audit-revoke-${installationId}-${githubUserId}`, installationId, githubUserId)
    .run()
}

async function seedReadySnapshot(db: D1Database, installationId = 42, quantity = 1): Promise<void> {
  await expect(
    writeStripeSeatSubscriptionSnapshot(env(db), {
      installationId,
      expectedRevision: null,
      state: "ready",
      customerId: `cus_${installationId}`,
      subscriptionId: `sub_${installationId}`,
      subscriptionItemId: `si_${installationId}`,
      priceId: `price_${installationId}`,
      subscriptionStatus: "active",
      quantity,
      eventId: `evt_${installationId}`,
      eventCreatedAtMs: 1,
      eventReceivedAtMs: 1,
      nowMs: 1,
    }),
  ).resolves.toEqual({ kind: "written", revision: 1 })
}

async function acquireLease(db: D1Database, installationId = 42, token = "managed-lease", nowMs = 10) {
  await expect(acquireOrgSeatBillingLease(env(db), { installationId, token, nowMs, ttlMs: 100 })).resolves.toEqual({
    kind: "acquired",
    expiresAtMs: nowMs + 100,
  })
  return { installationId, leaseToken: token, leaseAcquiredAtMs: nowMs, nowMs }
}

describe("managed D1 seat reconciliation store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(migration("0001_create_tenant_repo_usage.sql"))
    await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
    await db.exec(migration("0022_create_org_workspace_access.sql"))
    await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
    await db.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
    await db.exec(migration("0032_extend_org_seat_billing_operation_activity_identity.sql"))
    await db
      .prepare(
        `INSERT INTO tenant (installation_id, tier, created_at, updated_at)
         VALUES (42, 'teams', 't', 't'), (43, 'teams', 't', 't')`,
      )
      .run()
  })

  it("reads exact-installation identity and treats an absent canonical row as unassigned", async () => {
    await seedAccess(db, { githubUserId: "111" })
    await seedAccess(db, { installationId: 43, githubUserId: "111" })
    await seedAssignment(db, { installationId: 43, githubUserId: "111", lastKnownLogin: "foreign" })
    const fence = await acquireLease(db)

    await expect(readManagedOrgSeatAssignment(env(db), { githubUserId: "111", ...fence })).resolves.toEqual({
      kind: "ok",
      assignment: {
        installationId: 42,
        githubUserId: "111",
        assigned: false,
        role: "member",
        lastKnownLogin: null,
        source: "missing",
        assignedQuantity: 0,
      },
    })

    await seedAssignment(db, { githubUserId: "111", lastKnownLogin: "Alice" })
    await db
      .prepare(
        `UPDATE org_workspace_seat_assignment SET
           last_known_login = 'Alice-Renamed', updated_at = '2026-07-15T00:01:00.000Z'
         WHERE installation_id = 42 AND github_user_id = '111'`,
      )
      .run()
    await expect(readManagedOrgSeatAssignment(env(db), { githubUserId: "111", ...fence })).resolves.toEqual({
      kind: "ok",
      assignment: expect.objectContaining({
        githubUserId: "111",
        assigned: true,
        lastKnownLogin: "Alice-Renamed",
        source: "canonical",
        assignedQuantity: 1,
      }),
    })
  })

  it("excludes revoked access from target reads and the billable count", async () => {
    await seedAccess(db, { githubUserId: "111", role: "admin" })
    await seedAccess(db, { githubUserId: "222" })
    await seedAssignment(db, { githubUserId: "111", lastKnownLogin: "owner" })
    await seedAssignment(db, { githubUserId: "222", lastKnownLogin: "member" })
    await revokeAccess(db, 42, "222")
    const fence = await acquireLease(db)

    await expect(deriveManagedBillableSeatQuantity(env(db), 42)).resolves.toEqual({ kind: "ok", quantity: 1 })
    await expect(readManagedOrgSeatAssignment(env(db), { githubUserId: "222", ...fence })).resolves.toEqual({
      kind: "missing",
    })
    await expect(deriveManagedBillableSeatQuantity(env(db), 43)).resolves.toEqual({ kind: "ok", quantity: 0 })
  })

  it("rejects stale leases and missing or revoked active access on local writes", async () => {
    await seedAccess(db, { githubUserId: "111" })
    const fence = await acquireLease(db)
    const args = {
      githubUserId: "111",
      lastKnownLogin: "Alice",
      assigned: true,
      actorLogin: "Owner",
      nowIso: "2026-07-15T00:02:00.000Z",
      capacity: { kind: "local-only" as const },
      ...fence,
    }

    await expect(writeLocalManagedOrgSeatAssignment(env(db), { ...args, leaseToken: "stale" })).resolves.toEqual({
      kind: "conflict",
    })
    await revokeAccess(db, 42, "111")
    await expect(writeLocalManagedOrgSeatAssignment(env(db), args)).resolves.toEqual({ kind: "conflict" })
    await expect(
      db.prepare("SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 42").first(),
    ).resolves.toBeNull()
  })

  it("classifies the last assigned active admin and permits removal once another assigned admin exists", async () => {
    await seedAccess(db, { githubUserId: "111", role: "admin" })
    await seedAccess(db, { githubUserId: "222", role: "admin" })
    await seedAssignment(db, { githubUserId: "111", lastKnownLogin: "Owner" })
    const fence = await acquireLease(db)
    const remove = {
      githubUserId: "111",
      lastKnownLogin: "Owner-Renamed",
      assigned: false,
      actorLogin: "Owner",
      nowIso: "2026-07-15T00:03:00.000Z",
      capacity: { kind: "local-only" as const },
      ...fence,
    }

    await expect(writeLocalManagedOrgSeatAssignment(env(db), remove)).resolves.toEqual({ kind: "last_admin" })
    await seedAssignment(db, { githubUserId: "222", lastKnownLogin: "SecondAdmin" })
    await expect(writeLocalManagedOrgSeatAssignment(env(db), remove)).resolves.toEqual({
      kind: "written",
      snapshotRevision: null,
    })
    await expect(
      db
        .prepare(
          "SELECT assigned, last_known_login FROM org_workspace_seat_assignment" +
            " WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ assigned: 0, last_known_login: "Owner-Renamed" })
  })

  it("writes under a matching capacity snapshot and rejects a stale revision", async () => {
    await seedAccess(db, { githubUserId: "111" })
    await seedReadySnapshot(db, 42, 2)
    const fence = await acquireLease(db)
    const args = {
      githubUserId: "111",
      lastKnownLogin: "Alice",
      assigned: true,
      actorLogin: "Owner",
      nowIso: "2026-07-15T00:04:00.000Z",
      ...fence,
    }

    await expect(
      writeLocalManagedOrgSeatAssignment(env(db), {
        ...args,
        capacity: {
          kind: "snapshot",
          expectedRevision: 0,
          subscriptionId: "sub_42",
          subscriptionItemId: "si_42",
          minimumQuantity: 1,
        },
      }),
    ).resolves.toEqual({ kind: "conflict" })
    await expect(
      writeLocalManagedOrgSeatAssignment(env(db), {
        ...args,
        capacity: {
          kind: "snapshot",
          expectedRevision: 1,
          subscriptionId: "sub_42",
          subscriptionItemId: "si_42",
          minimumQuantity: 1,
        },
      }),
    ).resolves.toEqual({ kind: "written", snapshotRevision: 1 })
  })

  it("creates one ID-keyed managed expansion and accepts a display-login rename retry", async () => {
    await seedAccess(db, { githubUserId: "111" })
    await seedAccess(db, { githubUserId: "222" })
    await seedAssignment(db, { githubUserId: "222", lastKnownLogin: "Bob" })
    await seedReadySnapshot(db)
    const fence = await acquireLease(db)
    const args = {
      operationId: "op-managed",
      idempotencyKey: "seat:v2:42:111:assign",
      githubUserId: "111",
      lastKnownLogin: "Alice",
      actorLogin: "Owner",
      expectedAssignedQuantity: 1,
      desiredQuantity: 2,
      expectedSnapshotRevision: 1,
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      nextAttemptAtMs: 20,
      ...fence,
    }

    await expect(createPendingManagedOrgSeatExpansion(env(db), args)).resolves.toEqual({
      kind: "created",
      operation: expect.objectContaining({
        operationId: "op-managed",
        login: "Alice",
        targetIdentityKind: "managed_github",
        targetGithubUserId: "111",
        targetIsAdmin: false,
        idempotencyKey: "seat:v2:42:111:assign",
        desiredQuantity: 2,
      }),
    })
    await expect(
      createPendingManagedOrgSeatExpansion(env(db), { ...args, lastKnownLogin: "Alice-Renamed" }),
    ).resolves.toEqual({
      kind: "existing",
      operation: expect.objectContaining({ operationId: "op-managed", targetGithubUserId: "111" }),
    })
    await expect(createPendingManagedOrgSeatExpansion(env(db), { ...args, leaseToken: "stale" })).resolves.toEqual({
      kind: "conflict",
    })
  })

  it("commits only the persisted managed operation into canonical assignment and snapshot state", async () => {
    await seedAccess(db, { githubUserId: "111" })
    await seedAccess(db, { githubUserId: "222" })
    await seedAssignment(db, { githubUserId: "222", lastKnownLogin: "Bob" })
    await seedReadySnapshot(db)
    const fence = await acquireLease(db)
    const created = await createPendingManagedOrgSeatExpansion(env(db), {
      operationId: "op-commit",
      idempotencyKey: "seat:v2:42:111:commit",
      githubUserId: "111",
      lastKnownLogin: "Alice",
      actorLogin: "Owner",
      expectedAssignedQuantity: 1,
      desiredQuantity: 2,
      expectedSnapshotRevision: 1,
      subscriptionId: "sub_42",
      subscriptionItemId: "si_42",
      nextAttemptAtMs: 20,
      ...fence,
    })
    expect(created).toEqual({ kind: "created", operation: expect.objectContaining({ revision: 2 }) })
    await db
      .prepare(
        `UPDATE org_workspace_access SET
           role = 'admin', updated_at = '2026-07-15T00:04:30.000Z', updated_by = 'github:owner',
           last_audit_id = 'audit-role-change-111', last_action = 'role_changed'
         WHERE installation_id = 42 AND github_user_id = '111'`,
      )
      .run()
    await expect(
      createPendingManagedOrgSeatExpansion(env(db), {
        operationId: "op-commit",
        idempotencyKey: "seat:v2:42:111:commit",
        githubUserId: "111",
        lastKnownLogin: "Alice-Renamed",
        actorLogin: "Owner",
        expectedAssignedQuantity: 1,
        desiredQuantity: 2,
        expectedSnapshotRevision: 1,
        subscriptionId: "sub_42",
        subscriptionItemId: "si_42",
        nextAttemptAtMs: 20,
        ...fence,
      }),
    ).resolves.toEqual({
      kind: "existing",
      operation: expect.objectContaining({ operationId: "op-commit", targetIsAdmin: false }),
    })
    await expect(
      markOrgSeatExpansionStripeApplied(env(db), {
        operationId: "op-commit",
        revision: 2,
        stripeObservedQuantity: 2,
        nextAttemptAtMs: 30,
        ...fence,
      }),
    ).resolves.toEqual({ kind: "written" })
    await expect(
      commitManagedOrgSeatExpansion(env(db), {
        operationId: "op-commit",
        revision: 2,
        providerQuantity: 2,
        nowIso: "2026-07-15T00:05:00.000Z",
        ...fence,
      }),
    ).resolves.toEqual({ kind: "committed", snapshotRevision: 2, quantity: 2 })
    await expect(
      db
        .prepare(
          "SELECT github_user_id, assigned, last_known_login FROM org_workspace_seat_assignment" +
            " WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ github_user_id: "111", assigned: 1, last_known_login: "Alice" })
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({ observedQuantity: 2, derivedQuantity: 2, revision: 2 }),
    })
  })

  it("cancels pending and settles Stripe-applied managed operations without shrinking capacity", async () => {
    await seedAccess(db, { githubUserId: "111" })
    await seedAccess(db, { githubUserId: "222" })
    await seedAssignment(db, { githubUserId: "222", lastKnownLogin: "Bob" })
    await seedReadySnapshot(db)
    const fence = await acquireLease(db)
    const create = async (operationId: string) =>
      createPendingManagedOrgSeatExpansion(env(db), {
        operationId,
        idempotencyKey: `seat:v2:42:111:${operationId}`,
        githubUserId: "111",
        lastKnownLogin: "Alice",
        actorLogin: "Owner",
        expectedAssignedQuantity: 1,
        desiredQuantity: 2,
        expectedSnapshotRevision: 1,
        subscriptionId: "sub_42",
        subscriptionItemId: "si_42",
        nextAttemptAtMs: 20,
        ...fence,
      })

    expect(await create("op-pending")).toEqual({
      kind: "created",
      operation: expect.objectContaining({ revision: 2 }),
    })
    await expect(
      cancelActiveManagedOrgSeatBillingOperation(env(db), {
        operationId: "op-pending",
        revision: 2,
        expectedState: "pending",
        errorCode: "seat_unassigned",
        actorLogin: "Owner",
        nowIso: "2026-07-15T00:06:00.000Z",
        ...fence,
      }),
    ).resolves.toEqual({ kind: "settled", terminalState: "canceled" })

    expect(await create("op-applied")).toEqual({
      kind: "created",
      operation: expect.objectContaining({ revision: 3 }),
    })
    await markOrgSeatExpansionStripeApplied(env(db), {
      operationId: "op-applied",
      revision: 3,
      stripeObservedQuantity: 3,
      nextAttemptAtMs: 30,
      ...fence,
    })
    await expect(
      cancelActiveManagedOrgSeatBillingOperation(env(db), {
        operationId: "op-applied",
        revision: 3,
        expectedState: "stripe_applied",
        errorCode: "seat_unassigned",
        actorLogin: "Owner",
        nowIso: "2026-07-15T00:07:00.000Z",
        ...fence,
      }),
    ).resolves.toEqual({ kind: "settled", terminalState: "committed" })
    await expect(readStripeSeatSubscription(env(db), 42)).resolves.toEqual({
      kind: "ok",
      snapshot: expect.objectContaining({ observedQuantity: 2, derivedQuantity: 2, revision: 3 }),
    })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment" +
            " WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ assigned: 0 })
  })
})
