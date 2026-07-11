import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { disabledSkillSurfaces } from "@/src/features/skills/domain/policy"
import { configureSkillPolicy, readSkillPolicies, revokeSkillPolicy } from "./d1-skill-policy-store"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0017_create_org_skill_policy.sql", import.meta.url),
  "utf8",
)

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

describe("D1 skill policy store", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("creates default-off scoped policy and isolates installation reads", async () => {
    const created = await configureSkillPolicy(env(db), {
      installationId: 42,
      skillId: "supabase-postgres-best-practices",
      expectedVersion: 0,
      enabled: false,
      surfaces: disabledSkillSurfaces(),
      updatedBy: "user:admin-1",
      nowMs: 100,
    })
    expect(created).toEqual({
      status: "ok",
      policy: expect.objectContaining({
        installationId: 42,
        version: 1,
        status: "installed",
        enabled: false,
        surfaces: disabledSkillSurfaces(),
      }),
    })
    expect(await readSkillPolicies(env(db), 42)).toEqual({
      status: "ok",
      policies: [expect.objectContaining({ skillId: "supabase-postgres-best-practices" })],
      invalidRowCount: 0,
    })
    expect(await readSkillPolicies(env(db), 43)).toEqual({ status: "ok", policies: [], invalidRowCount: 0 })
  })

  it("uses the policy version as an atomic stale-write guard", async () => {
    const base = {
      installationId: 42,
      skillId: "supabase-postgres-best-practices",
      enabled: true,
      surfaces: { ...disabledSkillSurfaces(), chat: true },
      updatedBy: "user:admin-1",
      nowMs: 100,
    }
    expect((await configureSkillPolicy(env(db), { ...base, expectedVersion: 0 })).status).toBe("ok")
    expect((await configureSkillPolicy(env(db), { ...base, expectedVersion: 0, nowMs: 101 })).status).toBe("conflict")
    const updated = await configureSkillPolicy(env(db), { ...base, expectedVersion: 1, nowMs: 102 })
    expect(updated).toEqual({ status: "ok", policy: expect.objectContaining({ version: 2 }) })
    expect((await configureSkillPolicy(env(db), { ...base, expectedVersion: 1, nowMs: 103 })).status).toBe("conflict")
  })

  it("revokes atomically, clears every surface, and defeats a stale configure", async () => {
    const configured = await configureSkillPolicy(env(db), {
      installationId: 42,
      skillId: "openai-security-best-practices",
      expectedVersion: 0,
      enabled: true,
      surfaces: { ...disabledSkillSurfaces(), chat: true },
      updatedBy: "user:admin-1",
      nowMs: 100,
    })
    expect(configured.status).toBe("ok")
    const revoked = await revokeSkillPolicy(env(db), {
      installationId: 42,
      skillId: "openai-security-best-practices",
      updatedBy: "user:admin-2",
      nowMs: 200,
    })
    expect(revoked).toEqual({
      status: "ok",
      policy: expect.objectContaining({
        version: 2,
        status: "revoked",
        enabled: false,
        surfaces: disabledSkillSurfaces(),
        revokedAt: 200,
      }),
    })
    expect(
      (
        await configureSkillPolicy(env(db), {
          installationId: 42,
          skillId: "openai-security-best-practices",
          expectedVersion: 1,
          enabled: true,
          surfaces: { ...disabledSkillSurfaces(), chat: true },
          updatedBy: "user:stale-admin",
          nowMs: 201,
        })
      ).status,
    ).toBe("conflict")
  })

  it("counts malformed rows without returning partial policy", async () => {
    await db
      .prepare(
        `INSERT INTO org_skill_policy
          (installation_id, skill_id, version, status, enabled, surfaces, updated_by,
           installed_at_ms, updated_at_ms, revoked_at_ms)
         VALUES (?, ?, 1, 'installed', 1, ?, 'user:1', 1, 1, NULL)`,
      )
      .bind(42, "supabase-postgres-best-practices", '{"chat":true}')
      .run()
    expect(await readSkillPolicies(env(db), 42)).toEqual({ status: "ok", policies: [], invalidRowCount: 1 })
  })

  it("fails closed to unavailable for absent or broken storage", async () => {
    await expect(readSkillPolicies({}, 42)).resolves.toEqual({ status: "unavailable" })
    await expect(readSkillPolicies(env(brokenDb()), 42)).resolves.toEqual({ status: "unavailable" })
    await expect(
      configureSkillPolicy(env(brokenDb()), {
        installationId: 42,
        skillId: "supabase-postgres-best-practices",
        expectedVersion: 0,
        enabled: true,
        surfaces: { ...disabledSkillSurfaces(), chat: true },
        updatedBy: "user:1",
        nowMs: 1,
      }),
    ).resolves.toEqual({ status: "unavailable" })
  })
})
