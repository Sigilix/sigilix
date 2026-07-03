// Email-verification routes (sig-email-verification). AUTH-CRITICAL.
//
//   GET  /auth/verify?token=…            — top-level browser nav from the email
//                                          link. Consumes the single-use token,
//                                          flips email_verified=1, mints a session,
//                                          and 302s to the portal /auth/verified.
//   POST /v1/auth/resend-verification    — { email } → re-send a verify link.
//                                          Rate-limited; returns a NEUTRAL 200 so
//                                          it can't be used to enumerate accounts.
//
// The GET flow mirrors the OAuth callback: it is top-level navigation (no CORS),
// sets the __Host session cookie, and redirects. A failed/expired/used token is
// INERT — no state changes and no session is issued; the user is bounced to the
// portal landing with a status so it can offer a resend.
//
// This module never logs an email or a token.

import { consumeVerificationToken } from "./email-verification-store"
import { mintAndSendVerification } from "./email-verification"
import { createSession, mintSessionId, setSessionCookie } from "./auth-session"
import { checkAuthRateLimit, clientIp } from "./auth-rate-limit"
import { hasJsonContentType } from "./portal-cors"
import { findByEmail, findByUserId, markEmailVerified, normalizeEmail } from "./user-identity-store"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Portal origin that renders the /auth/verified landing. */
function portalBase(env: Env): string {
  return (env.OPENCLAW_PORTAL_URL ?? "https://app.sigilix.ai").replace(/\/+$/, "")
}

/** 302 to the portal landing with a status the page can render. */
function redirectToLanding(env: Env, status: string, extraCookie?: string): Response {
  const headers = new Headers({ location: `${portalBase(env)}/auth/verified?status=${encodeURIComponent(status)}` })
  if (extraCookie) headers.append("set-cookie", extraCookie)
  return new Response(null, { status: 302, headers })
}

/**
 * GET /auth/verify?token=… — consume the token, verify the email, log the user
 * in, and redirect to the portal. Every failure path is inert (no session).
 */
export async function handleVerifyEmailRoute(env: Env, url: URL): Promise<Response> {
  if (!env.SIGILIX_PLATFORM_DB || !env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
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
  let identity
  try {
    verified = await markEmailVerified(env.SIGILIX_PLATFORM_DB, consumed.userId, consumed.email)
    identity = verified ? await findByUserId(env.SIGILIX_PLATFORM_DB, consumed.userId) : null
  } catch (error) {
    console.error(
      JSON.stringify({ event: "verify-mark-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return redirectToLanding(env, "error")
  }
  if (!verified || !identity) return redirectToLanding(env, "invalid")

  // Success → log the user in (they proved email ownership) and land them in-app.
  const sessionId = mintSessionId()
  await createSession({
    kv: env.OPENCLAW_STATE,
    sessionId,
    login: identity.email ?? consumed.email,
    userId: identity.userId,
    provider: "password",
    remember: true,
    encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.name ? { name: identity.name } : {}),
  })
  return redirectToLanding(env, "ok", setSessionCookie(sessionId, true))
}

/**
 * POST /v1/auth/resend-verification — { email }. Rate-limited per IP + per email.
 * Returns a NEUTRAL 200 whether or not the address maps to an unverified account,
 * so the endpoint reveals nothing about who is registered. Only a genuinely
 * unverified password account triggers an actual send.
 */
export async function handleResendVerificationRoute(request: Request, env: Env): Promise<Response> {
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
    if (identity && identity.email && !identity.emailVerified && identity.providers.includes("password")) {
      await mintAndSendVerification(env, {
        userId: identity.userId,
        email: identity.email,
        name: identity.name,
      })
    }
  } catch (error) {
    // Never leak a fault as a distinguishable response — log and stay neutral.
    console.error(
      JSON.stringify({ event: "resend-verify-failed", err: error instanceof Error ? error.message : String(error) }),
    )
  }
  return json({ ok: true }, 200)
}
