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
//
// Org linkage (customer self-serve): when the portal starts the install with
// `?installation_id=N`, the flow is session-gated + admin-gated and the org
// identity rides the OAuth `state` (KV record, same as the GitLab connector).
// The callback then links the Slack team to that Sigilix installation in D1
// (slack_workspace, migration 0019) so the portal can bind channels to repos.
// A bare GET /slack/install (no param) keeps the original anonymous behavior.

import { requireSession } from "@/src/lib/auth-middleware"
import type { SessionRecord } from "@/src/lib/auth-session"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import { upsertSlackWorkspace } from "@/src/lib/slack/slack-binding-store"
import type { Env } from "@/src/shared/types/env"

export interface SlackInstall {
  teamId: string
  botToken: string
  installedAt: number
}

/** Org identity carried through the OAuth `state` KV record. The legacy
 *  anonymous flow stores the literal "1" instead (no org linkage). The state
 *  is bound to the SAME signed-in portal user who began the install (`userKey`)
 *  and the callback re-verifies the session against it — a forwarded authorize
 *  link cannot link a victim's workspace to the initiator's installation. */
interface SlackOAuthStateRecord {
  installationId: number
  login: string
  userKey: string
}

/** Stable per-user key for state↔session binding — mirrors the GitLab
 *  connector's `connectUserKey`. */
function sessionUserKey(record: SessionRecord): string {
  if (record.userId) return record.userId
  if (typeof record.githubUserId === "number") return `gh:${record.githubUserId}`
  return `login:${record.login}`
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
      if (record && typeof record.botToken === "string" && record.botToken) return record.botToken
      // Malformed record (missing/empty token) — fall through to env fallback.
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
  args?: { scopes?: string; stateRecord?: SlackOAuthStateRecord },
): Promise<string> {
  const state = crypto.randomUUID()
  const stateValue = args?.stateRecord ? JSON.stringify(args.stateRecord) : "1"
  await env.OPENCLAW_STATE.put(`${STATE_KV_PREFIX}${state}`, stateValue, { expirationTtl: 600 })
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

/** The portal origin — where org-linked installs bounce back to. */
function portalUrl(env: Pick<Env, "OPENCLAW_PORTAL_URL">): string {
  return env.OPENCLAW_PORTAL_URL ?? "https://app.sigilix.ai"
}

/** Bounce back to the portal's Slack app page with a status flag. */
function portalRedirect(env: Pick<Env, "OPENCLAW_PORTAL_URL">, params: Record<string, string>): Response {
  const u = new URL(`${portalUrl(env)}/apps/slack`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return new Response(null, { status: 302, headers: { location: u.toString() } })
}

/** Handle GET /slack/install — redirect the user to Slack's OAuth consent screen.
 *  Returns 503 if SLACK_CLIENT_ID is unset (Slack not configured).
 *  A fresh CSRF nonce is generated and stored in KV on every request.
 *
 *  With `?installation_id=N` (the portal's connect flow) the request is
 *  session-gated and admin-gated for THAT installation, and the org identity is
 *  carried through the OAuth state so the callback can link the workspace. */
export async function handleSlackInstall(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.SLACK_CLIENT_ID) {
    return new Response("Slack not configured\n", { status: 503 })
  }

  const rawInstallationId = new URL(request.url).searchParams.get("installation_id")
  let stateRecord: SlackOAuthStateRecord | undefined
  if (rawInstallationId !== null) {
    const installationId = Number(rawInstallationId)
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      return portalRedirect(env, { slackError: "invalid_installation" })
    }
    // Org-linked install: the caller must be a signed-in admin of the exact
    // installation (mirrors linear-config-route's admin gate).
    const session = await requireSession(request, env, ctx)
    if (!session) {
      return new Response(null, { status: 302, headers: { location: `${portalUrl(env)}/login` } })
    }
    if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
      return portalRedirect(env, { slackError: "misconfigured" })
    }
    let accessToken: string
    try {
      accessToken = await getValidGithubToken({
        env,
        sessionId: session.sessionId,
        record: session.record,
        encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
      })
    } catch {
      return portalRedirect(env, { slackError: "session_invalid" })
    }
    if (!(await isAdminOfInstallation(accessToken, session.record.login, installationId))) {
      return portalRedirect(env, { slackError: "forbidden" })
    }
    stateRecord = {
      installationId,
      login: session.record.login,
      userKey: sessionUserKey(session.record),
    }
  }

  const authorizeUrl = await buildSlackAuthorizeUrl(env, stateRecord ? { stateRecord } : undefined)
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
export async function handleSlackOAuthCallback(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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

  // Org identity threaded through the state (portal-initiated installs). The
  // legacy anonymous flow stores "1" — treated as "no org linkage".
  let orgLink: SlackOAuthStateRecord | null = null
  if (stateValue !== "1") {
    try {
      const parsedState = JSON.parse(stateValue) as Partial<SlackOAuthStateRecord>
      if (
        Number.isSafeInteger(parsedState.installationId) &&
        Number(parsedState.installationId) > 0 &&
        typeof parsedState.login === "string" &&
        parsedState.login &&
        typeof parsedState.userKey === "string" &&
        parsedState.userKey
      ) {
        orgLink = {
          installationId: Number(parsedState.installationId),
          login: parsedState.login,
          userKey: parsedState.userKey,
        }
      } else {
        // A structured state that fails validation is rejected outright —
        // never silently downgraded to an unlinked install.
        return portalRedirect(env, { slackError: "state_invalid" })
      }
    } catch {
      return portalRedirect(env, { slackError: "state_invalid" })
    }
  }

  // Session binding: the callback must arrive in the SAME signed-in browser
  // that began the org-linked install. Without this, a forwarded authorize
  // link could let a workspace member unknowingly link their Slack team to the
  // initiator's installation. Checked BEFORE the nonce is consumed so the
  // legitimate user can retry after signing in.
  if (orgLink) {
    const session = await requireSession(request, env, ctx)
    if (!session || sessionUserKey(session.record) !== orgLink.userKey) {
      return portalRedirect(env, { slackError: "session_mismatch" })
    }
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

  // Portal-initiated install: link the Slack team to the initiating Sigilix
  // org in D1, then bounce back to the portal's Slack page (channel picker).
  if (orgLink) {
    let linked: Awaited<ReturnType<typeof upsertSlackWorkspace>>
    try {
      linked = await upsertSlackWorkspace(env, {
        teamId,
        installationId: orgLink.installationId,
        installedBy: orgLink.login,
        nowIso: new Date().toISOString(),
      })
    } catch {
      // Org linkage failed (DB unbound / migration 0019 not applied). The bot
      // token IS stored, but the portal can't bind channels yet — surface it.
      console.error("slack oauth.v2.access: failed to link workspace to installation")
      return portalRedirect(env, { slackError: "org_link_failed" })
    }
    if (!linked.ok) {
      // The team already belongs to ANOTHER installation — takeover refused
      // (the installer proved admin of their own org, not the current owner's).
      console.error("slack oauth.v2.access: team already linked to another installation")
      return portalRedirect(env, { slackError: "workspace_already_linked" })
    }
    return portalRedirect(env, { slackConnected: "1" })
  }

  const base = env.OPENCLAW_BASE_URL ?? "https://app.sigilix.ai"
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/slack/installed` },
  })
}

/**
 * Render the post-install success page. The OAuth callback 302s here after a
 * successful install; this is the landing page the user actually sees. Static
 * HTML, no JS, strict CSP — mirrors the /auth/welcome page style (dark, red accent).
 */
export function handleSlackInstalled(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sigilix · Installed</title>
<meta name="referrer" content="strict-origin-when-cross-origin" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: #0b0c10;
    color: #f0f0f2;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 2rem;
  }
  .card {
    max-width: 28rem; width: 100%;
    background: #15161b;
    border: 1px solid #2a2b30;
    border-radius: 4px;
    padding: 2rem 2.25rem 2.5rem;
    box-shadow: 0 0 80px -30px rgba(198,35,74,0.25);
    text-align: center;
  }
  .kicker { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.625rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c6234a; margin-bottom: 1rem; }
  h1 { font-size: 1.875rem; font-weight: 500; line-height: 1.05; letter-spacing: -0.02em; margin-bottom: 1rem; }
  .accent { color: #c6234a; }
  p { color: #8a8b91; line-height: 1.65; font-size: 0.9375rem; }
</style>
</head>
<body>
  <div class="card">
    <p class="kicker">Sigilix</p>
    <h1>Sigilix <span class="accent">successfully installed</span>.</h1>
    <p>You can close this tab and return to Slack — mention <span class="accent">@Sigilix</span> in any connected channel to get started.</p>
  </div>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Strict CSP — page has no JS so nothing should ever execute.
      "content-security-policy":
        "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  })
}
