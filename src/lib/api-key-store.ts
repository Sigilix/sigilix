// #155 onboarding-backend FOUNDATION (slice 1 of 2) — shared D1 read/write
// helpers for `account_tenant` + `api_key` (migrations/0003_*.sql). Used by
// both the GET /setup issuance flow (auth-setup-route.ts) and the
// POST/DELETE /v1/keys management endpoints (api-keys-route.ts), so the two
// callers can't drift on the INSERT/UPDATE shape.
//
// AUTH-CRITICAL — `isLinkedToInstallation` gates who may mint or revoke a
// key for an installation. It FAILS CLOSED: a D1 error returns false (deny),
// the same direction as api-key-resolver.ts's fail-closed read path. This is
// the opposite of this repo's usual fail-open D1 convention (see
// d1-tenant-store.ts) — intentional here because the call site is an
// authorization decision, not a best-effort cache/telemetry read.
//
// Plaintext keys are generated here and returned to the caller; this module
// NEVER logs a plaintext key or a key_hash value.

import { base64urlEncode } from "@/src/lib/auth-session"

/** The non-secret token TYPE prefix every minted key carries. Shown (alone) as the
 *  masked stand-in in the keys list — the random tail is never stored, so it can
 *  never be reconstructed for an existing key. */
export const API_KEY_PREFIX = "sigilix_live_"

/** Mint a new plaintext API key. Never logged; the caller shows it once. */
export function mintApiKeyPlaintext(): string {
  return `${API_KEY_PREFIX}${base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))}`
}

/**
 * Insert a new api_key row. `keyHash` must already be the SHA-256 hex digest
 * of the plaintext (see auth-bearer.ts's `sha256Hex`) — this function never
 * sees or stores the plaintext itself.
 */
export async function insertApiKey(
  db: D1Database,
  args: {
    id: string
    keyHash: string
    installationId: number
    createdBy: string
    nowIso: string
    name?: string | null
  },
): Promise<void> {
  if (!validInstallationId(args.installationId)) throw new Error("invalid API key installation id")
  if (!validGithubUserId(args.createdBy)) throw new Error("invalid API key creator id")
  // Reference the `name` column (migrations/0009) ONLY when a label is actually
  // supplied. A null/absent name keeps the original 5-column INSERT, so this
  // helper still works against a DB that predates 0009 (and no existing caller
  // that omits `name` needs the new column).
  if (args.name != null) {
    await db
      .prepare(
        "INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at, name) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(args.id, args.keyHash, args.installationId, args.createdBy, args.nowIso, args.name)
      .run()
    return
  }
  await db
    .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(args.id, args.keyHash, args.installationId, args.createdBy, args.nowIso)
    .run()
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validGithubUserId(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

/** One api_key row as the portal's list surface shows it — NEVER the hash. */
export interface ApiKeySummary {
  id: string
  name: string | null
  installationId: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/**
 * List every api_key MINTED BY `createdBy` (a GitHub user id), newest first. This
 * is the caller's PERSONAL keys view — scoped to the keys they created, never
 * another user's. Returns metadata ONLY (id, name, installation, timestamps,
 * revoked state); the SHA-256 `key_hash` is never selected, so the secret can
 * never leak through this path. FAILS SOFT — a D1 error yields an empty list
 * (the portal shows "no keys" rather than a 500 on a read surface).
 */
export async function listApiKeysByCreator(db: D1Database, createdBy: string): Promise<ApiKeySummary[]> {
  try {
    const { results } = await db
      .prepare(
        "SELECT id, name, installation_id, created_at, last_used_at, revoked_at FROM api_key " +
          "WHERE created_by = ? ORDER BY created_at DESC",
      )
      .bind(createdBy)
      .all<{
        id: string
        name: string | null
        installation_id: number
        created_at: string
        last_used_at: string | null
        revoked_at: string | null
      }>()
    return (results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      installationId: row.installation_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }))
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "api-key-store-list-by-creator-d1-error",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return []
  }
}

/**
 * Every installation `githubUserId` is linked to via account_tenant, newest
 * link first. Used by the CLI-login flow (cli-login-route.ts) to pick the
 * installation a browser-authorized CLI key is minted against — the same
 * account_tenant trust link `/setup` writes and `isLinkedToInstallation`
 * checks. FAILS SOFT — a D1 error yields an empty list, which the caller
 * treats as "no linked installation" (a clean refuse-to-mint, never a mint
 * against an unverified installation).
 */
export async function getInstallationsForUser(db: D1Database, githubUserId: string): Promise<number[]> {
  try {
    const { results } = await db
      .prepare("SELECT installation_id FROM account_tenant WHERE github_user_id = ? ORDER BY created_at DESC")
      .bind(githubUserId)
      .all<{ installation_id: number }>()
    return (results ?? []).map((row) => row.installation_id)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "api-key-store-installations-for-user-d1-error",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return []
  }
}

/**
 * Link a GitHub user to an installation (idempotent — a re-run of /setup for
 * an already-linked user is a no-op, not a constraint error).
 */
export async function linkAccountTenant(
  db: D1Database,
  args: { githubUserId: string; installationId: number; role: string; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO account_tenant (github_user_id, installation_id, role, created_at) VALUES (?, ?, ?, ?)" +
        " ON CONFLICT(github_user_id, installation_id) DO NOTHING",
    )
    .bind(args.githubUserId, args.installationId, args.role, args.nowIso)
    .run()
}

/**
 * Authorization check: does `githubUserId` have an account_tenant link to
 * `installationId`? FAILS CLOSED — a D1 error returns false (deny), never
 * true. Callers must treat false as "forbidden", not "binding absent, skip
 * the check".
 */
export async function isLinkedToInstallation(
  db: D1Database,
  githubUserId: string,
  installationId: number,
): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 FROM account_tenant WHERE github_user_id = ? AND installation_id = ?")
      .bind(githubUserId, installationId)
      .first()
    return row != null
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "api-key-store-authz-d1-error-fail-closed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}

/** Look up an api_key row by id. Returns null when absent or on a D1 error. */
export async function getApiKeyById(
  db: D1Database,
  id: string,
): Promise<{ installationId: number; revokedAt: string | null } | null> {
  try {
    const row = await db
      .prepare("SELECT installation_id, revoked_at FROM api_key WHERE id = ?")
      .bind(id)
      .first<{ installation_id: number; revoked_at: string | null }>()
    if (row == null) return null
    return { installationId: row.installation_id, revokedAt: row.revoked_at }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "api-key-store-get-by-id-d1-error",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

/** Set revoked_at on an api_key row. Idempotent — re-revoking is a no-op UPDATE. */
export async function revokeApiKeyById(db: D1Database, id: string, nowIso: string): Promise<void> {
  await db.prepare("UPDATE api_key SET revoked_at = ? WHERE id = ?").bind(nowIso, id).run()
}

/** Best-effort `last_used_at` touch. Caller decides how to handle a failure. */
export async function touchApiKeyLastUsed(db: D1Database, keyHash: string, nowIso: string): Promise<void> {
  await db.prepare("UPDATE api_key SET last_used_at = ? WHERE key_hash = ?").bind(nowIso, keyHash).run()
}
