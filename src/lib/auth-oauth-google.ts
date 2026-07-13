// Google (OIDC) user OAuth — sig-user-identity launch P0.
//
// Mirrors the GitHub user-OAuth flow (auth-oauth-github.ts) exactly for CSRF
// hardening: a random state nonce is stored in KV AND set as a browser-bound
// state cookie; the callback requires BOTH to match, then read-then-deletes the
// KV nonce (single-use). The only differences from GitHub are the provider
// endpoints and that the account is resolved find-or-create BY EMAIL (Google
// verifies the email), which links a Google login to a pre-existing GitHub or
// email/password account that shares the address.
//
//   GET /auth/google/login     — mint nonce, set state cookie, 302 to Google
//   GET /auth/google/callback  — validate nonce + cookie, exchange code,
//                                 fetch userinfo, find-or-create identity by
//                                 email, mint the SAME session as GitHub, 302.
//
// Redirect URI (must be registered in Google Cloud console):
//   https://api.sigilix.ai/auth/google/callback
//
// Not-configured is graceful: when GOOGLE_CLIENT_ID/SECRET are unset the
// kickoff returns 503 and GET /auth/providers reports google:false, so the
// portal hides the button rather than dead-ending a user.

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
import { findOrCreateGoogleIdentity } from "./user-identity-store"

const GOOGLE_STATE_KV_PREFIX = "auth_state_google:"
const STATE_TTL_SECONDS = 600
const SCOPES = "openid email profile"
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

interface GoogleOauthEnv {
  OPENCLAW_STATE: KVNamespace
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  OPENCLAW_SESSION_ENCRYPTION_KEY?: string
  OPENCLAW_BASE_URL?: string
  OPENCLAW_PORTAL_URL?: string
  SIGILIX_PLATFORM_DB?: D1Database
}

function baseUrl(env: GoogleOauthEnv): string {
  return env.OPENCLAW_BASE_URL ?? "https://app.sigilix.ai"
}

/** True only when every secret + the identity DB needed for a Google login is present. */
export function isGoogleConfigured(env: GoogleOauthEnv): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OPENCLAW_SESSION_ENCRYPTION_KEY && env.SIGILIX_PLATFORM_DB,
  )
}

interface StateRecord {
  createdAt: number
  redirectAfter?: string
  // "Remember me" choice, carried server-side through the OAuth round-trip
  // (mirrors auth-oauth-github.ts). Absent = persistent default.
  remember?: boolean
}

export async function handleGoogleAuthKickoff(request: Request, env: GoogleOauthEnv): Promise<Response> {
  if (!isGoogleConfigured(env)) {
    console.error("google oauth kickoff not configured")
    return new Response("google login not configured\n", { status: 503 })
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
  await env.OPENCLAW_STATE.put(`${GOOGLE_STATE_KV_PREFIX}${nonce}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  })

  const authorizeUrl = new URL(AUTHORIZE_URL)
  authorizeUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!)
  authorizeUrl.searchParams.set("redirect_uri", `${baseUrl(env)}/auth/google/callback`)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("scope", SCOPES)
  authorizeUrl.searchParams.set("state", nonce)
  authorizeUrl.searchParams.set("access_type", "online")
  authorizeUrl.searchParams.set("prompt", "select_account")

  return new Response(null, {
    status: 302,
    headers: { location: authorizeUrl.toString(), "set-cookie": setStateCookie(nonce) },
  })
}

interface GoogleTokenResponse {
  access_token?: string
  id_token?: string
  error?: string
}

interface GoogleUserInfo {
  sub?: string
  email?: string
  email_verified?: boolean | string
  name?: string | null
  picture?: string | null
}

export async function handleGoogleAuthCallback(request: Request, env: GoogleOauthEnv): Promise<Response> {
  if (!isGoogleConfigured(env)) {
    console.error("google oauth callback not configured")
    return new Response("google login not configured\n", { status: 503 })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const cookieNonce = readCookie(request, STATE_COOKIE_NAME)

  if (!code || !state) {
    return new Response("missing code or state\n", { status: 400, headers: { "set-cookie": clearStateCookie() } })
  }
  // Browser-binding + KV single-use nonce (identical to the GitHub flow).
  if (!cookieNonce || cookieNonce !== state) {
    return new Response("state_mismatch\n", { status: 400, headers: { "set-cookie": clearStateCookie() } })
  }
  const stateRaw = (await env.OPENCLAW_STATE.get(`${GOOGLE_STATE_KV_PREFIX}${state}`, "json")) as StateRecord | null
  if (!stateRaw) {
    return new Response("state_invalid\n", { status: 400, headers: { "set-cookie": clearStateCookie() } })
  }
  await env.OPENCLAW_STATE.delete(`${GOOGLE_STATE_KV_PREFIX}${state}`)

  // Exchange the authorization code for tokens.
  let tokenJson: GoogleTokenResponse
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${baseUrl(env)}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    })
    if (!tokenRes.ok) {
      console.error("google oauth code exchange http error", { status: tokenRes.status })
      return new Response("code_exchange_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
    }
    tokenJson = (await tokenRes.json()) as GoogleTokenResponse
  } catch (e) {
    console.error("google oauth code exchange threw", { error: String(e) })
    return new Response("code_exchange_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
  }
  if (!tokenJson.access_token) {
    console.error("google oauth code exchange missing access_token", { error: tokenJson.error })
    return new Response("code_exchange_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
  }

  // Fetch the verified profile from the OIDC userinfo endpoint.
  let info: GoogleUserInfo
  try {
    const infoRes = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${tokenJson.access_token}` } })
    if (!infoRes.ok) {
      console.error("google userinfo http error", { status: infoRes.status })
      return new Response("user_fetch_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
    }
    info = (await infoRes.json()) as GoogleUserInfo
  } catch (e) {
    console.error("google userinfo threw", { error: String(e) })
    return new Response("user_fetch_failed\n", { status: 502, headers: { "set-cookie": clearStateCookie() } })
  }

  const emailVerified = info.email_verified === true || info.email_verified === "true"
  if (!info.sub || !info.email || !emailVerified) {
    // Fail closed: without a verified email we cannot safely link accounts.
    console.error("google userinfo missing sub or unverified email")
    return new Response("email_unverified\n", { status: 403, headers: { "set-cookie": clearStateCookie() } })
  }

  // Find-or-create the identity BY EMAIL (account linking across providers).
  let identity
  try {
    identity = await findOrCreateGoogleIdentity(env.SIGILIX_PLATFORM_DB!, {
      googleSub: info.sub,
      email: info.email,
      name: typeof info.name === "string" && info.name.trim() ? info.name.trim() : null,
      avatarUrl: typeof info.picture === "string" && info.picture ? info.picture : null,
      nowIso: new Date().toISOString(),
    })
  } catch (e) {
    console.error("google identity resolve failed", { error: String(e) })
    return new Response("identity_error\n", { status: 500, headers: { "set-cookie": clearStateCookie() } })
  }

  // Mint the SAME session shape as a GitHub login (no GitHub token → default "").
  // `remember` (default persistent) rode through the single-use KV state record.
  const remember = stateRaw.remember !== false
  const sessionId = mintSessionId()
  await createSession({
    kv: env.OPENCLAW_STATE,
    sessionId,
    login: identity.email ?? info.email,
    userId: identity.userId,
    provider: "google",
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
