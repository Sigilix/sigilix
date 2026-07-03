// Email/password sign-up + login (launch P0 — sig-user-identity).
//
//   POST /v1/auth/signup  { email, password, name? }  -> 201, verificationRequired (NO session)
//   POST /v1/auth/login   { email, password }          -> 200 + session cookie (gated on verified)
//
// AUTH-CRITICAL. Never logs an email or password. Passwords are slow-hashed
// (auth-password.ts) and only the hash is stored (user_credential). Login is a
// constant-time verify and returns a GENERIC error for both "no such user" and
// "wrong password" so the endpoint can't be used to enumerate accounts. Both
// routes are rate-limited (auth-rate-limit.ts) and require an application/json
// Content-Type (the CSRF guard for the SameSite=None session cookie).
//
// EMAIL VERIFICATION (sig-email-verification): a new email/password account is
// UNVERIFIED, so signup issues NO session — it mints a single-use token and
// emails a verify link (fail-soft). Login is GATED on email_verified: an
// unverified account gets a 403 `email_unverified` (after the password check, so
// it never leaks existence) carrying the email so the portal can offer a resend.
// The session that login mints is the SAME opaque session as the OAuth flows
// (createSession → __Host-sigilix_session), so a verified email/password user is
// treated identically to a GitHub/Google user. OAuth logins are provider-verified
// and never route through here, so they are never subject to this gate.

import { createSession, mintSessionId, setSessionCookie } from "./auth-session"
import { hashPassword, isAcceptablePassword, MIN_PASSWORD_LENGTH, needsRehash, verifyPassword } from "./auth-password"
import { checkAuthRateLimit, clientIp } from "./auth-rate-limit"
import { mintAndSendVerification } from "./email-verification"
import { hasJsonContentType } from "./portal-cors"
import {
  createPasswordIdentity,
  findByEmail,
  getPasswordHash,
  isPlausibleEmail,
  normalizeEmail,
  touchLastLogin,
  updatePasswordHash,
} from "./user-identity-store"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(body), { status, headers })
}

// A precomputed hash of a random throwaway password. Verifying against it on the
// "no such user" branch keeps the login path's timing roughly constant whether
// or not the email exists (defense against enumeration-by-timing). Its iteration
// count MUST track DEFAULT_ITERATIONS (auth-password.ts) so the dummy verify
// costs the same as a real one — otherwise the timing gap re-opens the oracle.
const DUMMY_HASH = "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

function extractCreds(
  body: unknown,
): { email: string; password: string; name: string | null; remember: boolean } | null {
  if (body == null || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  if (typeof b.email !== "string" || typeof b.password !== "string") return null
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120) : null
  // "Remember me": persistent 30-day session unless the client explicitly
  // opts out with `remember: false`. Any non-boolean (or absent) value keeps
  // the persistent default, so an older client that never sends the flag is
  // unaffected.
  const remember = b.remember !== false
  return { email: b.email, password: b.password, name, remember }
}

/** POST /v1/auth/signup — create an email/password account (NO session; sends a verify email). */
export async function handleSignupRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) return json({ error: "auth_misconfigured" }, 503)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const creds = extractCreds(body)
  if (!creds) return json({ error: "email and password are required" }, 400)

  const email = normalizeEmail(creds.email)
  if (!email || !isPlausibleEmail(email)) return json({ error: "invalid_email" }, 400)
  if (!isAcceptablePassword(creds.password)) {
    return json({ error: "weak_password", minLength: MIN_PASSWORD_LENGTH }, 400)
  }

  // Rate-limit signups per IP (spam control) AND per email. The per-email limit
  // blunts abuse of the 409 `email_taken` response as an existence oracle: an
  // attacker can no longer probe many addresses from one email bucket, and the
  // same address can't be hammered from rotating IPs. Fail-open (availability >
  // this soft control). NOTE: a residual oracle remains — a single 409 still
  // reveals that one address is registered. True neutrality needs the (not-yet-
  // shipped) email-verification sender to confirm out-of-band instead of via the
  // sync response; until then this rate limit is the mitigation.
  const [ipRl, emailRl] = await Promise.all([
    checkAuthRateLimit(env.OPENCLAW_STATE, "signup-ip", clientIp(request), { max: 10, windowSeconds: 3600 }),
    checkAuthRateLimit(env.OPENCLAW_STATE, "signup-email", email, { max: 5, windowSeconds: 3600 }),
  ])
  if (!ipRl.allowed || !emailRl.allowed) return json({ error: "rate_limited" }, 429)

  let result
  try {
    const passwordHash = await hashPassword(creds.password)
    result = await createPasswordIdentity(env.SIGILIX_PLATFORM_DB, {
      email,
      passwordHash,
      name: creds.name,
      nowIso: new Date().toISOString(),
    })
  } catch (error) {
    console.error(
      JSON.stringify({ event: "signup-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return json({ error: "signup_failed" }, 500)
  }
  if (!result.ok) {
    // Email already registered (possibly via OAuth). Tell the user to log in —
    // we never attach a password to a pre-existing account from an unauthed POST.
    return json({ error: "email_taken" }, 409)
  }

  // A new email/password account is UNVERIFIED. We do NOT issue a session here —
  // the user must confirm the email first (login is gated on email_verified).
  //
  // CONSTANT-TIME: dispatch the mint+send fire-and-forget via ctx.waitUntil so the
  // new-account response returns in the same time as the `email_taken` 409 above —
  // awaiting the network send only on the new-account path would leak, via latency,
  // that the address was previously unregistered. The send is fail-soft (logged),
  // and the user always has POST /v1/auth/resend-verification to recover.
  ctx.waitUntil(
    mintAndSendVerification(env, {
      userId: result.identity.userId,
      email: result.identity.email ?? email,
      name: result.identity.name,
    }).catch((error) => {
      console.error(
        JSON.stringify({
          event: "signup-verify-issue-failed",
          err: error instanceof Error ? error.message : String(error),
        }),
      )
    }),
  )
  // `emailSent: true` reflects that a verify email was DISPATCHED (best-effort) —
  // its outcome is intentionally not awaited (see constant-time note). The portal
  // still offers a resend affordance if the mail never arrives.
  return json({ ok: true, userId: result.identity.userId, verificationRequired: true, emailSent: true }, 201)
}

/** POST /v1/auth/login — verify an email/password credential + mint a session. */
export async function handleLoginRoute(request: Request, env: Env): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) return json({ error: "auth_misconfigured" }, 503)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const creds = extractCreds(body)
  if (!creds) return json({ error: "email and password are required" }, 400)
  const email = normalizeEmail(creds.email)
  if (!email) return json({ error: "invalid_credentials" }, 401)

  // Rate-limit per IP + per email (credential stuffing). Fail-open.
  const [ipRl, emailRl] = await Promise.all([
    checkAuthRateLimit(env.OPENCLAW_STATE, "login-ip", clientIp(request), { max: 30, windowSeconds: 900 }),
    checkAuthRateLimit(env.OPENCLAW_STATE, "login-email", email, { max: 10, windowSeconds: 900 }),
  ])
  if (!ipRl.allowed || !emailRl.allowed) return json({ error: "rate_limited" }, 429)

  let identity
  let storedHash: string | null = null
  try {
    identity = await findByEmail(env.SIGILIX_PLATFORM_DB, email)
    if (identity) storedHash = await getPasswordHash(env.SIGILIX_PLATFORM_DB, identity.userId)
  } catch (error) {
    console.error(
      JSON.stringify({ event: "login-lookup-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return json({ error: "login_failed" }, 500)
  }

  // Constant-ish time: always run a verify (dummy hash when the account/credential
  // is absent) so a missing account can't be told apart by response timing.
  const ok = await verifyPassword(creds.password, storedHash ?? DUMMY_HASH)
  if (!identity || !storedHash || !ok) {
    return json({ error: "invalid_credentials" }, 401)
  }

  // Gate on email verification. An email/password account cannot complete login
  // until it has confirmed the address (OAuth providers are provider-verified and
  // never reach this route). We surface a DISTINCT state — only AFTER the password
  // has been proven correct, so this never leaks whether an address is registered
  // to an unauthenticated probe — with the email so the portal can offer a resend.
  if (!identity.emailVerified) {
    return json({ error: "email_unverified", email: identity.email ?? email }, 403)
  }

  // Transparent work-factor upgrade + last-login touch — both best-effort.
  try {
    if (needsRehash(storedHash)) {
      const upgraded = await hashPassword(creds.password)
      await updatePasswordHash(env.SIGILIX_PLATFORM_DB, identity.userId, upgraded, new Date().toISOString())
    }
    await touchLastLogin(env.SIGILIX_PLATFORM_DB, identity.userId, new Date().toISOString())
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "login-postverify-nonfatal",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  const sessionId = mintSessionId()
  await createSession({
    kv: env.OPENCLAW_STATE,
    sessionId,
    login: identity.email ?? email,
    userId: identity.userId,
    provider: "password",
    remember: creds.remember,
    encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.name ? { name: identity.name } : {}),
  })
  return json({ ok: true, userId: identity.userId }, 200, {
    "set-cookie": setSessionCookie(sessionId, creds.remember),
  })
}
