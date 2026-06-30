// Linear AGENT install — the actor=app authorization-code callback + agent-token store.
//
// Distinct from `linear-oauth.ts` (the client_credentials app-actor token used for
// comments + field updates). When a workspace admin installs Sigilix as a Linear
// AGENT via the `?actor=app&scope=app:assignable,app:mentionable` authorize URL,
// Linear redirects the browser to GET /linear/oauth/callback?code=...&state=...
// This module exchanges that code for the AGENT access token and stores it in
// OPENCLAW_STATE KV. That token — NOT the client_credentials token — carries the
// agent capability and is what `createAgentActivity` posts agent activities with.
//
// Security: the authorization code, the client secret, and the access token are
// NEVER logged. Only neutral status strings reach console on error.

import type { Env } from "@/src/shared/types/env"

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token"

/** KV key holding the single workspace agent token (actor=app install). */
export const LINEAR_AGENT_TOKEN_KEY = "linear:agent-token"

/** KV nonce prefix for an optional CSRF state (a future /linear/install kickoff
 *  may write one; a manually-run authorize URL carries no stored nonce). */
const STATE_KV_PREFIX = "linear-oauth-state:"

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

/**
 * GET /linear/oauth/callback — finalize the actor=app agent install.
 *
 * Linear redirects here after the workspace admin approves the
 * `?actor=app&scope=app:assignable,app:mentionable` authorize URL. We exchange the
 * authorization code for the AGENT access token and store it in KV; that token is
 * what `createAgentActivity` posts agent activities with.
 *
 * The `redirect_uri` sent to the token endpoint MUST byte-match the one used in the
 * authorize request — we derive it from THIS request's own origin + path so it always
 * matches the exact callback Linear just hit (the install authorize URL uses the
 * worker origin, not the marketing OPENCLAW_BASE_URL).
 *
 * `state` is consumed opportunistically: when a matching CSRF nonce exists in KV it is
 * deleted; a manually-run authorize URL carries no stored nonce, so a missing nonce
 * does NOT block the install (requiring one would re-break the exact flow this route
 * exists to fix).
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

  const code = url.searchParams.get("code")
  if (!code) {
    return text("Missing authorization code.", 400)
  }

  // Opportunistic CSRF-nonce consumption (see the doc comment). Best-effort:
  // a KV blip on the nonce must not block an otherwise-valid install.
  const state = url.searchParams.get("state")
  if (state) {
    try {
      const nonceKey = `${STATE_KV_PREFIX}${state}`
      const nonce = await env.OPENCLAW_STATE.get(nonceKey)
      if (nonce !== null) await env.OPENCLAW_STATE.delete(nonceKey)
    } catch {
      // best-effort
    }
  }

  const redirectUri = `${url.origin}${url.pathname}`
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.LINEAR_OAUTH_CLIENT_ID,
    client_secret: env.LINEAR_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    code,
  })

  let res: Response
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    })
  } catch {
    console.error("linear oauth callback: network error during token exchange")
    return text("Sigilix install failed during token exchange. Please try again.", 502)
  }

  if (!res.ok) {
    // Status only — never the body (it can echo the code).
    console.error("linear oauth callback: non-2xx from token endpoint", { status: res.status })
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
