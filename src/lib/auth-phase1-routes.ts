// PHASE 1 auth surfaces — SCAFFOLDED, NOT SHIPPED. sig-user-identity.
//
// These endpoints are deliberately inert until deliberately finished (they are
// auth-critical and must not go out half-done). Each returns 501 unless its
// feature flag is explicitly enabled, and even the enabled path is a documented
// stub — the real logic + the schema/session wiring it still needs is listed in
// the identity report ("What is stubbed vs done").
//
//   MFA (TOTP), org-wide:
//     POST /v1/auth/mfa/enroll  — issue secret + otpauth URI (auth-totp.ts is
//                                 real); REMAINING: persist mfa_secret pending,
//                                 confirm-on-first-code, then set mfa_enabled=1;
//                                 an org-admin "require MFA" policy column +
//                                 a login-time challenge step.
//     POST /v1/auth/mfa/verify  — verify a code (verifyTotp is real); REMAINING:
//                                 the login flow must actually gate on it and a
//                                 recovery-codes fallback must exist first.
//
//   Email verification:
//     POST /v1/auth/verify-email/*  — REMAINING: a token table/KV, an email
//                                 sender (no provider wired yet), and flipping
//                                 email_verified=1 on confirm.
//
//   Password reset:
//     POST /v1/auth/password/reset/*  — REMAINING: a single-use reset token
//                                 (KV, short TTL), the same email sender, and a
//                                 set-new-password step that re-hashes.

import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from "./auth-totp"
import { requireSession } from "./auth-middleware"
import { hasJsonContentType } from "./portal-cors"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** "on" enables the (still-stub) enrolled path; anything else keeps the surface 501. */
function mfaEnabled(env: Env): boolean {
  return env.SIGILIX_MFA_MODE === "on"
}

/** POST /v1/auth/mfa/enroll — issues a fresh secret + otpauth URI (NOT yet persisted). */
export async function handleMfaEnrollStub(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!mfaEnabled(env)) return json({ error: "mfa_not_available", phase: 1 }, 501)
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  // The crypto is real; persistence + confirm-on-first-code is the remaining work.
  const secret = generateTotpSecret()
  const account = authed.record.email ?? authed.record.login
  const otpauthUri = buildOtpAuthUri({ secret, account, issuer: "Sigilix" })
  return json(
    {
      ok: true,
      stub: true,
      note: "MFA enrollment is scaffolded — this secret is NOT persisted and MFA is not enforced yet.",
      secret,
      otpauthUri,
    },
    200,
  )
}

/** POST /v1/auth/mfa/verify — verifies a code against a provided secret (no login gating yet). */
export async function handleMfaVerifyStub(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!mfaEnabled(env)) return json({ error: "mfa_not_available", phase: 1 }, 501)
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const b = body as Record<string, unknown> | null
  if (typeof b?.secret !== "string" || typeof b?.code !== "string") {
    return json({ error: "secret and code are required" }, 400)
  }
  const valid = await verifyTotp(b.secret, b.code)
  return json(
    { ok: valid, stub: true, note: "Login is not gated on MFA yet — see identity report." },
    valid ? 200 : 401,
  )
}

/** POST /v1/auth/verify-email and /v1/auth/password/reset — always 501 (no email sender wired). */
export function handlePhase1NotImplemented(): Response {
  return json(
    {
      error: "not_implemented",
      phase: 1,
      note: "Email verification + password reset are scaffolded; no email sender is wired yet.",
    },
    501,
  )
}
