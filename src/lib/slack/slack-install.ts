// Slack KV install store + OAuth v2 callback.
//
// Stores per-team installs as JSON under "slack-install:<teamId>" in the
// OPENCLAW_STATE KV namespace so multi-workspace OAuth tokens survive Worker
// restarts and can be looked up by team. In single-workspace beta mode, callers
// fall back to the SLACK_BOT_TOKEN env var if no KV record is present.
//
// Security: the token-exchange response body is NEVER logged. Only neutral
// status strings appear in console.error to prevent accidental token leakage.

import type { Env } from "@/src/shared/types/env"

export interface SlackInstall {
  teamId: string
  botToken: string
  installedAt: number
}

const KV_PREFIX = "slack-install:"

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

/** Handle GET /slack/oauth/callback — exchange the Slack OAuth v2 code for a
 *  bot token, persist the install, and redirect to the installed confirmation
 *  page. Returns neutral 502 on any exchange failure to avoid leaking details.
 *
 *  NEVER logs the token-exchange response body or the bot token. */
export async function handleSlackOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  if (!code) {
    return new Response("missing code\n", { status: 400 })
  }

  const formBody = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID ?? "",
    client_secret: env.SLACK_CLIENT_SECRET ?? "",
    code,
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

  await putSlackInstall(env, { teamId, botToken, installedAt: Date.now() })

  const base = env.OPENCLAW_BASE_URL ?? "https://app.sigilix.ai"
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/slack/installed` },
  })
}
