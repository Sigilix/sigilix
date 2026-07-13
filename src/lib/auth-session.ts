// Session storage + AES-GCM access-token encryption + cookie helpers.
//
// A Sigilix session is opaque from the client's perspective: the cookie
// holds only an unguessable session ID; the server-side KV record holds
// the user identity (login + githubUserId) and the GitHub user-to-server
// access token (encrypted at rest). The token is encrypted with AES-GCM
// using a single Worker-secret key and a random per-encryption IV plus
// AAD bound to the session ID — so a misplaced ciphertext can never
// decrypt against a different session record.
//
// Per-session AAD = `auth_session:${sessionId}`. AES-GCM rejects
// decryption when the AAD doesn't match (Codex catch on Phase 5 v1).

const SESSION_KV_PREFIX = "auth_session:"
const SESSION_COOKIE = "__Host-sigilix_session"
const STATE_COOKIE = "__Host-sigilix_oauth_state"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000
// sig-always-persistent-session: EVERY session is a persistent 30-day cookie +
// 30-day KV record, regardless of the login's "remember me" choice. The former
// remember-me-OFF path (a browser-SESSION cookie with no Max-Age + a 1-day KV
// TTL) was retired so a returning visitor is never unexpectedly signed out — a
// SameSite=None browser-session cookie was the most fragile thing across
// browsers. The `remember` field is still accepted/stored for back-compat, but
// no longer shortens a session. Logout still revokes cookie + record.

export interface SessionRecord {
  login: string
  // GitHub display name (public profile field), captured at OAuth time for the
  // portal's greeting / setup-wizard name prefill. Optional: GitHub users can
  // leave it blank, and sessions minted before this field existed won't have
  // it — consumers must fall back to `login`. Not a secret (public profile),
  // so stored plaintext alongside `login`; only the access token is encrypted.
  name?: string
  // GitHub numeric user id. Present for GitHub logins; ABSENT for Google /
  // email-password sessions (sig-user-identity). GitHub-App-install features
  // (keys, onboarding, org, usage seats) require it and fail closed when it is
  // absent — see the `githubUserId == null` guards in those routes.
  githubUserId?: number
  // The persistent user_identity.user_id (UUID) — the provider-agnostic account
  // key (migrations/0006). Present on every session minted since
  // sig-user-identity; absent only on legacy sessions minted before it, whose
  // consumers fall back to githubUserId. This is the stable subject to prefer.
  userId?: string
  // Captured/known email for this account, mirrored onto the session so the
  // portal can prompt for it (email-capture) without a D1 round-trip. Optional:
  // a GitHub user with a private email has none until captured.
  email?: string
  // Which provider minted this session. Absent on legacy GitHub sessions
  // (treat as "github").
  provider?: "github" | "google" | "gitlab" | "password"
  // "Remember me" choice at login, retained for back-compat and audit only.
  // sig-always-persistent-session: every session is now a persistent 30-day
  // cookie + record regardless of this value (see sessionTtlSeconds /
  // setSessionCookie), so `false` no longer shortens anything. Still stored
  // when a login sends it so existing serialized records round-trip unchanged.
  remember?: boolean
  // AES-GCM ciphertext of the GitHub user-to-server access token. For non-GitHub
  // sessions there is no GitHub token, so this holds the encryption of an EMPTY
  // string — decrypt yields "" and any GitHub API call made with it fails the
  // same way a scope-less token would, which the GitHub-backed routes already
  // treat as "no data / member" (fail-safe). The field stays a required string
  // so every existing consumer keeps compiling unchanged.
  encryptedAccessToken: string
  iv: string
  // GitHub App user-to-server token refresh (sig-portal-bugs). GitHub App user
  // tokens are SHORT-LIVED (~8h) when the App has "Expire user authorization
  // tokens" enabled, but the portal session cookie/record lives up to 30 days —
  // so without a refresh the stored token is dead long before the session is,
  // and every live GitHub call (installations, org membership → role) silently
  // 401s and degrades to "member" + an empty installation scope. These fields
  // let getValidGithubToken (github-user-token.ts) transparently refresh an
  // expired access token before use. All OPTIONAL: sessions minted before this
  // field existed (and non-GitHub sessions, and sessions from a GitHub App with
  // expiration disabled) simply have no refresh material — those keep the prior
  // behavior (the stored token is used as-is, never refreshed).
  //
  // AES-GCM ciphertext of the rotating refresh token (same key + per-session AAD
  // as encryptedAccessToken; its own random IV in `refreshIv`).
  encryptedRefreshToken?: string
  refreshIv?: string
  // ms-epoch when the access token expires (from the exchange's `expires_in`).
  accessTokenExpiresAt?: number
  // ms-epoch when the refresh token itself expires (from `refresh_token_expires_in`).
  refreshTokenExpiresAt?: number
  createdAt: number
  lastSeenAt: number
}

// ─── base64url helpers (Workers don't have node:Buffer) ─────────────

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((s.length + 2) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

// ─── AES-GCM encrypt / decrypt with AAD ─────────────────────────────

async function importAesKey(keyB64url: string): Promise<CryptoKey> {
  const raw = base64urlDecode(keyB64url)
  if (raw.length !== 32) {
    throw new Error("OPENCLAW_SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)")
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, /* extractable */ false, ["encrypt", "decrypt"])
}

// Encode a UTF-8 string into an ArrayBuffer-backed Uint8Array. We copy into a
// freshly-allocated ArrayBuffer so the result is typed `Uint8Array<ArrayBuffer>`
// (a valid BufferSource) under both the Workers and Node lib type worlds —
// `TextEncoder.encode()` alone yields `Uint8Array<ArrayBufferLike>` which the
// DOM/Workers `BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer`
// rejects. This is a type-level concern only; runtime bytes are identical.
function encodeUtf8(s: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(s)
  const out = new Uint8Array(new ArrayBuffer(bytes.length))
  out.set(bytes)
  return out
}

function aadFor(sessionId: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8(`${SESSION_KV_PREFIX}${sessionId}`)
}

export async function encryptAccessToken(
  plaintext: string,
  sessionId: string,
  keyB64url: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importAesKey(keyB64url)
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12))) // 96-bit per NIST SP 800-38D
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(sessionId) },
    key,
    encodeUtf8(plaintext),
  )
  return {
    ciphertext: base64urlEncode(new Uint8Array(ct)),
    iv: base64urlEncode(iv),
  }
}

export async function decryptAccessToken(
  record: { encryptedAccessToken: string; iv: string },
  sessionId: string,
  keyB64url: string,
): Promise<string> {
  const key = await importAesKey(keyB64url)
  const ct = base64urlDecode(record.encryptedAccessToken)
  const iv = base64urlDecode(record.iv)
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadFor(sessionId) }, key, ct)
  return new TextDecoder().decode(pt)
}

// ─── session ID minting ─────────────────────────────────────────────

export function mintSessionId(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

export function mintStateNonce(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
}

// ─── session lifetime selection ─────────────────────────────────────

/**
 * The KV `expirationTtl` (seconds) a session record should be written with.
 * Always the persistent 30-day TTL (sig-always-persistent-session) — the
 * `remember` argument is retained so every call site keeps compiling but no
 * longer shortens a session. Shared by createSession/touchSession/
 * updateSessionTokens/setSessionEmail, and mirrors the cookie Max-Age in
 * setSessionCookie so the cookie can never outlive its server-side record.
 */
export function sessionTtlSeconds(_remember?: boolean): number {
  return SESSION_TTL_SECONDS
}

// ─── session CRUD against KV ────────────────────────────────────────

export async function createSession(args: {
  kv: KVNamespace
  sessionId: string
  login: string
  encryptionKeyB64url: string
  // Optional so Google / email-password sessions (which have no GitHub token or
  // id) can be minted. `accessToken` defaults to "" (encrypts an empty token);
  // `githubUserId` is omitted for non-GitHub providers.
  accessToken?: string
  // GitHub App user-token refresh material (sig-portal-bugs). Present only for a
  // GitHub session minted against an App with token expiration enabled; omitted
  // otherwise (the stored access token is then used as-is, never refreshed).
  refreshToken?: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
  githubUserId?: number
  userId?: string
  email?: string
  provider?: "github" | "google" | "gitlab" | "password"
  name?: string
  // "Remember me" choice, stored for back-compat/audit only. Every session is a
  // persistent 30-day cookie + record regardless of this value
  // (sig-always-persistent-session).
  remember?: boolean
}): Promise<SessionRecord> {
  const { kv, sessionId, login, name, githubUserId, userId, email, provider, remember, encryptionKeyB64url } = args
  const { ciphertext, iv } = await encryptAccessToken(args.accessToken ?? "", sessionId, encryptionKeyB64url)
  const now = Date.now()
  // Encrypt the refresh token (when present) under the same key + per-session
  // AAD as the access token, with its own random IV.
  const refresh =
    args.refreshToken !== undefined && args.refreshToken !== ""
      ? await encryptAccessToken(args.refreshToken, sessionId, encryptionKeyB64url)
      : null
  const record: SessionRecord = {
    login,
    encryptedAccessToken: ciphertext,
    iv,
    createdAt: now,
    lastSeenAt: now,
    // exactOptionalPropertyTypes: omit each optional key entirely when absent
    // rather than set it to `undefined` (keeps in-memory + JSON shapes aligned).
    ...(githubUserId !== undefined ? { githubUserId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(remember !== undefined ? { remember } : {}),
    ...(refresh ? { encryptedRefreshToken: refresh.ciphertext, refreshIv: refresh.iv } : {}),
    ...(args.accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt: args.accessTokenExpiresAt } : {}),
    ...(args.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: args.refreshTokenExpiresAt } : {}),
  }
  await kv.put(`${SESSION_KV_PREFIX}${sessionId}`, JSON.stringify(record), {
    expirationTtl: sessionTtlSeconds(remember),
  })
  return record
}

export async function getSession(args: { kv: KVNamespace; sessionId: string }): Promise<SessionRecord | null> {
  const raw = await args.kv.get(`${SESSION_KV_PREFIX}${args.sessionId}`, "json")
  return (raw as SessionRecord) ?? null
}

export async function touchSession(args: { kv: KVNamespace; sessionId: string; record: SessionRecord }): Promise<void> {
  // Sliding TTL — refresh lastSeenAt + KV TTL on each authenticated request so
  // an active user never gets logged out at exactly the horizon. Every session
  // is a persistent 30-day record now (sig-always-persistent-session), so each
  // touch re-writes the full 30-day TTL. Done as fire-and-forget from the
  // request path; the race-window consequence is at most a slightly stale
  // lastSeenAt.
  const updated: SessionRecord = { ...args.record, lastSeenAt: Date.now() }
  await args.kv.put(`${SESSION_KV_PREFIX}${args.sessionId}`, JSON.stringify(updated), {
    expirationTtl: sessionTtlSeconds(args.record.remember),
  })
}

export async function deleteSession(args: { kv: KVNamespace; sessionId: string }): Promise<void> {
  await args.kv.delete(`${SESSION_KV_PREFIX}${args.sessionId}`)
}

/**
 * Persist a freshly-refreshed GitHub App user-to-server token onto the live
 * session (sig-portal-bugs). Re-encrypts the new access + rotated refresh token
 * under the session's key + AAD, records the new expiry timestamps, and writes
 * the record back under the persistent 30-day TTL (every session is persistent
 * now — sig-always-persistent-session) so a token refresh never changes the
 * session's lifetime. All other fields (identity, remember, createdAt) are
 * preserved; lastSeenAt is bumped.
 */
export async function updateSessionTokens(args: {
  kv: KVNamespace
  sessionId: string
  record: SessionRecord
  encryptionKeyB64url: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: number
  refreshTokenExpiresAt?: number
}): Promise<SessionRecord> {
  const { kv, sessionId, record, encryptionKeyB64url } = args
  const access = await encryptAccessToken(args.accessToken, sessionId, encryptionKeyB64url)
  const refresh = await encryptAccessToken(args.refreshToken, sessionId, encryptionKeyB64url)
  const updated: SessionRecord = {
    ...record,
    encryptedAccessToken: access.ciphertext,
    iv: access.iv,
    encryptedRefreshToken: refresh.ciphertext,
    refreshIv: refresh.iv,
    accessTokenExpiresAt: args.accessTokenExpiresAt,
    lastSeenAt: Date.now(),
    ...(args.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: args.refreshTokenExpiresAt } : {}),
  }
  await kv.put(`${SESSION_KV_PREFIX}${sessionId}`, JSON.stringify(updated), {
    expirationTtl: sessionTtlSeconds(record.remember),
  })
  return updated
}

/** One enumerated session (its id + record) from {@link listSessionsPage}. */
export interface EnumeratedSession {
  sessionId: string
  record: SessionRecord
}

/**
 * One KV page of live sessions (id + record), for the account-wide "sign out
 * everywhere" / "delete account" sweeps that must revoke EVERY session a user
 * holds — not just the current cookie. KV has no value index, so the caller
 * walks pages and filters by identity. A record that fails to parse (or has
 * since expired) is skipped rather than surfaced. Returns the next `cursor`
 * (undefined once `listComplete`).
 */
export async function listSessionsPage(
  kv: KVNamespace,
  cursor?: string,
): Promise<{ sessions: EnumeratedSession[]; cursor?: string; listComplete: boolean }> {
  const page = await kv.list({ prefix: SESSION_KV_PREFIX, ...(cursor ? { cursor } : {}) })
  const sessions: EnumeratedSession[] = []
  for (const key of page.keys) {
    const sessionId = key.name.slice(SESSION_KV_PREFIX.length)
    if (!sessionId) continue
    const record = await getSession({ kv, sessionId })
    if (record) sessions.push({ sessionId, record })
  }
  // The list result is a discriminated union — `cursor` only exists on the
  // not-complete arm, so branch on `list_complete` to read it type-safely.
  if (!page.list_complete) return { sessions, cursor: page.cursor, listComplete: false }
  return { sessions, listComplete: true }
}

/**
 * Mirror a just-captured email onto the live session (sig-user-identity email
 * capture) so /auth/me reflects it without a re-login. Preserves the sliding
 * TTL. The email is not a secret (the user just typed it into their own portal).
 */
export async function setSessionEmail(args: {
  kv: KVNamespace
  sessionId: string
  record: SessionRecord
  email: string
}): Promise<void> {
  const updated: SessionRecord = { ...args.record, email: args.email, lastSeenAt: Date.now() }
  await args.kv.put(`${SESSION_KV_PREFIX}${args.sessionId}`, JSON.stringify(updated), {
    // Every session is a persistent 30-day record (sig-always-persistent-session);
    // capturing an email re-writes that same 30-day TTL.
    expirationTtl: sessionTtlSeconds(args.record.remember),
  })
}

// ─── cookie helpers ─────────────────────────────────────────────────

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return rest.join("=") || null
  }
  return null
}

export function setSessionCookie(sessionId: string, _remember = true): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    // SameSite=None (not Lax) -- SIG-155 slice 3. The portal
    // (app.sigilix.ai / localhost:3300 dev) is a DIFFERENT ORIGIN from this
    // Worker, and its setup wizard drives this session over
    // `fetch(..., { credentials: "include" })` -- a subresource request,
    // not a top-level navigation, so SameSite=Lax would silently drop the
    // cookie cross-site. None widens the CSRF surface (any origin can now
    // cause a browser to attach this cookie to a cross-site request), but
    // three things mitigate it -- and (3) is load-bearing, not incidental:
    // (1) the OAuth login flow that mints this cookie is itself
    // CSRF-protected by the state nonce + browser-bound state cookie
    // (auth-oauth-github.ts), independent of this cookie's SameSite value;
    // (2) every session-authed portal route sits behind the
    // CORS-with-credentials allowlist (portal-cors.ts), which echoes only
    // an allowlisted Origin and NEVER `*` -- BUT that allowlist is only
    // consulted for a PREFLIGHTED request, and a cross-site POST with a
    // CORS-"simple" Content-Type (text/plain,
    // application/x-www-form-urlencoded, multipart/form-data, or none)
    // skips the preflight entirely and would still fire with this cookie
    // attached; (3) that's why every mutating route on this cookie (POST
    // /v1/keys, POST /v1/onboarding) explicitly REQUIRES
    // `application/json` via `hasJsonContentType` (portal-cors.ts) --
    // that Content-Type is NOT on the Fetch spec's CORS safelist, so it
    // forces the preflight and the allowlist in (2) actually applies.
    // Skipping that check on a new mutating route is a live CSRF hole, not
    // a style nit. The `__Host-` prefix still forces Secure + Path=/ + no
    // Domain regardless of SameSite.
    "SameSite=None",
  ]
  // sig-always-persistent-session: ALWAYS a persistent cookie whose Max-Age
  // equals the 30-day KV record TTL — matched so the cookie never outlives its
  // server-side session. The former remember-me-OFF branch (no Max-Age → a
  // browser-session cookie discarded on close) was retired so visitors are not
  // unexpectedly signed out. `_remember` is retained only to keep call sites
  // compiling. Logout still revokes both sides.
  parts.push(`Max-Age=${SESSION_TTL_SECONDS}`)
  return parts.join("; ")
}

export function clearSessionCookie(): string {
  // sig-relogin-session-fix: MUST mirror setSessionCookie's `SameSite=None`. The
  // portal (a different ORIGIN) calls POST /auth/logout — and the account sweeps
  // (delete-account / logout-everywhere) — over `fetch(..., {credentials:"include"})`.
  // A deletion cookie whose SameSite differs from how the cookie was SET is not a
  // reliable overwrite across browsers/topologies (localhost dev is genuinely
  // cross-site); matching `SameSite=None; Secure` makes the clear an exact,
  // unambiguous overwrite so a logged-out tab is left with the SAME clean cookie
  // jar as a fresh incognito tab. The `__Host-` prefix still forces Secure/Path=/.
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=None", "Max-Age=0"].join("; ")
}

export function setStateCookie(nonce: string): string {
  return [`${STATE_COOKIE}=${nonce}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=600"].join("; ")
}

export function clearStateCookie(): string {
  // sig-relogin-session-fix: `SameSite=None` so this clear is reliably applied even
  // when emitted from the cross-origin logout fetch (see clearSessionCookie). The
  // state cookie is SET SameSite=Lax (it only ever rides top-level OAuth navigations),
  // but for DELETION we want the widest, unambiguous overwrite so no stale OAuth
  // state cookie survives a same-tab logout into the next login round-trip.
  return [`${STATE_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=None", "Max-Age=0"].join("; ")
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE
export const STATE_COOKIE_NAME = STATE_COOKIE
