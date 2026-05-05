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

export function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((s.length + 2) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
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
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  )
}

function aadFor(sessionId: string): Uint8Array {
  return new TextEncoder().encode(`${SESSION_KV_PREFIX}${sessionId}`)
}

export async function encryptAccessToken(
  plaintext: string,
  sessionId: string,
  keyB64url: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importAesKey(keyB64url)
  const iv = crypto.getRandomValues(new Uint8Array(12)) // 96-bit per NIST SP 800-38D
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(sessionId) },
    key,
    new TextEncoder().encode(plaintext),
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
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(sessionId) },
    key,
    ct,
  )
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

export async function getSession(args: {
  kv: KVNamespace
  sessionId: string
}): Promise<SessionRecord | null> {
  const raw = await args.kv.get(`${SESSION_KV_PREFIX}${args.sessionId}`, "json")
  return (raw as SessionRecord) ?? null
}

export async function touchSession(args: {
  kv: KVNamespace
  sessionId: string
  record: SessionRecord
}): Promise<void> {
  // Sliding 30-day TTL — refresh lastSeenAt + KV TTL on each authenticated
  // request so an active user never gets logged out at exactly day 30.
  // Done as fire-and-forget from the request path; the race-window
  // consequence is at most a slightly stale lastSeenAt.
  const updated: SessionRecord = { ...args.record, lastSeenAt: Date.now() }
  await args.kv.put(`${SESSION_KV_PREFIX}${args.sessionId}`, JSON.stringify(updated), {
    expirationTtl: SESSION_TTL_SECONDS,
  })
}

export async function deleteSession(args: {
  kv: KVNamespace
  sessionId: string
}): Promise<void> {
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
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ")
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ")
}

export function setStateCookie(nonce: string): string {
  return [
    `${STATE_COOKIE}=${nonce}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=600",
  ].join("; ")
}

export function clearStateCookie(): string {
  return [
    `${STATE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ")
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE
export const STATE_COOKIE_NAME = STATE_COOKIE
