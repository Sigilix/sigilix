// Email-verification orchestration (sig-email-verification).
//
// Ties the token store (email-verification-store) to the Resend sender
// (email/send). Used by the signup route and the resend endpoint to mint a
// single-use token and email the verify link. Fail-soft: a send failure is
// reported to the caller (so the user can retry) but never crashes signup.

import { mintVerificationToken, VERIFY_TOKEN_TTL_HOURS } from "./email-verification-store"
import { sendVerificationEmail } from "./email/send"
import type { Env } from "@/src/shared/types/env"

/**
 * Public origin of the WORKER that serves GET /auth/verify. In prod
 * OPENCLAW_BASE_URL is the API hostname (https://api.sigilix.ai — the same base
 * the OAuth callbacks are registered under); the default matches that.
 */
export function verifyLinkBase(env: Env): string {
  return (env.OPENCLAW_BASE_URL ?? "https://api.sigilix.ai").replace(/\/+$/, "")
}

/** Build the absolute verify URL carrying the raw single-use token. */
export function buildVerifyUrl(env: Env, rawToken: string): string {
  return `${verifyLinkBase(env)}/auth/verify?token=${encodeURIComponent(rawToken)}`
}

export interface IssueArgs {
  userId: string
  email: string
  name?: string | null
}

/**
 * Mint a token + send the verify email. Returns `{ emailSent }` — the token is
 * always persisted (so a resend can supersede it), and `emailSent` reflects
 * whether Resend accepted the message so the caller can surface a retry.
 *
 * FAILS SOFT on the SEND (logged, emailSent=false) but PROPAGATES a token-store
 * fault (the mint is the security-relevant step and must not be swallowed).
 */
export async function mintAndSendVerification(env: Env, args: IssueArgs): Promise<{ emailSent: boolean }> {
  if (!env.SIGILIX_PLATFORM_DB) return { emailSent: false }
  const rawToken = await mintVerificationToken(env.SIGILIX_PLATFORM_DB, {
    userId: args.userId,
    email: args.email,
    nowIso: new Date().toISOString(),
  })
  const verifyUrl = buildVerifyUrl(env, rawToken)
  const result = await sendVerificationEmail(env, {
    to: args.email,
    verifyUrl,
    expiryHours: VERIFY_TOKEN_TTL_HOURS,
    ...(args.name ? { name: args.name } : {}),
  })
  return { emailSent: result.ok }
}
