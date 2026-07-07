// Identity + auth sub-router (sig-user-identity). Keeps src/index.ts (at the
// file-size ceiling) from growing: index.ts calls tryHandleIdentityRoute once
// and this module owns every new identity/auth path. Returns a Response when it
// handled the request, or null to let index.ts continue matching.
//
// Routing map (all fail-closed; see each handler):
//   GET  /auth/google/login        — Google OAuth kickoff (top-level nav)
//   GET  /auth/google/callback     — Google OAuth callback (top-level nav)
//   GET  /auth/verify              — email-verification confirm (top-level nav; marks verified, 302s to /login — NO session)
//   GET  /auth/providers           — which login methods are configured (portal reads this, CORS)
//   POST /v1/auth/signup           — email/password sign-up            (CORS; no session until verified)
//   POST /v1/auth/login            — email/password login              (CORS + session cookie; gated on verified)
//   POST /v1/auth/resend-verification — re-send a verify link          (CORS, rate-limited, neutral 200)
//   POST /v1/identity/email        — email capture                    (CORS, session-authed)
//   POST /v1/auth/mfa/enroll|verify        — PHASE 1 stubs            (CORS, 501 unless flagged)
//   POST /v1/auth/verify-email|password/reset — PHASE 1 stubs         (CORS, 501)

import { handleGoogleAuthCallback, handleGoogleAuthKickoff, isGoogleConfigured } from "./auth-oauth-google"
import { isGitlabConfigured } from "./auth-oauth-gitlab"
import { handleLoginRoute, handleSignupRoute } from "./auth-password-routes"
import { handleResendVerificationRoute, handleVerifyEmailRoute } from "./auth-verify-email-routes"
import { handleIdentityEmailRoute } from "./identity-email-route"
import { handleMfaEnrollStub, handleMfaVerifyStub, handlePhase1NotImplemented } from "./auth-phase1-routes"
import { handlePortalPreflight, withPortalCors } from "./portal-cors"
import type { Env } from "@/src/shared/types/env"

// The /v1 identity paths the portal calls cross-origin with credentials — they
// need the portal CORS wrapper + an OPTIONS preflight (see portal-cors.ts).
const IDENTITY_CORS_PATHS = new Set([
  "/v1/auth/signup",
  "/v1/auth/login",
  "/v1/auth/resend-verification",
  "/v1/identity/email",
  "/v1/auth/mfa/enroll",
  "/v1/auth/mfa/verify",
  "/v1/auth/verify-email",
  "/v1/auth/password/reset",
])

export async function tryHandleIdentityRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url
  const method = request.method

  // ── Google OAuth (top-level browser navigation — no CORS) ──
  if (method === "GET" && pathname === "/auth/google/login") return handleGoogleAuthKickoff(request, env)
  if (method === "GET" && pathname === "/auth/google/callback") return handleGoogleAuthCallback(request, env)

  // ── Email verification confirm (top-level nav from the email link — no CORS) ──
  if (method === "GET" && pathname === "/auth/verify") return handleVerifyEmailRoute(env, url)

  // ── Provider-config probe (portal reads cross-origin; simple GET, CORS) ──
  if (method === "GET" && pathname === "/auth/providers") {
    const body = {
      github: Boolean(env.GITHUB_OAUTH_CLIENT_ID),
      google: isGoogleConfigured(env),
      gitlab: isGitlabConfigured(env),
      password: true,
    }
    return withPortalCors(
      request,
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      env,
    )
  }

  // ── Portal CORS preflight for the credentialed /v1 identity POSTs ──
  if (method === "OPTIONS" && IDENTITY_CORS_PATHS.has(pathname)) {
    return handlePortalPreflight(request, env)
  }

  // ── Email/password auth ──
  if (method === "POST" && pathname === "/v1/auth/signup") {
    return withPortalCors(request, await handleSignupRoute(request, env, ctx), env)
  }
  if (method === "POST" && pathname === "/v1/auth/login") {
    return withPortalCors(request, await handleLoginRoute(request, env), env)
  }
  if (method === "POST" && pathname === "/v1/auth/resend-verification") {
    return withPortalCors(request, await handleResendVerificationRoute(request, env, ctx), env)
  }

  // ── Email capture ──
  if (method === "POST" && pathname === "/v1/identity/email") {
    return withPortalCors(request, await handleIdentityEmailRoute(request, env, ctx), env)
  }

  // ── PHASE 1 stubs (MFA / email-verify / password-reset) ──
  if (method === "POST" && pathname === "/v1/auth/mfa/enroll") {
    return withPortalCors(request, await handleMfaEnrollStub(request, env, ctx), env)
  }
  if (method === "POST" && pathname === "/v1/auth/mfa/verify") {
    return withPortalCors(request, await handleMfaVerifyStub(request, env, ctx), env)
  }
  if (method === "POST" && (pathname === "/v1/auth/verify-email" || pathname === "/v1/auth/password/reset")) {
    return withPortalCors(request, handlePhase1NotImplemented(), env)
  }

  return null
}
