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

export interface SessionRecord {
  login: string
  githubUserId: number
  encryptedAccessToken: string
  iv: string
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

// ─── session CRUD against KV ────────────────────────────────────────

export async function createSession(args: {
  kv: KVNamespace
  sessionId: string
  login: string
  githubUserId: number
  accessToken: string
  encryptionKeyB64url: string
}): Promise<SessionRecord> {
  const { kv, sessionId, login, githubUserId, accessToken, encryptionKeyB64url } = args
  const { ciphertext, iv } = await encryptAccessToken(accessToken, sessionId, encryptionKeyB64url)
  const now = Date.now()
  const record: SessionRecord = {
    login,
    githubUserId,
    encryptedAccessToken: ciphertext,
    iv,
    createdAt: now,
    lastSeenAt: now,
  }
  await kv.put(`${SESSION_KV_PREFIX}${sessionId}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  })
  return record
}

export async function getSession(args: { kv: KVNamespace; sessionId: string }): Promise<SessionRecord | null> {
  const raw = await args.kv.get(`${SESSION_KV_PREFIX}${args.sessionId}`, "json")
  return (raw as SessionRecord) ?? null
}

export async function touchSession(args: { kv: KVNamespace; sessionId: string; record: SessionRecord }): Promise<void> {
  // Sliding 30-day TTL — refresh lastSeenAt + KV TTL on each authenticated
  // request so an active user never gets logged out at exactly day 30.
  // Done as fire-and-forget from the request path; the race-window
  // consequence is at most a slightly stale lastSeenAt.
  const updated: SessionRecord = { ...args.record, lastSeenAt: Date.now() }
  await args.kv.put(`${SESSION_KV_PREFIX}${args.sessionId}`, JSON.stringify(updated), {
    expirationTtl: SESSION_TTL_SECONDS,
  })
}

export async function deleteSession(args: { kv: KVNamespace; sessionId: string }): Promise<void> {
  await args.kv.delete(`${SESSION_KV_PREFIX}${args.sessionId}`)
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

export function setSessionCookie(sessionId: string): string {
  return [
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
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ")
}

export function clearSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ")
}

export function setStateCookie(nonce: string): string {
  return [`${STATE_COOKIE}=${nonce}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=600"].join("; ")
}

export function clearStateCookie(): string {
  return [`${STATE_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ")
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE
export const STATE_COOKIE_NAME = STATE_COOKIE
