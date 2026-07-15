import {
  isOrgWorkspaceGithubUserId,
  type OrgWorkspaceAccess,
  type OrgWorkspaceRole,
  type RemoveOrgWorkspaceAccessResult,
  type SetOrgWorkspaceRoleResult,
} from "@/src/features/org-membership/domain/types"

interface AccessRow {
  installation_id: number
  github_user_id: string
  role: string
  revoked_at: string | null
  created_at: string
  updated_at: string
  updated_by: string
}

interface MutationArgs {
  installationId: number
  githubUserId: string
  nowIso: string
  updatedBy: string
}

interface RoleMutationArgs extends MutationArgs {
  role: OrgWorkspaceRole
}

interface RemoveArgs extends MutationArgs {
  /** Current roster login, when still available; used solely to clear the
   * legacy login-keyed seat row. Access/key revocation never depends on it. */
  login?: string
}

interface ExistingRemovalTombstone {
  revokedAt: string
  auditId: string
}

export interface OrgWorkspaceSeatBillingFence {
  leaseToken: string
  leaseAcquiredAtMs: number
  nowMs: number
  expectedActiveOperation: {
    operationId: string
    revision: number
    state: "pending" | "stripe_applied"
    settlementStatements: readonly D1PreparedStatement[]
  } | null
}

const ACCESS_COLUMNS = "installation_id, github_user_id, role, revoked_at, created_at, updated_at, updated_by"

export async function readOrgWorkspaceAccess(
  db: D1Database,
  installationId: number,
  githubUserId: string,
): Promise<OrgWorkspaceAccess | null> {
  validateIdentity(installationId, githubUserId)
  const row = await db
    .prepare(`SELECT ${ACCESS_COLUMNS} FROM org_workspace_access WHERE installation_id = ? AND github_user_id = ?`)
    .bind(installationId, githubUserId)
    .first<AccessRow>()
  return row === null ? null : decodeAccess(row)
}

export async function listOrgWorkspaceAccess(db: D1Database, installationId: number): Promise<OrgWorkspaceAccess[]> {
  if (!validInstallationId(installationId)) throw new Error("invalid installation id")
  const { results } = await db
    .prepare(`SELECT ${ACCESS_COLUMNS} FROM org_workspace_access WHERE installation_id = ? ORDER BY github_user_id`)
    .bind(installationId)
    .all<AccessRow>()
  return results.map(decodeAccess)
}

export async function hasActiveOrgAdmin(db: D1Database, installationId: number): Promise<boolean> {
  if (!validInstallationId(installationId)) throw new Error("invalid installation id")
  const row = await db
    .prepare(
      "SELECT 1 AS present FROM org_workspace_access" +
        " WHERE installation_id = ? AND role = 'admin' AND revoked_at IS NULL LIMIT 1",
    )
    .bind(installationId)
    .first<{ present: number }>()
  return row !== null
}

/**
 * Atomically seed the first Sigilix admin. D1 executes one database's queries
 * serially; the INSERT...SELECT predicate and conflict update are one statement,
 * so concurrent GitHub admins cannot both observe an admin-less workspace.
 * A revoked target is deliberately never resurrected here.
 */
export async function bootstrapFirstOrgAdmin(
  db: D1Database,
  args: MutationArgs,
): Promise<"bootstrapped" | "not_bootstrapped"> {
  validateMutation(args)
  const auditId = auditKey()
  const result = await db
    .prepare(
      `INSERT INTO org_workspace_access
          (installation_id, github_user_id, role, revoked_at, created_at, updated_at,
           updated_by, last_audit_id, last_action)
         SELECT ?, ?, 'admin', NULL, ?, ?, ?, ?, 'bootstrap_admin'
          WHERE NOT EXISTS (
            SELECT 1 FROM org_workspace_access
             WHERE installation_id = ? AND role = 'admin' AND revoked_at IS NULL
          )
            AND NOT EXISTS (
              SELECT 1 FROM org_workspace_access
               WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NOT NULL
            )
         ON CONFLICT(installation_id, github_user_id) DO UPDATE SET
           role = 'admin', updated_at = excluded.updated_at, updated_by = excluded.updated_by,
           last_audit_id = excluded.last_audit_id, last_action = excluded.last_action
         WHERE org_workspace_access.revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM org_workspace_access AS other
              WHERE other.installation_id = excluded.installation_id
                AND other.role = 'admin' AND other.revoked_at IS NULL
           )`,
    )
    .bind(
      args.installationId,
      args.githubUserId,
      args.nowIso,
      args.nowIso,
      args.updatedBy,
      auditId,
      args.installationId,
      args.installationId,
      args.githubUserId,
    )
    .run()
  return changes(result) === 1 ? "bootstrapped" : "not_bootstrapped"
}

/** Add a roster-proven member or regrant a revoked member. Active roles are preserved. */
export async function addOrgWorkspaceMember(db: D1Database, args: MutationArgs): Promise<OrgWorkspaceAccess> {
  validateMutation(args)
  await db
    .prepare(
      `INSERT INTO org_workspace_access
          (installation_id, github_user_id, role, revoked_at, created_at, updated_at,
           updated_by, last_audit_id, last_action)
         VALUES (?, ?, 'member', NULL, ?, ?, ?, ?, 'member_added_or_regranted')
         ON CONFLICT(installation_id, github_user_id) DO UPDATE SET
           role = CASE
             WHEN org_workspace_access.revoked_at IS NULL THEN org_workspace_access.role
             ELSE 'member'
           END,
           revoked_at = NULL,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           last_audit_id = excluded.last_audit_id,
           last_action = excluded.last_action`,
    )
    .bind(args.installationId, args.githubUserId, args.nowIso, args.nowIso, args.updatedBy, auditKey())
    .run()
  return requireAccess(await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId))
}

/** Change a stored role while atomically preserving at least one active admin. */
export async function setOrgWorkspaceRole(db: D1Database, args: RoleMutationArgs): Promise<SetOrgWorkspaceRoleResult> {
  validateMutation(args)
  if (!validRole(args.role)) throw new Error("invalid organization role")
  const result = await db
    .prepare(
      `UPDATE org_workspace_access
            SET role = ?, updated_at = ?, updated_by = ?,
                last_audit_id = ?, last_action = 'role_changed'
          WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NULL
            AND (
              role <> 'admin' OR ? = 'admin' OR EXISTS (
                SELECT 1 FROM org_workspace_access AS other
                 WHERE other.installation_id = org_workspace_access.installation_id
                   AND other.github_user_id <> org_workspace_access.github_user_id
                   AND other.role = 'admin' AND other.revoked_at IS NULL
              )
            )`,
    )
    .bind(args.role, args.nowIso, args.updatedBy, auditKey(), args.installationId, args.githubUserId, args.role)
    .run()
  if (changes(result) === 1) {
    return {
      status: "updated",
      access: requireAccess(await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId)),
    }
  }
  const current = await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId)
  return current?.revokedAt === null && current.role === "admin" && args.role === "member"
    ? { status: "last_admin" }
    : { status: "not_found" }
}

/**
 * Revoke Sigilix access. The tombstone, exact-installation key revocation,
 * immutable managed-seat unassign, optional legacy seat unassign, and durable
 * audit commit in one D1 transaction.
 */
export async function removeOrgWorkspaceAccess(
  db: D1Database,
  args: RemoveArgs,
): Promise<RemoveOrgWorkspaceAccessResult> {
  validateMutation(args)
  const loginKey = args.login === undefined ? null : normalizeLogin(args.login)
  if (args.login !== undefined && loginKey === null) throw new Error("invalid member login")
  const auditId = auditKey()
  const statements = removalMutationStatements(db, args, loginKey, auditId, null)
  const results = await db.batch(statements)
  if (changes(results[0]) === 1) return { status: "removed" }
  return classifyRemovalMiss(db, args)
}

/**
 * Remove access under the exact seat-billing lease. When an expansion is
 * active, its caller-composed settlement statements and the access tombstone
 * commit in the same D1 transaction. The leading eligibility guard preserves
 * last-admin/not-found semantics without allowing a rejected removal to
 * settle billing work; the trailing audit guard rolls back the entire batch
 * unless either this invocation's tombstone or the exact pinned prior
 * tombstone remains durable after settlement.
 */
export async function removeOrgWorkspaceAccessWithSeatBillingFence(
  db: D1Database,
  args: RemoveArgs,
  fence: OrgWorkspaceSeatBillingFence,
): Promise<RemoveOrgWorkspaceAccessResult> {
  validateMutation(args)
  validateSeatBillingFence(fence)
  const loginKey = args.login === undefined ? null : normalizeLogin(args.login)
  if (args.login !== undefined && loginKey === null) throw new Error("invalid member login")
  const auditId = auditKey()
  const existingTombstone = await readExistingRemovalTombstone(db, args)
  const mutations = removalMutationStatements(db, args, loginKey, auditId, fence)
  const settlementStatements = fence.expectedActiveOperation?.settlementStatements ?? []
  const accessResultIndex = 1 + settlementStatements.length
  try {
    const results = await db.batch([
      removalEligibilityGuard(db, args, fence, existingTombstone),
      ...settlementStatements,
      ...mutations,
      removalAuditGuard(db, args, fence, auditId, existingTombstone),
    ])
    return changes(results[accessResultIndex]) === 1 ? { status: "removed" } : classifyRemovalMiss(db, args)
  } catch {
    return classifyFencedRemovalFailure(db, args)
  }
}

function removalMutationStatements(
  db: D1Database,
  args: RemoveArgs,
  loginKey: string | null,
  auditId: string,
  fence: OrgWorkspaceSeatBillingFence | null,
): D1PreparedStatement[] {
  const fenceSql =
    fence === null
      ? ""
      : ` AND EXISTS (
              SELECT 1 FROM org_seat_billing_lease
               WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM org_seat_billing_operation
               WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')
            )`
  const fenceBindings =
    fence === null
      ? []
      : [args.installationId, fence.leaseToken, fence.leaseAcquiredAtMs, fence.nowMs, args.installationId]
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE org_workspace_access
            SET revoked_at = ?, updated_at = ?, updated_by = ?,
                last_audit_id = ?, last_action = 'access_removed'
          WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NULL
            AND (
              role <> 'admin' OR EXISTS (
                SELECT 1 FROM org_workspace_access AS other
                 WHERE other.installation_id = org_workspace_access.installation_id
                   AND other.github_user_id <> org_workspace_access.github_user_id
                   AND other.role = 'admin' AND other.revoked_at IS NULL
              )
            )${fenceSql}`,
      )
      .bind(
        args.nowIso,
        args.nowIso,
        args.updatedBy,
        auditId,
        args.installationId,
        args.githubUserId,
        ...fenceBindings,
      ),
    db
      .prepare(
        `UPDATE api_key SET revoked_at = ?
          WHERE installation_id = ? AND created_by = ? AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1 FROM org_workspace_access
               WHERE installation_id = ? AND github_user_id = ? AND last_audit_id = ?
            )`,
      )
      .bind(args.nowIso, args.installationId, args.githubUserId, args.installationId, args.githubUserId, auditId),
    db
      .prepare(
        `UPDATE org_workspace_seat_assignment
            SET assigned = 0, updated_at = ?, updated_by = ?
          WHERE installation_id = ? AND github_user_id = ?
            AND EXISTS (
              SELECT 1 FROM org_workspace_access
               WHERE installation_id = ? AND github_user_id = ? AND last_audit_id = ?
            )`,
      )
      .bind(
        args.nowIso,
        args.updatedBy,
        args.installationId,
        args.githubUserId,
        args.installationId,
        args.githubUserId,
        auditId,
      ),
  ]
  if (loginKey !== null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO org_seat_assignment
          (installation_id, login, assigned, is_admin, updated_at, updated_by)
         SELECT ?, ?, 0, 0, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM org_workspace_access
             WHERE installation_id = ? AND github_user_id = ? AND last_audit_id = ?
         )
         ON CONFLICT(installation_id, login) DO UPDATE SET
           assigned = 0, is_admin = 0,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(
          args.installationId,
          loginKey,
          args.nowIso,
          args.updatedBy,
          args.installationId,
          args.githubUserId,
          auditId,
        ),
    )
  }
  return statements
}

function removalEligibilityGuard(
  db: D1Database,
  args: RemoveArgs,
  fence: OrgWorkspaceSeatBillingFence,
  existingTombstone: ExistingRemovalTombstone | null,
): D1PreparedStatement {
  const operationSql =
    fence.expectedActiveOperation === null
      ? `NOT EXISTS (
          SELECT 1 FROM org_seat_billing_operation
           WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')
        )`
      : `EXISTS (
          SELECT 1 FROM org_seat_billing_operation
           WHERE installation_id = ? AND operation_id = ? AND revision = ? AND state = ?
        )`
  const operationBindings =
    fence.expectedActiveOperation === null
      ? [args.installationId]
      : [
          args.installationId,
          fence.expectedActiveOperation.operationId,
          fence.expectedActiveOperation.revision,
          fence.expectedActiveOperation.state,
        ]
  const targetSql =
    existingTombstone === null
      ? `target.revoked_at IS NULL AND (
          target.role <> 'admin' OR EXISTS (
            SELECT 1 FROM org_workspace_access AS other
             WHERE other.installation_id = target.installation_id
               AND other.github_user_id <> target.github_user_id
               AND other.role = 'admin' AND other.revoked_at IS NULL
          )
        )`
      : "target.revoked_at = ? AND target.last_audit_id = ?"
  const targetBindings = existingTombstone === null ? [] : [existingTombstone.revokedAt, existingTombstone.auditId]
  // The leased installation already occupies its primary key, so the true
  // branch no-ops. The false branch selects installation 0, which cannot
  // conflict because the schema CHECK (> 0) makes such a row impossible; its
  // constraint error aborts and rolls back the caller-composed D1 batch.
  return db
    .prepare(
      `INSERT INTO org_seat_billing_lease
         (installation_id, lease_token, acquired_at_ms, expires_at_ms)
       SELECT CASE WHEN EXISTS (
         SELECT 1 FROM org_seat_billing_lease
          WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
       ) AND EXISTS (
         SELECT 1 FROM org_workspace_access AS target
          WHERE target.installation_id = ? AND target.github_user_id = ?
            AND (${targetSql})
       ) AND (${operationSql}) THEN ? ELSE 0 END,
       '__org_member_removal_guard__', 0, 1
       WHERE true
       ON CONFLICT(installation_id) DO NOTHING`,
    )
    .bind(
      args.installationId,
      fence.leaseToken,
      fence.leaseAcquiredAtMs,
      fence.nowMs,
      args.installationId,
      args.githubUserId,
      ...targetBindings,
      ...operationBindings,
      args.installationId,
    )
}

function removalAuditGuard(
  db: D1Database,
  args: RemoveArgs,
  fence: OrgWorkspaceSeatBillingFence,
  auditId: string,
  existingTombstone: ExistingRemovalTombstone | null,
): D1PreparedStatement {
  const tombstoneBindings =
    existingTombstone === null ? [args.nowIso, auditId] : [existingTombstone.revokedAt, existingTombstone.auditId]
  return db
    .prepare(
      `INSERT INTO org_seat_billing_lease
         (installation_id, lease_token, acquired_at_ms, expires_at_ms)
       SELECT CASE WHEN EXISTS (
         SELECT 1 FROM org_seat_billing_lease
          WHERE installation_id = ? AND lease_token = ? AND acquired_at_ms = ? AND expires_at_ms > ?
       ) AND EXISTS (
         SELECT 1 FROM org_workspace_access
          WHERE installation_id = ? AND github_user_id = ? AND revoked_at IS NOT NULL
            AND revoked_at = ? AND last_audit_id = ?
       ) AND NOT EXISTS (
         SELECT 1 FROM org_seat_billing_operation
          WHERE installation_id = ? AND state IN ('pending', 'stripe_applied')
       ) THEN ? ELSE 0 END,
       '__org_member_removal_audit_guard__', 0, 1
       WHERE true
       ON CONFLICT(installation_id) DO NOTHING`,
    )
    .bind(
      args.installationId,
      fence.leaseToken,
      fence.leaseAcquiredAtMs,
      fence.nowMs,
      args.installationId,
      args.githubUserId,
      ...tombstoneBindings,
      args.installationId,
      args.installationId,
    )
}

async function readExistingRemovalTombstone(
  db: D1Database,
  args: Pick<RemoveArgs, "installationId" | "githubUserId">,
): Promise<ExistingRemovalTombstone | null> {
  const row = await db
    .prepare(
      `SELECT revoked_at, last_audit_id FROM org_workspace_access
        WHERE installation_id = ? AND github_user_id = ?`,
    )
    .bind(args.installationId, args.githubUserId)
    .first<{ revoked_at: unknown; last_audit_id: unknown }>()
  if (row === null || row.revoked_at === null) return null
  if (
    typeof row.revoked_at !== "string" ||
    row.revoked_at.length === 0 ||
    typeof row.last_audit_id !== "string" ||
    row.last_audit_id.length === 0
  ) {
    throw new Error("invalid organization access tombstone")
  }
  return { revokedAt: row.revoked_at, auditId: row.last_audit_id }
}

async function classifyRemovalMiss(
  db: D1Database,
  args: Pick<RemoveArgs, "installationId" | "githubUserId">,
): Promise<RemoveOrgWorkspaceAccessResult> {
  const current = await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId)
  if (current === null || current.revokedAt !== null) return { status: "not_found" }
  if (current.role === "admin" && (await isLastActiveAdmin(db, args))) return { status: "last_admin" }
  throw new Error("organization access removal was fenced")
}

async function classifyFencedRemovalFailure(
  db: D1Database,
  args: Pick<RemoveArgs, "installationId" | "githubUserId">,
): Promise<RemoveOrgWorkspaceAccessResult> {
  const current = await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId)
  if (current?.revokedAt === null && current.role === "admin" && (await isLastActiveAdmin(db, args))) {
    return { status: "last_admin" }
  }
  const activeOperation = await db
    .prepare(
      `SELECT 1 AS present FROM org_seat_billing_operation
        WHERE installation_id = ? AND state IN ('pending', 'stripe_applied') LIMIT 1`,
    )
    .bind(args.installationId)
    .first<{ present: number }>()
  if (activeOperation !== null) throw new Error("organization access removal settlement did not persist")
  if (current === null || current.revokedAt !== null) return { status: "not_found" }
  throw new Error("organization access removal was fenced")
}

async function isLastActiveAdmin(
  db: D1Database,
  args: Pick<RemoveArgs, "installationId" | "githubUserId">,
): Promise<boolean> {
  const other = await db
    .prepare(
      `SELECT 1 AS present FROM org_workspace_access
        WHERE installation_id = ? AND github_user_id <> ? AND role = 'admin' AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(args.installationId, args.githubUserId)
    .first<{ present: number }>()
  return other === null
}

/** Operator-only resurrection seam. Route-level admin-token + roster proof happen outside the store. */
export async function recoverOrgWorkspaceAdmin(db: D1Database, args: MutationArgs): Promise<OrgWorkspaceAccess> {
  validateMutation(args)
  await db
    .prepare(
      `INSERT INTO org_workspace_access
          (installation_id, github_user_id, role, revoked_at, created_at, updated_at,
           updated_by, last_audit_id, last_action)
         VALUES (?, ?, 'admin', NULL, ?, ?, ?, ?, 'operator_recovery')
         ON CONFLICT(installation_id, github_user_id) DO UPDATE SET
           role = 'admin', revoked_at = NULL,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by,
           last_audit_id = excluded.last_audit_id, last_action = excluded.last_action`,
    )
    .bind(args.installationId, args.githubUserId, args.nowIso, args.nowIso, args.updatedBy, auditKey())
    .run()
  return requireAccess(await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId))
}

function decodeAccess(row: AccessRow): OrgWorkspaceAccess {
  if (
    !validInstallationId(row.installation_id) ||
    !isOrgWorkspaceGithubUserId(row.github_user_id) ||
    !validRole(row.role) ||
    (row.revoked_at !== null && typeof row.revoked_at !== "string") ||
    typeof row.created_at !== "string" ||
    row.created_at.length === 0 ||
    typeof row.updated_at !== "string" ||
    row.updated_at.length === 0 ||
    typeof row.updated_by !== "string" ||
    row.updated_by.length === 0
  ) {
    throw new Error("invalid organization access row")
  }
  return {
    installationId: row.installation_id,
    githubUserId: row.github_user_id,
    role: row.role,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function requireAccess(value: OrgWorkspaceAccess | null): OrgWorkspaceAccess {
  if (value === null) throw new Error("organization access write did not persist")
  return value
}

function changes(result: D1Result | undefined): number {
  return result?.meta?.changes ?? 0
}

function auditKey(): string {
  return `orgaudit_${crypto.randomUUID()}`
}

function validateMutation(args: MutationArgs): void {
  validateIdentity(args.installationId, args.githubUserId)
  if (typeof args.nowIso !== "string" || args.nowIso.length === 0) throw new Error("invalid mutation time")
  if (typeof args.updatedBy !== "string" || args.updatedBy.length === 0) throw new Error("invalid mutation actor")
}

function validateSeatBillingFence(fence: OrgWorkspaceSeatBillingFence): void {
  const active = fence.expectedActiveOperation
  if (
    fence.leaseToken.trim().length === 0 ||
    !Number.isSafeInteger(fence.leaseAcquiredAtMs) ||
    fence.leaseAcquiredAtMs < 0 ||
    !Number.isSafeInteger(fence.nowMs) ||
    fence.nowMs < 0 ||
    (active !== null &&
      (active.operationId.trim().length === 0 ||
        !Number.isSafeInteger(active.revision) ||
        active.revision <= 0 ||
        (active.state !== "pending" && active.state !== "stripe_applied") ||
        active.settlementStatements.length === 0))
  ) {
    throw new Error("invalid seat billing fence")
  }
}

function validateIdentity(installationId: number, githubUserId: string): void {
  if (!validInstallationId(installationId)) throw new Error("invalid installation id")
  if (!isOrgWorkspaceGithubUserId(githubUserId)) throw new Error("invalid GitHub user id")
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validRole(value: string): value is OrgWorkspaceRole {
  return value === "admin" || value === "member"
}

function normalizeLogin(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 && normalized.length <= 255 ? normalized : null
}
