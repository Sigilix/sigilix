// Account deletion must not strand an organization without a stored admin who
// is reachable in a complete, exact-installation GitHub roster snapshot.
// These store-level regressions exercise the D1 transaction directly so races
// between proof collection and purge cannot be hidden by route stubs.

import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  AccountDeleteConflictError,
  listAccountAdminInstallationIds,
  purgeUserAccount,
  type AccountDeleteAdminRosterProof,
  type AccountSubject,
} from "@/src/lib/account-store"
import { canonicalizeInstallationRosterMemberIds } from "@/src/features/org-membership"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const SCHEMA_FILES = [
  "0001_create_tenant_repo_usage.sql",
  "0003_create_account_tenant_and_api_key.sql",
  "0004_create_usage_events.sql",
  "0005_create_user_profile.sql",
  "0006_create_user_identity.sql",
  "0008_create_email_verification_token.sql",
  "0009_add_api_key_name.sql",
  "0010_add_gitlab_id_to_user_identity.sql",
  "0020_create_stripe_seat_reconciliation.sql",
  "0021_create_app_memory.sql",
  "0022_create_org_workspace_access.sql",
  "0023_add_org_seat_billing_operation_context.sql",
  "0028_create_org_workspace_seat_assignment.sql",
] as const

const NOW = "2026-07-15T00:00:00.000Z"

function migration(name: (typeof SCHEMA_FILES)[number]): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
}

async function makeDatabase(): Promise<D1Database> {
  const db = makeD1()
  for (const file of SCHEMA_FILES) await db.exec(migration(file))
  return db
}

function subject(githubUserId: string): AccountSubject {
  return {
    userId: `user-${githubUserId}`,
    githubUserId,
    login: `user-${githubUserId}`,
    provider: "github",
  }
}

async function seedIdentity(db: D1Database, githubUserId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_identity
        (user_id, github_user_id, providers, created_at, last_login_at)
       VALUES (?, ?, '["github"]', ?, ?)`,
    )
    .bind(`user-${githubUserId}`, githubUserId, NOW, NOW)
    .run()
  await db
    .prepare("INSERT INTO user_credential (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(`user-${githubUserId}`, "pbkdf2-sha256$1$salt$hash", NOW, NOW)
    .run()
}

async function seedAccess(
  db: D1Database,
  githubUserId: string,
  role: "admin" | "member",
  installationId = 42,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, ?, ?, ?, NULL, 'system:test', ?, ?)`,
    )
    .bind(
      installationId,
      githubUserId,
      role,
      NOW,
      NOW,
      `seed-${installationId}-${githubUserId}`,
      role === "admin" ? "bootstrap_admin" : "member_added_or_regranted",
    )
    .run()
}

async function seedAssignedSeat(db: D1Database, githubUserId: string, installationId = 42): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_workspace_seat_assignment
        (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
       VALUES (?, ?, 1, ?, ?, ?, 'system:test')`,
    )
    .bind(installationId, githubUserId, `user-${githubUserId}`, NOW, NOW)
    .run()
}

function proof(installationId: number, memberIds: readonly string[]): AccountDeleteAdminRosterProof {
  const rosterSnapshot = canonicalizeInstallationRosterMemberIds(memberIds)
  if (rosterSnapshot === null) throw new Error("test roster must be canonicalizable")
  return { installationId, rosterSnapshot }
}

async function readAccess(
  db: D1Database,
  githubUserId: string,
  installationId = 42,
): Promise<{ role: string; revoked_at: string | null } | null> {
  return db
    .prepare("SELECT role, revoked_at FROM org_workspace_access WHERE installation_id = ? AND github_user_id = ?")
    .bind(installationId, githubUserId)
    .first<{ role: string; revoked_at: string | null }>()
}

async function readActiveAdmins(db: D1Database, installationId = 42): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT github_user_id FROM org_workspace_access
        WHERE installation_id = ? AND role = 'admin' AND revoked_at IS NULL
        ORDER BY github_user_id`,
    )
    .bind(installationId)
    .all<{ github_user_id: string }>()
  return rows.results.map((row) => row.github_user_id)
}

async function expectLastAdminConflict(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: AccountDeleteConflictError.name,
    reason: "last_admin",
  })
}

describe("purgeUserAccount reachable-admin proof", () => {
  let db: D1Database

  beforeEach(async () => {
    db = await makeDatabase()
  })

  it("blocks without mutation when the only stored successor is stale outside the complete snapshot", async () => {
    await seedIdentity(db, "111")
    await seedAccess(db, "111", "admin")
    await seedAccess(db, "222", "admin")
    await seedAssignedSeat(db, "111")

    await expect(listAccountAdminInstallationIds(db, subject("111"))).resolves.toEqual([42])
    await expectLastAdminConflict(
      purgeUserAccount(db, subject("111"), {
        adminRosterProofs: [proof(42, ["111"])],
      }),
    )

    await expect(db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-111'").first()).resolves.toEqual({
      user_id: "user-111",
    })
    await expect(db.prepare("SELECT user_id FROM user_credential WHERE user_id = 'user-111'").first()).resolves.toEqual(
      { user_id: "user-111" },
    )
    await expect(readAccess(db, "111")).resolves.toEqual({ role: "admin", revoked_at: null })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ assigned: 1 })
    await expect(
      db.prepare("SELECT COUNT(*) AS n FROM org_workspace_access_audit WHERE action = 'access_removed'").first(),
    ).resolves.toEqual({ n: 0 })
  })

  it("purges when another stored admin is reachable in the complete snapshot", async () => {
    await seedIdentity(db, "111")
    await seedAccess(db, "111", "admin")
    await seedAccess(db, "222", "admin")

    const counts = await purgeUserAccount(db, subject("111"), {
      adminRosterProofs: [proof(42, ["111", "222"])],
    })

    expect(counts.orgWorkspaceAccess).toBe(1)
    await expect(db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-111'").first()).resolves.toBeNull()
    await expect(readAccess(db, "111")).resolves.toMatchObject({ role: "admin", revoked_at: expect.any(String) })
    await expect(readAccess(db, "222")).resolves.toEqual({ role: "admin", revoked_at: null })
  })

  it("allows a departed target to purge when the complete snapshot contains its stored successor", async () => {
    await seedIdentity(db, "111")
    await seedAccess(db, "111", "admin")
    await seedAccess(db, "222", "admin")

    await expect(
      purgeUserAccount(db, subject("111"), {
        adminRosterProofs: [proof(42, ["222"])],
      }),
    ).resolves.toMatchObject({ orgWorkspaceAccess: 1 })

    await expect(readAccess(db, "111")).resolves.toMatchObject({ revoked_at: expect.any(String) })
    await expect(readActiveAdmins(db)).resolves.toEqual(["222"])
  })

  it("serializes concurrent two-admin purges against one complete snapshot and retains one reachable admin", async () => {
    for (const githubUserId of ["111", "222"] as const) {
      await seedIdentity(db, githubUserId)
      await seedAccess(db, githubUserId, "admin")
    }
    const rosterProof = proof(42, ["111", "222"])

    const results = await Promise.allSettled(
      ["111", "222"].map((githubUserId) =>
        purgeUserAccount(db, subject(githubUserId), { adminRosterProofs: [rosterProof] }),
      ),
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({
      name: AccountDeleteConflictError.name,
      reason: "last_admin",
    })
    const activeAdmins = await readActiveAdmins(db)
    expect(activeAdmins).toHaveLength(1)
    expect(["111", "222"]).toContain(activeAdmins[0])
    await expect(
      db.prepare("SELECT github_user_id FROM user_identity ORDER BY github_user_id").all(),
    ).resolves.toMatchObject({ results: [{ github_user_id: activeAdmins[0] }] })
  })

  it("rolls the whole purge back when the subject becomes an admin after proof collection", async () => {
    await seedIdentity(db, "111")
    await seedAccess(db, "111", "member")
    await seedAccess(db, "222", "admin")
    await seedAssignedSeat(db, "111")

    const installationIds = await listAccountAdminInstallationIds(db, subject("111"))
    expect(installationIds).toEqual([])
    await db
      .prepare(
        `UPDATE org_workspace_access
            SET role = 'admin', updated_at = ?, updated_by = 'system:race',
                last_audit_id = 'promoted-after-proof', last_action = 'role_changed'
          WHERE installation_id = 42 AND github_user_id = '111'`,
      )
      .bind("2026-07-15T00:00:01.000Z")
      .run()

    await expect(purgeUserAccount(db, subject("111"), { adminRosterProofs: [] })).rejects.toMatchObject({
      name: AccountDeleteConflictError.name,
      reason: "org_access_changed",
    })

    await expect(db.prepare("SELECT user_id FROM user_identity WHERE user_id = 'user-111'").first()).resolves.toEqual({
      user_id: "user-111",
    })
    await expect(db.prepare("SELECT user_id FROM user_credential WHERE user_id = 'user-111'").first()).resolves.toEqual(
      { user_id: "user-111" },
    )
    await expect(readAccess(db, "111")).resolves.toEqual({ role: "admin", revoked_at: null })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .first(),
    ).resolves.toEqual({ assigned: 1 })
  })
})
