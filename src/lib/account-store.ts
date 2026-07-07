// sig-settings-backends — account lifecycle store (delete / export / logout-all).
//
// The data layer behind the portal Danger Zone (account-routes.ts):
//   • purgeUserAccount  — hard-delete every D1 row that IS this user (identity,
//                         credential, profile, tenant links, api keys).
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
import { findByUserId, type UserIdentity } from "@/src/lib/user-identity-store"

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
  userIdentity: number
  userCredential: number
  userProfile: number
  accountTenant: number
  apiKey: number
  emailVerificationToken: number
  usageEvents: number
}

function changes(result: D1Result | undefined): number {
  return result?.meta?.changes ?? 0
}

const EMPTY_PURGE: PurgeCounts = {
  userIdentity: 0,
  userCredential: 0,
  userProfile: 0,
  accountTenant: 0,
  apiKey: 0,
  emailVerificationToken: 0,
  usageEvents: 0,
}

/**
 * Hard-delete EVERY D1 row that IS this user, in ONE batch (atomic on D1):
 *   • user_credential / user_identity / email_verification_token — keyed by `userId`
 *   • user_profile / account_tenant / api_key — keyed by `githubUserId`
 *   • usage_events — keyed by the seat key `gh:<githubUserId>`
 * Rows keyed by an identifier the caller doesn't have (e.g. a Google-only account
 * with no githubUserId) are simply skipped. THROWS on a D1 fault (the route
 * returns 500); idempotent — a re-run deletes 0 rows.
 */
export async function purgeUserAccount(db: D1Database, subject: AccountSubject): Promise<PurgeCounts> {
  const statements: D1PreparedStatement[] = []
  // Order: credential before identity (credential FK-conceptually depends on
  // identity), though D1 has no enforced FK here — batch runs atomically anyway.
  if (subject.userId != null) {
    statements.push(db.prepare("DELETE FROM user_credential WHERE user_id = ?").bind(subject.userId))
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
  }
  if (statements.length === 0) return { ...EMPTY_PURGE }
  const results = await db.batch(statements)
  // Map results back positionally in the order pushed above.
  let i = 0
  const counts: PurgeCounts = { ...EMPTY_PURGE }
  if (subject.userId != null) {
    counts.userCredential = changes(results[i++])
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
 * api-key metadata, usage events) for a GDPR-style JSON export. Every query is
 * keyed by the caller's identity, so ONLY the caller's data is ever returned.
 * NEVER includes a secret: identity excludes mfa_secret/password_hash (the store
 * type omits them), and api keys are metadata-only (no hash). FAILS SOFT per
 * source — a read fault on one store leaves that section empty, not the whole
 * export failing.
 */
export async function gatherAccountExport(db: D1Database, subject: AccountSubject): Promise<AccountExport> {
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
  }
}
