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
  /** Space/comma-separated scopes Linear granted (e.g. "app:assignable app:mentionable"). */
  scope?: string
  /** ms epoch when the token expires, when Linear returns `expires_in`. */
  expiresAt?: number
  installedAt: number
}

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

interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

/** Compute the OAuth redirect URI. PINNED to OPENCLAW_GATEWAY_ISSUER (the worker
 *  origin the Linear OAuth app is configured against) so /linear/install and the
 *  token exchange use the same value and cannot drift; falls back to the request
 *  origin only when the issuer env is unset. */
function linearRedirectUri(env: Pick<Env, "OPENCLAW_GATEWAY_ISSUER">, requestUrl: URL): string {
  const base = env.OPENCLAW_GATEWAY_ISSUER ?? requestUrl.origin
  return `${base}/linear/oauth/callback`
}

/** Build the actor=app authorize URL + persist a CSRF nonce in KV (10-min TTL).
 *  The callback verifies and deletes the nonce before exchanging the code. */
export async function buildLinearAuthorizeUrl(
  env: Pick<Env, "OPENCLAW_STATE" | "LINEAR_OAUTH_CLIENT_ID" | "OPENCLAW_GATEWAY_ISSUER">,
  requestUrl: URL,
): Promise<string> {
  const state = crypto.randomUUID()
  await env.OPENCLAW_STATE.put(`${STATE_KV_PREFIX}${state}`, "1", { expirationTtl: STATE_TTL_SECONDS })
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINEAR_OAUTH_CLIENT_ID ?? "",
    redirect_uri: linearRedirectUri(env, requestUrl),
    scope: DEFAULT_INSTALL_SCOPES,
    actor: "app",
    state,
  })
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`
}

/**
 * GET /linear/install — the founder's one-click agent-install entry. Mints a CSRF
 * nonce, stores it in KV, and 302-redirects to Linear's actor=app consent screen.
 * Returns 503 when LINEAR_OAUTH_CLIENT_ID is unset (Linear OAuth not configured).
 */
export async function handleLinearInstall(request: Request, env: Env): Promise<Response> {
  if (!env.LINEAR_OAUTH_CLIENT_ID) {
    return text("Linear OAuth is not configured.", 503)
  }
  const authorizeUrl = await buildLinearAuthorizeUrl(env, new URL(request.url))
  return new Response(null, { status: 302, headers: { location: authorizeUrl } })
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
  if (!env.LINEAR_OAUTH_CLIENT_ID || !env.LINEAR_OAUTH_CLIENT_SECRET) {
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
    client_id: env.LINEAR_OAUTH_CLIENT_ID,
    client_secret: env.LINEAR_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    code,
  })

  const MAX_ATTEMPTS = 3
  let res: Response | null = null
  let lastNetworkError = false
  let attemptsUsed = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt
    try {
      res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(8000),
      })
      lastNetworkError = false
      // Do not retry 4xx — deterministic client error.
      if (res.status < 500) break
      // 5xx — retryable. On the final attempt fall through to the failure handler.
      if (attempt < MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 400))
      }
    } catch {
      lastNetworkError = true
      if (attempt < MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 400))
        continue
      }
    }
  }

  if (res === null || lastNetworkError) {
    console.error("linear oauth callback: network error during token exchange", { attempts: attemptsUsed })
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
      attempts: attemptsUsed,
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
  if (typeof json.scope === "string") record.scope = json.scope
  if (typeof json.expires_in === "number") record.expiresAt = Date.now() + json.expires_in * 1000

  try {
    await putLinearAgentToken(env.OPENCLAW_STATE, record)
  } catch {
    console.error("linear oauth callback: failed to persist agent token")
    return text("Sigilix install failed while saving the install. Please try again.", 502)
  }

  console.log(
    JSON.stringify({
      event: "linear-agent-installed",
      scopePresent: !!record.scope,
      hasExpiry: typeof record.expiresAt === "number",
      // access_token / code / client_secret intentionally excluded
    }),
  )

  return htmlPage("Sigilix agent installed — you can close this tab.")
}

function text(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
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
