// GitHub user-to-server OAuth handler (Phase 5 v2 LOCKED).
//
// The same GitHub App that signs server-to-server JWTs (see github-app.ts)
// also exposes a user OAuth flow at the client_id/client_secret pair on
// the App's settings page. Sigilix uses both: server-to-server for
// repo/PR access, user-to-server for "who is signed in to the dashboard."
//
// Flow:
//   GET /auth/github           — mint nonce, set state cookie, 302 to GitHub
//   GET /auth/github/callback  — validate (KV nonce) AND (state cookie matches)
//                                 read-then-delete nonce from KV
//                                 exchange code for token
//                                 fetch GET /user
//                                 mint session + encrypt token + store + cookie
//                                 302 to redirectAfter or /auth/welcome
//
// Browser binding: the state cookie is a separate signal from the KV nonce.
// Either one alone is insufficient (see spec § Browser-bound OAuth state).

import {
  base64urlEncode,
  clearSessionCookie,
  clearStateCookie,
  createSession,
  mintSessionId,
  mintStateNonce,
  readCookie,
  setSessionCookie,
  setStateCookie,
  STATE_COOKIE_NAME,
} from "./auth-session"
import { parseGithubTokenSet } from "./github-user-token"
import { upsertGithubIdentity } from "./user-identity-store"
import { listUserInstallationIds } from "@/src/shared/adapters/github/user-installation-access"
import { linkAccountTenant } from "@/src/lib/api-key-store"

const STATE_KV_PREFIX = "auth_state:"
const STATE_TTL_SECONDS = 600
const SCOPES = "read:user user:email"

interface AuthOauthEnv {
  OPENCLAW_STATE: KVNamespace
  GITHUB_OAUTH_CLIENT_ID?: string
  GITHUB_OAUTH_CLIENT_SECRET?: string
  OPENCLAW_SESSION_ENCRYPTION_KEY?: string
  OPENCLAW_BASE_URL?: string
  // #155 onboarding-backend slice 3 (env-gated redirect polish — see
  // safeRedirectAfter callers below). Unset = today's behavior, unchanged.
  OPENCLAW_PORTAL_URL?: string
  // sig-user-identity: the persistent identity D1. Optional so a deploy that
  // hasn't migrated 0006 still logs users in (identity persistence is
  // best-effort — a missing binding just skips the upsert, never blocks login).
  SIGILIX_PLATFORM_DB?: D1Database
}

function baseUrl(env: AuthOauthEnv): string {
  return env.OPENCLAW_BASE_URL ?? "https://app.sigilix.ai"
}

function isMisconfigured(env: AuthOauthEnv): string | null {
  if (!env.GITHUB_OAUTH_CLIENT_ID) return "GITHUB_OAUTH_CLIENT_ID missing"
  if (!env.GITHUB_OAUTH_CLIENT_SECRET) return "GITHUB_OAUTH_CLIENT_SECRET missing"
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) return "OPENCLAW_SESSION_ENCRYPTION_KEY missing"
  return null
}

// ─── /auth/github ───────────────────────────────────────────────────

interface StateRecord {
  createdAt: number
  redirectAfter?: string
  // "Remember me" choice, carried server-side through the OAuth round-trip (the
  // callback has no other channel to the login form). Absent = persistent
  // default. Not a secret; lives only in the single-use KV state nonce record.
  remember?: boolean
}

export async function handleGitHubAuthKickoff(request: Request, env: AuthOauthEnv): Promise<Response> {
  const misconfigured = isMisconfigured(env)
  if (misconfigured) {
    console.error("github oauth kickoff misconfigured", { missing: misconfigured })
    return new Response("auth misconfigured\n", { status: 503 })
  }

  const url = new URL(request.url)
  // Parsed + stored for back-compat only; every session is a persistent 30-day
  // session now (sig-always-persistent-session), so `?remember=0` no longer
  // shortens it.
  const remember = url.searchParams.get("remember") !== "0"
  const rawRedirect = url.searchParams.get("redirectAfter") ?? undefined
  // Only validate + store a redirectAfter when the CALLER explicitly asked
  // for one. safeRedirectAfter's own fallback ("/auth/welcome") is for the
  // CALLBACK's use when nothing was stored — computing it here too would
  // make `record.redirectAfter` always truthy, which would make the
  // callback unable to tell "no redirectAfter was requested" from "one WAS
  // requested and it happened to validate to /auth/welcome," silently
  // defeating the OPENCLAW_PORTAL_URL default-destination switch below.
  const redirectAfter = rawRedirect ? safeRedirectAfter(rawRedirect, baseUrl(env)) : undefined

  const nonce = mintStateNonce()
  // exactOptionalPropertyTypes: omit the key entirely rather than set it to
  // `undefined` — `JSON.stringify` would drop it anyway, but this keeps the
  // in-memory shape and the serialized shape identical. `remember` is only
  // stored when it deviates from the persistent default (i.e. remember=false),
  // so existing state records are byte-identical unless a user opts out.
  const record: StateRecord = {
    createdAt: Date.now(),
    ...(redirectAfter ? { redirectAfter } : {}),
    ...(remember ? {} : { remember: false }),
  }
  await env.OPENCLAW_STATE.put(`${STATE_KV_PREFIX}${nonce}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  })

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize")
  authorizeUrl.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID!)
  authorizeUrl.searchParams.set("redirect_uri", `${baseUrl(env)}/auth/github/callback`)
  authorizeUrl.searchParams.set("scope", SCOPES)
  authorizeUrl.searchParams.set("state", nonce)
  authorizeUrl.searchParams.set("allow_signup", "true")

  await writeAuthEvent(env.OPENCLAW_STATE, {
    kind: "kickoff",
    provider: "github",
    ts: Date.now(),
  })

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl.toString(),
      "set-cookie": setStateCookie(nonce),
    },
  })
}

// ─── /auth/github/callback ──────────────────────────────────────────

interface AccessTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  // sig-portal-bugs: a GitHub App with "Expire user authorization tokens"
  // enabled returns these alongside the access token. Captured so the session
  // can transparently refresh the short-lived (~8h) access token instead of
  // silently degrading to "member" + an empty feed once it dies (see
  // github-user-token.ts). Absent when the App has expiration disabled.
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

interface GitHubUserResponse {
  login?: string
  id?: number
  name?: string | null
  email?: string | null
  avatar_url?: string | null
}

// One entry of `GET /user/emails` (the private-email fallback below).
interface GitHubEmailEntry {
  email?: string | null
  primary?: boolean
  verified?: boolean
  visibility?: string | null
}

// Pick the best email from a `/user/emails` payload. Precedence:
//   primary AND verified → first verified → primary → first entry.
// Returns null when the array carries no usable (non-empty) address.
export function selectGithubEmail(entries: GitHubEmailEntry[]): string | null {
  const valid = entries.filter((e): e is GitHubEmailEntry & { email: string } => {
    // Guard non-object entries (a malformed `[null]` / `["x"]` payload) so a
    // bad shape returns null (fail-soft) instead of throwing and blocking login.
    return typeof e === "object" && e !== null && typeof e.email === "string" && e.email.trim().length > 0
  })
  if (valid.length === 0) return null
  const primaryVerified = valid.find((e) => e.primary === true && e.verified === true)
  if (primaryVerified) return primaryVerified.email
  const verified = valid.find((e) => e.verified === true)
  if (verified) return verified.email
  const primary = valid.find((e) => e.primary === true)
  if (primary) return primary.email
  return valid[0]!.email
}

// Fetch the OAuth user's private email via `GET /user/emails` when `/user`
// returned no public email (email-privacy enabled). Uses the SAME access token
// + headers as the `/user` call. FAIL-SOFT: any transport / HTTP / shape fault
// returns null so login is never blocked — the caller then falls through to the
// email-capture prompt exactly as before. Never logs an email body (PII).
async function fetchGithubPrimaryEmail(accessToken: string): Promise<string | null> {
  let res: Response
  try {
    res = await fetch("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "sigilix-worker",
      },
    })
  } catch (e) {
    console.error("github user emails fetch threw", { error: String(e) })
    return null
  }
  if (!res.ok) {
    console.error("github user emails fetch http error", { status: res.status })
    return null
  }
  let payload: unknown
  try {
    payload = await res.json()
  } catch (e) {
    console.error("github user emails parse failed", { error: String(e) })
    return null
  }
  if (!Array.isArray(payload)) return null
  return selectGithubEmail(payload as GitHubEmailEntry[])
}

export async function handleGitHubAuthCallback(request: Request, env: AuthOauthEnv): Promise<Response> {
  const misconfigured = isMisconfigured(env)
  if (misconfigured) {
    console.error("github oauth callback misconfigured", { missing: misconfigured })
    return new Response("auth misconfigured\n", { status: 503 })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const cookieNonce = readCookie(request, STATE_COOKIE_NAME)

  if (!code || !state) {
    return new Response("missing code or state\n", {
      status: 400,
      headers: { "set-cookie": clearStateCookie() },
    })
  }

  // 1. Browser-binding check. Cookie must exist and match the query state.
  if (!cookieNonce || cookieNonce !== state) {
    await writeAuthEvent(env.OPENCLAW_STATE, {
      kind: "callback_failed",
      provider: "github",
      reason: "state_mismatch",
      ts: Date.now(),
    })
    return new Response("state_mismatch\n", {
      status: 400,
      headers: { "set-cookie": clearStateCookie() },
    })
  }

  // 2. KV nonce check. Read-then-delete (single-use, best-effort under KV
  //    eventual consistency — browser-binding above protects against the
  //    multi-region race).
  const stateRaw = (await env.OPENCLAW_STATE.get(`${STATE_KV_PREFIX}${state}`, "json")) as StateRecord | null
  if (!stateRaw) {
    await writeAuthEvent(env.OPENCLAW_STATE, {
      kind: "callback_failed",
      provider: "github",
      reason: "state_invalid",
      ts: Date.now(),
    })
    return new Response("state_invalid\n", {
      status: 400,
      headers: { "set-cookie": clearStateCookie() },
    })
  }
  await env.OPENCLAW_STATE.delete(`${STATE_KV_PREFIX}${state}`)

  // 3. Exchange code for access token.
  let tokenRes: Response
  try {
    tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_OAUTH_CLIENT_ID!,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET!,
        code,
        redirect_uri: `${baseUrl(env)}/auth/github/callback`,
      }),
    })
  } catch (e) {
    console.error("github oauth code exchange threw", { error: String(e) })
    await writeAuthEvent(env.OPENCLAW_STATE, {
      kind: "callback_failed",
      provider: "github",
      reason: "code_exchange_failed",
      ts: Date.now(),
    })
    return new Response("code_exchange_failed\n", {
      status: 502,
      headers: { "set-cookie": clearStateCookie() },
    })
  }
  if (!tokenRes.ok) {
    console.error("github oauth code exchange http error", { status: tokenRes.status })
    await writeAuthEvent(env.OPENCLAW_STATE, {
      kind: "callback_failed",
      provider: "github",
      reason: "code_exchange_failed",
      ts: Date.now(),
    })
    return new Response("code_exchange_failed\n", {
      status: 502,
      headers: { "set-cookie": clearStateCookie() },
    })
  }
  const tokenJson = (await tokenRes.json()) as AccessTokenResponse
  if (!tokenJson.access_token) {
    console.error("github oauth code exchange missing access_token", { error: tokenJson.error })
    await writeAuthEvent(env.OPENCLAW_STATE, {
      kind: "callback_failed",
      provider: "github",
      reason: "code_exchange_failed",
      ts: Date.now(),
    })
    return new Response("code_exchange_failed\n", {
      status: 502,
      headers: { "set-cookie": clearStateCookie() },
    })
  }
  const accessToken = tokenJson.access_token
  // sig-portal-bugs: resolve the (optional) refresh material into absolute
  // expiries the session stores, so getValidGithubToken can renew the short-
  // lived access token before it 401s the portal's role + feed lookups.
  const tokenSet = parseGithubTokenSet(tokenJson, Date.now())

  // 4. Fetch user profile.
  let userRes: Response
  try {
    userRes = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "sigilix-worker",
      },
    })
  } catch (e) {
    console.error("github user fetch threw", { error: String(e) })
    await writeAuthEvent(env.OPENCLAW_STATE, {
      kind: "callback_failed",
      provider: "github",
      reason: "user_fetch_failed",
      ts: Date.now(),
    })
    return new Response("user_fetch_failed\n", {
      status: 502,
      headers: { "set-cookie": clearStateCookie() },
    })
  }
  if (!userRes.ok) {
    console.error("github user fetch http error", { status: userRes.status })
    await writeAuthEvent(env.OPENCLAW_STATE, {
      kind: "callback_failed",
      provider: "github",
      reason: "user_fetch_failed",
      ts: Date.now(),
    })
    return new Response("user_fetch_failed\n", {
      status: 502,
      headers: { "set-cookie": clearStateCookie() },
    })
  }
  const user = (await userRes.json()) as GitHubUserResponse
  if (!user.login || typeof user.id !== "number") {
    console.error("github user response missing login or id")
    return new Response("user_fetch_failed\n", {
      status: 502,
      headers: { "set-cookie": clearStateCookie() },
    })
  }

  // 5. Persist the real user record (sig-user-identity). BEST-EFFORT: the login
  //    has already succeeded, so a D1 fault or an unmigrated/absent binding must
  //    NOT block sign-in — upsertGithubIdentity swallows + logs its own errors
  //    and returns null. When it succeeds we thread the surrogate user_id +
  //    resolved email onto the session so the portal can read a stable account
  //    key and know whether to prompt for a missing email (email-capture).
  const displayName = typeof user.name === "string" && user.name.trim() ? user.name.trim() : undefined
  const avatarUrl = typeof user.avatar_url === "string" && user.avatar_url ? user.avatar_url : undefined
  let identityUserId: string | undefined
  let identityEmail: string | undefined
  if (env.SIGILIX_PLATFORM_DB) {
    // Capture the email. GitHub returns `/user.email = null` for accounts with
    // email privacy on, which used to dead-end the user at the "add a work
    // email" prompt. We already hold the `user:email` scope, so fall back to
    // `GET /user/emails` (primary+verified → verified → primary → first) when
    // the profile carries no public address. Fail-soft: a null result just
    // keeps the existing email-capture path.
    let resolvedEmail: string | null =
      typeof user.email === "string" && user.email.trim().length > 0 ? user.email : null
    if (!resolvedEmail) {
      resolvedEmail = await fetchGithubPrimaryEmail(accessToken)
    }
    const identity = await upsertGithubIdentity(env.SIGILIX_PLATFORM_DB, {
      githubUserId: String(user.id),
      email: resolvedEmail,
      name: displayName ?? null,
      avatarUrl: avatarUrl ?? null,
      nowIso: new Date().toISOString(),
    })
    if (identity) {
      identityUserId = identity.userId
      identityEmail = identity.email ?? undefined
    }

    // 5b. Always link the user to every org tenant they belong to
    //     (account_tenant), so a signed-in user is NEVER tenant-less — each
    //     tenant carries its own fairness/isolation, so membership must exist the
    //     moment they sign in, not only after /setup. BEST-EFFORT (login already
    //     succeeded — a lookup/D1 fault must not block sign-in) + idempotent
    //     (linkAccountTenant is ON CONFLICT DO NOTHING, so it never downgrades an
    //     existing admin link to member).
    try {
      const installationIds = await listUserInstallationIds(accessToken)
      const linkNowIso = new Date().toISOString()
      for (const installationId of installationIds) {
        await linkAccountTenant(env.SIGILIX_PLATFORM_DB, {
          githubUserId: String(user.id),
          installationId,
          role: "member",
          nowIso: linkNowIso,
        })
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "login-link-account-tenant-failed",
          err: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  // 6. Mint session + encrypt token + store. `remember` (default persistent)
  //    was carried from the login form through the single-use KV state record.
  const remember = stateRaw.remember !== false
  const sessionId = mintSessionId()
  await createSession({
    kv: env.OPENCLAW_STATE,
    sessionId,
    login: user.login,
    githubUserId: user.id,
    accessToken,
    provider: "github",
    remember,
    encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY!,
    // exactOptionalPropertyTypes: omit each key entirely when absent.
    ...(tokenSet?.refreshToken !== undefined ? { refreshToken: tokenSet.refreshToken } : {}),
    ...(tokenSet?.accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt: tokenSet.accessTokenExpiresAt } : {}),
    ...(tokenSet?.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt } : {}),
    ...(displayName !== undefined ? { name: displayName } : {}),
    ...(identityUserId !== undefined ? { userId: identityUserId } : {}),
    ...(identityEmail !== undefined ? { email: identityEmail } : {}),
  })

  await writeAuthEvent(env.OPENCLAW_STATE, {
    kind: "callback_success",
    provider: "github",
    githubUserId: user.id,
    sessionId,
    ts: Date.now(),
  })

  // 7. 302 to redirectAfter (validated) or the default success destination.
  //
  // Redirect polish (env-gated, SIG-155 slice 3): when OPENCLAW_PORTAL_URL
  // is set, the DEFAULT destination (no explicit redirectAfter requested at
  // kickoff) becomes the portal's own /setup page instead of this Worker's
  // /auth/welcome — an intentional, absolute CROSS-ORIGIN 302. That's safe
  // here because it's a top-level browser navigation (not a fetch/XHR), so
  // no CORS is involved, and the destination is operator config
  // (OPENCLAW_PORTAL_URL), never user input. It deliberately bypasses
  // safeRedirectAfter, which exists to stop an ATTACKER-SUPPLIED
  // redirectAfter from escaping this Worker's own origin — it was never
  // meant to constrain OUR OWN fallback. An explicit redirectAfter (when
  // present) is untouched by this and keeps going through
  // safeRedirectAfter exactly as before. When OPENCLAW_PORTAL_URL is unset,
  // this whole branch is inert and behavior is byte-identical to before.
  const portalUrl = env.OPENCLAW_PORTAL_URL
  const dest = stateRaw.redirectAfter ?? (portalUrl ? `${portalUrl}/setup` : "/auth/welcome")
  const finalDest = stateRaw.redirectAfter ? safeRedirectAfter(dest, baseUrl(env)) : dest

  const headers = new Headers({ location: finalDest })
  headers.append("set-cookie", setSessionCookie(sessionId, remember))
  headers.append("set-cookie", clearStateCookie())

  return new Response(null, { status: 302, headers })
}

// ─── redirect-after validation (Codex catch on Phase 5 v1) ──────────

export function safeRedirectAfter(raw: string | undefined, baseUrlStr: string): string {
  const fallback = "/auth/welcome"
  if (!raw) return fallback
  // Reject scheme-relative URLs (`//evil.com`), backslash variants, NUL,
  // and absolute URLs (`https://...`, `javascript:...`).
  if (raw.startsWith("//") || raw.includes("\\") || raw.includes("\0") || !raw.startsWith("/")) {
    return fallback
  }
  // Reject encoded slashes / backslashes / NUL — middleware in front of
  // the Worker may percent-decode the path, turning `/%2f%2fevil.com`
  // into `//evil.com` (scheme-relative) before a redirect lands. Block
  // the encoded form at the validator.
  if (/%2[Ff]|%5[Cc]|%00/.test(raw)) return fallback
  let parsed: URL
  try {
    parsed = new URL(raw, baseUrlStr)
  } catch {
    return fallback
  }
  if (parsed.origin !== new URL(baseUrlStr).origin) return fallback
  return parsed.pathname + parsed.search + parsed.hash
}

// ─── auth event telemetry ───────────────────────────────────────────

const AUTH_EVENT_KV_PREFIX = "auth_event:"
const AUTH_EVENT_TTL_SECONDS = 24 * 60 * 60

export type AuthEvent =
  | { kind: "kickoff"; provider: "github"; ts: number }
  | {
      kind: "callback_success"
      provider: "github"
      githubUserId: number
      sessionId: string
      ts: number
    }
  | {
      kind: "callback_failed"
      provider: "github"
      reason: "state_mismatch" | "state_invalid" | "code_exchange_failed" | "user_fetch_failed"
      ts: number
    }
  | { kind: "logout"; sessionId: string; ts: number }

export async function writeAuthEvent(kv: KVNamespace, event: AuthEvent): Promise<void> {
  const sessionId = event.kind === "callback_success" ? event.sessionId : event.kind === "logout" ? event.sessionId : ""
  // Reverse-timestamp key prefix so newest entries list first under
  // wrangler kv key list (same convention as ensemble-review-telemetry).
  const reverseTs = base64urlEncode(new TextEncoder().encode(String(Number.MAX_SAFE_INTEGER - event.ts)))
  const key = `${AUTH_EVENT_KV_PREFIX}${reverseTs}:${sessionId}`
  try {
    await kv.put(key, JSON.stringify(event), { expirationTtl: AUTH_EVENT_TTL_SECONDS })
  } catch (e) {
    // Telemetry write failures must never block the auth flow.
    console.error("auth event write failed", { error: String(e), kind: event.kind })
  }
}

// ─── /auth/logout ───────────────────────────────────────────────────

export async function handleLogout(_request: Request, _env: AuthOauthEnv, sessionId: string | null): Promise<Response> {
  if (sessionId) {
    try {
      await _env.OPENCLAW_STATE.delete(`auth_session:${sessionId}`)
      await writeAuthEvent(_env.OPENCLAW_STATE, {
        kind: "logout",
        sessionId,
        ts: Date.now(),
      })
    } catch (e) {
      console.error("logout cleanup failed", { error: String(e) })
    }
  }
  // 204 (not a 302 redirect): the portal calls this cross-origin via
  // `fetch(..., { credentials: "include" })` and handles navigation itself.
  // A redirect would send the fetch to this Worker's "/" — a cross-origin hop
  // with no CORS grant that rejects the portal's fetch. A bodyless 204 carrying
  // the clear-cookie lets the browser drop the session cookie and the fetch
  // resolve cleanly. The caller wraps this with withPortalCors so the
  // credentialed response is actually accepted (see auth-routes.ts).
  //
  // sig-relogin-session-fix: clear BOTH the session cookie AND the OAuth state
  // cookie. Previously only the session cookie was cleared, so a leftover state
  // cookie (from an interrupted kickoff) could survive a same-tab logout into the
  // next login round-trip and desync the callback's browser-binding check. Clearing
  // both leaves a logged-out tab with the same clean cookie jar as a fresh
  // incognito tab — so a same-tab logout→login behaves identically to incognito.
  const headers = new Headers()
  headers.append("set-cookie", clearSessionCookie())
  headers.append("set-cookie", clearStateCookie())
  return new Response(null, { status: 204, headers })
}
