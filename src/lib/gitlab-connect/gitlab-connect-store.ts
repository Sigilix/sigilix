// sig-gitlab-connector: the KV persistence layer for the portal's one-click
// GitLab connect flow. Keeps every KV key + shape in ONE module so the OAuth
// handlers, the project routes, and the webhook-verify extension all read/write
// the same canonical keys (COMPLIANCE §4 — one owner per concern).
//
// KV keys (all in OPENCLAW_STATE):
//   gitlab_connect_state:<nonce>     CSRF nonce for the OAuth round-trip ({userId,createdAt}), single-use, short TTL.
//   gitlab-connect-oauth:<userId>    the user's GitLab OAuth access token, ENCRYPTED at rest, short TTL (picker window).
//   gitlab-project-token:<projectId> the REVIEW credential (a project access token), PLAINTEXT — the EXISTING
//                                    contract `resolveGitLabProjectToken` reads; storing it ALSO auto-allowlists
//                                    the project (isGitLabProjectAllowlisted treats a per-project token as onboarded).
//   gitlab-webhook-secret:<projectId>  the per-project webhook secret (PLAINTEXT — a shared secret like the global
//                                    env one), resolved by the webhook-verify extension before the constant-time compare.
//   gitlab-connection:<projectId>    the connection record ({userId,projectPath,name,hookId,connectedAt}) — pins
//                                    OWNERSHIP by userId so a second tenant can't take over a connected project.
//   gitlab-connections:<userId>      per-user index (array of projectIds) so the portal can list what it connected.
//
// SECURITY: tokens + secrets are generated/stored server-side and NEVER logged.
// The OAuth token is encrypted (AES-GCM, AAD bound to its own key) so a KV dump
// alone can't replay it; the review token + webhook secret are plaintext by the
// existing review-path contract (mirrors the plaintext env credentials).

import { base64urlEncode, encryptAccessToken, decryptAccessToken } from "@/src/lib/auth-session"

interface ConnectStoreEnv {
  OPENCLAW_STATE: KVNamespace
  OPENCLAW_SESSION_ENCRYPTION_KEY?: string
}

const STATE_PREFIX = "gitlab_connect_state:"
const OAUTH_PREFIX = "gitlab-connect-oauth:"
const PROJECT_TOKEN_PREFIX = "gitlab-project-token:"
const WEBHOOK_SECRET_PREFIX = "gitlab-webhook-secret:"
const CONNECTION_PREFIX = "gitlab-connection:"
const CONNECTIONS_INDEX_PREFIX = "gitlab-connections:"

/** CSRF nonce lives just long enough for the human OAuth round-trip. */
const STATE_TTL_SECONDS = 600
/** The OAuth token only needs to survive the connect→pick→enable window. */
const OAUTH_TTL_SECONDS = 60 * 60

/** The connect record persisted per project (ownership + idempotency + listing). */
export interface GitLabConnection {
  userId: string
  projectPath: string
  name: string
  /** GitLab webhook (hook) id, so a disconnect can DELETE the exact hook. */
  hookId: number
  /** Project-access-token id, so a disconnect can revoke it. */
  patId?: number
  /** The review token's expiry (ISO date) — surfaced so the portal can warn
   *  before the ~1-year GitLab project-access-token lifetime lapses. */
  reviewTokenExpiresAt?: string
  connectedAt: string
}

/** CSRF state record carried through the OAuth round-trip. */
export interface GitLabConnectState {
  userId: string
  createdAt: number
}

// ── random secret generation (server-side only, never logged) ───────────────

/** A 32-byte URL-safe random secret (webhook token). */
export function generateWebhookSecret(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

/** A CSRF nonce for the OAuth round-trip (distinct helper name for clarity). */
export function generateConnectNonce(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

// ── CSRF state ───────────────────────────────────────────────────────────────

export async function putConnectState(env: ConnectStoreEnv, nonce: string, state: GitLabConnectState): Promise<void> {
  await env.OPENCLAW_STATE.put(`${STATE_PREFIX}${nonce}`, JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS })
}

/** Read-then-delete (single-use). Returns null when absent/expired. */
export async function takeConnectState(env: ConnectStoreEnv, nonce: string): Promise<GitLabConnectState | null> {
  const raw = (await env.OPENCLAW_STATE.get(`${STATE_PREFIX}${nonce}`, "json")) as GitLabConnectState | null
  if (raw) await env.OPENCLAW_STATE.delete(`${STATE_PREFIX}${nonce}`)
  return raw
}

// ── OAuth token (encrypted at rest) ───────────────────────────────────────────

/** AAD seed for the per-user OAuth token — stable + distinct from session AAD. */
function oauthAad(userId: string): string {
  return `${OAUTH_PREFIX}${userId}`
}

export async function putUserOAuthToken(env: ConnectStoreEnv, userId: string, token: string): Promise<void> {
  const key = env.OPENCLAW_SESSION_ENCRYPTION_KEY
  if (!key) throw new Error("OPENCLAW_SESSION_ENCRYPTION_KEY missing — cannot store GitLab OAuth token")
  const { ciphertext, iv } = await encryptAccessToken(token, oauthAad(userId), key)
  await env.OPENCLAW_STATE.put(`${OAUTH_PREFIX}${userId}`, JSON.stringify({ ciphertext, iv }), {
    expirationTtl: OAUTH_TTL_SECONDS,
  })
}

/** Decrypt + return the user's OAuth token, or null when absent/expired/undecryptable. */
export async function getUserOAuthToken(env: ConnectStoreEnv, userId: string): Promise<string | null> {
  const key = env.OPENCLAW_SESSION_ENCRYPTION_KEY
  if (!key) return null
  const raw = (await env.OPENCLAW_STATE.get(`${OAUTH_PREFIX}${userId}`, "json")) as {
    ciphertext?: string
    iv?: string
  } | null
  if (!raw?.ciphertext || !raw.iv) return null
  try {
    return await decryptAccessToken({ encryptedAccessToken: raw.ciphertext, iv: raw.iv }, oauthAad(userId), key)
  } catch {
    // A rotated encryption key (or corrupt record) — treat as "not authorized"
    // so the portal re-runs the OAuth flow rather than 500ing.
    return null
  }
}

export async function deleteUserOAuthToken(env: ConnectStoreEnv, userId: string): Promise<void> {
  await env.OPENCLAW_STATE.delete(`${OAUTH_PREFIX}${userId}`)
}

// ── review token + webhook secret (plaintext, existing contracts) ─────────────

export async function putProjectReviewToken(env: ConnectStoreEnv, projectId: number, token: string): Promise<void> {
  await env.OPENCLAW_STATE.put(`${PROJECT_TOKEN_PREFIX}${projectId}`, token)
}

export async function getProjectReviewToken(env: ConnectStoreEnv, projectId: number): Promise<string | null> {
  return env.OPENCLAW_STATE.get(`${PROJECT_TOKEN_PREFIX}${projectId}`)
}

export async function deleteProjectReviewToken(env: ConnectStoreEnv, projectId: number): Promise<void> {
  await env.OPENCLAW_STATE.delete(`${PROJECT_TOKEN_PREFIX}${projectId}`)
}

export async function putProjectWebhookSecret(env: ConnectStoreEnv, projectId: number, secret: string): Promise<void> {
  await env.OPENCLAW_STATE.put(`${WEBHOOK_SECRET_PREFIX}${projectId}`, secret)
}

/** The per-project webhook secret, or null when the project connected via the
 *  global-env secret only. Used by the webhook-verify extension. */
export async function getProjectWebhookSecret(env: ConnectStoreEnv, projectId: number): Promise<string | null> {
  return env.OPENCLAW_STATE.get(`${WEBHOOK_SECRET_PREFIX}${projectId}`)
}

export async function deleteProjectWebhookSecret(env: ConnectStoreEnv, projectId: number): Promise<void> {
  await env.OPENCLAW_STATE.delete(`${WEBHOOK_SECRET_PREFIX}${projectId}`)
}

// ── connection record + per-user index ─────────────────────────────────────────

export async function getConnection(env: ConnectStoreEnv, projectId: number): Promise<GitLabConnection | null> {
  return (await env.OPENCLAW_STATE.get(`${CONNECTION_PREFIX}${projectId}`, "json")) as GitLabConnection | null
}

export async function putConnection(env: ConnectStoreEnv, projectId: number, conn: GitLabConnection): Promise<void> {
  await env.OPENCLAW_STATE.put(`${CONNECTION_PREFIX}${projectId}`, JSON.stringify(conn))
}

export async function deleteConnection(env: ConnectStoreEnv, projectId: number): Promise<void> {
  await env.OPENCLAW_STATE.delete(`${CONNECTION_PREFIX}${projectId}`)
}

/** The projectIds this user has connected (deduped). */
export async function getUserConnectionIds(env: ConnectStoreEnv, userId: string): Promise<number[]> {
  const raw = (await env.OPENCLAW_STATE.get(`${CONNECTIONS_INDEX_PREFIX}${userId}`, "json")) as number[] | null
  return Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : []
}

export async function addUserConnectionId(env: ConnectStoreEnv, userId: string, projectId: number): Promise<void> {
  const ids = await getUserConnectionIds(env, userId)
  if (!ids.includes(projectId)) ids.push(projectId)
  await env.OPENCLAW_STATE.put(`${CONNECTIONS_INDEX_PREFIX}${userId}`, JSON.stringify(ids))
}

export async function removeUserConnectionId(env: ConnectStoreEnv, userId: string, projectId: number): Promise<void> {
  const ids = (await getUserConnectionIds(env, userId)).filter((id) => id !== projectId)
  await env.OPENCLAW_STATE.put(`${CONNECTIONS_INDEX_PREFIX}${userId}`, JSON.stringify(ids))
}
