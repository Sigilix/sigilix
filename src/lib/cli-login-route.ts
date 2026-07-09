// sig-cli-login — the Worker half of `sigilix login` (the browser/loopback CLI
// auth flow, gh-auth-login-web pattern). Three endpoints:
//
//   POST /v1/cli/authorize  — SESSION-authed (the portal's /cli/authorize page
//                             calls it on Approve, credentials:include). Mints a
//                             per-user API key against the caller's own
//                             account_tenant installation and binds it to a
//                             single-use one-time code + the CLI's PKCE
//                             challenge + state. Returns ONLY the code (never
//                             the key) so the key never rides a redirect URL.
//   POST /v1/cli/exchange   — PUBLIC (the CLI's loopback listener calls it). Trades
//                             the one-time code (+ the PKCE verifier + state) for
//                             the API key exactly once. Read-then-delete single
//                             use; PKCE S256 + state verified before the key is
//                             returned, so an intercepted code alone is useless.
//   GET  /v1/cli/me         — BEARER-authed (the CLI's stored key). Returns the
//                             caller's plan + the cli_byok entitlement (computed
//                             from the SHARED entitlements policy) so `whoami`
//                             can show the tier and the CLI can gate BYOK.
//
// REUSE, not a parallel system: the key is minted with the SAME
// mintApiKeyPlaintext + insertApiKey + account_tenant trust link the GitHub-App
// /setup flow and POST /v1/keys use, and it authenticates via the SAME
// resolveApiKey bearer path every /v1/* route already uses. The plan is the SAME
// per-installation tenant.tier the entitlements gate reads, and cli_byok is the
// SAME isFeatureEntitled policy the README pins as the CLI's display gate.
//
// SECURITY:
//   - The one-time code is single-use (read-then-delete) + short-lived (KV TTL,
//     5 min) + bound to the CLI's state and PKCE challenge.
//   - PKCE S256: the CLI keeps the verifier local and only ever sends the
//     challenge through the browser; a code interceptor can't exchange without
//     the verifier.
//   - The plaintext key is returned exactly once, in the exchange response BODY
//     (never a query string), and is never logged.
//   - Minting requires an authenticated session that can access the
//     installation. The fast path is an existing account_tenant link (the
//     /setup flow / POST /v1/keys); when none exists (the ORG-OWNER/MEMBER case
//     — the App is installed on the user's ORG, not their personal account) we
//     resolve + persist it LIVE from GitHub's `GET /user/installations` (which
//     returns org installs the caller can access). A session with NO visible
//     installation is refused (409), never minted against an install the
//     caller's own token can't see.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { base64urlEncode } from "@/src/lib/auth-session"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { handlePortalPreflight, hasJsonContentType, withPortalCors } from "@/src/lib/portal-cors"
import { getInstallationsForUser, insertApiKey, linkAccountTenant, mintApiKeyPlaintext } from "@/src/lib/api-key-store"
import { listAppInstallations, listOrgMemberIds } from "@/src/shared/adapters/github/github-app"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { isFeatureEntitled, readInstallationPlan, upsellFor } from "@/src/features/entitlements"
import type { Env } from "@/src/shared/types/env"

const CLI_CODE_KV_PREFIX = "cli_login_code:"
const CLI_CODE_TTL_SECONDS = 300 // 5 minutes — a browser hop, not a session.
const CLI_KEY_NAME = "Sigilix CLI"

// Defensive pagination cap on the live GET /user/installations fallback —
// mirrors auth-setup-route.ts / org-overview-route.ts. Real users never approach
// it; hitting it means something's wrong upstream, not that we should spin.
const MAX_INSTALLATION_PAGES = 20

// Defensive length bounds on the CLI-supplied opaque nonces so a malformed
// caller can't push oversized values into KV. Both are base64url-ish tokens the
// CLI mints from 32 random bytes (~43 chars); the caps are generous headroom.
const MAX_NONCE_LEN = 512
const MIN_NONCE_LEN = 16

interface CliCodeRecord {
  keyPlaintext: string
  login: string
  installationId: number
  state: string
  challenge: string
  createdAt: number
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function readString(body: unknown, field: string): string | null {
  if (body == null || typeof body !== "object") return null
  const raw = (body as Record<string, unknown>)[field]
  return typeof raw === "string" ? raw : null
}

/** A CLI nonce (state / challenge / verifier / code) within the length bounds. */
function isValidNonce(value: string | null): value is string {
  return value != null && value.length >= MIN_NONCE_LEN && value.length <= MAX_NONCE_LEN
}

/** PKCE S256: base64url(SHA-256(verifier)) — the value the CLI sent as `challenge`. */
async function computeS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64urlEncode(new Uint8Array(digest))
}

/** Constant-time string compare (equal-length short nonces). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, 405)
}

/**
 * Owns the entire `/v1/cli/*` namespace (wired once in index.ts). `/authorize`
 * is the portal's browser call, so it handles its OWN preflight + CORS-with-
 * credentials here (never in the shared isPortalCorsPath list); `/exchange` and
 * `/me` are called by the CLI directly (Node — one-time code / bearer), so they
 * carry no CORS. An unknown subpath 404s; a wrong method 405s.
 */
export async function tryHandleCliLoginRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/v1/cli/authorize") {
    if (request.method === "OPTIONS") return handlePortalPreflight(request, env)
    if (request.method === "POST") return withPortalCors(request, await handleCliAuthorizeRoute(request, env, ctx), env)
    return methodNotAllowed()
  }
  if (url.pathname === "/v1/cli/exchange") {
    if (request.method === "POST") return handleCliExchangeRoute(request, env)
    return methodNotAllowed()
  }
  if (url.pathname === "/v1/cli/me") {
    if (request.method === "GET") return handleCliMeRoute(request, env, ctx)
    return methodNotAllowed()
  }
  return json({ error: "not_found" }, 404)
}

/**
 * POST /v1/cli/authorize — session-authed. The portal calls this on Approve; it
 * mints the CLI's key and returns a one-time code bound to the CLI's PKCE
 * challenge + state. See the file header.
 */
export async function handleCliAuthorizeRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  // CSRF guard — SameSite=None session cookie (see portal-cors.ts / auth-session.ts).
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  // Keys are keyed by github_user_id (account_tenant / api_key.created_by). A
  // non-GitHub session (Google/GitLab/password) has no GitHub identity to mint
  // an installation-bound key for — same 403 as POST /v1/keys.
  if (authed.record.githubUserId == null) return json({ error: "github_account_required" }, 403)

  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)
  const db = env.SIGILIX_PLATFORM_DB

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const state = readString(body, "state")
  const challenge = readString(body, "challenge")
  if (!isValidNonce(state) || !isValidNonce(challenge)) {
    return json({ error: "state and challenge are required" }, 400)
  }

  // Bind the key to the SAME account_tenant installation the /setup flow linked.
  const githubUserId = String(authed.record.githubUserId)
  const installations = await getInstallationsForUser(db, githubUserId)
  let installationId = installations[0]
  // No D1 account_tenant link yet? That's the ORG-OWNER/MEMBER case
  // (sig-cli-login-org): the GitHub App is installed on the user's ORG (not
  // their personal account), so the per-user /setup link was never written even
  // though they can legitimately use that installation. Resolve it LIVE from
  // GitHub — `GET /user/installations` returns BOTH personal AND org installs
  // the caller can access — then persist the link so the next login is fast. If
  // the user genuinely has NO visible installation, we still refuse (409); we
  // never mint against an installation the caller's token can't see.
  if (installationId === undefined) {
    installationId = await resolveInstallationLive(env, authed, githubUserId, db)
  }
  if (installationId === undefined) {
    return json({ error: "no_installation" }, 409)
  }

  const plaintext = mintApiKeyPlaintext()
  const keyHash = await sha256Hex(plaintext)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await insertApiKey(db, { id, keyHash, installationId, createdBy: githubUserId, nowIso: now, name: CLI_KEY_NAME })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-authorize-mint-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "mint_failed" }, 500)
  }

  // The one-time code. Random + high-entropy; the CLI never sees the key until it
  // trades this code (with the matching verifier + state) at /v1/cli/exchange.
  const code = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const record: CliCodeRecord = {
    keyPlaintext: plaintext,
    login: authed.record.login,
    installationId,
    state,
    challenge,
    createdAt: Date.now(),
  }
  try {
    await env.OPENCLAW_STATE.put(`${CLI_CODE_KV_PREFIX}${code}`, JSON.stringify(record), {
      expirationTtl: CLI_CODE_TTL_SECONDS,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-authorize-code-store-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "authorize_failed" }, 500)
  }

  // Only the code + the display login leave here — never the key.
  return json({ code, login: authed.record.login }, 200)
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: Array<{ id?: number }>
}

/**
 * Every installation id the session's GitHub user-to-server token can see via
 * `GET /user/installations` — which includes BOTH the caller's PERSONAL installs
 * AND every ORG install they're an owner/member of. FAILS SOFT to [] on any
 * network/HTTP/JSON error so the caller cleanly refuses (409) rather than
 * minting against an unverified installation. Never logs the token.
 */
async function fetchVisibleInstallationIds(accessToken: string): Promise<number[]> {
  const ids: number[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "sigilix-worker",
        },
      })
    } catch {
      return []
    }
    if (!res.ok) return []
    let body: UserInstallationsResponse
    try {
      body = (await res.json()) as UserInstallationsResponse
    } catch {
      return []
    }
    const installs = Array.isArray(body.installations) ? body.installations : []
    for (const inst of installs) {
      if (typeof inst.id === "number") ids.push(inst.id)
    }
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return ids
}

/**
 * Path 1 (user-token): the installation the session's OWN GitHub user-to-server
 * token can see via `GET /user/installations`. Cheap + covers the common case,
 * but DEPENDS on a usable user token — a session whose short-lived App user
 * token has expired without refresh material (a reused/legacy browser session)
 * returns [] here. FAILS SOFT to undefined. Never logs the token.
 */
async function resolveInstallationViaUserToken(env: Env, authed: AuthedSession): Promise<number | undefined> {
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "cli-authorize-live-install-encryption-key-missing" }))
    return undefined
  }
  // Refresh the (short-lived) GitHub App user token before the lookup — a stale
  // token 401s /user/installations and would falsely read as "no installation"
  // for an org owner (mirrors auth-me-route.ts).
  const accessToken = await getValidGithubToken({
    env,
    sessionId: authed.sessionId,
    record: authed.record,
    encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
  })
  return (await fetchVisibleInstallationIds(accessToken))[0]
}

/**
 * Path 2 (app server-to-server): resolve the install from the caller's IMMUTABLE
 * numeric GitHub id using the App's OWN credentials (JWT → `GET /app/installations`,
 * then the installation token → `GET /orgs/{org}/members`). This is the ROBUST
 * path — it does NOT depend on the user's OAuth token being fresh (the real
 * production failure: an org owner whose reused session carried an expired,
 * unrefreshable user token, so path 1 returned []). Uses the SAME App credential
 * the review pipeline uses, so it's reliably configured. Resolves:
 *   • a PERSONAL install whose account id == the caller's github id, or
 *   • an ORG install whose member roster contains the caller's github id.
 * Matching is by the IMMUTABLE numeric id (never the mutable login), so a stale
 * session carrying a renamed/reused handle can't bind the wrong account. FAILS
 * SOFT to undefined (app unconfigured / GitHub error / no match).
 */
async function resolveInstallationViaApp(env: Env, githubUserId: number): Promise<number | undefined> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !env.OPENCLAW_STATE || !Number.isSafeInteger(githubUserId)) {
    return undefined
  }
  const { items: installs } = await listAppInstallations(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY)

  // Personal install owned by the caller — a direct account-id match, no roster call.
  for (const inst of installs) {
    if (inst.accountType === "User" && inst.accountId === githubUserId) return inst.id
  }
  // Org install where the caller is a member — verified server-side via the App's
  // "Members" org read permission (same credential the org page uses), matched on
  // the immutable member id, so it works even when the caller's own token has no
  // org visibility.
  for (const inst of installs) {
    if (inst.accountType !== "Organization" || inst.accountLogin === "") continue
    const roster = await listOrgMemberIds(
      env.OPENCLAW_STATE,
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      inst.id,
      inst.accountLogin,
    )
    if (roster.items.includes(githubUserId)) return inst.id
  }
  return undefined
}

/**
 * Resolve the installation to mint the CLI key against when the caller has NO
 * account_tenant link yet — the ORG-OWNER/MEMBER case (sig-cli-login-org). Tries
 * the cheap user-token path first, then the ROBUST App server-to-server path
 * (which is what actually fixes the production failure: a reused session whose
 * user token had expired without refresh material). On success, persists the
 * account_tenant link (idempotent) so subsequent logins take the fast D1 path.
 * FAILS SOFT to undefined so the caller cleanly refuses (409); we never mint
 * against an installation the caller has no verified relationship to. Never logs
 * the token.
 *
 * TRUST MODEL (deliberate): the proof required is a VERIFIED relationship to the
 * install — either it is visible to the caller's own user-to-server token (the
 * same visibility-based check the /setup flow uses, auth-setup-route.ts
 * `userControlsInstallation`), or the caller's immutable GitHub id is in the
 * org's member roster (server-verified via the App). This matches /setup: any
 * org member who can access the install resolves; it is NOT admin-gated. We link
 * with the placeholder DEFAULT_ROLE "owner"; portal admin/member gating is NOT
 * read from this row — it is re-derived LIVE from GitHub per request
 * (resolve-user-role.ts `isAdminOfInstallation`), so a plain member linked here
 * is still gated to member-scoped data in the portal.
 */
async function resolveInstallationLive(
  env: Env,
  authed: AuthedSession,
  githubUserId: string,
  db: D1Database,
): Promise<number | undefined> {
  try {
    let installationId = await resolveInstallationViaUserToken(env, authed)
    if (installationId === undefined && authed.record.githubUserId != null) {
      // User-token path found nothing (expired/unrefreshable session token, or
      // no org visibility) — fall back to the App's own credentials, matched on
      // the caller's immutable numeric GitHub id.
      installationId = await resolveInstallationViaApp(env, authed.record.githubUserId)
    }
    if (installationId === undefined) return undefined
    // Persist the trust link (idempotent — mirrors the /setup DEFAULT_ROLE).
    await linkAccountTenant(db, { githubUserId, installationId, role: "owner", nowIso: new Date().toISOString() })
    return installationId
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-authorize-live-install-resolve-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return undefined
  }
}

/**
 * POST /v1/cli/exchange — PUBLIC. The CLI's loopback listener trades the one-time
 * code (+ PKCE verifier + state) for the API key, exactly once. See the header.
 */
export async function handleCliExchangeRoute(request: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const code = readString(body, "code")
  const state = readString(body, "state")
  const verifier = readString(body, "verifier")
  if (!isValidNonce(code) || !isValidNonce(state) || !isValidNonce(verifier)) {
    return json({ error: "code, state and verifier are required" }, 400)
  }

  // Single-use: read-then-delete up front so a code can never be replayed even
  // if a later step fails. A concurrent second exchange either loses the race
  // (record already gone → invalid) or reads the same record but only one delete
  // matters — the code is single-use from the first read's perspective.
  const kvKey = `${CLI_CODE_KV_PREFIX}${code}`
  const record = (await env.OPENCLAW_STATE.get(kvKey, "json")) as CliCodeRecord | null
  if (!record) {
    return json({ error: "invalid_or_expired_code" }, 400)
  }
  await env.OPENCLAW_STATE.delete(kvKey)

  // State must match the value the CLI generated and the portal echoed back.
  if (!timingSafeEqualStr(record.state, state)) {
    return json({ error: "state_mismatch" }, 400)
  }

  // PKCE S256: the presented verifier must hash to the stored challenge.
  const expected = await computeS256Challenge(verifier)
  if (!timingSafeEqualStr(record.challenge, expected)) {
    return json({ error: "pkce_verification_failed" }, 400)
  }

  // Plan + entitlement for the CLI to cache (whoami + the cli_byok display gate).
  const { plan, entitlements } = await resolvePlanAndEntitlements(env, record.installationId)

  // The plaintext key is returned exactly once here, in the body (never a URL).
  return json(
    {
      key: record.keyPlaintext,
      login: record.login,
      installationId: record.installationId,
      plan,
      entitlements,
      upsell: { cli_byok: upsellFor("cli_byok") },
    },
    200,
  )
}

/**
 * GET /v1/cli/me — bearer-authed. The CLI hits this on `whoami` and at the start
 * of key commands (short-TTL cached) so a plan change is picked up. Returns the
 * caller's plan + the cli_byok entitlement computed from the SHARED policy.
 */
export async function handleCliMeRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const apiAuth = await requireApiTenant(request, env, ctx)
  if ("response" in apiAuth) return apiAuth.response // 401

  const { plan, entitlements } = await resolvePlanAndEntitlements(env, apiAuth.caller.installationId)
  return json(
    {
      installationId: apiAuth.caller.installationId,
      plan,
      entitlements,
      upsell: { cli_byok: upsellFor("cli_byok") },
    },
    200,
  )
}

/**
 * Resolve the installation's plan + the cli_byok entitlement, both from the
 * SHARED entitlements domain (tenant.tier + isFeatureEntitled). Fail-soft: a plan
 * lookup fault yields `plan: null`, and — recall-safety — `cli_byok: false` (the
 * LESS-privileged BYOK behavior on an unknown plan), never a guessed paid tier.
 */
async function resolvePlanAndEntitlements(
  env: Env,
  installationId: number,
): Promise<{ plan: string | null; entitlements: { cli_byok: boolean } }> {
  let plan: string | null = null
  try {
    plan = await readInstallationPlan(env, installationId)
  } catch (error) {
    // Unknown plan → un-entitled (isFeatureEntitled fails closed on null).
    console.warn(
      JSON.stringify({
        event: "cli-me-plan-lookup-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    plan = null
  }
  return { plan, entitlements: { cli_byok: isFeatureEntitled(plan, "cli_byok") } }
}
