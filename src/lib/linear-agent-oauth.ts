// Linear AGENT install — the actor=app authorization-code flow + agent-token store.
//
// Distinct from `linear-oauth.ts` (the client_credentials app-actor token used for
// comments + field updates). When a workspace admin installs Sigilix as a Linear
// AGENT, the browser is sent to GET /linear/install (which mints a CSRF nonce and
// 302s to Linear's `?actor=app` consent screen) and Linear redirects back to
// GET /linear/oauth/callback?code=...&state=... This module exchanges that code for
// the AGENT access token and stores it in OPENCLAW_STATE KV. That token — NOT the
// client_credentials token — carries the agent capability and is what
// `createAgentActivity` posts agent activities with.
//
// Security (mirrors src/lib/slack/slack-install.ts):
//   - CSRF: /linear/install stores a CSPRNG nonce in KV (10-min TTL); the callback
//     REQUIRES it, verifies it, and deletes it on use to prevent replays.
//   - redirect_uri is PINNED to OPENCLAW_GATEWAY_ISSUER (the same value in both the
//     authorize request and the token exchange so they byte-match), request origin
//     fallback only.
//   - Workspace allowlist: when OPENCLAW_LINEAR_ALLOWED_ORG_ID is set, only that org
//     may finish the install; unset → allowed + warned (so the founder's first
//     install isn't blocked).
//   - The authorization code, the client secret, and the access token are NEVER
//     logged. Only neutral status strings reach console on error.

import type { Env } from "@/src/shared/types/env"
import {
  commitAgentTokenToBroker,
  installAgentTokenToBroker,
  rollbackAgentTokenFromBroker,
  stageAgentTokenToBroker,
  type LinearTenantInstallReceipt,
  type LinearTokenScope,
} from "@/src/lib/linear-token-broker-client"
import { requireSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import {
  connectLinearOrganization,
  fetchLinearWorkspaceIdentity,
  getLinearConnectionByInstallation,
  getLinearConnectionByOrganization,
  listLinearInstallationRepos,
} from "@/src/features/linear-integration"

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token"
const AUTHORIZE_ENDPOINT = "https://linear.app/oauth/authorize"
const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql"

/** KV key holding the single workspace agent token (actor=app install). */
export const LINEAR_AGENT_TOKEN_KEY = "linear:agent-token"

/** KV nonce prefix for the CSRF state minted by /linear/install. */
const STATE_KV_PREFIX = "linear-oauth-state:"

/** CSRF nonce TTL — 10 minutes (matches slack-install). */
const STATE_TTL_SECONDS = 600

/** Scopes requested for the agent install. Comma-separated (Linear's format). */
const DEFAULT_INSTALL_SCOPES = "read,write,comments:create,issues:create,app:assignable,app:mentionable"

/** KV-stored agent token record. `scope` + `expiresAt` are captured for ops
 *  visibility; only `accessToken` is required to post agent activities. */
export interface LinearAgentTokenRecord {
  accessToken: string
  /** Immutable tenant metadata. Required for every organization-sharded broker
   * record; absent only on the pre-SIG-242 dogfood singleton record. */
  organizationId?: string
  installationId?: number
  actorType?: "app"
  appUserId?: string
  /** Internal broker generation used only to make a lost commit response
   * idempotent. It is never logged or sent to Linear. */
  installGeneration?: string
  /** The rotating refresh token (actor=app authorization_code tokens return one).
   *  Used by `refreshAgentToken` to mint a fresh 24h access token; rotated (and
   *  re-persisted) on every successful refresh. NEVER logged. */
  refreshToken?: string
  /** Space/comma-separated scopes Linear granted (e.g. "app:assignable app:mentionable"). */
  scope?: string
  /** ms epoch when the token expires, when Linear returns `expires_in`. */
  expiresAt?: number
  installedAt: number
}

/** Env slice the token-refresh path needs: the state KV (to read/persist the
 *  record) plus the OAuth creds (`resolveAgentOAuthCreds`). The credential
 *  fields are all optional on `Env`, so a caller passing only `OPENCLAW_STATE`
 *  still satisfies this type. */
export type AgentTokenEnv = Pick<
  Env,
  | "OPENCLAW_STATE"
  | "LINEAR_OAUTH_CLIENT_ID"
  | "LINEAR_OAUTH_CLIENT_SECRET"
  | "OPENCLAW_LINEAR_AGENT_CLIENT_ID"
  | "OPENCLAW_LINEAR_AGENT_CLIENT_SECRET"
>

/** Refresh ahead of expiry by this margin (10 min) so an in-flight agent
 *  activity never races a hard expiry. Generous for clock skew. Exported so the
 *  LinearTokenBroker DO uses the same headroom as the KV-backed path. */
export const REFRESH_BUFFER_MS = 10 * 60 * 1000

/** Fallback access-token lifetime used ONLY when a refresh response omits
 *  `expires_in` (Linear actor=app tokens are 24h). Without it the refreshed
 *  record would carry no `expiresAt`, which permanently disables proactive
 *  refresh — the token would then silently ride until it 401s. Exported so the
 *  LinearTokenBroker DO computes the same default expiry. */
export const FALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** Persist the agent token record under LINEAR_AGENT_TOKEN_KEY. */
export async function putLinearAgentToken(kv: KVNamespace, record: LinearAgentTokenRecord): Promise<void> {
  await kv.put(LINEAR_AGENT_TOKEN_KEY, JSON.stringify(record))
}

/** Read the stored agent access token, or null when none is installed / malformed. */
export async function getLinearAgentToken(kv: KVNamespace): Promise<string | null> {
  const raw = await kv.get(LINEAR_AGENT_TOKEN_KEY)
  if (raw === null) return null
  try {
    const record = JSON.parse(raw) as LinearAgentTokenRecord
    if (record && typeof record.accessToken === "string" && record.accessToken) {
      return record.accessToken
    }
  } catch {
    // Malformed record — treat as not-installed.
  }
  return null
}

/** Read + parse the FULL stored agent token record (accessToken + refreshToken +
 *  scope + expiresAt), or null when none is installed / malformed. The refresh
 *  path needs the whole record, not just the access token. */
async function readAgentTokenRecord(kv: KVNamespace): Promise<LinearAgentTokenRecord | null> {
  const raw = await kv.get(LINEAR_AGENT_TOKEN_KEY)
  if (raw === null) return null
  try {
    const record = JSON.parse(raw) as LinearAgentTokenRecord
    if (record && typeof record.accessToken === "string" && record.accessToken) {
      return record
    }
  } catch {
    // Malformed record — treat as not-installed.
  }
  return null
}

interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
  scope?: string | string[]
  /** Rotating refresh token returned with actor=app authorization_code (and
   *  refresh_token) grants. Linear issues a NEW one on every refresh. */
  refresh_token?: string
}

interface LinearTenantOAuthState {
  version: 1
  installationId: number
  userId: string
  login: string
  createdAt: number
}

function parseTenantOAuthState(raw: string): LinearTenantOAuthState | null {
  try {
    const value = JSON.parse(raw) as Partial<LinearTenantOAuthState>
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.installationId) ||
      Number(value.installationId) <= 0 ||
      typeof value.userId !== "string" ||
      !value.userId ||
      typeof value.login !== "string" ||
      !value.login ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt)
    ) {
      return null
    }
    return value as LinearTenantOAuthState
  } catch {
    return null
  }
}

function tenantOAuthStateIsFresh(state: LinearTenantOAuthState, nowMs = Date.now()): boolean {
  return state.createdAt <= nowMs && nowMs - state.createdAt <= STATE_TTL_SECONDS * 1000
}

function normalizeScopes(scope: TokenResponse["scope"]): string[] {
  const values = Array.isArray(scope) ? scope : typeof scope === "string" ? scope.split(/[\s,]+/) : []
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** Compute the OAuth redirect URI. PINNED to OPENCLAW_GATEWAY_ISSUER (the worker
 *  origin the Linear OAuth app is configured against) so /linear/install and the
 *  token exchange use the same value and cannot drift; falls back to the request
 *  origin only when the issuer env is unset. */
function linearRedirectUri(env: Pick<Env, "OPENCLAW_GATEWAY_ISSUER">, requestUrl: URL): string {
  const base = env.OPENCLAW_GATEWAY_ISSUER ?? requestUrl.origin
  return `${base}/linear/oauth/callback`
}

/** Resolve the OAuth credentials for the agent install (authorization_code flow).
 *  Prefers the dedicated agent-app credentials; falls back to the shared
 *  LINEAR_OAUTH_CLIENT_* pair so existing deployments need no new secrets.
 *  Exported so the LinearTokenBroker DO resolves creds from its worker env the
 *  same way. */
export function resolveAgentOAuthCreds(
  env: Pick<
    Env,
    | "LINEAR_OAUTH_CLIENT_ID"
    | "LINEAR_OAUTH_CLIENT_SECRET"
    | "OPENCLAW_LINEAR_AGENT_CLIENT_ID"
    | "OPENCLAW_LINEAR_AGENT_CLIENT_SECRET"
  >,
): { clientId: string | undefined; clientSecret: string | undefined } {
  return {
    clientId: env.OPENCLAW_LINEAR_AGENT_CLIENT_ID ?? env.LINEAR_OAUTH_CLIENT_ID,
    clientSecret: env.OPENCLAW_LINEAR_AGENT_CLIENT_SECRET ?? env.LINEAR_OAUTH_CLIENT_SECRET,
  }
}

/** Build the only new-install authorize URL. The state is not a bare nonce: its
 * KV value binds the approval to one GitHub installation and one authenticated
 * portal user, and the callback requires the same session before consuming it. */
export async function buildLinearTenantAuthorizeUrl(
  env: Pick<
    Env,
    "OPENCLAW_STATE" | "LINEAR_OAUTH_CLIENT_ID" | "OPENCLAW_LINEAR_AGENT_CLIENT_ID" | "OPENCLAW_GATEWAY_ISSUER"
  >,
  requestUrl: URL,
  stateValue: Omit<LinearTenantOAuthState, "version" | "createdAt">,
): Promise<string> {
  const state = crypto.randomUUID()
  const record: LinearTenantOAuthState = { version: 1, ...stateValue, createdAt: Date.now() }
  await env.OPENCLAW_STATE.put(`${STATE_KV_PREFIX}${state}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  })
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.OPENCLAW_LINEAR_AGENT_CLIENT_ID ?? env.LINEAR_OAUTH_CLIENT_ID ?? "",
    redirect_uri: linearRedirectUri(env, requestUrl),
    scope: DEFAULT_INSTALL_SCOPES,
    actor: "app",
    // Force the consent screen every time. Without this Linear short-circuits an
    // already-installed workspace to a "manage/cancel" screen and never issues a
    // fresh authorization code, so the callback that writes linear_connection
    // never fires — leaving the registry empty and the portal stuck on "Connect
    // app". prompt=consent re-issues a code on every reconnect (Linear docs:
    // "The consent screen is displayed every time, even if all scopes were
    // previously granted.").
    prompt: "consent",
    state,
  })
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`
}

/** POST /v1/org/:installationId/linear/install — session + exact-install admin gated. */
export async function handleLinearTenantInstall(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  const { clientId } = resolveAgentOAuthCreds(env)
  if (!clientId) return json({ error: "linear_oauth_not_configured" }, 503)
  const session = await requireSession(request, env, ctx)
  if (!session) return json({ error: "unauthorized" }, 401)
  if (session.record.githubUserId == null) return json({ error: "github_session_required" }, 403)
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) return json({ error: "misconfigured" }, 503)
  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch {
    return json({ error: "linear_install_failed" }, 500)
  }
  if (!(await isAdminOfInstallation(accessToken, session.record.login, installationId))) {
    return json({ error: "forbidden" }, 403)
  }
  const userId = session.record.userId ?? String(session.record.githubUserId)
  const authorizeUrl = await buildLinearTenantAuthorizeUrl(env, new URL(request.url), {
    installationId,
    userId,
    login: session.record.login,
  })
  return json({ authorizeUrl }, 200)
}

/** Closed compatibility symbol for callers compiled against the legacy public
 * install helper. It never mints a new bare-nonce OAuth authorization. */
export async function handleLinearInstall(_request: Request, _env: Env): Promise<Response> {
  return text("Use the installation-scoped portal Linear install flow.", 410)
}

/**
 * Resolve the installing workspace's organization id from the freshly-minted agent
 * token (for the OPENCLAW_LINEAR_ALLOWED_ORG_ID allowlist gate). Returns null on any
 * fault — the caller treats a null as a non-match when an allowlist is configured.
 * NEVER logs the token.
 */
async function fetchOrganizationId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query: "query { organization { id } }" }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { organization?: { id?: string } } }
    const id = json.data?.organization?.id
    return typeof id === "string" && id ? id : null
  } catch {
    return null
  }
}

/**
 * GET /linear/oauth/callback — finalize the actor=app agent install.
 *
 * Linear redirects here after the workspace admin approves the consent screen from
 * /linear/install. We verify the CSRF nonce, exchange the authorization code for the
 * AGENT access token, enforce the workspace allowlist, and store the token in KV; that
 * token is what `createAgentActivity` posts agent activities with.
 *
 * Order (mirrors slack-install): state present → state found in KV → code present →
 * delete nonce → exchange → allowlist → persist. The nonce is never consumed for a
 * missing-code 400 (replay-safe).
 *
 * The `redirect_uri` is PINNED to OPENCLAW_GATEWAY_ISSUER (the same value the authorize
 * request used) so the two byte-match; request origin is the fallback only.
 *
 * NEVER logs the code, the client secret, or the access token.
 */
export async function handleLinearOAuthCallback(request: Request, env: Env): Promise<Response> {
  const { clientId, clientSecret } = resolveAgentOAuthCreds(env)
  if (!clientId || !clientSecret) {
    return text("Linear OAuth is not configured.", 503)
  }

  const url = new URL(request.url)

  // Linear bounced the consent (denied / misconfig). Do NOT echo the raw error
  // value into the page; log it server-side for diagnosis.
  const authError = url.searchParams.get("error")
  if (authError) {
    console.error("linear oauth callback: authorize returned error", { error: authError })
    return text("Sigilix install was not completed. You can close this tab and try again.", 400)
  }

  // 1. CSRF state — REQUIRED + verified before the code exchange. /linear/install
  //    always mints a nonce, so a missing/unknown state is a forged or stale request.
  const state = url.searchParams.get("state")
  if (!state) {
    return text("Missing state.", 400)
  }
  const stateKey = `${STATE_KV_PREFIX}${state}`
  const stateValue = await env.OPENCLAW_STATE.get(stateKey)
  if (stateValue === null) {
    return text("Invalid or expired state.", 400)
  }
  const tenantState = parseTenantOAuthState(stateValue)
  // Structured states are bound to the SAME signed-in portal user who began
  // the installation. The literal legacy value "1" is accepted only as the
  // already-minted pre-SIG-242 dogfood callback seam; the new POST route never
  // writes it, so no new global install can be created through this branch.
  if (tenantState && !tenantOAuthStateIsFresh(tenantState)) {
    try {
      await env.OPENCLAW_STATE.delete(stateKey)
    } catch {
      // The explicit age check is repeated on every callback, so a failed
      // best-effort cleanup cannot make this state usable again.
    }
    return text("Invalid or expired state.", 400)
  }
  if (tenantState) {
    const session = await requireSession(request, env)
    const sessionUserId =
      session?.record.userId ?? (session?.record.githubUserId != null ? String(session.record.githubUserId) : null)
    if (!session || sessionUserId !== tenantState.userId || session.record.login !== tenantState.login) {
      return text("The Linear install must be completed by the user who started it.", 403)
    }
  } else if (stateValue !== "1") {
    return text("Invalid or expired state.", 400)
  }

  // 2. Code must be present before we consume the nonce (replay-safe: a missing
  //    code returns 400 WITHOUT deleting the nonce).
  const code = url.searchParams.get("code")
  if (!code) {
    return text("Missing authorization code.", 400)
  }

  // 3. Delete the nonce immediately to prevent replay.
  try {
    await env.OPENCLAW_STATE.delete(stateKey)
  } catch {
    console.error("linear oauth callback: failed to delete nonce")
    return text("Sigilix install failed during token exchange. Please try again.", 502)
  }

  const redirectUri = linearRedirectUri(env, url)
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  })

  // Single attempt only — authorization codes are single-use; retrying a consumed
  // code causes `invalid_grant` and poisons the install. Keep the AbortSignal for
  // a hard upper bound on hang time.
  let res: Response
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    console.error("linear oauth callback: network error during token exchange")
    return text("Sigilix install failed during token exchange. Please try again.", 502)
  }

  if (!res.ok) {
    // Body is Linear's error JSON (e.g. {"error":"...","error_description":"..."}).
    // It does NOT contain the submitted code — safe to log truncated for diagnosis.
    // Never log the body of a success response (it contains access_token).
    let errorBody = ""
    try {
      const raw = await res.text()
      errorBody = raw.slice(0, 300)
    } catch {
      // ignore — best-effort
    }
    console.error("linear oauth callback: non-2xx from token endpoint", {
      status: res.status,
      body: errorBody,
    })
    return text("Sigilix install failed during token exchange. Please try again.", 502)
  }

  let json: TokenResponse
  try {
    json = (await res.json()) as TokenResponse
  } catch {
    console.error("linear oauth callback: invalid JSON from token endpoint")
    return text("Sigilix install failed during token exchange. Please try again.", 502)
  }

  if (!json.access_token) {
    console.error("linear oauth callback: token response missing access_token")
    return text("Sigilix install failed during token exchange. Please try again.", 502)
  }

  if (tenantState) {
    return finalizeTenantLinearInstall(env, tenantState, json as TokenResponse & { access_token: string })
  }

  // Workspace allowlist. When OPENCLAW_LINEAR_ALLOWED_ORG_ID is set, the install must
  // come from that org — a neutral 403 + server log otherwise (before we persist the
  // token). Unset → allow but warn so the founder knows to lock it. NEVER logs the
  // token; the org id is a workspace identifier, not a credential.
  const allowedOrgId = env.OPENCLAW_LINEAR_ALLOWED_ORG_ID
  if (allowedOrgId) {
    const orgId = await fetchOrganizationId(json.access_token)
    if (orgId !== allowedOrgId) {
      console.error(
        JSON.stringify({
          event: "linear-agent-install-org-rejected",
          orgResolved: orgId !== null,
          // access token intentionally excluded
        }),
      )
      return text("This Linear workspace is not allowed to install Sigilix.", 403)
    }
  } else {
    console.warn(
      JSON.stringify({
        event: "linear-agent-install-no-org-allowlist",
        note: "OPENCLAW_LINEAR_ALLOWED_ORG_ID unset — install allowed; set it to lock to one workspace",
      }),
    )
  }

  const record: LinearAgentTokenRecord = {
    accessToken: json.access_token,
    installedAt: Date.now(),
  }
  // Capture the rotating refresh token so a later background refresh can mint a
  // fresh access token without a re-install. NEVER logged.
  if (typeof json.refresh_token === "string" && json.refresh_token) record.refreshToken = json.refresh_token
  const legacyScopes = normalizeScopes(json.scope)
  if (legacyScopes.length > 0) record.scope = legacyScopes.join(" ")
  if (typeof json.expires_in === "number") record.expiresAt = Date.now() + json.expires_in * 1000

  try {
    await putLinearAgentToken(env.OPENCLAW_STATE, record)
  } catch {
    console.error("linear oauth callback: failed to persist agent token")
    return text("Sigilix install failed while saving the install. Please try again.", 502)
  }

  // SIG-144 slice 2: bootstrap the LinearTokenBroker DO with the same record so
  // buildLinearAgentClient (which now reads through the broker, not KV) sees a
  // fresh install immediately. Best-effort / additive — KV (above) stays this
  // callback's source of truth and the install already succeeded, so a broker
  // bootstrap fault must NOT fail the response; it only means the broker stays
  // not-installed until the next successful install. `installAgentTokenToBroker`
  // itself never throws, but the call is still guarded here — defense in depth
  // for the one response in this flow that must always reach the user.
  let brokerInstalled = false
  try {
    brokerInstalled = await installAgentTokenToBroker(env, record)
  } catch {
    // fall through — brokerInstalled stays false, logged below
  }
  if (!brokerInstalled) {
    console.warn(JSON.stringify({ event: "linear-agent-broker-install-failed" }))
  }

  console.log(
    JSON.stringify({
      event: "linear-agent-installed",
      scopePresent: !!record.scope,
      hasExpiry: typeof record.expiresAt === "number",
      hasRefresh: !!record.refreshToken,
      brokerInstalled,
      // access_token / refresh_token / code / client_secret intentionally excluded
    }),
  )

  return htmlPage("Sigilix agent installed — you can close this tab.")
}

async function finalizeTenantLinearInstall(
  env: Env,
  state: LinearTenantOAuthState,
  token: TokenResponse & { access_token: string },
): Promise<Response> {
  const identity = await fetchLinearWorkspaceIdentity(token.access_token)
  if (!identity) return text("Sigilix could not verify this Linear workspace.", 502)
  if (!identity.viewer.app) return text("Sigilix requires a Linear actor=app installation.", 403)

  let byInstallation: Awaited<ReturnType<typeof getLinearConnectionByInstallation>>
  let byOrganization: Awaited<ReturnType<typeof getLinearConnectionByOrganization>>
  let repos: Awaited<ReturnType<typeof listLinearInstallationRepos>>
  try {
    ;[byInstallation, byOrganization, repos] = await Promise.all([
      getLinearConnectionByInstallation(env, state.installationId),
      getLinearConnectionByOrganization(env, identity.organization.id),
      listLinearInstallationRepos(env, state.installationId),
    ])
  } catch {
    // All D1 reads happen before the broker write, so an unavailable tenant
    // store cannot leave behind an orphaned access token.
    return text("Sigilix could not verify the tenant connection boundary.", 502)
  }
  if (
    (byInstallation &&
      byInstallation.status === "active" &&
      byInstallation.organizationId !== identity.organization.id) ||
    (byOrganization && byOrganization.status === "active" && byOrganization.installationId !== state.installationId)
  ) {
    return text("This GitHub installation or Linear workspace is already connected elsewhere.", 409)
  }

  const scopes = normalizeScopes(token.scope)
  const record: LinearAgentTokenRecord = {
    accessToken: token.access_token,
    organizationId: identity.organization.id,
    installationId: state.installationId,
    actorType: "app",
    appUserId: identity.viewer.id,
    installedAt: Date.now(),
  }
  if (typeof token.refresh_token === "string" && token.refresh_token) record.refreshToken = token.refresh_token
  if (scopes.length > 0) record.scope = scopes.join(" ")
  if (typeof token.expires_in === "number") record.expiresAt = Date.now() + token.expires_in * 1000

  const scope = { organizationId: identity.organization.id, installationId: state.installationId }
  const receipt: LinearTenantInstallReceipt = { generation: crypto.randomUUID() }
  if (!(await stageAgentTokenToBroker(env, scope, record, receipt))) {
    // The generation was created before the RPC. A transport error can mean the
    // stage committed but its response was lost, so always issue the guarded
    // rollback; it cannot touch a prior active token.
    await rollbackAgentTokenFromBroker(env, scope, receipt)
    return text("Sigilix could not safely store this tenant-scoped Linear install.", 502)
  }

  // A single-repo installation has an unambiguous default. Multi-repo installs
  // remain visibly unbound (repo id 0/name empty) until an admin explicitly maps
  // teams through the config API; consumers warn and refuse retrieval/writeback.
  const defaultRepo = repos.length === 1 ? repos[0] : undefined
  let connected: Awaited<ReturnType<typeof connectLinearOrganization>>
  try {
    connected = await connectLinearOrganization(env, {
      installationId: state.installationId,
      organizationId: identity.organization.id,
      organizationName: identity.organization.name,
      appUserId: identity.viewer.id,
      source: "oauth",
      grantedScopes: scopes,
      canAccessAllPublicTeams: false,
      installedByUserId: state.userId,
      installedByLogin: state.login,
      teams: identity.teams.map((team) => ({
        ...team,
        githubRepoId: defaultRepo?.id ?? 0,
        githubRepoFullName: defaultRepo?.fullName ?? "",
      })),
      nowIso: new Date().toISOString(),
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "linear-tenant-connection-write-failed",
        installationId: state.installationId,
        organizationId: identity.organization.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    await compensateTenantBrokerInstall(env, scope, receipt)
    return text("Sigilix could not persist the tenant connection. Please retry.", 502)
  }
  if (!connected.ok) {
    await rollbackAgentTokenFromBroker(env, scope, receipt)
    return text("This GitHub installation or Linear workspace is already connected elsewhere.", 409)
  }

  if (!(await commitAgentTokenToBroker(env, scope, receipt))) {
    // D1 is already authoritative. The staged record's broker alarm will
    // reconcile and promote it from that exact active link, but do not claim the
    // install completed synchronously when the commit RPC did not confirm.
    console.error(
      JSON.stringify({
        event: "linear-tenant-token-commit-deferred",
        organizationId: identity.organization.id,
        installationId: state.installationId,
      }),
    )
    return text(
      "Sigilix saved the tenant link but is still finalizing the Linear credential. Please retry shortly.",
      502,
    )
  }

  console.log(
    JSON.stringify({
      event: "linear-tenant-installed",
      organizationId: identity.organization.id,
      installationId: state.installationId,
      teamCount: identity.teams.length,
      teamsNeedRepoBinding: defaultRepo === undefined,
      hasRefresh: !!record.refreshToken,
      hasExpiry: typeof record.expiresAt === "number",
    }),
  )
  return htmlPage("Sigilix Linear integration connected — you can close this tab.")
}

/** Compensate a broker write only when D1 does not already contain the exact
 * active tenant link. The re-read handles an ambiguous D1 batch outcome: if
 * the batch committed before the transport threw, retaining the token avoids
 * creating the inverse active-connection/no-token inconsistency. */
async function compensateTenantBrokerInstall(
  env: Env,
  scope: LinearTokenScope,
  receipt: LinearTenantInstallReceipt,
): Promise<void> {
  let connection: Awaited<ReturnType<typeof getLinearConnectionByInstallation>>
  try {
    connection = await getLinearConnectionByInstallation(env, scope.installationId)
  } catch {
    console.error(
      JSON.stringify({
        event: "linear-tenant-token-compensation-deferred",
        organizationId: scope.organizationId,
        installationId: scope.installationId,
        reason: "d1-state-unknown-broker-alarm-will-reconcile",
      }),
    )
    return
  }
  if (
    connection?.status === "active" &&
    connection.organizationId === scope.organizationId &&
    connection.installationId === scope.installationId
  ) {
    const committed = await commitAgentTokenToBroker(env, scope, receipt)
    console.warn(
      JSON.stringify({
        event: "linear-tenant-token-compensation-retained",
        organizationId: scope.organizationId,
        installationId: scope.installationId,
        reason: committed ? "active-d1-link" : "active-d1-link-commit-deferred",
      }),
    )
    return
  }
  const removed = await rollbackAgentTokenFromBroker(env, scope, receipt)
  if (!removed) {
    console.error(
      JSON.stringify({
        event: "linear-tenant-token-compensation-failed",
        organizationId: scope.organizationId,
        installationId: scope.installationId,
      }),
    )
  }
}

/** Discriminated result of the refresh_token grant POST to Linear's token
 *  endpoint. Pure transport outcome — the caller owns persistence + telemetry, so
 *  the failure arm carries NO token material and this helper never logs. */
export type AgentTokenRefreshResult =
  | { ok: true; accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }
  | { ok: false; reason: "network" | "non-2xx" | "invalid-json" | "missing-access-token"; status?: number }

/**
 * Perform the refresh_token grant POST and parse the response — the shared
 * token-exchange transport reused by both `refreshAgentToken` (KV-backed) and the
 * `LinearTokenBroker` Durable Object (DO-storage-backed). It does NOT read or
 * persist any record and does NOT log: the caller owns persistence and telemetry.
 *
 * SINGLE attempt, no retry: refresh tokens are single-use, so retrying risks
 * double-rotation and invalidating the freshly-issued token. 15s AbortSignal upper
 * bound (mirrors the install callback). On a non-2xx the body is NOT read (it can
 * carry token material); the status code is surfaced instead.
 */
export async function performAgentTokenRefresh(
  refreshToken: string,
  creds: { clientId: string; clientSecret: string },
): Promise<AgentTokenRefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  })

  let res: Response
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    return { ok: false, reason: "network" }
  }

  // Status only — the response body can carry token material, so it is never read here.
  if (!res.ok) return { ok: false, reason: "non-2xx", status: res.status }

  let json: TokenResponse
  try {
    json = (await res.json()) as TokenResponse
  } catch {
    return { ok: false, reason: "invalid-json" }
  }

  if (!json.access_token) return { ok: false, reason: "missing-access-token" }

  const out: AgentTokenRefreshResult = { ok: true, accessToken: json.access_token }
  // Rotation: surface the NEW refresh token when present; the caller falls back to
  // the old one only when the response omits one (Linear always rotates).
  if (typeof json.refresh_token === "string" && json.refresh_token) out.refreshToken = json.refresh_token
  if (typeof json.expires_in === "number") out.expiresIn = json.expires_in
  const scopes = normalizeScopes(json.scope)
  if (scopes.length > 0) out.scope = scopes.join(" ")
  return out
}

/**
 * Refresh the stored agent access token using the rotating refresh token.
 *
 * actor=app authorization_code tokens are 24h access tokens carrying a rotating
 * refresh_token; this exchanges that refresh token for a NEW access token AND a
 * NEW refresh token (Linear rotates on every refresh — the new refresh token MUST
 * be persisted or the next refresh fails). The POST itself lives in the shared
 * `performAgentTokenRefresh`; this function owns the KV read, the rotation-record
 * write, and the neutral telemetry.
 *
 * Returns the new access token on success, or null on ANY failure (no stored
 * refresh token, missing creds, non-2xx, network/JSON error, missing access_token,
 * persist failure). A failed refresh NEVER corrupts the existing stored record.
 * NEVER logs tokens or the refresh response body.
 */
export async function refreshAgentToken(env: AgentTokenEnv): Promise<string | null> {
  const existing = await readAgentTokenRecord(env.OPENCLAW_STATE)
  if (!existing || !existing.refreshToken) return null

  const { clientId, clientSecret } = resolveAgentOAuthCreds(env)
  if (!clientId || !clientSecret) return null

  const result = await performAgentTokenRefresh(existing.refreshToken, { clientId, clientSecret })
  if (!result.ok) {
    // Preserve the prior neutral telemetry shape: a non-2xx logs the status only;
    // the others log a reason. NEVER logs token material.
    console.error(
      JSON.stringify(
        result.reason === "non-2xx"
          ? { event: "linear-agent-refresh-failed", status: result.status }
          : { event: "linear-agent-refresh-failed", reason: result.reason },
      ),
    )
    return null
  }

  const next: LinearAgentTokenRecord = {
    accessToken: result.accessToken,
    // Rotation: persist the NEW refresh token; fall back to the old one only when
    // the response omits one (Linear always rotates, but stay defensive).
    refreshToken: result.refreshToken ?? existing.refreshToken,
    installedAt: existing.installedAt,
  }
  if (typeof result.scope === "string") next.scope = result.scope
  else if (existing.scope) next.scope = existing.scope
  // Always record an expiry so proactive refresh keeps working; default to the
  // known 24h lifetime if the response omits expires_in (it never should).
  next.expiresAt = Date.now() + (typeof result.expiresIn === "number" ? result.expiresIn * 1000 : FALLBACK_TOKEN_TTL_MS)

  try {
    await putLinearAgentToken(env.OPENCLAW_STATE, next)
  } catch {
    console.error(JSON.stringify({ event: "linear-agent-refresh-failed", reason: "persist" }))
    return null
  }

  return next.accessToken
}

// WITHIN-ISOLATE single-flight: concurrent getValidAgentToken refreshes in one
// isolate dedupe to a single in-flight POST (a refresh token is single-use, so
// parallel refreshes would double-rotate). This is best-effort — it collapses the
// common concurrent burst, but a narrow read-then-check window (and the
// cross-isolate case entirely) can still issue a second refresh. Linear's ~30-min
// refresh-token consume grace bounds the blast radius of such a rare double-rotation
// (the prior token stays valid; no token-family revocation). Full read+decide+rotate
// serialization via a Durable Object lock is a deliberate FOLLOW-UP for the
// high-traffic path and is OUT OF SCOPE here — the agent-activity path is low-volume
// and single-workspace (one LINEAR_AGENT_TOKEN_KEY).
let refreshInFlight: Promise<string | null> | null = null

/**
 * Return a valid agent access token, refreshing it when it is at/near expiry.
 *
 * - No stored record → null (agent not installed).
 * - No recorded `expiresAt` (legacy install) → return the cached token as-is
 *   (we can't know its freshness; do not force a refresh).
 * - More than REFRESH_BUFFER_MS from expiry → return the cached token.
 * - Otherwise refresh (single-flight within this isolate). If the refresh FAILS
 *   but the stored token is not yet hard-expired, fall back to it rather than
 *   disabling the agent inside the refresh headroom (fail-safe / availability).
 *
 * `getLinearAgentToken` is kept as-is for callers that only need the raw stored
 * token without the freshness guarantee.
 */
export async function getValidAgentToken(env: AgentTokenEnv): Promise<string | null> {
  const record = await readAgentTokenRecord(env.OPENCLAW_STATE)
  if (!record) return null
  if (typeof record.expiresAt !== "number") return record.accessToken
  if (Date.now() < record.expiresAt - REFRESH_BUFFER_MS) return record.accessToken

  // At/near expiry — refresh, deduped within this isolate. The leader (the call
  // that created the promise) clears the slot in its finally; joiners share it.
  const inFlight = refreshInFlight ?? (refreshInFlight = refreshAgentToken(env))
  let refreshed: string | null
  try {
    refreshed = await inFlight
  } finally {
    if (refreshInFlight === inFlight) refreshInFlight = null
  }
  if (refreshed) return refreshed
  // Refresh failed (transient). `record.expiresAt` is a number here (guarded
  // above); use the stored token while it is still valid, else give up (null).
  return Date.now() < record.expiresAt ? record.accessToken : null
}

function text(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function htmlPage(message: string): Response {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sigilix</title></head>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${safe}</h1></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  )
}
