// sig-gitlab-connector: the OAuth round-trip for the portal's one-click GitLab
// connect flow — the GitLab counterpart of `auth-oauth-github.ts`, but for the
// broad `api` scope the connector needs (NOT the read_user login OAuth) and
// storing the resulting token for the project-picker step rather than minting a
// login session.
//
// Flow:
//   GET /gitlab/connect/start     — session-gated; mint CSRF nonce (KV + cookie),
//                                    302 to GitLab's /oauth/authorize (scope=api).
//   GET /gitlab/connect/callback  — validate nonce (cookie + KV single-use),
//                                    exchange code, store the OAuth token
//                                    (encrypted, keyed by the session user), 302
//                                    back to the portal /apps/gitlab.
//
// Browser binding mirrors the GitHub handler: the state cookie is a second signal
// beside the KV nonce (either alone is insufficient).

import type { Env } from "@/src/shared/types/env"
import { requireSession } from "@/src/lib/auth-middleware"
import {
  readCookie,
  setStateCookie,
  clearStateCookie,
  STATE_COOKIE_NAME,
  type SessionRecord,
} from "@/src/lib/auth-session"
import { buildAuthorizeUrl, exchangeOAuthCode } from "./gitlab-connect-api"
import { generateConnectNonce, putConnectState, takeConnectState, putUserOAuthToken } from "./gitlab-connect-store"

/** Stable per-user key for connection ownership + token storage. Prefers the
 *  identity surrogate `userId`, then the GitHub numeric id, then the login. */
export function connectUserKey(record: SessionRecord): string {
  if (record.userId) return record.userId
  if (typeof record.githubUserId === "number") return `gh:${record.githubUserId}`
  return `login:${record.login}`
}

function baseUrl(env: Env): string {
  return env.OPENCLAW_BASE_URL ?? "https://api.sigilix.ai"
}

function portalUrl(env: Env): string {
  return env.OPENCLAW_PORTAL_URL ?? "https://app.sigilix.ai"
}

function redirectUri(env: Env): string {
  return `${baseUrl(env)}/gitlab/connect/callback`
}

function isMisconfigured(env: Env): string | null {
  if (!env.SIGILIX_GITLAB_OAUTH_CLIENT_ID) return "SIGILIX_GITLAB_OAUTH_CLIENT_ID missing"
  if (!env.SIGILIX_GITLAB_OAUTH_CLIENT_SECRET) return "SIGILIX_GITLAB_OAUTH_CLIENT_SECRET missing"
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) return "OPENCLAW_SESSION_ENCRYPTION_KEY missing"
  return null
}

// ── GET /gitlab/connect/start ─────────────────────────────────────────────────

export async function handleGitLabConnectStart(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const misconfigured = isMisconfigured(env)
  if (misconfigured) {
    console.error("gitlab connect start misconfigured", { missing: misconfigured })
    return new Response("gitlab connect not configured\n", { status: 503 })
  }

  // Session-gated: connecting acts on the signed-in user's GitLab account. No
  // session → send them through the portal login (top-level nav, so a 302 is fine).
  const authed = await requireSession(request, env, ctx)
  if (!authed) {
    return new Response(null, { status: 302, headers: { location: `${portalUrl(env)}/login` } })
  }

  const nonce = generateConnectNonce()
  await putConnectState(env, nonce, { userId: connectUserKey(authed.record), createdAt: Date.now() })

  const authorizeUrl = buildAuthorizeUrl({
    ...(env.SIGILIX_GITLAB_BASE_URL ? { baseUrl: env.SIGILIX_GITLAB_BASE_URL } : {}),
    clientId: env.SIGILIX_GITLAB_OAUTH_CLIENT_ID!,
    redirectUri: redirectUri(env),
    state: nonce,
  })

  return new Response(null, {
    status: 302,
    headers: { location: authorizeUrl, "set-cookie": setStateCookie(nonce) },
  })
}

// ── GET /gitlab/connect/callback ───────────────────────────────────────────────

/** Bounce back to the portal's GitLab app page with a status flag. */
function portalRedirect(env: Env, params: Record<string, string>): Response {
  const u = new URL(`${portalUrl(env)}/apps/gitlab`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  const headers = new Headers({ location: u.toString() })
  headers.append("set-cookie", clearStateCookie())
  return new Response(null, { status: 302, headers })
}

export async function handleGitLabConnectCallback(request: Request, env: Env): Promise<Response> {
  const misconfigured = isMisconfigured(env)
  if (misconfigured) {
    console.error("gitlab connect callback misconfigured", { missing: misconfigured })
    return new Response("gitlab connect not configured\n", { status: 503 })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const cookieNonce = readCookie(request, STATE_COOKIE_NAME)

  if (!code || !state) return portalRedirect(env, { gitlabError: "missing_code" })
  // Browser-binding: the cookie must exist and match the query state.
  if (!cookieNonce || cookieNonce !== state) return portalRedirect(env, { gitlabError: "state_mismatch" })

  const stateRecord = await takeConnectState(env, state) // single-use
  if (!stateRecord) return portalRedirect(env, { gitlabError: "state_invalid" })

  let token: string
  try {
    const exchanged = await exchangeOAuthCode({
      ...(env.SIGILIX_GITLAB_BASE_URL ? { baseUrl: env.SIGILIX_GITLAB_BASE_URL } : {}),
      clientId: env.SIGILIX_GITLAB_OAUTH_CLIENT_ID!,
      clientSecret: env.SIGILIX_GITLAB_OAUTH_CLIENT_SECRET!,
      code,
      redirectUri: redirectUri(env),
    })
    token = exchanged.access_token!
  } catch (err) {
    // Never log the code/token — only the failure shape.
    console.error("gitlab connect code exchange failed", { err: err instanceof Error ? err.message : "unknown" })
    return portalRedirect(env, { gitlabError: "oauth_failed" })
  }

  try {
    await putUserOAuthToken(env, stateRecord.userId, token)
  } catch (err) {
    console.error("gitlab connect token store failed", { err: err instanceof Error ? err.message : "unknown" })
    return portalRedirect(env, { gitlabError: "store_failed" })
  }

  return portalRedirect(env, { gitlabConnected: "1" })
}
