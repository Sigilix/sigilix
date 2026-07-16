import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  addOrgWorkspaceMember,
  bootstrapFirstOrgAdmin,
  hasActiveOrgAdmin,
  listOrgWorkspaceAccess,
  readOrgWorkspaceAccess,
  recoverOrgWorkspaceAdmin,
  removeOrgWorkspaceAccess,
  setOrgWorkspaceRole,
} from "./d1-store"

const migration = (name: string) => readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(migration("0003_create_account_tenant_and_api_key.sql"))
  await db.exec(migration("0007_create_org_seat_assignment.sql"))
  await db.exec(migration("0020_create_stripe_seat_reconciliation.sql"))
  await db.exec(migration("0022_create_org_workspace_access.sql"))
  await db.exec(migration("0023_add_org_seat_billing_operation_context.sql"))
  await db.exec(migration("0028_create_org_workspace_seat_assignment.sql"))
  return db
}

const now = (n: number) => `2026-07-13T03:${String(n).padStart(2, "0")}:00.000Z`

function withRosterSnapshot<T extends object>(args: T, memberIds: readonly string[]) {
  const canonicalMemberIds = [...new Set(memberIds)].sort()
  return {
    ...args,
    rosterSnapshot: {
      memberIds: canonicalMemberIds,
      sqlTokenSet: canonicalMemberIds.length === 0 ? "" : `|${canonicalMemberIds.join("|")}|`,
    },
  }
}

const TEST_ROSTER = withRosterSnapshot({}, ["11", "111", "222", "333", "999"]).rosterSnapshot

describe("D1 organization workspace access store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = await makeDb()
  })

  it("keeps legacy account links dark and rejects malformed immutable IDs", async () => {
    const pre = makeD1()
    await pre.exec(migration("0003_create_account_tenant_and_api_key.sql"))
    await pre
      .prepare("INSERT INTO account_tenant (github_user_id, installation_id, role, created_at) VALUES (?, ?, ?, ?)")
      .bind("111", 42, "owner", now(1))
      .run()
    await pre
      .prepare("INSERT INTO account_tenant (github_user_id, installation_id, role, created_at) VALUES (?, ?, ?, ?)")
      .bind("not-a-github-id", 42, "member", now(1))
      .run()
    await pre.exec(migration("0007_create_org_seat_assignment.sql"))
    await pre.exec(migration("0022_create_org_workspace_access.sql"))

    await expect(readOrgWorkspaceAccess(pre, 42, "111")).resolves.toBeNull()
    await expect(hasActiveOrgAdmin(pre, 42, TEST_ROSTER)).resolves.toBe(false)
    await expect(pre.prepare("SELECT COUNT(*) AS n FROM org_workspace_access").first<{ n: number }>()).resolves.toEqual(
      { n: 0 },
    )
    await expect(
      pre
        .prepare(
          `INSERT INTO org_workspace_access
            (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
             updated_by, last_audit_id, last_action)
           VALUES (42, 'still-invalid', 'member', ?, ?, NULL,
                   'system:test', 'invalid-id-audit', 'member_added_or_regranted')`,
        )
        .bind(now(1), now(1))
        .run(),
    ).rejects.toThrow()
  })

  it("requires every direct access update to emit an audit and keeps immutable identity fixed", async () => {
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "111",
      nowIso: now(1),
      updatedBy: "github:999",
    })

    await expect(
      db
        .prepare(
          "UPDATE org_workspace_access SET role = 'admin'" + " WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .run(),
    ).rejects.toThrow(/audit/i)
    await expect(
      db
        .prepare(
          "UPDATE org_workspace_access SET github_user_id = '222', last_audit_id = 'forged-audit'" +
            " WHERE installation_id = 42 AND github_user_id = '111'",
        )
        .run(),
    ).rejects.toThrow(/immutable/i)

    await expect(readOrgWorkspaceAccess(db, 42, "111")).resolves.toMatchObject({ role: "member" })
    await expect(readOrgWorkspaceAccess(db, 42, "222")).resolves.toBeNull()
    await expect(
      db.prepare("SELECT COUNT(*) AS n FROM org_workspace_access_audit").first<{ n: number }>(),
    ).resolves.toEqual({ n: 1 })
  })

  it("serializes concurrent first-admin bootstrap so exactly one caller wins", async () => {
    const results = await Promise.all(
      ["111", "222"].map((githubUserId, index) =>
        bootstrapFirstOrgAdmin(db, {
          installationId: 42,
          githubUserId,
          nowIso: now(index + 2),
          updatedBy: `admin-${githubUserId}`,
          rosterSnapshot: TEST_ROSTER,
        }),
      ),
    )

    expect(results.filter((result) => result === "bootstrapped")).toHaveLength(1)
    expect(results.filter((result) => result === "not_bootstrapped")).toHaveLength(1)
    const active = (await listOrgWorkspaceAccess(db, 42)).filter(
      (row) => row.role === "admin" && row.revokedAt === null,
    )
    expect(active).toHaveLength(1)
  })

  it("allows divergent complete rosters to seed multiple roster-proven reachable admins", async () => {
    const results = await Promise.all(
      ["111", "222"].map((githubUserId, index) =>
        bootstrapFirstOrgAdmin(
          db,
          withRosterSnapshot(
            {
              installationId: 42,
              githubUserId,
              nowIso: now(index + 2),
              updatedBy: `admin-${githubUserId}`,
            },
            [githubUserId],
          ),
        ),
      ),
    )

    expect(results).toEqual(["bootstrapped", "bootstrapped"])
    expect(
      (await listOrgWorkspaceAccess(db, 42)).filter((row) => row.role === "admin" && row.revokedAt === null),
    ).toHaveLength(2)
  })

  it("ignores stale stored admins outside the roster snapshot when bootstrapping a current member", async () => {
    await expect(
      bootstrapFirstOrgAdmin(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "222",
            nowIso: now(2),
            updatedBy: "stale-admin",
          },
          ["222"],
        ),
      ),
    ).resolves.toBe("bootstrapped")

    await expect(
      bootstrapFirstOrgAdmin(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "111",
            nowIso: now(3),
            updatedBy: "current-admin",
          },
          ["111"],
        ),
      ),
    ).resolves.toBe("bootstrapped")
    await expect(readOrgWorkspaceAccess(db, 42, "111")).resolves.toMatchObject({
      role: "admin",
      revokedAt: null,
    })
  })

  it("does not bootstrap from an empty roster snapshot", async () => {
    await expect(
      bootstrapFirstOrgAdmin(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "111",
            nowIso: now(2),
            updatedBy: "unreachable-admin",
          },
          [],
        ),
      ),
    ).resolves.toBe("not_bootstrapped")
    await expect(readOrgWorkspaceAccess(db, 42, "111")).resolves.toBeNull()
  })

  it("promotes an existing active member through the bootstrap conflict path", async () => {
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "111",
      nowIso: now(2),
      updatedBy: "onboarding",
    })

    await expect(
      bootstrapFirstOrgAdmin(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "111",
            nowIso: now(3),
            updatedBy: "github:111",
          },
          ["111"],
        ),
      ),
    ).resolves.toBe("bootstrapped")
    await expect(readOrgWorkspaceAccess(db, 42, "111")).resolves.toMatchObject({ role: "admin", revokedAt: null })
  })

  it("matches roster IDs exactly rather than treating 11 as part of 111", async () => {
    await bootstrapFirstOrgAdmin(
      db,
      withRosterSnapshot(
        {
          installationId: 42,
          githubUserId: "111",
          nowIso: now(2),
          updatedBy: "old-admin",
        },
        ["111"],
      ),
    )

    await expect(
      bootstrapFirstOrgAdmin(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "11",
            nowIso: now(3),
            updatedBy: "current-admin",
          },
          ["11"],
        ),
      ),
    ).resolves.toBe("bootstrapped")
    await expect(readOrgWorkspaceAccess(db, 42, "11")).resolves.toMatchObject({ role: "admin" })
  })

  it("never lets bootstrap resurrect a revoked tombstone", async () => {
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "111",
      nowIso: now(2),
      updatedBy: "owner",
    })
    expect(
      await removeOrgWorkspaceAccess(db, {
        installationId: 42,
        githubUserId: "111",
        login: "octocat",
        nowIso: now(3),
        updatedBy: "owner",
        rosterSnapshot: TEST_ROSTER,
      }),
    ).toEqual({ status: "removed" })

    await expect(
      bootstrapFirstOrgAdmin(db, {
        installationId: 42,
        githubUserId: "111",
        nowIso: now(4),
        updatedBy: "octocat",
        rosterSnapshot: TEST_ROSTER,
      }),
    ).resolves.toBe("not_bootstrapped")
    await expect(readOrgWorkspaceAccess(db, 42, "111")).resolves.toMatchObject({
      role: "member",
      revokedAt: now(3),
    })
  })

  it("blocks the last admin demotion and removal", async () => {
    expect(
      await bootstrapFirstOrgAdmin(db, {
        installationId: 42,
        githubUserId: "111",
        nowIso: now(2),
        updatedBy: "octocat",
        rosterSnapshot: TEST_ROSTER,
      }),
    ).toBe("bootstrapped")

    await expect(
      setOrgWorkspaceRole(db, {
        installationId: 42,
        githubUserId: "111",
        role: "member",
        nowIso: now(3),
        updatedBy: "octocat",
        rosterSnapshot: TEST_ROSTER,
      }),
    ).resolves.toEqual({ status: "last_admin" })
    await expect(
      removeOrgWorkspaceAccess(db, {
        installationId: 42,
        githubUserId: "111",
        login: "octocat",
        nowIso: now(4),
        updatedBy: "octocat",
        rosterSnapshot: TEST_ROSTER,
      }),
    ).resolves.toEqual({ status: "last_admin" })
  })

  async function seedCurrentAndStaleStoredAdmins(): Promise<void> {
    await bootstrapFirstOrgAdmin(
      db,
      withRosterSnapshot(
        {
          installationId: 42,
          githubUserId: "111",
          nowIso: now(2),
          updatedBy: "admin-111",
        },
        ["111", "222"],
      ),
    )
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "222",
      nowIso: now(3),
      updatedBy: "admin-111",
    })
    await setOrgWorkspaceRole(
      db,
      withRosterSnapshot(
        {
          installationId: 42,
          githubUserId: "222",
          role: "admin" as const,
          nowIso: now(4),
          updatedBy: "admin-111",
        },
        ["111", "222"],
      ),
    )
  }

  it("blocks demoting the only roster-current admin when another stored admin is stale", async () => {
    await seedCurrentAndStaleStoredAdmins()

    await expect(
      setOrgWorkspaceRole(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "111",
            role: "member" as const,
            nowIso: now(5),
            updatedBy: "admin-111",
          },
          ["111"],
        ),
      ),
    ).resolves.toEqual({ status: "last_admin" })
    await expect(readOrgWorkspaceAccess(db, 42, "111")).resolves.toMatchObject({ role: "admin" })
  })

  it("blocks removing the only roster-current admin when another stored admin is stale", async () => {
    await seedCurrentAndStaleStoredAdmins()

    await expect(
      removeOrgWorkspaceAccess(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "111",
            login: "current-admin",
            nowIso: now(5),
            updatedBy: "admin-111",
          },
          ["111"],
        ),
      ),
    ).resolves.toEqual({ status: "last_admin" })
    await expect(readOrgWorkspaceAccess(db, 42, "111")).resolves.toMatchObject({ revokedAt: null })
  })

  it("allows removing a departed stale admin after a current roster admin is stored", async () => {
    await bootstrapFirstOrgAdmin(
      db,
      withRosterSnapshot(
        {
          installationId: 42,
          githubUserId: "222",
          nowIso: now(2),
          updatedBy: "old-admin",
        },
        ["222"],
      ),
    )

    await expect(
      bootstrapFirstOrgAdmin(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "111",
            nowIso: now(3),
            updatedBy: "current-admin",
          },
          ["111"],
        ),
      ),
    ).resolves.toBe("bootstrapped")

    await expect(
      removeOrgWorkspaceAccess(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "222",
            login: "departed-admin",
            nowIso: now(4),
            updatedBy: "current-operator",
          },
          ["111"],
        ),
      ),
    ).resolves.toEqual({ status: "removed" })
    await expect(readOrgWorkspaceAccess(db, 42, "222")).resolves.toMatchObject({ revokedAt: now(4) })
  })

  it("blocks a departed-admin removal when a newer snapshot has no stored reachable admin", async () => {
    await seedCurrentAndStaleStoredAdmins()

    await expect(
      setOrgWorkspaceRole(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "111",
            role: "member" as const,
            nowIso: now(5),
            updatedBy: "admin-111",
          },
          ["111", "222"],
        ),
      ),
    ).resolves.toEqual({ status: "updated", access: expect.objectContaining({ role: "member" }) })

    await expect(
      removeOrgWorkspaceAccess(
        db,
        withRosterSnapshot(
          {
            installationId: 42,
            githubUserId: "222",
            login: "departed-admin",
            nowIso: now(6),
            updatedBy: "admin-111",
          },
          ["111"],
        ),
      ),
    ).resolves.toEqual({ status: "last_admin" })
    expect(
      (await listOrgWorkspaceAccess(db, 42)).filter((row) => row.role === "admin" && row.revokedAt === null),
    ).toHaveLength(1)
  })

  it("serializes concurrent two-admin demotions against one roster snapshot and retains one active admin", async () => {
    await bootstrapFirstOrgAdmin(
      db,
      withRosterSnapshot(
        {
          installationId: 42,
          githubUserId: "111",
          nowIso: now(2),
          updatedBy: "admin-111",
        },
        ["111", "222"],
      ),
    )
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "222",
      nowIso: now(3),
      updatedBy: "admin-111",
    })
    await setOrgWorkspaceRole(
      db,
      withRosterSnapshot(
        {
          installationId: 42,
          githubUserId: "222",
          role: "admin" as const,
          nowIso: now(4),
          updatedBy: "admin-111",
        },
        ["111", "222"],
      ),
    )

    const results = await Promise.all(
      ["111", "222"].map((githubUserId, index) =>
        setOrgWorkspaceRole(
          db,
          withRosterSnapshot(
            {
              installationId: 42,
              githubUserId,
              role: "member" as const,
              nowIso: now(5 + index),
              updatedBy: "race",
            },
            ["111", "222"],
          ),
        ),
      ),
    )
    expect(results.filter((result) => result.status === "updated")).toHaveLength(1)
    expect(results.filter((result) => result.status === "last_admin")).toHaveLength(1)
    expect(
      (await listOrgWorkspaceAccess(db, 42)).filter((row) => row.role === "admin" && row.revokedAt === null),
    ).toHaveLength(1)
  })

  it("removes access, unassigns the exact seat, and revokes only exact-installation keys atomically", async () => {
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "222",
      nowIso: now(2),
      updatedBy: "owner",
    })
    await addOrgWorkspaceMember(db, {
      installationId: 99,
      githubUserId: "222",
      nowIso: now(2),
      updatedBy: "other-owner",
    })
    await db
      .prepare(
        `INSERT INTO org_workspace_seat_assignment
          (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
         VALUES (42, '222', 1, 'old-name', ?, ?, 'owner'),
                (99, '222', 1, 'other-name', ?, ?, 'other-owner')`,
      )
      .bind(now(2), now(2), now(2), now(2))
      .run()
    await db
      .prepare(
        "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at) VALUES (?, ?, 1, 1, ?)",
      )
      .bind(42, "renamed-user", now(2))
      .run()
    for (const [id, installationId] of [
      ["key-a", 42],
      ["key-b", 99],
    ] as const) {
      await db
        .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, `hash-${id}`, installationId, "222", now(2))
        .run()
    }

    await expect(
      removeOrgWorkspaceAccess(db, {
        installationId: 42,
        githubUserId: "222",
        login: "Renamed-User",
        nowIso: now(3),
        updatedBy: "owner",
        rosterSnapshot: TEST_ROSTER,
      }),
    ).resolves.toEqual({ status: "removed" })

    expect(
      await db
        .prepare(
          "SELECT assigned, is_admin FROM org_seat_assignment" +
            " WHERE installation_id = 42 AND login = 'renamed-user'",
        )
        .first<{ assigned: number; is_admin: number }>(),
    ).toEqual({ assigned: 0, is_admin: 0 })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 42 AND github_user_id = '222'",
        )
        .first<{ assigned: number }>(),
    ).resolves.toEqual({ assigned: 0 })
    await expect(
      db
        .prepare(
          "SELECT assigned FROM org_workspace_seat_assignment WHERE installation_id = 99 AND github_user_id = '222'",
        )
        .first<{ assigned: number }>(),
    ).resolves.toEqual({ assigned: 1 })
    expect(
      await db.prepare("SELECT revoked_at FROM api_key WHERE id = 'key-a'").first<{ revoked_at: string | null }>(),
    ).toEqual({ revoked_at: now(3) })
    expect(
      await db.prepare("SELECT revoked_at FROM api_key WHERE id = 'key-b'").first<{ revoked_at: string | null }>(),
    ).toEqual({ revoked_at: null })
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM org_workspace_access_audit WHERE action = 'access_removed'")
        .first<{ n: number }>(),
    ).toEqual({ n: 1 })
  })

  it("does not repeat removal side effects when a retry reuses the same timestamp and actor", async () => {
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "222",
      nowIso: now(2),
      updatedBy: "owner",
    })
    const removal = {
      installationId: 42,
      githubUserId: "222",
      login: "member",
      nowIso: now(3),
      updatedBy: "owner",
      rosterSnapshot: TEST_ROSTER,
    } as const

    await expect(removeOrgWorkspaceAccess(db, removal)).resolves.toEqual({ status: "removed" })
    await db
      .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("key-created-after-removal", "hash-created-after-removal", 42, "222", now(4))
      .run()

    await expect(removeOrgWorkspaceAccess(db, removal)).resolves.toEqual({ status: "not_found" })
    await expect(
      db
        .prepare("SELECT revoked_at FROM api_key WHERE id = 'key-created-after-removal'")
        .first<{ revoked_at: string | null }>(),
    ).resolves.toEqual({ revoked_at: null })
  })

  it("keeps identical GitHub users isolated across installations", async () => {
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "222",
      nowIso: now(2),
      updatedBy: "owner",
    })
    await addOrgWorkspaceMember(db, {
      installationId: 99,
      githubUserId: "222",
      nowIso: now(3),
      updatedBy: "other-owner",
    })
    await removeOrgWorkspaceAccess(db, {
      installationId: 42,
      githubUserId: "222",
      login: "member",
      nowIso: now(4),
      updatedBy: "owner",
      rosterSnapshot: TEST_ROSTER,
    })

    await expect(readOrgWorkspaceAccess(db, 42, "222")).resolves.toMatchObject({ revokedAt: now(4) })
    await expect(readOrgWorkspaceAccess(db, 99, "222")).resolves.toMatchObject({ revokedAt: null })
  })

  it("operator recovery intentionally clears a tombstone and records a durable audit", async () => {
    await addOrgWorkspaceMember(db, {
      installationId: 42,
      githubUserId: "111",
      nowIso: now(2),
      updatedBy: "owner",
    })
    await removeOrgWorkspaceAccess(db, {
      installationId: 42,
      githubUserId: "111",
      login: "octocat",
      nowIso: now(3),
      updatedBy: "owner",
      rosterSnapshot: TEST_ROSTER,
    })

    const recovered = await recoverOrgWorkspaceAdmin(db, {
      installationId: 42,
      githubUserId: "111",
      nowIso: now(4),
      updatedBy: "system:admin-token",
    })
    expect(recovered).toMatchObject({ role: "admin", revokedAt: null })
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM org_workspace_access_audit WHERE action = 'operator_recovery'")
        .first<{ n: number }>(),
    ).toEqual({ n: 1 })
  })
})
