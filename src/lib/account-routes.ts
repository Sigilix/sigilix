// sig-settings-backends — the portal account-controls surface (P0, GDPR/SOC2).
//
// Pulled out of index.ts (at its size-budget ceiling) into one self-contained
// dispatcher — like portal-account-routes.ts / org-routes.ts — that owns its own
// portal-CORS preflight + response wrapping and returns null when the path isn't
// ours. Routes (all SESSION-authed, own-account only):
//   DELETE /v1/account              → delete + purge the caller's account
//   GET    /v1/account/export       → JSON download of the caller's OWN data
//   POST   /v1/account/logout-all   → revoke every session the caller holds
//
// SECURITY POSTURE:
//   • DELETE + POST are MUTATING on the SameSite=None session cookie, so both
//     REQUIRE `application/json` (hasJsonContentType) — that content-type is not
//     on the CORS safelist, forcing a preflight the portal-CORS allowlist gates
//     (see auth-session.ts's setSessionCookie doc). Skipping it is a CSRF hole.
//   • DELETE additionally requires a TYPED CONFIRMATION (`confirm` === the
//     caller's login or email) — an intentional, destructive-action gate on top
//     of the session, matching the portal's typed-confirmation modal.
//   • GET export is a read; a cross-site page can trigger it but can NEVER read
//     the body (withPortalCors echoes only an allowlisted Origin, never `*`), so
//     the sensitive payload is not exfiltratable cross-origin.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { clearSessionCookie } from "@/src/lib/auth-session"
import { hasJsonContentType, handlePortalPreflight, withPortalCors } from "@/src/lib/portal-cors"
import { gatherAccountExport, purgeUserAccount, revokeUserSessions, subjectFromSession } from "@/src/lib/account-store"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  })
}

/** The typed-confirmation value: matches the caller's login or email (case-insensitive). */
function confirmationMatches(confirm: string, session: AuthedSession): boolean {
  const needle = confirm.trim().toLowerCase()
  if (needle === "") return false
  if (needle === session.record.login.toLowerCase()) return true
  const email = session.record.email
  return email != null && needle === email.trim().toLowerCase()
}

/** DELETE /v1/account — delete + purge the caller's account. Typed-confirmation gated. */
async function handleDeleteAccount(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // NO ctx here (deliberate): passing it would schedule a fire-and-forget
  // touchSession KV write for the current session, which could land AFTER the
  // revoke sweep below and resurrect the just-deleted session. Reading without
  // ctx skips the touch entirely — the session is about to be revoked anyway.
  void ctx
  const session = await requireSession(request, env)
  if (!session) return json({ error: "unauthenticated" }, 401)
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const confirm = (body as { confirm?: unknown })?.confirm
  if (typeof confirm !== "string" || !confirmationMatches(confirm, session)) {
    return json({ error: "confirmation_mismatch", detail: "type your login or email to confirm" }, 400)
  }

  const subject = subjectFromSession(session.record)
  let purged: Awaited<ReturnType<typeof purgeUserAccount>>
  try {
    purged = await purgeUserAccount(env.SIGILIX_PLATFORM_DB, subject)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "account-delete-purge-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "delete_failed" }, 500)
  }

  // Revoke every session (including this one). Best-effort; the account rows are
  // already gone, so a stray un-revoked session record can no longer resolve to data.
  const sessionsRevoked = await revokeUserSessions(env.OPENCLAW_STATE, subject)

  // Clear the current cookie regardless, so the browser is logged out immediately.
  return json({ deleted: true, purged, sessionsRevoked }, 200, { "set-cookie": clearSessionCookie() })
}

/** GET /v1/account/export — JSON download of the caller's OWN data. */
async function handleExportAccount(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await requireSession(request, env, ctx)
  if (!session) return json({ error: "unauthenticated" }, 401)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)

  const subject = subjectFromSession(session.record)
  const data = await gatherAccountExport(env.SIGILIX_PLATFORM_DB, subject)
  const filename = `sigilix-account-export-${new Date().toISOString().slice(0, 10)}.json`
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  })
}

/** POST /v1/account/logout-all — revoke every session the caller holds. */
async function handleLogoutAll(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // NO ctx (see handleDeleteAccount): skip the sliding-TTL touch so it can't
  // race the revoke sweep and resurrect the current session.
  void ctx
  const session = await requireSession(request, env)
  if (!session) return json({ error: "unauthenticated" }, 401)
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const subject = subjectFromSession(session.record)
  const revoked = await revokeUserSessions(env.OPENCLAW_STATE, subject)
  return json({ revoked }, 200, { "set-cookie": clearSessionCookie() })
}

/**
 * Match + dispatch the /v1/account* routes. Answers this surface's own CORS
 * preflight and wraps every matched response with portal CORS. Returns null when
 * nothing here matches so the caller falls through to its own routing.
 */
export async function tryHandleAccountRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const isAccountPath =
    url.pathname === "/v1/account" || url.pathname === "/v1/account/export" || url.pathname === "/v1/account/logout-all"
  if (!isAccountPath) return null

  if (request.method === "OPTIONS") return handlePortalPreflight(request, env)

  if (request.method === "DELETE" && url.pathname === "/v1/account") {
    return withPortalCors(request, await handleDeleteAccount(request, env, ctx), env)
  }
  if (request.method === "GET" && url.pathname === "/v1/account/export") {
    return withPortalCors(request, await handleExportAccount(request, env, ctx), env)
  }
  if (request.method === "POST" && url.pathname === "/v1/account/logout-all") {
    return withPortalCors(request, await handleLogoutAll(request, env, ctx), env)
  }
  return null
}
