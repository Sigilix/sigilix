// sig-cli-login — the Worker half of `sigilix login` (the browser/loopback CLI
// auth flow, gh-auth-login-web pattern). Three endpoints:
//
//   POST /v1/cli/authorize  — SESSION-authed (the portal's /cli/authorize page
//                             calls it on Approve, credentials:include). Checks
//                             exact installation access and returns a sealed,
//                             short-lived grant bound to the CLI's PKCE
//                             challenge + state. No API key exists yet.
//   POST /v1/cli/exchange   — PUBLIC (the CLI's loopback listener calls it). Trades
//                             the sealed grant (+ the PKCE verifier + state) for
//                             an API key exactly once. The grant's fixed key id
//                             is atomically claimed in D1 before plaintext is
//                             returned, so an intercepted code alone is useless.
//   GET  /v1/cli/me         — BEARER-authed (the CLI's stored key). Returns the
//                             caller's plan + the cli_byok entitlement (computed
//                             from the SHARED entitlements policy) so `whoami`
//                             can show the tier and the CLI can gate BYOK.
//
// REUSE, not a parallel system: the key uses the SAME plaintext/hash shape and
// api_key table as /setup and POST /v1/keys, and it authenticates via the SAME
// resolveApiKey bearer path every /v1/* route already uses. The plan is the SAME
// per-installation tenant.tier the entitlements gate reads, and cli_byok is the
// SAME isFeatureEntitled policy the README pins as the CLI's display gate.
//
// SECURITY:
//   - The grant is AES-GCM authenticated/encrypted, five-minute-lived, and bound
//     to the CLI's state + PKCE challenge. It contains no API-key plaintext and
//     is not persisted server-side.
//   - PKCE S256: the CLI keeps the verifier local and only ever sends the
//     challenge through the browser; a code interceptor can't exchange without
//     the verifier.
//   - The grant fixes a random api_key PRIMARY KEY. Concurrent/replayed exchanges
//     can race, but only the one D1 INSERT winner receives its in-memory key.
//   - The plaintext key is minted only at exchange and returned once in the
//     response BODY (never a query string); it is never stored or logged.
//   - Minting requires an authenticated session that can access the
//     exact installation through requireOrgAccess. The durable user identity
//     and exact account_tenant row are lifecycle markers during exchange, not
//     role grants. Managed mode additionally requires active exact org access.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { base64urlDecode, base64urlEncode, decryptAccessToken, encryptAccessToken } from "@/src/lib/auth-session"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { requireOrgAccess } from "@/src/lib/org-access"
import { findByGithubUserId } from "@/src/lib/user-identity-store"
import { handlePortalPreflight, hasJsonContentType, withPortalCors } from "@/src/lib/portal-cors"
import {
  claimCliApiKey,
  getInstallationsForUser,
  linkAccountTenant,
  mintApiKeyPlaintext,
} from "@/src/lib/api-key-store"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { isFeatureEntitled, readInstallationPlan, upsellFor } from "@/src/features/entitlements"
import type { Env } from "@/src/shared/types/env"

const CLI_GRANT_AAD_SEED = "sigilix-cli-grant:v1"
const CLI_GRANT_TTL_MS = 5 * 60 * 1000 // A browser hop, not a session.
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
const MIN_GRANT_CODE_LEN = 48
const MAX_GRANT_CODE_LEN = 4096
const MAX_LOGIN_LEN = 256

interface CliGrant {
  keyId: string
  accountUserId: string
  createdBy: string
  login: string
  installationId: number
  state: string
  challenge: string
  createdAt: number
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
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

function isValidGrantCode(value: string | null): value is string {
  return value != null && value.length >= MIN_GRANT_CODE_LEN && value.length <= MAX_GRANT_CODE_LEN
}

type InstallationSelection = { kind: "absent" } | { kind: "valid"; installationId: number } | { kind: "invalid" }

/** Preserve legacy omission while making any explicit selector strict. */
function readInstallationSelection(body: unknown): InstallationSelection {
  if (body == null || typeof body !== "object") return { kind: "absent" }
  const record = body as Record<string, unknown>
  if (!("installationId" in record)) return { kind: "absent" }
  const raw = record.installationId
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return { kind: "valid", installationId: raw }
  }
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw)) {
    const installationId = Number(raw)
    if (Number.isSafeInteger(installationId) && String(installationId) === raw) {
      return { kind: "valid", installationId }
    }
  }
  return { kind: "invalid" }
}

function validInstallationId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function validGithubUserId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function decodeCliGrant(value: unknown, nowMs: number): CliGrant | null {
  if (value == null || typeof value !== "object") return null
  const grant = value as Record<string, unknown>
  const ageMs = typeof grant.createdAt === "number" ? nowMs - grant.createdAt : Number.NaN
  if (
    !validUuid(grant.keyId) ||
    !validUuid(grant.accountUserId) ||
    !validGithubUserId(grant.createdBy) ||
    !validInstallationId(grant.installationId) ||
    typeof grant.login !== "string" ||
    grant.login.length === 0 ||
    grant.login.length > MAX_LOGIN_LEN ||
    !isValidNonce(typeof grant.state === "string" ? grant.state : null) ||
    !isValidNonce(typeof grant.challenge === "string" ? grant.challenge : null) ||
    typeof grant.createdAt !== "number" ||
    !Number.isSafeInteger(grant.createdAt) ||
    !Number.isSafeInteger(ageMs) ||
    ageMs < 0 ||
    ageMs > CLI_GRANT_TTL_MS
  ) {
    return null
  }
  return grant as unknown as CliGrant
}

async function sealCliGrant(grant: CliGrant, encryptionKey: string): Promise<string> {
  const sealed = await encryptAccessToken(JSON.stringify(grant), CLI_GRANT_AAD_SEED, encryptionKey)
  return `v1.${sealed.iv}.${sealed.ciphertext}`
}

async function openCliGrant(code: string, encryptionKey: string): Promise<CliGrant | null> {
  const match = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/.exec(code)
  if (!match) return null
  try {
    // Reject alternate non-canonical base64url spellings whose unused trailing
    // bits decode to the same authenticated bytes. One sealed grant has one
    // accepted string representation.
    if (base64urlEncode(base64urlDecode(match[1]!)) !== match[1]) return null
    if (base64urlEncode(base64urlDecode(match[2]!)) !== match[2]) return null
    const plaintext = await decryptAccessToken(
      { encryptedAccessToken: match[2]!, iv: match[1]! },
      CLI_GRANT_AAD_SEED,
      encryptionKey,
    )
    return decodeCliGrant(JSON.parse(plaintext), Date.now())
  } catch {
    return null
  }
}

function withPrivateNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "private, no-store")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
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
 * verifies exact installation access and returns a sealed grant bound to the
 * CLI's PKCE challenge + state. Key creation is deferred to exchange.
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

  const selection = readInstallationSelection(body)
  if (selection.kind === "invalid") return json({ error: "invalid_installation_id" }, 400)

  // Omission preserves the old default only for CLI versions that do not yet
  // send a selector. An explicit installation is exact and never substitutes a
  // legacy link or some other visible organization.
  const githubUserId = String(authed.record.githubUserId)
  let installationId: number | undefined
  if (selection.kind === "valid") {
    installationId = selection.installationId
  } else {
    const installations = await getInstallationsForUser(db, githubUserId)
    installationId = installations[0]
    if (installationId === undefined) installationId = await resolveInstallationViaUserToken(env, authed)
  }
  if (installationId === undefined) return json({ error: "no_installation" }, 409)

  // account_tenant role metadata is never authorization. The central guard
  // requires fresh visibility for this exact installation and, in managed mode,
  // active stored workspace access. Its exact row is written later only as the
  // account-liveness marker that account deletion removes atomically with keys.
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "member" })
  if (!access.ok) return withPrivateNoStore(access.response)
  if (access.githubUserId !== githubUserId) return json({ error: "forbidden" }, 403)

  // Bind the grant to the durable account UUID as well as the GitHub id. The
  // account-delete transaction removes this identity row; a later account
  // recreation gets a new UUID and cannot redeem an old five-minute grant.
  let accountUserId: string
  try {
    const identity = await findByGithubUserId(db, githubUserId)
    if (!identity || !validUuid(identity.userId)) return json({ error: "account_identity_required" }, 403)
    if (authed.record.userId != null && authed.record.userId !== identity.userId) {
      return json({ error: "forbidden" }, 403)
    }
    accountUserId = identity.userId
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-authorize-identity-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "authorize_failed" }, 500)
  }

  // Preserve the historical lookup link for older readers, but only after the
  // real exact-installation guard succeeds.
  try {
    await linkAccountTenant(db, {
      githubUserId,
      installationId,
      role: "owner",
      nowIso: new Date().toISOString(),
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-authorize-link-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "authorize_failed" }, 500)
  }

  const encryptionKey = env.OPENCLAW_SESSION_ENCRYPTION_KEY
  if (!encryptionKey) return json({ error: "misconfigured" }, 503)
  const grant: CliGrant = {
    keyId: crypto.randomUUID(),
    accountUserId,
    createdBy: githubUserId,
    login: access.login,
    installationId,
    state,
    challenge,
    createdAt: Date.now(),
  }
  let code: string
  try {
    code = await sealCliGrant(grant, encryptionKey)
    if (!isValidGrantCode(code)) throw new Error("sealed CLI grant exceeds size bounds")
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-authorize-grant-seal-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "authorize_failed" }, 500)
  }

  // Only an authenticated encrypted grant + display login leave here. No API
  // key exists until the CLI proves PKCE possession at exchange.
  return json({ code, login: access.login }, 200)
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

/** Resolve the legacy default only from the caller's fresh user token. */
async function resolveInstallationViaUserToken(env: Env, authed: AuthedSession): Promise<number | undefined> {
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "cli-authorize-live-install-encryption-key-missing" }))
    return undefined
  }
  try {
    const accessToken = await getValidGithubToken({
      env,
      sessionId: authed.sessionId,
      record: authed.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
    return (await fetchVisibleInstallationIds(accessToken))[0]
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-authorize-user-install-resolve-failed",
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
  if (!isValidGrantCode(code) || !isValidNonce(state) || !isValidNonce(verifier)) {
    return json({ error: "code, state and verifier are required" }, 400)
  }

  const encryptionKey = env.OPENCLAW_SESSION_ENCRYPTION_KEY
  if (!encryptionKey || !env.SIGILIX_PLATFORM_DB) return json({ error: "exchange_unavailable" }, 503)
  const grant = await openCliGrant(code, encryptionKey)
  if (!grant) return json({ error: "invalid_or_expired_code" }, 400)

  // State must match the value the CLI generated and the portal echoed back.
  if (!timingSafeEqualStr(grant.state, state)) {
    return json({ error: "state_mismatch" }, 400)
  }

  // PKCE S256: the presented verifier must hash to the stored challenge.
  const expected = await computeS256Challenge(verifier)
  if (!timingSafeEqualStr(grant.challenge, expected)) {
    return json({ error: "pkce_verification_failed" }, 400)
  }

  // The plaintext exists only in this exchange invocation. The sealed grant's
  // fixed PRIMARY KEY is the atomic single-use claim: concurrent/replayed calls
  // can validate PKCE, but only changes=1 may receive its matching plaintext.
  const plaintext = mintApiKeyPlaintext()
  const keyHash = await sha256Hex(plaintext)
  let claim: Awaited<ReturnType<typeof claimCliApiKey>>
  try {
    claim = await claimCliApiKey(env.SIGILIX_PLATFORM_DB, {
      id: grant.keyId,
      keyHash,
      installationId: grant.installationId,
      createdBy: grant.createdBy,
      accountUserId: grant.accountUserId,
      nowIso: new Date().toISOString(),
      name: CLI_KEY_NAME,
      // Rollout-off intentionally preserves the legacy five-minute,
      // authorize-time live GitHub grant. Immediate member-removal invalidation
      // is guaranteed only once managed membership mode is on; external GitHub
      // roster changes still need the separate reconciliation path.
      requireActiveAccess: env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on",
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cli-exchange-key-claim-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "exchange_failed" }, 500)
  }
  if (claim === "already_claimed") return json({ error: "invalid_or_expired_code" }, 400)
  if (claim === "access_revoked") return json({ error: "access_revoked" }, 403)

  // Plan + entitlement for the CLI to cache (whoami + the cli_byok display gate).
  const { plan, entitlements } = await resolvePlanAndEntitlements(env, grant.installationId)

  // The plaintext key is returned exactly once here, in the body (never a URL).
  return json(
    {
      key: plaintext,
      login: grant.login,
      installationId: grant.installationId,
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
  if ("response" in apiAuth) return withPrivateNoStore(apiAuth.response) // 401

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
