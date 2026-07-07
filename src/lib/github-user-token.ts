// GitHub App user-to-server token refresh (sig-portal-bugs).
//
// ROOT CAUSE this fixes: a GitHub App's user-to-server access token is
// SHORT-LIVED (~8h) whenever the App has "Expire user authorization tokens"
// enabled (GitHub's default for new Apps). The portal session cookie + KV
// record, however, live up to 30 days. So `requireSession` keeps succeeding
// long after the stored GitHub token has died, and every LIVE GitHub call the
// portal makes with it — `GET /user/installations` (the PR-feed + org-page
// installation scope) and `GET /user/memberships/orgs` (the admin/member role
// derivation, resolve-user-role.ts) — silently 401s. Those routes are
// fail-safe (401 → member / empty scope), so the user is quietly downgraded to
// "not admin" with an EMPTY Pull-Requests feed and EMPTY seat list — even
// though they own the org. The session outliving the token is the whole bug.
//
// THE FIX: capture the refresh token + expiry at OAuth exchange
// (auth-oauth-github.ts) and, before any portal route uses the access token,
// transparently refresh it here when it's expired (or within a small skew
// window), persisting the rotated tokens back onto the session. A GitHub App
// refresh token is long-lived (~6 months) and rotates on each use.
//
// FAIL-SOFT: refreshing is best-effort. If there's no refresh material (a
// legacy session minted before this existed, a non-GitHub session, or an App
// with expiration disabled), or the refresh call fails, we return the stored
// (possibly stale) access token — exactly what the caller would have used
// before, so behavior is never WORSE than today; when a refresh token is
// present and valid it's strictly better. The access-token DECRYPT itself still
// throws on failure (a session-integrity fault), preserving each caller's
// existing decrypt-failure handling.

import { decryptAccessToken, updateSessionTokens, type SessionRecord } from "@/src/lib/auth-session"

// Refresh a little BEFORE the hard expiry so an in-flight request can't race
// the boundary and 401 anyway.
const EXPIRY_SKEW_MS = 60_000

interface RefreshEnv {
  OPENCLAW_STATE: KVNamespace
  GITHUB_OAUTH_CLIENT_ID?: string
  GITHUB_OAUTH_CLIENT_SECRET?: string
}

interface GithubRefreshResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  error?: string
}

/** Parsed, validated token fields from GitHub's exchange/refresh response. */
export interface GithubTokenSet {
  accessToken: string
  refreshToken?: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
}

/**
 * Extract the token set from a GitHub OAuth token response body. `expires_in` /
 * `refresh_token_expires_in` are RELATIVE seconds; we resolve them against
 * `nowMs` into absolute ms-epoch expiries the session record stores. Returns
 * null when there's no usable access token. When the App has expiration
 * DISABLED, GitHub omits `expires_in`/`refresh_token` — the result then carries
 * only `accessToken` and no expiry, so getValidGithubToken never tries to
 * refresh it (there's nothing to expire).
 */
export function parseGithubTokenSet(body: GithubRefreshResponse, nowMs: number): GithubTokenSet | null {
  if (typeof body.access_token !== "string" || body.access_token === "") return null
  const out: GithubTokenSet = { accessToken: body.access_token }
  if (typeof body.refresh_token === "string" && body.refresh_token !== "") out.refreshToken = body.refresh_token
  if (typeof body.expires_in === "number" && body.expires_in > 0) {
    out.accessTokenExpiresAt = nowMs + body.expires_in * 1000
  }
  if (typeof body.refresh_token_expires_in === "number" && body.refresh_token_expires_in > 0) {
    out.refreshTokenExpiresAt = nowMs + body.refresh_token_expires_in * 1000
  }
  return out
}

/** Does this session hold an access token that's expired (or about to) AND a
 *  still-valid refresh token we can use to renew it? */
function needsRefresh(record: SessionRecord, nowMs: number): boolean {
  if (typeof record.accessTokenExpiresAt !== "number") return false // legacy / non-expiring session
  if (!record.encryptedRefreshToken || !record.refreshIv) return false
  if (typeof record.refreshTokenExpiresAt === "number" && nowMs >= record.refreshTokenExpiresAt) return false
  return nowMs >= record.accessTokenExpiresAt - EXPIRY_SKEW_MS
}

/** POST GitHub's `grant_type=refresh_token`. Returns the new token set, or null
 *  on any HTTP/JSON error (fail-soft — the caller falls back to the stale token). */
async function callGithubRefresh(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch,
): Promise<GithubTokenSet | null> {
  let res: Response
  try {
    res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let body: GithubRefreshResponse
  try {
    body = (await res.json()) as GithubRefreshResponse
  } catch {
    return null
  }
  return parseGithubTokenSet(body, Date.now())
}

/**
 * Return a USABLE GitHub user-to-server access token for the session, refreshing
 * (and re-persisting) it first when the stored one has expired. The access-token
 * decrypt throws on failure (preserving each caller's own handling); the refresh
 * step is fail-soft (see the file header). Never logs any token.
 */
export async function getValidGithubToken(args: {
  env: RefreshEnv
  sessionId: string
  record: SessionRecord
  encryptionKeyB64url: string
  fetchImpl?: typeof fetch
}): Promise<string> {
  const { env, sessionId, record, encryptionKeyB64url } = args
  const fetchImpl = args.fetchImpl ?? fetch

  // Decrypt the current access token first — a decrypt failure is a session
  // integrity fault and must surface exactly as it did before this module.
  const accessToken = await decryptAccessToken(
    { encryptedAccessToken: record.encryptedAccessToken, iv: record.iv },
    sessionId,
    encryptionKeyB64url,
  )

  const now = Date.now()
  if (!needsRefresh(record, now)) return accessToken
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return accessToken

  try {
    const refreshToken = await decryptAccessToken(
      { encryptedAccessToken: record.encryptedRefreshToken!, iv: record.refreshIv! },
      sessionId,
      encryptionKeyB64url,
    )
    const refreshed = await callGithubRefresh(
      refreshToken,
      env.GITHUB_OAUTH_CLIENT_ID,
      env.GITHUB_OAUTH_CLIENT_SECRET,
      fetchImpl,
    )
    // A refresh MUST yield both a new access token AND a new expiry to be worth
    // persisting; without an expiry we'd never know to refresh it again.
    if (!refreshed || refreshed.accessTokenExpiresAt === undefined) return accessToken

    await updateSessionTokens({
      kv: env.OPENCLAW_STATE,
      sessionId,
      record,
      encryptionKeyB64url,
      accessToken: refreshed.accessToken,
      // GitHub rotates the refresh token on use; fall back to the old one only
      // if the response omitted a new one.
      refreshToken: refreshed.refreshToken ?? refreshToken,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      ...(refreshed.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }
        : {}),
    })
    console.log(JSON.stringify({ event: "github-user-token-refreshed" }))
    return refreshed.accessToken
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "github-user-token-refresh-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return accessToken
  }
}
