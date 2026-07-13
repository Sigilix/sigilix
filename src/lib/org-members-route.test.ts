import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { handleAddOrgMember, handleDeleteOrgMember, handleUpdateOrgMemberRole } from "@/src/lib/org-members-route"
import {
  addOrgWorkspaceMember,
  readOrgWorkspaceAccess,
  removeOrgWorkspaceAccess,
  setOrgWorkspaceRole,
} from "@/src/features/org-membership"
import { recoverOrgSeatBillingOperation } from "@/src/features/billing"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const mocks = vi.hoisted(() => ({
  requireOrgAccess: vi.fn(),
  fetchInstallationRoster: vi.fn(),
}))

vi.mock("@/src/lib/org-access", () => ({ requireOrgAccess: mocks.requireOrgAccess }))
vi.mock("@/src/lib/org-members-roster", () => ({ fetchInstallationRoster: mocks.fetchInstallationRoster }))

const INSTALLATION_ID = 42
const ACTOR_ID = "111"
const TARGET_ID = "222"
const NOW = "2026-07-13T04:00:00.000Z"
const PORTAL_ORIGIN = "https://app.sigilix.ai"
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

const migration = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(migration("0001_create_tenant_repo_usage.sql"))
  await db.exec(migration("0003_create_account_tenant_and_api_key.sql"))
  await db.exec(migration("0007_create_org_seat_assignment.sql"))
  await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
  await db.exec(migration("0022_create_org_workspace_access.sql"))
  await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, 'acme', 'Organization', ?, ?)",
    )
    .bind(INSTALLATION_ID, NOW, NOW)
    .run()
  return db
}

function env(db: D1Database, mode: string = "on"): Env {
  return {
    SIGILIX_PLATFORM_DB: db,
    OPENCLAW_ORG_MEMBERSHIP_MODE: mode,
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: "pem",
    OPENCLAW_STATE: {} as KVNamespace,
  } as unknown as Env
}

function adminAccess() {
  return {
    ok: true,
    session: {},
    accessToken: "ghu_actor",
    installationId: INSTALLATION_ID,
    githubUserId: ACTOR_ID,
    login: "owner",
    role: "admin",
  }
}

function denied(status: 401 | 403, error: string) {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  }
}

function completeRoster(...members: Array<{ githubUserId: string; login: string; avatarUrl?: string }>) {
  return {
    members: members.map((member) => ({ avatarUrl: "", ...member })),
    complete: true,
    source: "org" as const,
  }
}

function request(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  options: { json?: boolean; origin?: string } = {},
): Request {
  const headers = new Headers()
  if (options.json !== false) headers.set("content-type", "application/json")
  if (options.origin) headers.set("origin", options.origin)
  return new Request(`https://api.sigilix.ai${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function seedAccess(db: D1Database, githubUserId: string, role: "admin" | "member"): Promise<void> {
  await addOrgWorkspaceMember(db, {
    installationId: INSTALLATION_ID,
    githubUserId,
    nowIso: NOW,
    updatedBy: "owner",
  })
  if (role === "admin") {
    const promoted = await setOrgWorkspaceRole(db, {
      installationId: INSTALLATION_ID,
      githubUserId,
      role: "admin",
      nowIso: "2026-07-13T04:01:00.000Z",
      updatedBy: "owner",
    })
    expect(promoted.status).toBe("updated")
  }
}

beforeEach(() => {
  mocks.requireOrgAccess.mockReset().mockResolvedValue(adminAccess())
  mocks.fetchInstallationRoster
    .mockReset()
    .mockResolvedValue(completeRoster({ githubUserId: TARGET_ID, login: "Target" }))
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("organization member mutation authorization", () => {
  it("returns 401 before disclosing that the rollout is disabled", async () => {
    const db = await makeDb()
    mocks.requireOrgAccess.mockResolvedValue(denied(401, "unauthorized"))

    const response = await handleAddOrgMember(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, { githubUserId: TARGET_ID }),
      env(db, "off"),
      undefined,
      INSTALLATION_ID,
    )

    expect(response.status).toBe(401)
    expect(mocks.fetchInstallationRoster).not.toHaveBeenCalled()
  })

  it("returns 403 for an installation outside the caller's exact live scope", async () => {
    const db = await makeDb()
    mocks.requireOrgAccess.mockResolvedValue(denied(403, "forbidden"))

    const response = await handleAddOrgMember(
      request("POST", `/v1/org/99/members`, { githubUserId: TARGET_ID }),
      env(db),
      undefined,
      99,
    )

    expect(response.status).toBe(403)
    expect(mocks.requireOrgAccess).toHaveBeenCalledWith(expect.any(Request), expect.any(Object), undefined, 99, {
      requiredRole: "admin",
    })
    expect(mocks.fetchInstallationRoster).not.toHaveBeenCalled()
  })

  it("fails closed if the access resolver ever returns a different installation", async () => {
    const db = await makeDb()
    mocks.requireOrgAccess.mockResolvedValue({ ...adminAccess(), installationId: 99 })

    const response = await handleAddOrgMember(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, { githubUserId: TARGET_ID }),
      env(db),
      undefined,
      INSTALLATION_ID,
    )

    expect(response.status).toBe(403)
    expect(mocks.fetchInstallationRoster).not.toHaveBeenCalled()
  })

  it("returns 403 when a stored member attempts an admin mutation", async () => {
    const db = await makeDb()
    mocks.requireOrgAccess.mockResolvedValue(denied(403, "forbidden"))

    const response = await handleUpdateOrgMemberRole(
      request("PATCH", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, { role: "admin" }),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(403)
    expect(mocks.requireOrgAccess).toHaveBeenCalledWith(expect.any(Request), env(db), undefined, INSTALLATION_ID, {
      requiredRole: "admin",
    })
    expect(mocks.fetchInstallationRoster).not.toHaveBeenCalled()
  })

  it("requires the rollout after authentication", async () => {
    const db = await makeDb()
    const response = await handleAddOrgMember(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, { githubUserId: TARGET_ID }),
      env(db, "off"),
      undefined,
      INSTALLATION_ID,
    )
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "org_membership_disabled" })
  })

  it("requires application/json on every mutation", async () => {
    const db = await makeDb()
    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, undefined, { json: false }),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )
    expect(response.status).toBe(415)
    expect(mocks.fetchInstallationRoster).not.toHaveBeenCalled()
  })

  it("caps JSON mutation bodies before buffering them", async () => {
    const db = await makeDb()
    const response = await handleAddOrgMember(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, {
        githubUserId: TARGET_ID,
        padding: "x".repeat(4 * 1024),
      }),
      env(db),
      undefined,
      INSTALLATION_ID,
    )
    expect(response.status).toBe(413)
    expect(mocks.fetchInstallationRoster).not.toHaveBeenCalled()
  })
})

describe("POST /v1/org/:installationId/members", () => {
  it("fails unavailable on an incomplete roster even when the target appeared", async () => {
    const db = await makeDb()
    mocks.fetchInstallationRoster.mockResolvedValue({
      ...completeRoster({ githubUserId: TARGET_ID, login: "Target" }),
      complete: false,
    })

    const response = await handleAddOrgMember(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, { githubUserId: TARGET_ID }),
      env(db),
      undefined,
      INSTALLATION_ID,
    )

    expect(response.status).toBe(503)
    expect(await readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).toBeNull()
  })

  it("returns 404 for a complete immutable-ID roster miss", async () => {
    const db = await makeDb()
    mocks.fetchInstallationRoster.mockResolvedValue(completeRoster({ githubUserId: "333", login: "Other" }))

    const response = await handleAddOrgMember(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, { githubUserId: TARGET_ID }),
      env(db),
      undefined,
      INSTALLATION_ID,
    )

    expect(response.status).toBe(404)
    expect(await readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).toBeNull()
  })

  it("adds or regrants a default member and never trusts a body login", async () => {
    const db = await makeDb()
    mocks.fetchInstallationRoster.mockResolvedValue(
      completeRoster({ githubUserId: TARGET_ID, login: "Roster-Renamed" }),
    )
    const runtimeEnv = env(db)

    const response = await handleAddOrgMember(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, {
        githubUserId: TARGET_ID,
        login: "attacker-controlled",
      }),
      runtimeEnv,
      undefined,
      INSTALLATION_ID,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      installationId: INSTALLATION_ID,
      githubUserId: TARGET_ID,
      login: "Roster-Renamed",
      role: "member",
    })
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      role: "member",
      revokedAt: null,
    })
    await expect(
      db
        .prepare(
          "SELECT actor_id FROM org_workspace_access_audit" +
            " WHERE installation_id = ? AND target_github_user_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(INSTALLATION_ID, TARGET_ID)
        .first<{ actor_id: string }>(),
    ).resolves.toEqual({ actor_id: `github:${ACTOR_ID}` })
    expect(mocks.fetchInstallationRoster).toHaveBeenCalledWith(runtimeEnv, INSTALLATION_ID, "acme", "Organization")
  })
})

describe("PATCH /v1/org/:installationId/members/:githubUserId", () => {
  it("updates a stored role and treats a same-role retry as idempotent", async () => {
    const db = await makeDb()
    await seedAccess(db, TARGET_ID, "member")
    const req = () => request("PATCH", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, { role: "admin" })

    expect((await handleUpdateOrgMemberRole(req(), env(db), undefined, INSTALLATION_ID, TARGET_ID)).status).toBe(200)
    expect((await handleUpdateOrgMemberRole(req(), env(db), undefined, INSTALLATION_ID, TARGET_ID)).status).toBe(200)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({ role: "admin" })
  })

  it("returns 409 instead of demoting the last active admin", async () => {
    const db = await makeDb()
    await seedAccess(db, ACTOR_ID, "admin")
    mocks.fetchInstallationRoster.mockResolvedValue(completeRoster({ githubUserId: ACTOR_ID, login: "owner" }))

    const response = await handleUpdateOrgMemberRole(
      request("PATCH", `/v1/org/${INSTALLATION_ID}/members/${ACTOR_ID}`, { role: "member" }),
      env(db),
      undefined,
      INSTALLATION_ID,
      ACTOR_ID,
    )

    expect(response.status).toBe(409)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, ACTOR_ID)).resolves.toMatchObject({ role: "admin" })
  })

  it("returns 404 when the roster member has no active Sigilix access row", async () => {
    const db = await makeDb()
    const response = await handleUpdateOrgMemberRole(
      request("PATCH", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, { role: "admin" }),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )
    expect(response.status).toBe(404)
  })
})

describe("DELETE /v1/org/:installationId/members/:githubUserId", () => {
  it("does not cancel another member's active seat expansion", async () => {
    const db = await makeDb()
    await seedAccess(db, ACTOR_ID, "admin")
    await seedAccess(db, TARGET_ID, "member")
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-other-member', ?, 1, 'alice', 'owner', 0,
                 1, 0, 2, 'pending', 'sub_1', 'si_1', 1,
                 'sigilix-seat-op-other-member', 0, 1, 1, 1)`,
      )
      .bind(INSTALLATION_ID)
      .run()

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(503)
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-other-member'").first(),
    ).resolves.toEqual({ state: "pending" })
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({ revokedAt: null })
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'alice'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toBeNull()
  })

  it("cancels an active seat expansion in the same transaction before removing the member", async () => {
    const db = await makeDb()
    const providerFetch = vi.spyOn(globalThis, "fetch")
    await seedAccess(db, ACTOR_ID, "admin")
    await seedAccess(db, TARGET_ID, "member")
    await db
      .prepare(
        "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
          " VALUES (99, 'other', 'Organization', ?, ?)",
      )
      .bind(NOW, NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-remove-target', ?, 1, 'target', 'owner', 0,
                 1, 0, 2, 'pending', 'sub_1', 'si_1', 1,
                 'sigilix-seat-op-remove-target', 0, 1, 1, 1)`,
      )
      .bind(INSTALLATION_ID)
      .run()
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-foreign-tenant', 99, 1, 'target', 'other-owner', 0,
                 1, 0, 2, 'pending', 'sub_99', 'si_99', 1,
                 'sigilix-seat-op-foreign-tenant', 0, 1, 1, 1)`,
      )
      .run()

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(200)
    await expect(
      db
        .prepare("SELECT state, error_code FROM org_seat_billing_operation WHERE operation_id = ?")
        .bind("op-remove-target")
        .first(),
    ).resolves.toEqual({ state: "canceled", error_code: "member_removed" })
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      revokedAt: expect.any(String),
    })
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-foreign-tenant'").first(),
    ).resolves.toEqual({ state: "pending" })

    await expect(
      recoverOrgSeatBillingOperation(env(db), {
        type: "org-seat-billing-reconcile",
        installationId: INSTALLATION_ID,
        operationId: "op-remove-target",
      }),
    ).resolves.toBeUndefined()
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'target'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 0 })
    expect(providerFetch).not.toHaveBeenCalled()
    providerFetch.mockRestore()
  })

  it("finalizes a Stripe-applied expansion without shrinking paid capacity or calling Stripe", async () => {
    const db = await makeDb()
    const providerFetch = vi.spyOn(globalThis, "fetch")
    await seedAccess(db, ACTOR_ID, "admin")
    await seedAccess(db, TARGET_ID, "member")
    await db
      .prepare(
        `INSERT INTO stripe_seat_subscription
          (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
           stripe_price_id, subscription_status, observed_quantity, derived_quantity, revision,
           snapshot_state, last_refreshed_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'cus_1', 'sub_1', 'si_1', 'price_1', 'active', 2, 2, 1, 'ready', 1, 1, 1)`,
      )
      .bind(INSTALLATION_ID)
      .run()
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms,
           stripe_applied_at_ms)
         VALUES ('op-applied-remove', ?, 1, 'target', 'owner', 0,
                 1, 0, 2, 'stripe_applied', 'sub_1', 'si_1', 2,
                 'sigilix-seat-op-applied-remove', 1, 2, 1, 2, 2)`,
      )
      .bind(INSTALLATION_ID)
      .run()

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(200)
    await expect(
      db
        .prepare("SELECT state, error_code FROM org_seat_billing_operation WHERE operation_id = ?")
        .bind("op-applied-remove")
        .first(),
    ).resolves.toEqual({ state: "committed", error_code: null })
    await expect(
      db
        .prepare("SELECT observed_quantity, derived_quantity FROM stripe_seat_subscription WHERE installation_id = ?")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ observed_quantity: 2, derived_quantity: 2 })
    expect(providerFetch).not.toHaveBeenCalled()
    providerFetch.mockRestore()
  })

  it("settles a pre-existing active expansion for an already-tombstoned member", async () => {
    const db = await makeDb()
    await seedAccess(db, ACTOR_ID, "admin")
    await seedAccess(db, TARGET_ID, "member")
    await expect(
      removeOrgWorkspaceAccess(db, {
        installationId: INSTALLATION_ID,
        githubUserId: TARGET_ID,
        login: "target",
        nowIso: "2026-07-13T03:59:00.000Z",
        updatedBy: "legacy-removal",
      }),
    ).resolves.toEqual({ status: "removed" })
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-after-legacy-removal', ?, 1, 'target', 'owner', 0,
                 1, 0, 2, 'pending', 'sub_1', 'si_1', 1,
                 'sigilix-seat-op-after-legacy-removal', 0, 1, 1, 1)`,
      )
      .bind(INSTALLATION_ID)
      .run()

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(404)
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-after-legacy-removal'").first(),
    ).resolves.toEqual({ state: "canceled" })
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = 'target'")
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ assigned: 0 })
  })

  it("fails unavailable instead of hiding an unsettled operation behind an old tombstone", async () => {
    const db = await makeDb()
    await seedAccess(db, ACTOR_ID, "admin")
    await seedAccess(db, TARGET_ID, "member")
    await removeOrgWorkspaceAccess(db, {
      installationId: INSTALLATION_ID,
      githubUserId: TARGET_ID,
      login: "target",
      nowIso: "2026-07-13T03:59:00.000Z",
      updatedBy: "legacy-removal",
    })
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms,
           stripe_applied_at_ms)
         VALUES ('op-unsettled-old-tombstone', ?, 1, 'target', 'owner', 0,
                 1, 0, 2, 'stripe_applied', 'sub_missing', 'si_missing', 2,
                 'sigilix-seat-op-unsettled-old-tombstone', 1, 2, 1, 2, 2)`,
      )
      .bind(INSTALLATION_ID)
      .run()

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(503)
    await expect(
      db
        .prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-unsettled-old-tombstone'")
        .first(),
    ).resolves.toEqual({ state: "stripe_applied" })
  })

  it("returns 409 instead of removing the last active admin", async () => {
    const db = await makeDb()
    await seedAccess(db, ACTOR_ID, "admin")
    mocks.fetchInstallationRoster.mockResolvedValue(completeRoster({ githubUserId: ACTOR_ID, login: "owner" }))
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-last-admin', ?, 1, 'owner', 'owner', 1,
                 1, 0, 1, 'pending', 'sub_1', 'si_1', 0,
                 'sigilix-seat-op-last-admin', 0, 1, 1, 1)`,
      )
      .bind(INSTALLATION_ID)
      .run()

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${ACTOR_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      ACTOR_ID,
    )

    expect(response.status).toBe(409)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, ACTOR_ID)).resolves.toMatchObject({ revokedAt: null })
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-last-admin'").first(),
    ).resolves.toEqual({ state: "pending" })
  })

  it("removes access, revokes only target-tenant keys, and unassigns the roster-derived legacy seat", async () => {
    const db = await makeDb()
    await seedAccess(db, ACTOR_ID, "admin")
    await seedAccess(db, TARGET_ID, "member")
    mocks.fetchInstallationRoster.mockResolvedValue(
      completeRoster({ githubUserId: TARGET_ID, login: "Roster-Renamed" }),
    )
    await db
      .prepare(
        "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at)" +
          " VALUES (?, 'roster-renamed', 1, 0, ?)",
      )
      .bind(INSTALLATION_ID, NOW)
      .run()
    for (const [id, installationId, createdBy] of [
      ["target-key", INSTALLATION_ID, TARGET_ID],
      ["foreign-tenant-key", 99, TARGET_ID],
      ["other-member-key", INSTALLATION_ID, "333"],
    ] as const) {
      await db
        .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, `hash-${id}`, installationId, createdBy, NOW)
        .run()
    }

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(200)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      revokedAt: expect.any(String),
    })
    await expect(
      db
        .prepare("SELECT assigned FROM org_seat_assignment WHERE installation_id = ? AND login = ?")
        .bind(INSTALLATION_ID, "roster-renamed")
        .first(),
    ).resolves.toEqual({ assigned: 0 })
    await expect(db.prepare("SELECT revoked_at FROM api_key WHERE id = 'target-key'").first()).resolves.toEqual({
      revoked_at: expect.any(String),
    })
    await expect(db.prepare("SELECT revoked_at FROM api_key WHERE id = 'foreign-tenant-key'").first()).resolves.toEqual(
      {
        revoked_at: null,
      },
    )
    await expect(db.prepare("SELECT revoked_at FROM api_key WHERE id = 'other-member-key'").first()).resolves.toEqual({
      revoked_at: null,
    })
  })

  it("retries departed-member removal after an unjoinable active operation settles", async () => {
    const db = await makeDb()
    await seedAccess(db, ACTOR_ID, "admin")
    await seedAccess(db, TARGET_ID, "member")
    mocks.fetchInstallationRoster.mockResolvedValue(completeRoster({ githubUserId: ACTOR_ID, login: "owner" }))
    await db
      .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("departed-member-key", "hash-departed-member-key", INSTALLATION_ID, TARGET_ID, NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO org_seat_billing_operation
          (operation_id, installation_id, revision, login, actor_login, target_is_admin,
           requested_assigned, previous_assigned, desired_quantity, state,
           stripe_subscription_id, stripe_subscription_item_id, stripe_observed_quantity,
           idempotency_key, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('op-departed-member', ?, 1, 'old-login', 'owner', 0,
                 1, 0, 2, 'pending', 'sub_1', 'si_1', 1,
                 'sigilix-seat-op-departed-member', 0, 1, 1, 1)`,
      )
      .bind(INSTALLATION_ID)
      .run()

    const busy = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(busy.status).toBe(503)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({ revokedAt: null })
    await expect(
      db.prepare("SELECT revoked_at FROM api_key WHERE id = 'departed-member-key'").first(),
    ).resolves.toEqual({ revoked_at: null })
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-departed-member'").first(),
    ).resolves.toEqual({ state: "pending" })

    await db
      .prepare(
        `UPDATE org_seat_billing_operation
            SET state = 'canceled', error_code = 'test_settled', next_attempt_at_ms = NULL,
                updated_at_ms = 2, completed_at_ms = 2
          WHERE operation_id = 'op-departed-member' AND state = 'pending'`,
      )
      .run()

    const response = await handleDeleteOrgMember(
      request("DELETE", `/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`),
      env(db),
      undefined,
      INSTALLATION_ID,
      TARGET_ID,
    )

    expect(response.status).toBe(200)
    await expect(readOrgWorkspaceAccess(db, INSTALLATION_ID, TARGET_ID)).resolves.toMatchObject({
      revokedAt: expect.any(String),
    })
    await expect(
      db.prepare("SELECT revoked_at FROM api_key WHERE id = 'departed-member-key'").first(),
    ).resolves.toEqual({
      revoked_at: expect.any(String),
    })
    await expect(
      db.prepare("SELECT state FROM org_seat_billing_operation WHERE operation_id = 'op-departed-member'").first(),
    ).resolves.toEqual({ state: "canceled" })
  })
})

describe("worker.fetch member route registration and CORS", () => {
  it("dispatches the collection route and returns credentialed portal CORS", async () => {
    const db = await makeDb()
    const response = await worker.fetch(
      request("POST", `/v1/org/${INSTALLATION_ID}/members`, { githubUserId: TARGET_ID }, { origin: PORTAL_ORIGIN }),
      env(db),
      ctx,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
  })

  it("answers item-route preflight with PATCH and DELETE allowed", async () => {
    const response = await worker.fetch(
      new Request(`https://api.sigilix.ai/v1/org/${INSTALLATION_ID}/members/${TARGET_ID}`, {
        method: "OPTIONS",
        headers: { origin: PORTAL_ORIGIN },
      }),
      {} as Env,
      ctx,
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH")
    expect(response.headers.get("access-control-allow-methods")).toContain("DELETE")
    expect(response.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
  })
})
