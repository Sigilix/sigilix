// Single-use email-verification token store (sig-email-verification).
//
// Backed by the D1 `email_verification_token` table (migrations/0008). A token
// is minted on email/password signup (and on an explicit resend) and consumed
// exactly once by GET /auth/verify.
//
// SECURITY:
//   - Only a SHA-256 hex of the opaque token is stored — the raw secret lives
//     solely in the email link, so a DB read cannot forge a live verification.
//   - Single-use is enforced ATOMICALLY: consume is a conditional UPDATE guarded
//     on `used_at IS NULL AND expires_at > now`, and we assert exactly one row
//     changed. There is no read-then-delete TOCTOU window (two concurrent clicks
//     race on the same UPDATE; only one sees changes === 1).
//   - The email is bound at mint time and returned on consume so the caller can
//     verify the identity's CURRENT email still matches — a stale token never
//     stamps a different address as verified.
//   - This module never logs an email, a token, or a hash value.
//
// Fail-direction: FAILS CLOSED. This is the account-resolution path for the
// verify flow, so a D1 fault throws (mint) or returns a non-ok reason (consume)
// rather than silently "succeeding".

import { sha256Hex } from "./auth-bearer"
import { base64urlEncode } from "./auth-session"

/** Default verify-link lifetime. Kept in sync with the copy in the email body. */
export const VERIFY_TOKEN_TTL_HOURS = 24

export interface MintArgs {
  userId: string
  email: string
  nowIso: string
  ttlHours?: number
}

/**
 * Mint a fresh single-use token for `userId`/`email` and persist only its hash.
 * Returns the RAW token (the secret that goes in the email link) — it is never
 * stored or logged. Any still-outstanding tokens for this user are invalidated
 * first, so a resend supersedes an earlier link (one live link per user).
 */
export async function mintVerificationToken(db: D1Database, args: MintArgs): Promise<string> {
  const ttlHours = args.ttlHours ?? VERIFY_TOKEN_TTL_HOURS
  const rawToken = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await sha256Hex(rawToken)
  const expiresAt = new Date(new Date(args.nowIso).getTime() + ttlHours * 3600_000).toISOString()

  // Invalidate any prior outstanding tokens for this user, then insert the new
  // one — a single batch so a resend can never leave two live links.
  await db.batch([
    db
      .prepare("UPDATE email_verification_token SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
      .bind(args.nowIso, args.userId),
    db
      .prepare(
        "INSERT INTO email_verification_token (token_hash, user_id, email, created_at, expires_at, used_at) " +
          "VALUES (?, ?, ?, ?, ?, NULL)",
      )
      .bind(tokenHash, args.userId, args.email, args.nowIso, expiresAt),
  ])
  return rawToken
}

export type ConsumeResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "not_found" | "expired" | "used" }

interface TokenRow {
  user_id: string
  email: string
  expires_at: string
  used_at: string | null
}

/**
 * Consume a token exactly once. Atomic: the conditional UPDATE only succeeds on
 * an unused, unexpired token; a second concurrent attempt sees changes === 0.
 * On success returns the bound `{ userId, email }`. On failure classifies why
 * (not_found / expired / used) purely for the redirect message — every failure
 * is inert (no state changed, no session issued).
 */
export async function consumeVerificationToken(
  db: D1Database,
  rawToken: string,
  nowIso: string,
): Promise<ConsumeResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return { ok: false, reason: "not_found" }
  const tokenHash = await sha256Hex(rawToken)

  const update = await db
    .prepare(
      "UPDATE email_verification_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(nowIso, tokenHash, nowIso)
    .run()

  if ((update.meta?.changes ?? 0) === 1) {
    const row = await db
      .prepare("SELECT user_id, email FROM email_verification_token WHERE token_hash = ?")
      .bind(tokenHash)
      .first<Pick<TokenRow, "user_id" | "email">>()
    // Consumed but vanished — treat as not_found (never issue a session without a subject).
    if (!row) return { ok: false, reason: "not_found" }
    return { ok: true, userId: row.user_id, email: row.email }
  }

  // Didn't consume — classify for the redirect. Read the row (if any) to tell an
  // already-used / expired token apart from an unknown one.
  const row = await db
    .prepare("SELECT user_id, email, expires_at, used_at FROM email_verification_token WHERE token_hash = ?")
    .bind(tokenHash)
    .first<TokenRow>()
  if (!row) return { ok: false, reason: "not_found" }
  if (row.used_at) return { ok: false, reason: "used" }
  return { ok: false, reason: "expired" }
}
