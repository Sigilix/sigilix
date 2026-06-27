// Slack KV install store + OAuth v2 callback.
//
// Stores per-team installs as JSON under "slack-install:<teamId>" in the
// OPENCLAW_STATE KV namespace so multi-workspace OAuth tokens survive Worker
// restarts and can be looked up by team. In single-workspace beta mode, callers
// fall back to the SLACK_BOT_TOKEN env var if no KV record is present.
//
// Security: the token-exchange response body is NEVER logged. Only neutral
// status strings appear in console.error to prevent accidental token leakage.
// CSRF: the install flow uses a KV-backed nonce (state) with a 10-minute TTL;
// the callback verifies and immediately deletes the nonce to prevent replays.

import type { Env } from "@/src/shared/types/env"

export interface SlackInstall {
  teamId: string
  botToken: string
  installedAt: number
}

const KV_PREFIX = "slack-install:"
const STATE_KV_PREFIX = "slack-oauth-state:"
const DEFAULT_SCOPES = "app_mentions:read,chat:write,channels:history,groups:history"

/** Compute the OAuth redirect URI from env. Factored here so authorize and
 *  token-exchange use the same value and cannot drift. */
function slackRedirectUri(env: Pick<Env, "OPENCLAW_BASE_URL">): string {
  const base = env.OPENCLAW_BASE_URL ?? "https://app.sigilix.ai"
  return `${base}/slack/oauth/callback`
}

/** Write a Slack install record to KV. Key: `slack-install:<teamId>`. */
export async function putSlackInstall(env: Pick<Env, "OPENCLAW_STATE">, install: SlackInstall): Promise<void> {
  await env.OPENCLAW_STATE.put(`${KV_PREFIX}${install.teamId}`, JSON.stringify(install))
}

/** Resolve the bot token for a team.
 *  Returns the KV record's `botToken` if one exists, otherwise falls back to
 *  `env.SLACK_BOT_TOKEN` (single-workspace beta convenience), or `null`. */
export async function getSlackBotToken(
  env: Pick<Env, "OPENCLAW_STATE" | "SLACK_BOT_TOKEN">,
  teamId: string,
): Promise<string | null> {
  const raw = await env.OPENCLAW_STATE.get(`${KV_PREFIX}${teamId}`)
  if (raw !== null) {
    try {
      const record = JSON.parse(raw) as SlackInstall
      return record.botToken
    } catch {
      // Malformed KV record — fall through to env fallback.
    }
  }
  return env.SLACK_BOT_TOKEN ?? null
}

/** Generate a CSRF-proof Slack OAuth v2 authorize URL.
 *  Stores a CSPRNG nonce in KV under `slack-oauth-state:<state>` with a
 *  10-minute TTL. The callback must verify and delete the nonce before
 *  proceeding with the code exchange. */
export async function buildSlackAuthorizeUrl(
  env: Pick<Env, "OPENCLAW_STATE" | "SLACK_CLIENT_ID" | "OPENCLAW_BASE_URL">,
  args?: { scopes?: string },
): Promise<string> {
  const state = crypto.randomUUID()
  await env.OPENCLAW_STATE.put(`${STATE_KV_PREFIX}${state}`, "1", { expirationTtl: 600 })
  const redirectUri = slackRedirectUri(env)
  const scopes = args?.scopes ?? DEFAULT_SCOPES
  return (
    `https://slack.com/oauth/v2/authorize` +
    `?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID ?? "")}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`
  )
}

/** Handle GET /slack/install — redirect the user to Slack's OAuth consent screen.
 *  Returns 503 if SLACK_CLIENT_ID is unset (Slack not configured).
 *  A fresh CSRF nonce is generated and stored in KV on every request. */
export async function handleSlackInstall(_request: Request, env: Env): Promise<Response> {
  if (!env.SLACK_CLIENT_ID) {
    return new Response("Slack not configured\n", { status: 503 })
  }
  const authorizeUrl = await buildSlackAuthorizeUrl(env)
  return new Response(null, {
    status: 302,
    headers: { location: authorizeUrl },
  })
}

/** Handle GET /slack/oauth/callback — verify CSRF state, exchange the Slack
 *  OAuth v2 code for a bot token, persist the install, and redirect to the
 *  installed confirmation page. Returns neutral 502 on any exchange or KV
 *  failure to avoid leaking details.
 *
 *  Order: state present → state found in KV → code present → delete nonce
 *  → exchange → persist. The nonce is never consumed for a missing-code 400.
 *
 *  NEVER logs the token-exchange response body or the bot token. */
export async function handleSlackOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  // 1. CSRF state verification — must happen before the code exchange.
  const state = url.searchParams.get("state")
  if (!state) {
    return new Response("missing state\n", { status: 400 })
  }
  const stateValue = await env.OPENCLAW_STATE.get(`${STATE_KV_PREFIX}${state}`)
  if (stateValue === null) {
    return new Response("invalid or expired state\n", { status: 400 })
  }

  // 2. Code must be present before we consume the nonce (replay-safe: a
  //    missing code returns 400 WITHOUT deleting the nonce).
  const code = url.searchParams.get("code")
  if (!code) {
    return new Response("missing code\n", { status: 400 })
  }

  // 3. Delete the nonce immediately to prevent replay attacks.
  try {
    await env.OPENCLAW_STATE.delete(`${STATE_KV_PREFIX}${state}`)
  } catch {
    console.error("slack oauth.v2.access: failed to delete nonce")
    return new Response("OAuth exchange failed\n", { status: 502 })
  }

  const formBody = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID ?? "",
    client_secret: env.SLACK_CLIENT_SECRET ?? "",
    code,
    redirect_uri: slackRedirectUri(env),
  })

  let slackRes: Response
  try {
    slackRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    })
  } catch {
    // Network error — do NOT log the body.
    console.error("slack oauth.v2.access: network error during token exchange")
    return new Response("OAuth exchange failed\n", { status: 502 })
  }

  if (!slackRes.ok) {
    // Non-2xx — do NOT log the body.
    console.error("slack oauth.v2.access: non-2xx response", { status: slackRes.status })
    return new Response("OAuth exchange failed\n", { status: 502 })
  }

  // Parse the response. We intentionally avoid logging or spreading `data`
  // to prevent bot token leakage in log sinks.
  let data: unknown
  try {
    data = await slackRes.json()
  } catch {
    console.error("slack oauth.v2.access: invalid JSON in response")
    return new Response("OAuth exchange failed\n", { status: 502 })
  }

  const parsed = data as { ok?: boolean; access_token?: string; team?: { id?: string } }

  if (!parsed.ok) {
    // ok:false — log only the fact, not the body or token.
    console.error("slack oauth.v2.access: ok:false")
    return new Response("OAuth exchange failed\n", { status: 502 })
  }

  const teamId = parsed.team?.id
  const botToken = parsed.access_token
  if (!teamId || !botToken) {
    console.error("slack oauth.v2.access: response missing team.id or access_token")
    return new Response("OAuth exchange failed\n", { status: 502 })
  }

  try {
    await putSlackInstall(env, { teamId, botToken, installedAt: Date.now() })
  } catch {
    console.error("slack oauth.v2.access: failed to persist install")
    return new Response("OAuth exchange failed\n", { status: 502 })
  }

  const base = env.OPENCLAW_BASE_URL ?? "https://app.sigilix.ai"
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/slack/installed` },
  })
}
