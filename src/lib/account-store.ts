// sig-settings-backends — account lifecycle store (delete / export / logout-all).
//
// The data layer behind the portal Danger Zone (account-routes.ts):
//   • purgeUserAccount  — hard-delete every personal D1 row that IS this user,
//                         tombstone exact managed-org access, unassign managed
//                         seats, and retain immutable organization audit.
//   • revokeUserSessions— delete every KV session record this user holds (the
//                         "sign out everywhere" sweep; also runs inside delete).
//   • gatherAccountExport — assemble the user's OWN data for a JSON download.
//
// TENANT/IDENTITY SCOPE is the load-bearing invariant of all three: every query
// is keyed by the CALLER'S OWN identity (`userId` UUID + `githubUserId`), so a
// purge/export can only ever touch the caller's rows — never another account's.
//
// FAIL DIRECTION:
//   • purge THROWS on a D1 fault — a partial/failed delete must surface as a 500,
//     never a silent "your data is gone" that left rows behind. It is idempotent:
//     deleting already-gone rows is a 0-row no-op, so a retry is safe.
//   • export FAILS SOFT per-source — a read fault on one store yields that
//     section empty rather than failing the whole download.
//   • revokeUserSessions best-effort-deletes matches and returns the count.

import { listSessionsPage, type SessionRecord } from "@/src/lib/auth-session"
import { findByGithubUserId, findByUserId, type UserIdentity } from "@/src/lib/user-identity-store"

/** The caller's identity keys — the ONLY scope any of these operations touch. */
export interface AccountSubject {
  /** Provider-agnostic account UUID (user_identity.user_id). Absent on legacy sessions. */
  userId: string | null
  /** GitHub numeric id (as string). Absent for Google / password-only accounts. */
  githubUserId: string | null
  /** GitHub login (the fallback session-owner match key). */
  login: string
  /** Which provider minted the session (fallback match key). */
  provider: "github" | "google" | "gitlab" | "password"
}

/** Raised when two durable identifiers on the same session resolve to different users. */
export class AccountSubjectIntegrityError extends Error {
  constructor() {
    super("account session identity mismatch")
    this.name = "AccountSubjectIntegrityError"
  }
}

export type AccountDeleteConflictReason = "last_admin" | "billing_operation_active"

/** A managed-org invariant that must be resolved before account deletion can proceed. */
export class AccountDeleteConflictError extends Error {
  constructor(readonly reason: AccountDeleteConflictReason) {
    super(`account deletion blocked: ${reason}`)
    this.name = "AccountDeleteConflictError"
  }
}

/** Derive the caller's {@link AccountSubject} from a live session record. */
export function subjectFromSession(record: SessionRecord): AccountSubject {
  return {
    userId: record.userId ?? null,
    githubUserId: record.githubUserId != null ? String(record.githubUserId) : null,
    login: record.login,
    provider: record.provider ?? "github",
  }
}

/**
 * Re-resolve both durable identity directions. Legacy GitHub sessions predate
 * SessionRecord.userId, while linked Google/password sessions may omit the
 * GitHub id; filling either key keeps export/delete complete. Any stored
 * mismatch is a session-integrity fault and fails closed.
 */
async function resolveDurableSubject(db: D1Database, subject: AccountSubject): Promise<AccountSubject> {
  const byUserId = subject.userId === null ? null : await findByUserId(db, subject.userId)
  const byGithubUserId = subject.githubUserId === null ? null : await findByGithubUserId(db, subject.githubUserId)

  if (
    (byUserId !== null && subject.githubUserId !== null && byUserId.githubUserId !== subject.githubUserId) ||
    (byGithubUserId !== null && subject.userId !== null && byGithubUserId.userId !== subject.userId) ||
    (byUserId !== null && byGithubUserId !== null && byUserId.userId !== byGithubUserId.userId)
  ) {
    throw new AccountSubjectIntegrityError()
  }

  const identity = byUserId ?? byGithubUserId
  if (identity === null) return subject
  return {
    ...subject,
    userId: identity.userId,
    githubUserId: identity.githubUserId ?? subject.githubUserId,
  }
}

/**
 * Does `record` belong to `subject`? A session matches on ANY stable identifier
 * they share — `userId` OR `githubUserId` — so "sign out everywhere" / account-
 * delete also catch a LEGACY session minted before the `userId` field existed
 * (it still carries the same, globally-unique `githubUserId`). Both ids are
 * one-to-one with a single account, so an OR match can never revoke a different
 * person's session. Only when the subject has NEITHER stable id (a legacy
 * non-GitHub session) do we fall back to the weaker login+provider match.
 */
export function sessionBelongsTo(record: SessionRecord, subject: AccountSubject): boolean {
  if (subject.userId != null && record.userId === subject.userId) return true
  if (
    subject.githubUserId != null &&
    record.githubUserId != null &&
    String(record.githubUserId) === subject.githubUserId
  ) {
    return true
  }
  if (subject.userId == null && subject.githubUserId == null) {
    return record.login === subject.login && (record.provider ?? "github") === subject.provider
  }
  return false
}

// Safety bound on the session sweep — KV has no value index, so we page the whole
// `auth_session:` keyspace. At launch scale this terminates well within it; the cap
// prevents an unbounded loop if `list_complete` never settles.
const MAX_SESSION_PAGES = 100

/**
 * Delete every KV session that belongs to `subject`. Returns the number revoked.
 * Best-effort per record (a single delete fault is logged and skipped so one bad
 * key can't strand the rest). Used by BOTH logout-all and account-delete.
 */
export async function revokeUserSessions(kv: KVNamespace, subject: AccountSubject): Promise<number> {
  let revoked = 0
  let cursor: string | undefined
  for (let page = 0; page < MAX_SESSION_PAGES; page++) {
    const result = await listSessionsPage(kv, cursor)
    for (const { sessionId, record } of result.sessions) {
      if (!sessionBelongsTo(record, subject)) continue
      try {
        await kv.delete(`auth_session:${sessionId}`)
        revoked++
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "account-session-revoke-failed",
            err: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
    if (result.listComplete || !result.cursor) break
    cursor = result.cursor
  }
  return revoked
}

/** Row counts deleted per store — telemetry + the delete response body. */
export interface PurgeCounts {
  orgWorkspaceAccess: number
  orgWorkspaceSeat: number
  userIdentity: number
  userCredential: number
  userProfile: number
  accountTenant: number
  apiKey: number
  emailVerificationToken: number
  usageEvents: number
  appMemory: number
}

function changes(result: D1Result | undefined): number {
  return result?.meta?.changes ?? 0
}

const EMPTY_PURGE: PurgeCounts = {
  orgWorkspaceAccess: 0,
  orgWorkspaceSeat: 0,
  userIdentity: 0,
  userCredential: 0,
  userProfile: 0,
  accountTenant: 0,
  apiKey: 0,
  emailVerificationToken: 0,
  usageEvents: 0,
  appMemory: 0,
}

interface AccountDeleteConflictRow {
  last_admin: number
  billing_operation_active: number
}

async function readAccountDeleteConflict(
  db: D1Database,
  githubUserId: string,
): Promise<AccountDeleteConflictReason | null> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS (
           SELECT 1 FROM org_workspace_access AS target
            WHERE target.github_user_id = ? AND target.revoked_at IS NULL AND target.role = 'admin'
              AND NOT EXISTS (
                SELECT 1 FROM org_workspace_access AS other
                 WHERE other.installation_id = target.installation_id
                   AND other.github_user_id <> target.github_user_id
                   AND other.role = 'admin' AND other.revoked_at IS NULL
              )
         ) AS last_admin,
         EXISTS (
           SELECT 1 FROM org_seat_billing_operation AS operation
            WHERE operation.state IN ('pending', 'stripe_applied')
              AND (
                (operation.target_identity_kind = 'managed_github' AND operation.target_github_user_id = ?)
                OR EXISTS (
                  SELECT 1 FROM org_workspace_access AS access
                   WHERE access.installation_id = operation.installation_id
                     AND access.github_user_id = ? AND access.revoked_at IS NULL
                )
                OR EXISTS (
                  SELECT 1 FROM org_workspace_seat_assignment AS seat
                   WHERE seat.installation_id = operation.installation_id
                     AND seat.github_user_id = ? AND seat.assigned = 1
                )
              )
         ) AS billing_operation_active`,
    )
    .bind(githubUserId, githubUserId, githubUserId, githubUserId)
    .first<AccountDeleteConflictRow>()
  if (row?.last_admin === 1) return "last_admin"
  if (row?.billing_operation_active === 1) return "billing_operation_active"
  return null
}

/**
 * Remove every caller-owned row in ONE D1 batch (atomic on D1):
 *   • app-managed access is tombstoned (never deleted) and exact managed seats are unassigned
 *   • user_credential / user_identity / email_verification_token / personal app memory — keyed by `userId`
 *   • user_profile / account_tenant / api_key — keyed by `githubUserId`
 *   • usage_events — keyed by the seat key `gh:<githubUserId>`
 * Rows keyed by an identifier the caller doesn't have (e.g. a Google-only account
 * with no githubUserId) are simply skipped. THROWS on a D1 fault (the route
 * returns 500); idempotent — a re-run deletes 0 rows.
 */
export async function purgeUserAccount(db: D1Database, subject: AccountSubject): Promise<PurgeCounts> {
  subject = await resolveDurableSubject(db, subject)
  const statements: D1PreparedStatement[] = []
  const hasIdentityGuard = subject.userId != null && subject.githubUserId != null
  if (hasIdentityGuard) {
    // Identity reads happen before the transactional batch. Abort if a
    // concurrent delete + recreation rebound this GitHub account to a new UUID
    // after resolution, so a stale session can never purge the new account.
    // Migration 0022 rejects the sentinel via both installation_id > 0 and the
    // canonical positive GitHub-id CHECKs.
    statements.push(
      db
        .prepare(
          `INSERT INTO org_workspace_access
            (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
             updated_by, last_audit_id, last_action)
           SELECT 0, '0', 'member', '', '', NULL,
                  'account-delete-identity-guard', 'account-delete-identity-guard', 'access_removed'
            WHERE EXISTS (
              SELECT 1 FROM user_identity
               WHERE github_user_id = ? AND user_id <> ?
            ) OR EXISTS (
              SELECT 1 FROM user_identity
               WHERE user_id = ? AND github_user_id IS NOT ?
            )`,
        )
        .bind(subject.githubUserId, subject.userId, subject.userId, subject.githubUserId),
    )
  }
  if (subject.githubUserId != null) {
    const conflict = await readAccountDeleteConflict(db, subject.githubUserId)
    if (conflict !== null) throw new AccountDeleteConflictError(conflict)

    const nowIso = new Date().toISOString()
    const auditId = crypto.randomUUID()
    const updatedBy = `github:${subject.githubUserId}`
    statements.push(
      db
        .prepare(
          `UPDATE org_workspace_access AS target
              SET revoked_at = ?, updated_at = ?, updated_by = ?,
                  last_audit_id = ?, last_action = 'access_removed'
            WHERE target.github_user_id = ? AND target.revoked_at IS NULL
              AND (
                target.role <> 'admin' OR EXISTS (
                  SELECT 1 FROM org_workspace_access AS other
                   WHERE other.installation_id = target.installation_id
                     AND other.github_user_id <> target.github_user_id
                     AND other.role = 'admin' AND other.revoked_at IS NULL
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM org_seat_billing_operation AS operation
                 WHERE operation.installation_id = target.installation_id
                   AND operation.state IN ('pending', 'stripe_applied')
              )`,
        )
        .bind(nowIso, nowIso, updatedBy, auditId, subject.githubUserId),
    )
    statements.push(
      db
        .prepare(
          `UPDATE org_workspace_seat_assignment AS target
              SET assigned = 0, updated_at = ?, updated_by = ?
            WHERE target.github_user_id = ? AND target.assigned = 1
              AND NOT EXISTS (
                SELECT 1 FROM org_seat_billing_operation AS operation
                 WHERE operation.installation_id = target.installation_id
                   AND operation.state IN ('pending', 'stripe_applied')
              )`,
        )
        .bind(nowIso, updatedBy, subject.githubUserId),
    )
  }
  // Order: credential before identity (credential FK-conceptually depends on
  // identity), though D1 has no enforced FK here — batch runs atomically anyway.
  if (subject.userId != null) {
    statements.push(db.prepare("DELETE FROM user_credential WHERE user_id = ?").bind(subject.userId))
    statements.push(
      db.prepare("DELETE FROM app_memory WHERE scope = 'personal' AND owner_user_id = ?").bind(subject.userId),
    )
    statements.push(db.prepare("DELETE FROM user_identity WHERE user_id = ?").bind(subject.userId))
    statements.push(db.prepare("DELETE FROM email_verification_token WHERE user_id = ?").bind(subject.userId))
  }
  if (subject.githubUserId != null) {
    // user_profile.github_user_id is an INTEGER column; account_tenant/api_key
    // store it as TEXT. Bind the value both ways so each matches its column type.
    const ghNum = Number(subject.githubUserId)
    statements.push(db.prepare("DELETE FROM user_profile WHERE github_user_id = ?").bind(ghNum))
    statements.push(db.prepare("DELETE FROM account_tenant WHERE github_user_id = ?").bind(subject.githubUserId))
    statements.push(db.prepare("DELETE FROM api_key WHERE created_by = ?").bind(subject.githubUserId))
    // usage_events attribute a seat via `gh:<githubUserId>` (see the usage writers).
    statements.push(db.prepare("DELETE FROM usage_events WHERE user_key = ?").bind(`gh:${subject.githubUserId}`))
    // The deliberately-invalid INSERT runs only if a raced org mutation left
    // authorization, a billed seat, or exact-target billing work behind. Its
    // CHECK failure rolls the entire D1 batch back instead of acknowledging a
    // partially deleted account. Migration 0022's positive-id CHECKs make the
    // sentinel unconditionally invalid whenever the residual predicate is true.
    statements.push(
      db
        .prepare(
          `INSERT INTO org_workspace_access
            (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
             updated_by, last_audit_id, last_action)
           SELECT 0, '0', 'member', '', '', NULL,
                  'account-delete-guard', 'account-delete-guard', 'access_removed'
            WHERE EXISTS (
              SELECT 1 FROM org_workspace_access
               WHERE github_user_id = ? AND revoked_at IS NULL
            ) OR EXISTS (
              SELECT 1 FROM org_workspace_seat_assignment
               WHERE github_user_id = ? AND assigned = 1
            ) OR EXISTS (
              SELECT 1 FROM org_seat_billing_operation
               WHERE target_identity_kind = 'managed_github' AND target_github_user_id = ?
                 AND state IN ('pending', 'stripe_applied')
            )`,
        )
        .bind(subject.githubUserId, subject.githubUserId, subject.githubUserId),
    )
  }
  if (statements.length === 0) return { ...EMPTY_PURGE }
  let results: D1Result[]
  try {
    results = await db.batch(statements)
  } catch (error) {
    // Re-run the durable cross-check after rollback so an identity race is
    // reported as authentication failure rather than a generic delete fault.
    await resolveDurableSubject(db, subject)
    if (subject.githubUserId != null) {
      const racedConflict = await readAccountDeleteConflict(db, subject.githubUserId).catch(() => null)
      if (racedConflict !== null) throw new AccountDeleteConflictError(racedConflict)
    }
    throw error
  }
  // Map results back positionally in the order pushed above.
  let i = 0
  const counts: PurgeCounts = { ...EMPTY_PURGE }
  if (hasIdentityGuard) i++
  if (subject.githubUserId != null) {
    counts.orgWorkspaceAccess = changes(results[i++])
    counts.orgWorkspaceSeat = changes(results[i++])
  }
  if (subject.userId != null) {
    counts.userCredential = changes(results[i++])
    counts.appMemory = changes(results[i++])
    counts.userIdentity = changes(results[i++])
    counts.emailVerificationToken = changes(results[i++])
  }
  if (subject.githubUserId != null) {
    counts.userProfile = changes(results[i++])
    counts.accountTenant = changes(results[i++])
    counts.apiKey = changes(results[i++])
    counts.usageEvents = changes(results[i++])
  }
  return counts
}

/** The user's OWN data, assembled for a JSON download. Every field is scoped to the caller. */
export interface AccountExport {
  exportedAt: string
  subject: { userId: string | null; githubUserId: string | null; login: string; provider: string }
  identity: UserIdentity | null
  profile: { displayName: string | null; settings: unknown; createdAt: string; updatedAt: string } | null
  installations: Array<{ installationId: number; role: string; createdAt: string }>
  apiKeys: Array<{
    id: string
    name: string | null
    installationId: number
    createdAt: string
    lastUsedAt: string | null
    revokedAt: string | null
  }>
  usageEvents: Array<{ meter: string; surface: string; installationId: number; createdAt: string }>
  appMemories: Array<{
    id: string
    installationId: number
    appId: string
    scope: "personal"
    content: string
    createdAt: string
  }>
  organizationAccess: Array<{
    installationId: number
    role: string
    createdAt: string
    updatedAt: string
    revokedAt: string | null
    lastAction: string
  }>
  organizationSeats: Array<{
    installationId: number
    assigned: boolean
    lastKnownLogin: string | null
    createdAt: string
    updatedAt: string
  }>
  organizationAccessAudit: Array<{
    installationId: number
    action: string
    previousRole: string | null
    nextRole: string | null
    createdAt: string
  }>
}

async function safeFirst<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return await db
      .prepare(sql)
      .bind(...binds)
      .first<T>()
  } catch {
    return null
  }
}

async function safeAll<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const { results } = await db
      .prepare(sql)
      .bind(...binds)
      .all<T>()
    return results ?? []
  } catch {
    return []
  }
}

/**
 * Assemble the caller's OWN account data (identity, profile, installation links,
 * api-key metadata, usage events, personal app memories) for a GDPR-style JSON export. Every query is
 * keyed by the caller's identity, so ONLY the caller's data is ever returned.
 * NEVER includes a secret: identity excludes mfa_secret/password_hash (the store
 * type omits them), and api keys are metadata-only (no hash). FAILS SOFT per
 * source — a read fault on one store leaves that section empty, not the whole
 * export failing.
 */
export async function gatherAccountExport(db: D1Database, subject: AccountSubject): Promise<AccountExport> {
  subject = await resolveDurableSubject(db, subject)
  const identity = subject.userId != null ? await findByUserId(db, subject.userId).catch(() => null) : null

  const profileRow =
    subject.githubUserId != null
      ? await safeFirst<{ display_name: string | null; settings: string; created_at: string; updated_at: string }>(
          db,
          "SELECT display_name, settings, created_at, updated_at FROM user_profile WHERE github_user_id = ?",
          Number(subject.githubUserId),
        )
      : null
  let profileSettings: unknown = null
  if (profileRow) {
    try {
      profileSettings = JSON.parse(profileRow.settings)
    } catch {
      profileSettings = profileRow.settings
    }
  }

  const installations =
    subject.githubUserId != null
      ? await safeAll<{ installation_id: number; role: string; created_at: string }>(
          db,
          "SELECT installation_id, role, created_at FROM account_tenant WHERE github_user_id = ? ORDER BY created_at DESC",
          subject.githubUserId,
        )
      : []

  const apiKeys =
    subject.githubUserId != null
      ? await safeAll<{
          id: string
          name: string | null
          installation_id: number
          created_at: string
          last_used_at: string | null
          revoked_at: string | null
        }>(
          db,
          "SELECT id, name, installation_id, created_at, last_used_at, revoked_at FROM api_key WHERE created_by = ? ORDER BY created_at DESC",
          subject.githubUserId,
        )
      : []

  // Usage events attributed to this seat. Seat key layout = `gh:<githubUserId>`
  // (see usage-events writers). Google/password-only accounts have no seat key.
  const usageEvents =
    subject.githubUserId != null
      ? await safeAll<{ meter: string; surface: string; installation_id: number; created_at: string }>(
          db,
          "SELECT meter, surface, installation_id, created_at FROM usage_events WHERE user_key = ? ORDER BY created_at DESC LIMIT 1000",
          `gh:${subject.githubUserId}`,
        )
      : []

  const appMemories =
    subject.userId != null
      ? await safeAll<{
          id: string
          installation_id: number
          app_id: string
          content: string
          created_at_ms: number
        }>(
          db,
          `SELECT id, installation_id, app_id, content, created_at_ms
             FROM app_memory
            WHERE scope = 'personal' AND owner_user_id = ?
            ORDER BY created_at_ms DESC, id DESC
            LIMIT 1000`,
          subject.userId,
        )
      : []

  // Managed organization lifecycle is scoped by the same immutable GitHub id
  // used for authorization. Actor/updater fields are deliberately omitted:
  // those identify another organization member, not the exporting caller.
  const organizationAccess =
    subject.githubUserId != null
      ? await safeAll<{
          installation_id: number
          role: string
          created_at: string
          updated_at: string
          revoked_at: string | null
          last_action: string
        }>(
          db,
          `SELECT installation_id, role, created_at, updated_at, revoked_at, last_action
             FROM org_workspace_access
            WHERE github_user_id = ?
            ORDER BY updated_at DESC, installation_id DESC`,
          subject.githubUserId,
        )
      : []

  const organizationSeats =
    subject.githubUserId != null
      ? await safeAll<{
          installation_id: number
          assigned: number
          last_known_login: string | null
          created_at: string
          updated_at: string
        }>(
          db,
          `SELECT installation_id, assigned, last_known_login, created_at, updated_at
             FROM org_workspace_seat_assignment
            WHERE github_user_id = ?
            ORDER BY updated_at DESC, installation_id DESC`,
          subject.githubUserId,
        )
      : []

  const organizationAccessAudit =
    subject.githubUserId != null
      ? await safeAll<{
          installation_id: number
          action: string
          previous_role: string | null
          next_role: string | null
          created_at: string
        }>(
          db,
          `SELECT installation_id, action, previous_role, next_role, created_at
             FROM org_workspace_access_audit
            WHERE target_github_user_id = ?
            ORDER BY created_at DESC, installation_id DESC`,
          subject.githubUserId,
        )
      : []

  // All export sections above are separate reads. Re-check the resolved pair
  // after the final read so a delete + recreation that raced the export cannot
  // return rows from the newly bound account to a stale session.
  await resolveDurableSubject(db, subject)

  return {
    exportedAt: new Date().toISOString(),
    subject: {
      userId: subject.userId,
      githubUserId: subject.githubUserId,
      login: subject.login,
      provider: subject.provider,
    },
    identity,
    profile: profileRow
      ? {
          displayName: profileRow.display_name,
          settings: profileSettings,
          createdAt: profileRow.created_at,
          updatedAt: profileRow.updated_at,
        }
      : null,
    installations: installations.map((r) => ({
      installationId: r.installation_id,
      role: r.role,
      createdAt: r.created_at,
    })),
    apiKeys: apiKeys.map((r) => ({
      id: r.id,
      name: r.name,
      installationId: r.installation_id,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    })),
    usageEvents: usageEvents.map((r) => ({
      meter: r.meter,
      surface: r.surface,
      installationId: r.installation_id,
      createdAt: r.created_at,
    })),
    appMemories: appMemories.map((r) => ({
      id: r.id,
      installationId: r.installation_id,
      appId: r.app_id,
      scope: "personal",
      content: r.content,
      createdAt: new Date(r.created_at_ms).toISOString(),
    })),
    organizationAccess: organizationAccess.map((r) => ({
      installationId: r.installation_id,
      role: r.role,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      revokedAt: r.revoked_at,
      lastAction: r.last_action,
    })),
    organizationSeats: organizationSeats.map((r) => ({
      installationId: r.installation_id,
      assigned: r.assigned === 1,
      lastKnownLogin: r.last_known_login,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    organizationAccessAudit: organizationAccessAudit.map((r) => ({
      installationId: r.installation_id,
      action: r.action,
      previousRole: r.previous_role,
      nextRole: r.next_role,
      createdAt: r.created_at,
    })),
  }
}
