// Persistent user-identity D1 store (launch P0 — sig-user-identity).
//
// The real user record: one `user_identity` row per human (migrations/0006),
// keyed by a surrogate `user_id` (UUID) so a single person can link GitHub +
// Google + email/password to ONE account.
//
// ACCOUNT-LINKING RULE (security — sig-user-identity P0 fix): a row is resolved
// by its PROVIDER key (github_user_id / google_sub) FIRST. Email is NOT a
// cross-provider auto-linking key while email verification is stubbed, because
// an email can be written by an UNVERIFIED path (password signup, email-capture,
// a GitHub-provided address) — treating it as a merge key let an attacker seed a
// victim's email onto their own row and have the victim's later VERIFIED login
// silently merge in (account takeover). So:
//   - GitHub login (email UNVERIFIED): resolve by github_user_id ONLY; never
//     link into, or collide with, an email another row holds.
//   - Google login (email VERIFIED by Google): resolve by google_sub; only link
//     into a pre-existing email row when that row's email is ALREADY verified
//     (email_verified=1). If an UNVERIFIED row holds the email, the verified
//     login REVOKES that claim (nulls its email + invalidates its password
//     credential) and takes ownership — it never joins the unverified row.
//   - password signup / email-capture: store the email UNVERIFIED + non-linking.
// Cross-provider linking by email returns once a real verification flow ships.
//
// Fail-direction:
//   - `upsertGithubIdentity` is BEST-EFFORT — a GitHub OAuth login has already
//     succeeded before we persist, so a D1 fault must NOT block the login; it
//     logs and returns null (the session is still issued).
//   - `findOrCreateGoogleIdentity`, `createPasswordIdentity`, and the
//     credential reads are the account-resolution path for their providers, so
//     they FAIL CLOSED — a D1 fault throws / returns null (deny), never a
//     silently half-created account.
//
// This module NEVER logs an email body, a password, or a hash value.

export type Provider = "github" | "google" | "password"

export interface UserIdentity {
  userId: string
  githubUserId: string | null
  googleSub: string | null
  email: string | null
  emailVerified: boolean
  name: string | null
  avatarUrl: string | null
  providers: Provider[]
  mfaEnabled: boolean
  createdAt: string
  lastLoginAt: string
}

interface IdentityRow {
  user_id: string
  github_user_id: string | null
  google_sub: string | null
  email: string | null
  email_verified: number
  name: string | null
  avatar_url: string | null
  providers: string
  mfa_enabled: number
  created_at: string
  last_login_at: string
}

/** Normalize an email for storage + lookup: trim + lowercase. Returns null when blank. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Structural email check (server-side floor; the portal does its own hint).
 * Deliberately conservative — one `@`, a non-empty local part, a dotted domain,
 * no whitespace, bounded length.
 */
export function isPlausibleEmail(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
}

function parseProviders(raw: string): Provider[] {
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((p): p is Provider => p === "github" || p === "google" || p === "password")
  } catch {
    return []
  }
}

function mergeProvider(existing: Provider[], add: Provider): Provider[] {
  return existing.includes(add) ? existing : [...existing, add]
}

function rowToIdentity(row: IdentityRow): UserIdentity {
  return {
    userId: row.user_id,
    githubUserId: row.github_user_id,
    googleSub: row.google_sub,
    email: row.email,
    emailVerified: row.email_verified === 1,
    name: row.name,
    avatarUrl: row.avatar_url,
    providers: parseProviders(row.providers),
    mfaEnabled: row.mfa_enabled === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }
}

const SELECT_COLS =
  "user_id, github_user_id, google_sub, email, email_verified, name, avatar_url, providers, mfa_enabled, created_at, last_login_at"

async function selectOne(db: D1Database, where: string, ...binds: unknown[]): Promise<UserIdentity | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLS} FROM user_identity WHERE ${where}`)
    .bind(...binds)
    .first<IdentityRow>()
  return row ? rowToIdentity(row) : null
}

export function findByUserId(db: D1Database, userId: string): Promise<UserIdentity | null> {
  return selectOne(db, "user_id = ?", userId)
}

export function findByGithubUserId(db: D1Database, githubUserId: string): Promise<UserIdentity | null> {
  return selectOne(db, "github_user_id = ?", githubUserId)
}

export function findByGoogleSub(db: D1Database, googleSub: string): Promise<UserIdentity | null> {
  return selectOne(db, "google_sub = ?", googleSub)
}

/** Look up by normalized email. Returns null for a blank/unnormalizable input. */
export async function findByEmail(db: D1Database, email: string): Promise<UserIdentity | null> {
  const norm = normalizeEmail(email)
  if (!norm) return null
  return selectOne(db, "email = ?", norm)
}

/**
 * True when SOME OTHER row already holds this normalized email (excluding
 * `exceptUserId` when given). Used by the UNVERIFIED GitHub path to avoid
 * writing an email that collides with — or would silently attach to — another
 * account. Never steals; the caller simply declines to store a taken email.
 */
async function emailHeldByOther(db: D1Database, email: string, exceptUserId?: string): Promise<boolean> {
  const row = exceptUserId
    ? await db
        .prepare("SELECT user_id FROM user_identity WHERE email = ? AND user_id != ?")
        .bind(email, exceptUserId)
        .first<{ user_id: string }>()
    : await db.prepare("SELECT user_id FROM user_identity WHERE email = ?").bind(email).first<{ user_id: string }>()
  return row != null
}

interface GithubUpsertArgs {
  githubUserId: string
  email?: string | null
  name?: string | null
  avatarUrl?: string | null
  nowIso: string
}

/**
 * BEST-EFFORT upsert of the GitHub-linked identity on every GitHub login. The
 * GitHub OAuth login has already succeeded, so this must not throw into the
 * login path — a D1 fault logs and returns null (session still issued).
 *
 * A GitHub-provided email is UNVERIFIED (we never proved the user controls it),
 * so it is NEVER a cross-provider linking key — resolution is by github_user_id
 * ONLY, and a GitHub email is stored only when no other row holds it:
 *   1. An existing row for this github_user_id -> update it (refresh
 *      name/avatar/last_login; fill email only if this row has none AND the
 *      address is free; add "github").
 *   2. Else -> insert a brand-new row (storing the email only when it's free).
 * There is deliberately NO "link into a row found by email" path anymore — that
 * was the account-takeover sink (an attacker-seeded email would silently absorb
 * a GitHub login). Cross-provider linking returns once verification ships.
 */
export async function upsertGithubIdentity(db: D1Database, args: GithubUpsertArgs): Promise<UserIdentity | null> {
  try {
    const email = normalizeEmail(args.email)
    const existingByGithub = await findByGithubUserId(db, args.githubUserId)
    if (existingByGithub) {
      const providers = mergeProvider(existingByGithub.providers, "github")
      // Fill the email only when this row has none AND no other account holds it
      // (COALESCE keeps the existing value; null leaves it unchanged).
      const emailToFill = email && !(await emailHeldByOther(db, email, existingByGithub.userId)) ? email : null
      await db
        .prepare(
          "UPDATE user_identity SET name = ?, avatar_url = ?, providers = ?, last_login_at = ?, " +
            "email = COALESCE(email, ?) WHERE user_id = ?",
        )
        .bind(
          args.name ?? existingByGithub.name,
          args.avatarUrl ?? existingByGithub.avatarUrl,
          JSON.stringify(providers),
          args.nowIso,
          emailToFill,
          existingByGithub.userId,
        )
        .run()
      return findByUserId(db, existingByGithub.userId)
    }

    // New GitHub row. Store the (unverified) email only when it's free, so we
    // never collide with — or silently attach to — another account's address.
    const emailToInsert = email && !(await emailHeldByOther(db, email)) ? email : null
    const userId = crypto.randomUUID()
    await db
      .prepare(
        "INSERT INTO user_identity (user_id, github_user_id, email, email_verified, name, avatar_url, providers, created_at, last_login_at) " +
          "VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)",
      )
      .bind(
        userId,
        args.githubUserId,
        emailToInsert,
        args.name ?? null,
        args.avatarUrl ?? null,
        JSON.stringify(["github"]),
        args.nowIso,
        args.nowIso,
      )
      .run()
    return findByUserId(db, userId)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "user-identity-github-upsert-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

interface GoogleFindOrCreateArgs {
  googleSub: string
  email: string
  name?: string | null
  avatarUrl?: string | null
  nowIso: string
}

/**
 * Find-or-create the identity for a Google login. FAILS CLOSED — this IS the
 * account resolution for the provider, so a D1 fault throws (the caller returns
 * a 5xx and no session is issued) rather than silently minting a duplicate.
 *
 * Google verifies the email it returns, so `email_verified` is set to 1. But a
 * pre-existing row found ONLY by email is trusted as a linking target ONLY when
 * its own email is ALREADY verified — otherwise an attacker could seed a
 * victim's email onto an unverified row and have this verified login merge in
 * (account takeover). Resolution:
 *   1. Existing row for this google_sub -> update, return (the returning user).
 *   2. Else a row whose email == this email AND email_verified=1 -> LINK: set
 *      google_sub + add "google" (a trustworthy same-email account gains Google).
 *   3. Else a row whose email == this email but email_verified=0 -> REVOKE that
 *      unverified claim (null its email + delete its password credential) so the
 *      verified login can OWN the email, then fall through to (4).
 *   4. Else -> insert a new verified row.
 */
export async function findOrCreateGoogleIdentity(db: D1Database, args: GoogleFindOrCreateArgs): Promise<UserIdentity> {
  const email = normalizeEmail(args.email)
  if (!email) throw new Error("google identity requires an email")

  const existingBySub = await findByGoogleSub(db, args.googleSub)
  if (existingBySub) {
    const providers = mergeProvider(existingBySub.providers, "google")
    await db
      .prepare(
        "UPDATE user_identity SET name = COALESCE(name, ?), avatar_url = COALESCE(avatar_url, ?), " +
          "email = COALESCE(email, ?), email_verified = 1, providers = ?, last_login_at = ? WHERE user_id = ?",
      )
      .bind(
        args.name ?? null,
        args.avatarUrl ?? null,
        email,
        JSON.stringify(providers),
        args.nowIso,
        existingBySub.userId,
      )
      .run()
    const updated = await findByUserId(db, existingBySub.userId)
    if (!updated) throw new Error("identity vanished after google update")
    return updated
  }

  const existingByEmail = await selectOne(db, "email = ?", email)
  if (existingByEmail && existingByEmail.emailVerified) {
    // The email on this row is ALREADY verified (only a verified provider sets
    // email_verified=1), so it is a trustworthy same-person account — safe to
    // link this Google login into it.
    const providers = mergeProvider(existingByEmail.providers, "google")
    await db
      .prepare(
        "UPDATE user_identity SET google_sub = COALESCE(google_sub, ?), name = COALESCE(name, ?), " +
          "avatar_url = COALESCE(avatar_url, ?), email_verified = 1, providers = ?, last_login_at = ? WHERE user_id = ?",
      )
      .bind(
        args.googleSub,
        args.name ?? null,
        args.avatarUrl ?? null,
        JSON.stringify(providers),
        args.nowIso,
        existingByEmail.userId,
      )
      .run()
    const updated = await findByUserId(db, existingByEmail.userId)
    if (!updated) throw new Error("identity vanished after google link")
    return updated
  }

  if (existingByEmail) {
    // An UNVERIFIED row holds this email (password/github/email-capture wrote it
    // without proving ownership — possibly attacker-seeded). Do NOT merge the
    // verified Google login into it. Revoke the unverified claim so the verified
    // login can own the address: null its email + delete its password
    // credential, then fall through to insert a fresh verified Google row.
    await db.batch([
      db.prepare("UPDATE user_identity SET email = NULL WHERE user_id = ?").bind(existingByEmail.userId),
      db.prepare("DELETE FROM user_credential WHERE user_id = ?").bind(existingByEmail.userId),
    ])
  }

  const userId = crypto.randomUUID()
  await db
    .prepare(
      "INSERT INTO user_identity (user_id, google_sub, email, email_verified, name, avatar_url, providers, created_at, last_login_at) " +
        "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
    )
    .bind(
      userId,
      args.googleSub,
      email,
      args.name ?? null,
      args.avatarUrl ?? null,
      JSON.stringify(["google"]),
      args.nowIso,
      args.nowIso,
    )
    .run()
  const created = await findByUserId(db, userId)
  if (!created) throw new Error("identity vanished after google insert")
  return created
}

/**
 * Set/replace the email on an identity (email-capture). Fails closed (throws) on
 * a D1 fault. The captured email is UNVERIFIED — we have not proved the caller
 * controls it — so this ALSO forces email_verified back to 0. That is a security
 * requirement, not a nicety: without it, a verified row could overwrite its
 * email with an arbitrary address while keeping the verified flag, which the
 * Google login treats as a trustworthy linking target (takeover). The UNIQUE
 * index still rejects an address another account already owns.
 */
export async function setIdentityEmail(db: D1Database, userId: string, email: string): Promise<void> {
  const norm = normalizeEmail(email)
  if (!norm) throw new Error("cannot set a blank email")
  await db.prepare("UPDATE user_identity SET email = ?, email_verified = 0 WHERE user_id = ?").bind(norm, userId).run()
}

/** Best-effort last_login_at touch (login already succeeded — a failure is non-fatal). */
export async function touchLastLogin(db: D1Database, userId: string, nowIso: string): Promise<void> {
  await db.prepare("UPDATE user_identity SET last_login_at = ? WHERE user_id = ?").bind(nowIso, userId).run()
}

// ─── password credential (email/password sign-up + login) ───────────────────

/**
 * Create a NEW email/password identity + its credential row atomically (D1
 * batch). FAILS CLOSED. Returns:
 *   { ok: true, identity }        on success
 *   { ok: false, reason: "email_taken" }  if the email already exists (the
 *                                 caller tells the user to log in / link instead)
 * The caller passes an ALREADY-HASHED password (auth-password.ts) — this
 * function never sees the plaintext.
 *
 * The row is inserted with email_verified=0: a signup email is UNVERIFIED and
 * therefore NON-LINKING — a later verified Google login for the same address
 * will NOT merge into this row (it revokes the unverified claim instead), so an
 * attacker cannot seed a victim's email here to capture their account.
 */
export async function createPasswordIdentity(
  db: D1Database,
  args: { email: string; passwordHash: string; name?: string | null; nowIso: string },
): Promise<{ ok: true; identity: UserIdentity } | { ok: false; reason: "email_taken" }> {
  const email = normalizeEmail(args.email)
  if (!email) throw new Error("password identity requires an email")

  const existing = await selectOne(db, "email = ?", email)
  if (existing) {
    // The email already belongs to an account (possibly OAuth-only). Signup does
    // NOT silently attach a password to someone else's account — the caller
    // routes the user to log in (and can link a password afterward).
    return { ok: false, reason: "email_taken" }
  }

  const userId = crypto.randomUUID()
  await db.batch([
    db
      .prepare(
        "INSERT INTO user_identity (user_id, email, email_verified, name, providers, created_at, last_login_at) " +
          "VALUES (?, ?, 0, ?, ?, ?, ?)",
      )
      .bind(userId, email, args.name ?? null, JSON.stringify(["password"]), args.nowIso, args.nowIso),
    db
      .prepare("INSERT INTO user_credential (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(userId, args.passwordHash, args.nowIso, args.nowIso),
  ])
  const created = await findByUserId(db, userId)
  if (!created) throw new Error("identity vanished after password insert")
  return { ok: true, identity: created }
}

/** Read the stored password hash for a user, or null when none / on a D1 read that finds nothing. */
export async function getPasswordHash(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT password_hash FROM user_credential WHERE user_id = ?")
    .bind(userId)
    .first<{ password_hash: string }>()
  return row?.password_hash ?? null
}

/** Replace a stored password hash (transparent work-factor upgrade on login). Best-effort. */
export async function updatePasswordHash(
  db: D1Database,
  userId: string,
  passwordHash: string,
  nowIso: string,
): Promise<void> {
  await db
    .prepare("UPDATE user_credential SET password_hash = ?, updated_at = ? WHERE user_id = ?")
    .bind(passwordHash, nowIso, userId)
    .run()
}
