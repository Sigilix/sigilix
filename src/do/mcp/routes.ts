// sig-mcp-connections-p1 — HTTP routes for custom MCP-server connections,
// wired into src/index.ts. Auth accepts EITHER a portal session cookie
// (requireSession) OR an API-key bearer (requireApiTenant) — same dual-auth
// shape as workspace-prs-route.ts / deep-research routes.ts — and the caller's
// resolved identity is what NAMES the McpConnectionsAgent DO instance, so
// per-seat/tenant token isolation is enforced by DO naming, never by a
// client-supplied id.
//
//   POST   /v1/mcp/servers          → connect a server, return connected/auth_required
//   GET    /v1/mcp/servers          → list the caller's connected servers
//   DELETE /v1/mcp/servers/:id      → disconnect + purge (404 if not this caller's)
//   GET    /mcp/oauth/callback      → completes the OAuth handshake, redirects to the portal
//
// The /v1/mcp/servers routes are CORS'd (same as /v1/research); the OAuth
// callback is a top-level browser navigation (the third-party MCP server's
// 302 back to us), not a portal fetch(), so it needs no CORS handling — only
// a safe, allowlisted redirect back to the portal's origin at the end.
//
// index.ts wires this whole surface through the single `tryHandleMcpRoute`
// dispatcher below (kept here, not inlined in index.ts, for the file's
// COMPLIANCE.md §4 line budget) — it still needs `isPortalCorsPath` to cover
// this surface for the shared OPTIONS-preflight branch.

import { requireSession } from "@/src/lib/auth-middleware"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { handlePortalPreflight, hasJsonContentType, isAllowedPortalOrigin, withPortalCors } from "@/src/lib/portal-cors"
import { guardUrl } from "@/src/do/deep-research/fetch-guard"
import type { McpConnectResult, McpServerSummary } from "./mcp-connections-do"
import type { Env } from "@/src/shared/types/env"

const DO_BASE = "https://mcp-connections.do"
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"
const DEFAULT_PORTAL_URL = "https://app.sigilix.ai"

/** The caller's stable identity + the 401 branch when unauthenticated. Mirrors
 *  deep-research routes.ts's `authorize()` exactly (same dual-auth shape). */
type CallerAuth = { scope: string } | { response: Response }

async function authorize(request: Request, env: Env, ctx: ExecutionContext): Promise<CallerAuth> {
  const session = await requireSession(request, env, ctx)
  if (session) return { scope: `session:${session.record.githubUserId}` }
  const tenant = await requireApiTenant(request, env, ctx)
  if ("caller" in tenant) return { scope: `tenant:${tenant.caller.installationId}` }
  return { response: tenant.response }
}

function resolveStub(env: Env, scope: string): DurableObjectStub {
  const id = env.MCP_CONNECTIONS.idFromName(scope)
  return env.MCP_CONNECTIONS.get(id)
}

/** POST /v1/mcp/servers — body { url, name? } → connected | auth_required. */
export async function handleMcpServersCreate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) return auth.response

  let body: { url?: unknown; name?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  const url = typeof body.url === "string" ? body.url.trim() : ""
  if (!url) return json({ error: "missing url" }, 400)

  // SSRF guard on the user-supplied URL BEFORE it ever reaches the DO (the DO
  // re-validates too — belt-and-suspenders — but rejecting here avoids even
  // spinning up/naming a DO instance for an obviously-blocked target).
  const guard = guardUrl(url)
  if (!guard.ok) return json({ error: `url not allowed: ${guard.reason}` }, 400)

  const name = typeof body.name === "string" ? body.name.trim() : ""
  const callbackUrl = new URL(request.url).origin + OAUTH_CALLBACK_PATH

  const stub = resolveStub(env, auth.scope)
  let response: Response
  try {
    response = await stub.fetch(`${DO_BASE}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: guard.url.toString(), name: name || undefined, callbackUrl }),
    })
  } catch (err) {
    console.error("mcp-servers: connect DO call failed", err instanceof Error ? err.message : err)
    return json({ error: "failed to connect" }, 502)
  }
  let result: McpConnectResult
  try {
    result = (await response.json()) as McpConnectResult
  } catch {
    return json({ error: "failed to connect" }, 502)
  }
  if (result.status === "error") return json({ error: result.error }, response.ok ? 502 : response.status)
  // The OAuth callback (GET /mcp/oauth/callback below) can only resolve a
  // SESSION scope (it authenticates off the browser's cookie, not a bearer
  // key) — an api-key/tenant caller that needs OAuth would hit a dead end:
  // the pending PKCE/state lives in a DIFFERENT DO than the one the callback
  // would resolve to. Reject up front with a clear message instead.
  if (result.status === "auth_required" && auth.scope.startsWith("tenant:")) {
    return json({ error: "this server requires OAuth, which is only supported from a signed-in browser session" }, 400)
  }
  return json(result)
}

/** GET /v1/mcp/servers — list the caller's connected servers. Fail-soft: a
 *  DO-fetch failure returns an empty list (logged), never a 500. */
export async function handleMcpServersList(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) return auth.response

  const stub = resolveStub(env, auth.scope)
  try {
    const response = await stub.fetch(`${DO_BASE}/list`, { method: "GET" })
    const body = (await response.json()) as { servers?: McpServerSummary[] }
    return json({ servers: Array.isArray(body.servers) ? body.servers : [] })
  } catch (err) {
    console.error("mcp-servers: list DO call failed", err instanceof Error ? err.message : err)
    return json({ servers: [] })
  }
}

/** DELETE /v1/mcp/servers/:id — disconnect + purge tokens. 404 when the id
 *  doesn't belong to (or exist for) the caller — no existence leak. */
export async function handleMcpServersDelete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<Response> {
  if (!id) return json({ error: "missing id" }, 400)
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) return auth.response

  const stub = resolveStub(env, auth.scope)
  let response: Response
  try {
    response = await stub.fetch(`${DO_BASE}/servers/${encodeURIComponent(id)}`, { method: "DELETE" })
  } catch (err) {
    console.error("mcp-servers: delete DO call failed", err instanceof Error ? err.message : err)
    return json({ error: "failed to disconnect" }, 502)
  }
  if (response.status === 404) return json({ error: "not found" }, 404)
  if (!response.ok) return json({ error: "failed to disconnect" }, 502)
  return json({ ok: true })
}

/**
 * GET /mcp/oauth/callback — the third-party MCP server's OAuth redirect back
 * to us. This is a top-level browser navigation carrying our own session
 * cookie (same as /auth/github/callback), so we authenticate it exactly like
 * the mutating routes above, resolve the caller's DO, forward the raw
 * query string in, and turn the SDK's result into a safe redirect back to
 * the portal. Never leaks OAuth internals to the browser beyond a plain
 * success/error flag on the redirect.
 */
export async function handleMcpOAuthCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const portalUrl = safePortalBase(env)
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) {
    return Response.redirect(`${portalUrl}/#/apps?mcpError=unauthenticated`, 302)
  }

  const url = new URL(request.url)
  const stub = resolveStub(env, auth.scope)
  try {
    const response = await stub.fetch(`${DO_BASE}/oauth-callback${url.search}`, { method: "GET" })
    const result = (await response.json()) as { authSuccess?: boolean; authError?: string }
    if (result.authSuccess) {
      return Response.redirect(`${portalUrl}/#/apps?mcpConnected=1`, 302)
    }
    return Response.redirect(`${portalUrl}/#/apps?mcpError=oauth_failed`, 302)
  } catch (err) {
    console.error("mcp-oauth-callback: DO call failed", err instanceof Error ? err.message : err)
    return Response.redirect(`${portalUrl}/#/apps?mcpError=oauth_failed`, 302)
  }
}

/** The portal origin to redirect back to. Falls back to the default portal
 *  origin unless OPENCLAW_PORTAL_URL is explicitly set to an allowlisted one
 *  (reuses the same CORS allowlist so this never redirects off-fleet). */
function safePortalBase(env: Env): string {
  const configured = env.OPENCLAW_PORTAL_URL
  if (!configured) return DEFAULT_PORTAL_URL
  try {
    const origin = new URL(configured).origin
    return isAllowedPortalOrigin(origin, env) ? origin : DEFAULT_PORTAL_URL
  } catch {
    return DEFAULT_PORTAL_URL
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function isMcpServersPath(pathname: string): boolean {
  return pathname === "/v1/mcp/servers" || pathname.startsWith("/v1/mcp/servers/")
}

/**
 * Single entry point index.ts calls for this whole feature: answers this
 * surface's own CORS preflight, matches method+path, dispatches to the right
 * handler, and applies portal CORS where needed. Returns `null` when the
 * request doesn't match anything here so the caller falls through to its own
 * routing (kept self-contained, rather than index.ts's shared preflight
 * branch, to stay inside index.ts's COMPLIANCE.md §4 line budget).
 */
export async function tryHandleMcpRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  if (request.method === "OPTIONS" && isMcpServersPath(url.pathname)) {
    return handlePortalPreflight(request, env)
  }
  if (request.method === "POST" && url.pathname === "/v1/mcp/servers") {
    return withPortalCors(request, await handleMcpServersCreate(request, env, ctx), env)
  }
  if (request.method === "GET" && url.pathname === "/v1/mcp/servers") {
    return withPortalCors(request, await handleMcpServersList(request, env, ctx), env)
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/v1/mcp/servers/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/mcp/servers/".length))
    return withPortalCors(request, await handleMcpServersDelete(request, env, ctx, id), env)
  }
  if (request.method === "GET" && url.pathname === OAUTH_CALLBACK_PATH) {
    return handleMcpOAuthCallback(request, env, ctx)
  }
  return null
}
