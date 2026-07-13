// GitLab user OAuth — sig-gitlab-oauth-login (GitLab support PR 4).
//
// Mirrors the GitHub / Google user-OAuth flow (auth-oauth-github.ts /
// auth-oauth-google.ts) exactly for CSRF hardening: a random state nonce is
// stored in KV AND set as a browser-bound state cookie; the callback requires
// BOTH to match, then read-then-deletes the KV nonce (single-use). The only
// differences from GitHub/Google are the provider endpoints, a configurable
// GitLab base URL (gitlab.com by default; a self-managed instance overrides it),
// and that the account is resolved find-or-create BY gitlab_id — a
// GitLab-provided email is treated as UNVERIFIED and never a cross-provider
// linking key (takeover-safe, exactly like the GitHub path). See
// findOrCreateGitlabIdentity.
//
//   GET /auth/gitlab/login     — mint nonce, set state cookie, 302 to GitLab
//   GET /auth/gitlab           — alias of /auth/gitlab/login (the path the
//                                 portal's provider stub historically hit)
//   GET /auth/gitlab/callback  — validate nonce + cookie, exchange code, fetch
//                                 /api/v4/user, find-or-create identity by
//                                 gitlab_id, mint the SAME session as GitHub, 302.
//
// Redirect URI (must be registered in the GitLab OAuth application):
//   https://api.sigilix.ai/auth/gitlab/callback
//
// Not-configured is graceful: when SIGILIX_GITLAB_OAUTH_CLIENT_ID/SECRET are
// unset the kickoff returns 503 and GET /auth/providers reports gitlab:false, so
// the portal hides the button rather than dead-ending a user.

import {
  clearStateCookie,
  createSession,
  mintSessionId,
  mintStateNonce,
  readCookie,
  setSessionCookie,
  setStateCookie,
  STATE_COOKIE_NAME,
} from "./auth-session"
import { safeRedirectAfter } from "./auth-oauth-github"
import { findOrCreateGitlabIdentity } from "./user-identity-store"

const GITLAB_STATE_KV_PREFIX = "auth_state_gitlab:"
const STATE_TTL_SECONDS = 600
// GitLab OAuth scopes: `read_user` grants read access to /api/v4/user (incl. the
// account email); `email` additionally grants the primary email via OIDC. Space
// separated → URLSearchParams serializes the space as `+` (read_user+email).
const SCOPES = "read_user email"
const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com"

interface GitlabOauthEnv {
  OPENCLAW_STATE: KVNamespace
  SIGILIX_GITLAB_OAUTH_CLIENT_ID?: string
  SIGILIX_GITLAB_OAUTH_CLIENT_SECRET?: string
  // REST origin WITHOUT the `/api/v4` suffix (default https://gitlab.com); a
  // self-managed instance sets its own. Reused from the GitLab MR-review path.
  SIGILIX_GITLAB_BASE_URL?: string
  OPENCLAW_SESSION_ENCRYPTION_KEY?: string
  OPENCLAW_BASE_URL?: string
  OPENCLAW_PORTAL_URL?: string
  SIGILIX_PLATFORM_DB?: D1Database
}

/** This Worker's own origin (where GitLab redirects the browser back to). */
function baseUrl(env: GitlabOauthEnv): string {
  return env.OPENCLAW_BASE_URL ?? "https://app.sigilix.ai"
}

/** The GitLab instance origin, trailing slash stripped (matches GitLabClient). */
function gitlabBaseUrl(env: GitlabOauthEnv): string {
  return (env.SIGILIX_GITLAB_BASE_URL ?? DEFAULT_GITLAB_BASE_URL).replace(/\/+$/, "")
}

/**
 * The stored `gitlab_id` provider key. Unlike a Google `sub` (globally unique
 * across one issuer), GitLab numeric user ids are INSTANCE-LOCAL — every
 * self-managed instance numbers its own users from 1 — so a bare id would
 * collide if SIGILIX_GITLAB_BASE_URL ever pointed at a different instance over
 * the same DB (instance A's user 42 silently resolving to instance B's user 42).
 * Qualify the id with the instance host so `gitlab.com:42` and
 * `gitlab.example.com:42` are distinct accounts. gitlab.com is the default, so
 * the common key is simply `gitlab.com:<id>`.
 */
function gitlabSubject(env: GitlabOauthEnv, userId: number): string {
  return `${new URL(gitlabBaseUrl(env)).host}:${userId}`
}

/** True only when every secret + the identity DB needed for a GitLab login is present. */
export function isGitlabConfigured(env: GitlabOauthEnv): boolean {
  return Boolean(
    env.SIGILIX_GITLAB_OAUTH_CLIENT_ID &&
    env.SIGILIX_GITLAB_OAUTH_CLIENT_SECRET &&
    env.OPENCLAW_SESSION_ENCRYPTION_KEY &&
    env.SIGILIX_PLATFORM_DB,
  )
}

interface StateRecord {
  createdAt: number
  redirectAfter?: string
  // "Remember me" choice, carried server-side through the OAuth round-trip
  // (mirrors auth-oauth-google.ts). Absent = persistent default.
  remember?: boolean
}

export async function handleGitlabAuthKickoff(request: Request, env: GitlabOauthEnv): Promise<Response> {
  if (!isGitlabConfigured(env)) {
    console.error("gitlab oauth kickoff not configured")
    return new Response("gitlab login not configured\n", { status: 503 })
  }

  const url = new URL(request.url)
  // Parsed + stored for back-compat only; every session is a persistent 30-day
  // session now (sig-always-persistent-session), so `?remember=0` no longer
  // shortens it.
  const remember = url.searchParams.get("remember") !== "0"
  const rawRedirect = url.searchParams.get("redirectAfter") ?? undefined
  const redirectAfter = rawRedirect ? safeRedirectAfter(rawRedirect, baseUrl(env)) : undefined

  const nonce = mintStateNonce()
  const record: StateRecord = {
    createdAt: Date.now(),
    ...(redirectAfter ? { redirectAfter } : {}),
    ...(remember ? {} : { remember: false }),
  }
  await env.OPENCLAW_STATE.put(`${GITLAB_STATE_KV_PREFIX}${nonce}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  })

  const authorizeUrl = new URL(`${gitlabBaseUrl(env)}/oauth/authorize`)
  authorizeUrl.searchParams.set("client_id", env.SIGILIX_GITLAB_OAUTH_CLIENT_ID!)
  authorizeUrl.searchParams.set("redirect_uri", `${baseUrl(env)}/auth/gitlab/callback`)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("scope", SCOPES)
  authorizeUrl.searchParams.set("state", nonce)

  return new Response(null, {
    status: 302,
    headers: { location: authorizeUrl.toString(), "set-cookie": setStateCookie(nonce) },
  })
}

interface GitlabTokenResponse {
  access_token?: string
  token_type?: string
  error?: string
  error_description?: string
}

interface GitlabUserResponse {
  id?: number
  username?: string
  name?: string | null
  email?: string | null
  avatar_url?: string | null
}

export async function handleGitlabAuthCallback(request: Request, env: GitlabOauthEnv): Promise<Response> {
  if (!isGitlabConfigured(env)) {
    console.error("gitlab oauth callback not configured")
    return new Response("gitlab login not configured\n", { status: 503 })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const cookieNonce = readCookie(request, STATE_COOKIE_NAME)

  if (!code || !state) {
    return new Response("missing code or state\n", { status: 400, headers: { "set-cookie": clearStateCookie() } })
  }
  // Browser-binding + KV single-use nonce (identical to the GitHub/Google flow).
  if (!cookieNonce || cookieNonce !== state) {
    return new Response("state_mismatch\n", { status: 400, headers: { "set-cookie": clearStateCookie() } })
  }
  const stateRaw = (await env.OPENCLAW_STATE.get(`${GITLAB_STATE_KV_PREFIX}${state}`, "json")) as StateRecord | null
  if (!stateRaw) {
    return new Response("state_invalid\n", { status: 400, headers: { "set-cookie": clearStateCookie() } })
  }
  await env.OPENCLAW_STATE.delete(`${GITLAB_STATE_KV_PREFIX}${state}`)

  // Exchange the authorization code for an access token.
  let tokenJson: GitlabTokenResponse
  try {
    const tokenRes = await fetch(`${gitlabBaseUrl(env)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: env.SIGILIX_GITLAB_OAUTH_CLIENT_ID!,
        client_secret: env.SIGILIX_GITLAB_OAUTH_CLIENT_SECRET!,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${baseUrl(env)}/auth/gitlab/callback`,
      }),
    })
    if (!tokenRes.ok) {
      console.error("gitlab oauth code exchange http error", { status: tokenRes.status })
      return new Response("code_exchange_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
    }
    tokenJson = (await tokenRes.json()) as GitlabTokenResponse
  } catch (e) {
    console.error("gitlab oauth code exchange threw", { error: String(e) })
    return new Response("code_exchange_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
  }
  if (!tokenJson.access_token) {
    console.error("gitlab oauth code exchange missing access_token", { error: tokenJson.error })
    return new Response("code_exchange_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
  }

  // Fetch the user profile from REST v4.
  let user: GitlabUserResponse
  try {
    const userRes = await fetch(`${gitlabBaseUrl(env)}/api/v4/user`, {
      headers: { authorization: `Bearer ${tokenJson.access_token}`, "user-agent": "sigilix-worker" },
    })
    if (!userRes.ok) {
      console.error("gitlab user fetch http error", { status: userRes.status })
      return new Response("user_fetch_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
    }
    user = (await userRes.json()) as GitlabUserResponse
  } catch (e) {
    console.error("gitlab user fetch threw", { error: String(e) })
    return new Response("user_fetch_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
  }
  if (typeof user.id !== "number" || !user.username) {
    console.error("gitlab user response missing id or username")
    return new Response("user_fetch_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
  }

  // Find-or-create the identity BY gitlab_id. A missing email does NOT block the
  // login — the row is created email=NULL and the portal's email-capture path
  // fills it later. FAILS CLOSED on a D1 fault (the GitLab session needs this
  // row's user_id — see findOrCreateGitlabIdentity).
  let identity
  try {
    identity = await findOrCreateGitlabIdentity(env.SIGILIX_PLATFORM_DB!, {
      gitlabId: gitlabSubject(env, user.id),
      email: typeof user.email === "string" && user.email.trim() ? user.email.trim() : null,
      name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : null,
      avatarUrl: typeof user.avatar_url === "string" && user.avatar_url ? user.avatar_url : null,
      nowIso: new Date().toISOString(),
    })
  } catch (e) {
    console.error("gitlab identity resolve failed", { error: String(e) })
    return new Response("identity_error\n", { status: 500, headers: { "set-cookie": clearStateCookie() } })
  }

  // Mint the SAME session shape as a GitHub login (no GitHub token → default "").
  // `login` is the GitLab username (analogous to the GitHub login handle).
  // `remember` (default persistent) rode through the single-use KV state record.
  const remember = stateRaw.remember !== false
  const sessionId = mintSessionId()
  await createSession({
    kv: env.OPENCLAW_STATE,
    sessionId,
    login: user.username,
    userId: identity.userId,
    provider: "gitlab",
    remember,
    encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY!,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.name ? { name: identity.name } : {}),
  })

  const portalUrl = env.OPENCLAW_PORTAL_URL
  const dest = stateRaw.redirectAfter ?? (portalUrl ? `${portalUrl}/setup` : "/auth/welcome")
  const finalDest = stateRaw.redirectAfter ? safeRedirectAfter(dest, baseUrl(env)) : dest

  const headers = new Headers({ location: finalDest })
  headers.append("set-cookie", setSessionCookie(sessionId, remember))
  headers.append("set-cookie", clearStateCookie())
  return new Response(null, { status: 302, headers })
}
