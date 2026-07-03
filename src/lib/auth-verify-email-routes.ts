// Email-verification routes (sig-email-verification). AUTH-CRITICAL.
//
//   GET  /auth/verify?token=…            — top-level browser nav from the email
//                                          link. Consumes the single-use token,
//                                          flips email_verified=1, and 302s to the
//                                          portal /login?verified=1. It does NOT
//                                          mint a session (see below).
//   POST /v1/auth/resend-verification    — { email } → re-send a verify link.
//                                          Rate-limited; returns a NEUTRAL 200 so
//                                          it can't be used to enumerate accounts.
//
// LOGIN-CSRF GUARD: GET /auth/verify is top-level-navigable with no browser-
// binding nonce, so it must NEVER mint a session. Auto-logging-in on this GET
// would let an ATTACKER's own verify link, opened by a victim, silently sign the
// victim in AS THE ATTACKER (login CSRF / session fixation). Instead we only mark
// the address verified and bounce to the portal login with a success signal; the
// user then signs in normally (email/password) and now passes the verified gate.
// Every failure path is likewise inert — no state changes, no session.
//
// This module never logs an email or a token.

import { consumeVerificationToken } from "./email-verification-store"
import { mintAndSendVerification } from "./email-verification"
import { checkAuthRateLimit, clientIp } from "./auth-rate-limit"
import { hasJsonContentType } from "./portal-cors"
import { findByEmail, markEmailVerified, normalizeEmail } from "./user-identity-store"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Portal origin that renders the login + /auth/verified landing. */
function portalBase(env: Env): string {
  return (env.OPENCLAW_PORTAL_URL ?? "https://app.sigilix.ai").replace(/\/+$/, "")
}

/** 302 to the portal /auth/verified landing with a FAILURE status to render. */
function redirectToLanding(env: Env, status: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `${portalBase(env)}/auth/verified?status=${encodeURIComponent(status)}` },
  })
}

/**
 * 302 to the portal login carrying a verified=1 success signal. No session is
 * issued here — the user signs in normally (and now clears the verified gate).
 */
function redirectToLogin(env: Env): Response {
  return new Response(null, { status: 302, headers: { location: `${portalBase(env)}/login?verified=1` } })
}

/**
 * GET /auth/verify?token=… — consume the token and mark the email verified, then
 * 302 to the portal login. Does NOT mint a session (login-CSRF guard above).
 * Every failure path is inert.
 */
export async function handleVerifyEmailRoute(env: Env, url: URL): Promise<Response> {
  if (!env.SIGILIX_PLATFORM_DB) {
    return redirectToLanding(env, "error")
  }
  const token = url.searchParams.get("token")
  if (!token) return redirectToLanding(env, "invalid")

  let consumed
  try {
    consumed = await consumeVerificationToken(env.SIGILIX_PLATFORM_DB, token, new Date().toISOString())
  } catch (error) {
    console.error(
      JSON.stringify({ event: "verify-consume-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return redirectToLanding(env, "error")
  }
  if (!consumed.ok) {
    // expired | used | not_found → a specific, non-authenticating status.
    return redirectToLanding(env, consumed.reason === "not_found" ? "invalid" : consumed.reason)
  }

  // Flip email_verified=1 only while the row's CURRENT email still matches the
  // address the token was minted for (guards against a post-mint email change).
  let verified = false
  try {
    verified = await markEmailVerified(env.SIGILIX_PLATFORM_DB, consumed.userId, consumed.email)
  } catch (error) {
    console.error(
      JSON.stringify({ event: "verify-mark-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return redirectToLanding(env, "error")
  }
  if (!verified) return redirectToLanding(env, "invalid")

  // Success → the email is confirmed. We deliberately do NOT mint a session on
  // this top-level GET (login-CSRF guard). Bounce to the portal login with a
  // success signal so it shows "Email verified — sign in."; the user logs in
  // normally and now passes the email_verified gate.
  return redirectToLogin(env)
}

/**
 * POST /v1/auth/resend-verification — { email }. Rate-limited per IP + per email.
 * Returns a NEUTRAL 200 whether or not the address maps to an unverified account,
 * so the endpoint reveals nothing about who is registered. Only a genuinely
 * unverified password account triggers an actual send.
 *
 * CONSTANT-TIME: the mint+send for a real account is dispatched fire-and-forget
 * via ctx.waitUntil, so the real-account and no-account branches return in the
 * same time. Awaiting the send only on the real branch would leak account
 * existence through response latency — defeating the neutral-200 above.
 */
export async function handleResendVerificationRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const b = body as Record<string, unknown> | null
  const email = normalizeEmail(typeof b?.email === "string" ? b.email : null)
  // Neutral success even for a malformed address — never signal validity here.
  if (!email) return json({ ok: true }, 200)

  // Rate limit per IP + per email (this endpoint sends mail). Fail-OPEN on a KV
  // fault, consistent with the signup/login limiters (availability > this soft
  // control). The residual blast radius under a limiter outage is deliberately
  // small: a send only fires for a REAL, unverified, password-owning account
  // that holds the address (see below), the response is always neutral, and each
  // send supersedes the prior token — so the worst case is re-emailing a genuine
  // unverified user, never spamming arbitrary victims or leaking existence.
  const [ipRl, emailRl] = await Promise.all([
    checkAuthRateLimit(env.OPENCLAW_STATE, "resend-verify-ip", clientIp(request), { max: 5, windowSeconds: 3600 }),
    checkAuthRateLimit(env.OPENCLAW_STATE, "resend-verify-email", email, { max: 3, windowSeconds: 3600 }),
  ])
  if (!ipRl.allowed || !emailRl.allowed) return json({ error: "rate_limited" }, 429)

  try {
    const identity = await findByEmail(env.SIGILIX_PLATFORM_DB, email)
    // Only resend for an UNVERIFIED, password-capable account that still owns the
    // address. OAuth-only or already-verified accounts get the same neutral 200.
    // Dispatch the mint+send fire-and-forget so this branch returns as fast as the
    // no-account branch (no existence-revealing latency); the send is fail-soft.
    if (identity && identity.email && !identity.emailVerified && identity.providers.includes("password")) {
      ctx.waitUntil(
        mintAndSendVerification(env, {
          userId: identity.userId,
          email: identity.email,
          name: identity.name,
        }).catch((error) => {
          console.error(
            JSON.stringify({
              event: "resend-verify-dispatch-failed",
              err: error instanceof Error ? error.message : String(error),
            }),
          )
        }),
      )
    }
  } catch (error) {
    // Never leak a fault as a distinguishable response — log and stay neutral.
    console.error(
      JSON.stringify({ event: "resend-verify-failed", err: error instanceof Error ? error.message : String(error) }),
    )
  }
  return json({ ok: true }, 200)
}
