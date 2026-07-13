// #155 onboarding-backend FOUNDATION (slice 1 of 2) — the GitHub App's Setup
// URL handler + the install-redirect kickoff that mints its CSRF state nonce.
//
// Flow:
//   GET /auth/install-redirect — requires a session; mints a single-use KV
//                                  nonce bound to the caller's githubUserId;
//                                  302s to the GitHub App's "install on your
//                                  repos" page with &state=<nonce>.
//   GET /setup                  — the GitHub App's configured Setup URL.
//                                  GitHub redirects here after install/update
//                                  with ?installation_id&setup_action&state.
//                                  Requires a session, a session-bound state
//                                  nonce, exact live GitHub visibility, and
//                                  (when enabled) active Sigilix workspace
//                                  access. On success: links compatibility
//                                  metadata, mints an api_key, and renders the
//                                  plaintext key ONCE.
//
// Mirrors the KV-backed, single-use, read-then-delete state-nonce CSRF
// pattern in slack-install.ts, and the never-log-secrets discipline used
// throughout the auth-* modules: the plaintext key is rendered into the
// response HTML and is never passed to console.log/console.error/console.warn.
//
// AUTH-CRITICAL — the exact-installation access check. `installation_id` arrives
// as an attacker-controllable query parameter, and GitHub installation IDs are
// low, enumerable integers that appear in webhook payloads (NOT secrets). The
// state nonce alone does NOT bind to an installation (it is minted before any
// installation exists, and an attacker mints it for their own session), so
// WITHOUT a positive ownership check an attacker could call
// `/setup?installation_id=<victim>&state=<own_nonce>` and link their account to
// (and mint a live API key for) a victim's installation — a cross-tenant
// takeover. `requireOrgAccess` proves the session user's fresh GitHub token can
// see this exact installation and, when managed membership is enabled, also
// requires an active exact workspace row. The legacy `account_tenant` row this
// route writes remains compatibility metadata only; it never grants access.

import { requireSession } from "@/src/lib/auth-middleware"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { insertApiKey, linkAccountTenant, mintApiKeyPlaintext } from "@/src/lib/api-key-store"
import { requireOrgAccess } from "@/src/lib/org-access"
import type { Env } from "@/src/shared/types/env"

const SETUP_STATE_KV_PREFIX = "setup_state:"
const SETUP_STATE_TTL_SECONDS = 600
const GITHUB_APP_INSTALL_URL = "https://github.com/apps/sigilix/installations/new"
// account_tenant.role is retained for legacy consumers only. Authorization is
// owned by requireOrgAccess and org_workspace_access, never this placeholder.
const DEFAULT_ROLE = "owner"

interface SetupStateRecord {
  githubUserId: number
  createdAt: number
}

/** GET /auth/install-redirect — mint the Setup-URL CSRF nonce, 302 to GitHub. */
export async function handleInstallRedirect(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) {
    return new Response(null, { status: 302, headers: { location: "/auth/github" } })
  }
  // sig-user-identity: the GitHub App install flow requires a GitHub session.
  // A Google / email-password user has no github id — send them to link GitHub.
  if (authed.record.githubUserId == null) {
    return new Response(null, { status: 302, headers: { location: "/auth/github" } })
  }

  const nonce = crypto.randomUUID()
  const record: SetupStateRecord = { githubUserId: authed.record.githubUserId, createdAt: Date.now() }
  await env.OPENCLAW_STATE.put(`${SETUP_STATE_KV_PREFIX}${nonce}`, JSON.stringify(record), {
    expirationTtl: SETUP_STATE_TTL_SECONDS,
  })

  const url = new URL(GITHUB_APP_INSTALL_URL)
  url.searchParams.set("state", nonce)
  return new Response(null, { status: 302, headers: { location: url.toString() } })
}

/** GET /setup — the GitHub App's Setup URL. Links account_tenant + issues the first key. */
export async function handleSetupRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) {
    return new Response("unauthenticated\n", { status: 401 })
  }
  // sig-user-identity: setup links a GitHub App install to the GitHub user id —
  // a non-GitHub session can't complete it. Fail closed.
  if (authed.record.githubUserId == null) {
    return new Response("github_account_required\n", { status: 403 })
  }

  const url = new URL(request.url)
  const state = url.searchParams.get("state")
  const installationIdRaw = url.searchParams.get("installation_id")
  // setup_action ("install" | "update" | "request") is accepted but not
  // branched on in this foundation slice — any action that carries a valid
  // installation_id + state + session links the same way. Differentiating
  // (e.g. "request" awaiting org-admin approval) is left for a follow-up.
  void url.searchParams.get("setup_action")

  if (!state) {
    return new Response("missing state\n", { status: 400 })
  }
  if (!installationIdRaw || !/^\d+$/.test(installationIdRaw)) {
    return new Response("missing or invalid installation_id\n", { status: 400 })
  }
  const installationId = Number(installationIdRaw)
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return new Response("missing or invalid installation_id\n", { status: 400 })
  }

  // Single-use nonce: read-then-delete (mirrors slack-install.ts). The code
  // path below never re-reads this key, so deleting up-front is safe even
  // though later steps can still fail (a failed /setup can be retried from
  // /auth/install-redirect, which mints a fresh nonce).
  const raw = (await env.OPENCLAW_STATE.get(`${SETUP_STATE_KV_PREFIX}${state}`, "json")) as SetupStateRecord | null
  if (!raw) {
    return new Response("state_invalid\n", { status: 400 })
  }
  await env.OPENCLAW_STATE.delete(`${SETUP_STATE_KV_PREFIX}${state}`)

  // Session-bound: the nonce must belong to the SAME user completing setup —
  // not just any currently-logged-in session — so a stolen/replayed state
  // value can't link an attacker's installation to a victim's account (or
  // vice versa).
  if (raw.githubUserId !== authed.record.githubUserId) {
    return new Response("state_mismatch\n", { status: 400 })
  }

  if (!env.SIGILIX_PLATFORM_DB) {
    return new Response("platform_db_not_configured\n", { status: 503 })
  }
  const db = env.SIGILIX_PLATFORM_DB
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "member" })
  if (!access.ok) return access.response

  // The request cookie cannot change during this handler, and session token
  // refreshes preserve identity. Still fail closed if the central guard ever
  // resolves a different immutable GitHub account than the nonce-bound read.
  if (access.githubUserId !== String(authed.record.githubUserId)) {
    console.error(JSON.stringify({ event: "setup-session-identity-drift", installationId }))
    return new Response("forbidden\n", { status: 403 })
  }
  const githubUserId = access.githubUserId
  const now = new Date().toISOString()

  // Don't assume the `tenant` row exists yet — the PR webhook upserts it
  // asynchronously (see d1-tenant-store.ts). account_tenant has no FK to
  // tenant, so this insert never blocks on that race.
  try {
    await linkAccountTenant(db, { githubUserId, installationId, role: DEFAULT_ROLE, nowIso: now })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "setup-link-account-tenant-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return new Response("setup_failed\n", { status: 500 })
  }

  const plaintext = mintApiKeyPlaintext()
  const keyHash = await sha256Hex(plaintext)
  const id = crypto.randomUUID()
  try {
    await insertApiKey(db, { id, keyHash, installationId, createdBy: githubUserId, nowIso: now })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "setup-mint-key-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return new Response("setup_failed\n", { status: 500 })
  }

  // Redirect polish (env-gated, SIG-155 slice 3): once the portal owns this
  // flow, hand the browser back to the portal's own /setup page instead of
  // rendering this Worker's plaintext-key page — the portal mints its OWN
  // key via POST /v1/keys (session-authed, CORS'd) once the user lands
  // there, so the key minted just above simply goes unused on this path.
  // NEVER put the key in the URL, ever — a GET request's query string ends
  // up in browser history, proxy logs, and server access logs. When
  // OPENCLAW_PORTAL_URL is unset this branch is inert and behavior is
  // byte-identical to before (renders the plaintext-key page).
  if (env.OPENCLAW_PORTAL_URL) {
    return new Response(null, {
      status: 302,
      headers: { location: `${env.OPENCLAW_PORTAL_URL}/setup?installed=1` },
    })
  }

  // Plaintext rendered into the page exactly once; never passed to console.*.
  return renderSetupSuccessPage(plaintext)
}

function renderSetupSuccessPage(plaintextKey: string): Response {
  const safeKey = escapeHtml(plaintextKey)
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sigilix · Setup complete</title>
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
    max-width: 32rem; width: 100%;
    background: #15161b;
    border: 1px solid #2a2b30;
    border-radius: 4px;
    padding: 2rem 2.25rem 2.5rem;
    box-shadow: 0 0 80px -30px rgba(198,35,74,0.25);
    text-align: center;
  }
  .kicker { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.625rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c6234a; margin-bottom: 1rem; }
  h1 { font-size: 1.875rem; font-weight: 500; line-height: 1.05; letter-spacing: -0.02em; margin-bottom: 1rem; }
  p { color: #8a8b91; line-height: 1.65; margin-bottom: 1.5rem; font-size: 0.9375rem; }
  .keybox {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.8125rem; word-break: break-all; text-align: left;
    background: #1c1d23; border: 1px solid #2a2b30; border-radius: 4px;
    padding: 1rem 1.125rem; margin: 1.5rem 0; color: #f0f0f2;
  }
  .legal { margin-top: 1.5rem; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.6875rem; color: #5a5b61; }
</style>
</head>
<body>
  <div class="card">
    <p class="kicker">Sigilix</p>
    <h1>Setup complete.</h1>
    <p>Your API key is shown once below. Copy it now — Sigilix never stores or displays the plaintext again.</p>
    <div class="keybox">${safeKey}</div>
    <p class="legal">Only a SHA-256 hash of this key is stored server-side.</p>
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
      "cache-control": "no-store",
    },
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
