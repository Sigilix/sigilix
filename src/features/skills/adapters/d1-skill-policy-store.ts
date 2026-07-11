import {
  parseSkillSurfacePolicy,
  type SkillInstallStatus,
  type StoredSkillPolicy,
} from "@/src/features/skills/domain/policy"
import type { Env } from "@/src/shared/types/env"

type SkillPolicyRow = {
  installation_id: number
  skill_id: string
  version: number
  status: string
  enabled: number
  surfaces: string
  updated_by: string
  installed_at_ms: number
  updated_at_ms: number
  revoked_at_ms: number | null
}

export type SkillPolicyReadResult =
  | { status: "ok"; policies: StoredSkillPolicy[]; invalidRowCount: number }
  | { status: "unavailable" }

export type SkillPolicyWriteResult =
  | { status: "ok"; policy: StoredSkillPolicy }
  | { status: "conflict" }
  | { status: "unavailable" }

interface ConfigureSkillPolicyArgs {
  installationId: number
  skillId: string
  expectedVersion: number
  enabled: boolean
  surfaces: StoredSkillPolicy["surfaces"]
  updatedBy: string
  nowMs: number
}

interface RevokeSkillPolicyArgs {
  installationId: number
  skillId: string
  updatedBy: string
  nowMs: number
}

const SELECT_COLUMNS = `SELECT installation_id, skill_id, version, status, enabled, surfaces,
                                updated_by, installed_at_ms, updated_at_ms, revoked_at_ms
                           FROM org_skill_policy`

export async function readSkillPolicies(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<SkillPolicyReadResult> {
  if (!validInstallationId(installationId) || !env.SIGILIX_PLATFORM_DB) return { status: "unavailable" }
  try {
    const result = await env.SIGILIX_PLATFORM_DB.prepare(
      `${SELECT_COLUMNS} WHERE installation_id = ? ORDER BY skill_id ASC`,
    )
      .bind(installationId)
      .all<SkillPolicyRow>()
    const policies: StoredSkillPolicy[] = []
    let invalidRowCount = 0
    for (const row of result.results) {
      const policy = mapPolicyRow(row)
      if (policy) policies.push(policy)
      else invalidRowCount += 1
    }
    return { status: "ok", policies, invalidRowCount }
  } catch {
    return { status: "unavailable" }
  }
}

export async function configureSkillPolicy(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: ConfigureSkillPolicyArgs,
): Promise<SkillPolicyWriteResult> {
  if (!validWriteArgs(args) || !env.SIGILIX_PLATFORM_DB) return { status: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const result =
      args.expectedVersion === 0
        ? await db
            .prepare(
              `INSERT INTO org_skill_policy
                 (installation_id, skill_id, version, status, enabled, surfaces, updated_by,
                  installed_at_ms, updated_at_ms, revoked_at_ms)
               VALUES (?, ?, 1, 'installed', ?, ?, ?, ?, ?, NULL)
               ON CONFLICT (installation_id, skill_id) DO NOTHING`,
            )
            .bind(
              args.installationId,
              args.skillId,
              args.enabled ? 1 : 0,
              JSON.stringify(args.surfaces),
              args.updatedBy,
              args.nowMs,
              args.nowMs,
            )
            .run()
        : await db
            .prepare(
              `UPDATE org_skill_policy
                  SET version = version + 1, status = 'installed', enabled = ?, surfaces = ?,
                      updated_by = ?, updated_at_ms = ?, revoked_at_ms = NULL
                WHERE installation_id = ? AND skill_id = ? AND version = ?`,
            )
            .bind(
              args.enabled ? 1 : 0,
              JSON.stringify(args.surfaces),
              args.updatedBy,
              args.nowMs,
              args.installationId,
              args.skillId,
              args.expectedVersion,
            )
            .run()
    if ((result.meta.changes ?? 0) !== 1) return { status: "conflict" }
    return readWrittenPolicy(db, args.installationId, args.skillId)
  } catch {
    return { status: "unavailable" }
  }
}

export async function revokeSkillPolicy(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: RevokeSkillPolicyArgs,
): Promise<SkillPolicyWriteResult> {
  if (!validWriteArgs({ ...args, expectedVersion: 0, enabled: false, surfaces: emptySurfaces() })) {
    return { status: "unavailable" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { status: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  try {
    const result = await db
      .prepare(
        `UPDATE org_skill_policy
            SET version = version + 1, status = 'revoked', enabled = 0,
                surfaces = ?, updated_by = ?, updated_at_ms = ?, revoked_at_ms = ?
          WHERE installation_id = ? AND skill_id = ? AND status <> 'revoked'`,
      )
      .bind(JSON.stringify(emptySurfaces()), args.updatedBy, args.nowMs, args.nowMs, args.installationId, args.skillId)
      .run()
    if ((result.meta.changes ?? 0) !== 1) return { status: "conflict" }
    return readWrittenPolicy(db, args.installationId, args.skillId)
  } catch {
    return { status: "unavailable" }
  }
}

async function readWrittenPolicy(
  db: D1Database,
  installationId: number,
  skillId: string,
): Promise<SkillPolicyWriteResult> {
  const row = await db
    .prepare(`${SELECT_COLUMNS} WHERE installation_id = ? AND skill_id = ?`)
    .bind(installationId, skillId)
    .first<SkillPolicyRow>()
  const policy = row ? mapPolicyRow(row) : null
  return policy ? { status: "ok", policy } : { status: "unavailable" }
}

function mapPolicyRow(row: SkillPolicyRow): StoredSkillPolicy | null {
  if (
    !validInstallationId(row.installation_id) ||
    !safeSkillId(row.skill_id) ||
    !Number.isSafeInteger(row.version) ||
    row.version <= 0 ||
    !isStatus(row.status) ||
    (row.enabled !== 0 && row.enabled !== 1) ||
    !safeActor(row.updated_by) ||
    !validTimestamp(row.installed_at_ms) ||
    !validTimestamp(row.updated_at_ms) ||
    (row.revoked_at_ms !== null && !validTimestamp(row.revoked_at_ms))
  ) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.surfaces)
  } catch {
    return null
  }
  const surfaces = parseSkillSurfacePolicy(parsed)
  if (!surfaces) return null
  return {
    installationId: row.installation_id,
    skillId: row.skill_id,
    version: row.version,
    status: row.status,
    enabled: row.enabled === 1,
    surfaces,
    updatedBy: row.updated_by,
    installedAt: row.installed_at_ms,
    updatedAt: row.updated_at_ms,
    revokedAt: row.revoked_at_ms,
  }
}

function validWriteArgs(args: ConfigureSkillPolicyArgs): boolean {
  return (
    validInstallationId(args.installationId) &&
    safeSkillId(args.skillId) &&
    Number.isSafeInteger(args.expectedVersion) &&
    args.expectedVersion >= 0 &&
    safeActor(args.updatedBy) &&
    validTimestamp(args.nowMs) &&
    parseSkillSurfacePolicy(args.surfaces) !== null
  )
}

function emptySurfaces(): StoredSkillPolicy["surfaces"] {
  return { chat: false, "deep-research": false, cli: false, "pr-review": false, agent: false }
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function safeSkillId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

function safeActor(value: string): boolean {
  return value.length > 0 && value.length <= 160 && /^[A-Za-z0-9_.:@-]+$/.test(value)
}

function isStatus(value: string): value is SkillInstallStatus {
  return value === "installed" || value === "revoked"
}
