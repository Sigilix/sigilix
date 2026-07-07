// Auth/identity sub-dispatcher (COMPLIANCE.md §4). Keeps src/index.ts under the
// file-size ceiling by owning the user-facing auth surface as ONE cohesive block
// that index.ts calls once (handleAuthRoutes). Returns a Response when it handled
// the request, or null to let index.ts continue matching. Behavior is
// byte-identical to the inline branches this replaces — same paths, methods, CORS
// (withPortalCors on the credentialed reads), and session gating.
//
// Routing map (relative order preserved from the old inline dispatch):
//   GET  /auth/github               — GitHub OAuth kickoff (top-level nav)
//   GET  /auth/github/callback      — GitHub OAuth callback (top-level nav)
//   GET  /auth/welcome              — session-gated welcome page (302 → / if not authed)
//   GET  /auth/me                   — session/whoami (portal reads cross-origin, CORS)
//   POST /auth/logout               — clears the session cookie
//   GET  /auth/install-redirect     — GitHub App install kickoff (mints CSRF nonce)
//   GET  /setup                     — GitHub App Setup URL callback
//   …then delegates to tryHandleIdentityRoute (Google OAuth + /v1/auth/* + email-capture)…
//   GET  /auth/gitlab|bitbucket|azure — deferred-provider 501 stubs (so "Soon" buttons don't 404)

import { handleGitHubAuthCallback, handleGitHubAuthKickoff, handleLogout } from "@/src/lib/auth-oauth-github"
import { requireSession } from "@/src/lib/auth-middleware"
import { handleAuthMeRoute } from "@/src/lib/auth-me-route"
import { tryHandleIdentityRoute } from "@/src/lib/identity-router"
import { renderWelcomePage } from "@/src/lib/auth-welcome"
import { readCookie, SESSION_COOKIE_NAME } from "@/src/lib/auth-session"
import { handleInstallRedirect, handleSetupRoute } from "@/src/lib/auth-setup-route"
import { withPortalCors } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"

/**
 * User-facing auth/identity dispatch. Returns a Response when it owns the route,
 * or null to fall through to the rest of index.ts's matching. Slotted at the same
 * position the inline `// Phase 5 user OAuth` block occupied — after the Slack GET
 * routes and before the portal-cors path block — so ordering is unchanged.
 */
export async function handleAuthRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url
  const method = request.method

  // ─── Phase 5 user OAuth (ARC-163) ────────────────────────────
  if (method === "GET" && pathname === "/auth/github") {
    return handleGitHubAuthKickoff(request, env)
  }
  if (method === "GET" && pathname === "/auth/github/callback") {
    return handleGitHubAuthCallback(request, env)
  }
  if (method === "GET" && pathname === "/auth/welcome") {
    const authed = await requireSession(request, env, ctx)
    if (!authed) {
      return new Response(null, { status: 302, headers: { location: "/" } })
    }
    return renderWelcomePage(authed.record)
  }
  if (method === "GET" && pathname === "/auth/me") {
    // #155: portal reads this cross-origin with credentials — needs CORS (simple GET, no preflight).
    return withPortalCors(request, await handleAuthMeRoute(request, env, ctx), env)
  }
  if (method === "POST" && pathname === "/auth/logout") {
    // sig-portal-bugs: the portal (app.sigilix.ai) calls this cross-origin with
    // `credentials: "include"`. Without the CORS-with-credentials grant the
    // browser blocks the response AND drops its Set-Cookie, so logout silently
    // does nothing. Wrap it (the OPTIONS preflight is handled in index.ts, which
    // lists /auth/logout as a portal-CORS path).
    const sessionId = readCookie(request, SESSION_COOKIE_NAME)
    return withPortalCors(request, await handleLogout(request, env, sessionId), env)
  }
  // #155 onboarding-backend FOUNDATION (slice 1 of 2): the GitHub App Setup
  // URL handler + the install-redirect kickoff that mints its CSRF nonce.
  if (method === "GET" && pathname === "/auth/install-redirect") {
    return handleInstallRedirect(request, env, ctx)
  }
  if (method === "GET" && pathname === "/setup") {
    return handleSetupRoute(request, env, ctx)
  }

  // sig-user-identity: Google OAuth + email/password + email-capture + phase-1 stubs (identity-router.ts).
  const identityResponse = await tryHandleIdentityRoute(request, env, ctx, url)
  if (identityResponse) return identityResponse

  // Stubs for deferred providers — 501 so "Soon" buttons don't 404. (Google
  // is live at /auth/google/login; email/password is POST /v1/auth/*.)
  if (
    method === "GET" &&
    (pathname === "/auth/gitlab" || pathname === "/auth/bitbucket" || pathname === "/auth/azure")
  ) {
    return new Response("provider not implemented yet — see /\n", {
      status: 501,
      headers: { "content-type": "text/plain" },
    })
  }

  return null
}
