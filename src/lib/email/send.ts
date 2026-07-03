// Transactional email sender (sig-email-verification) — Resend HTTP API.
//
// `sigilix.ai` is a verified Resend sending domain; mail goes out From
// "Sigilix <verify@sigilix.ai>" with Reply-To support@sigilix.ai.
//
// Fail-direction: FAIL-SOFT. A send fault (missing key, Resend 5xx, network)
// NEVER throws — it logs and returns `{ ok: false, error }` so a signup is not
// crashed by an email outage. The CALLER surfaces `ok` to the user (the portal
// shows a "couldn't send — resend" affordance) so a silent drop is still
// visible; this module only guarantees it won't take the request down.
//
// This module never logs the recipient address or the rendered body.

import { renderVerifyEmail } from "./render"
import type { Env } from "@/src/shared/types/env"

const RESEND_ENDPOINT = "https://api.resend.com/emails"
const FROM = "Sigilix <verify@sigilix.ai>"
const REPLY_TO = "support@sigilix.ai"

export interface SendResult {
  ok: boolean
  error?: string
}

export interface SendEmailArgs {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * POST a single transactional email to Resend. Fail-soft — returns
 * `{ ok: false, error }` (logged) instead of throwing on any fault.
 */
export async function sendEmail(env: Env, args: SendEmailArgs): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    console.error(JSON.stringify({ event: "email-send-skipped", reason: "no_resend_api_key" }))
    return { ok: false, error: "email_not_configured" }
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [args.to],
        reply_to: REPLY_TO,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    })
    if (!res.ok) {
      // Log ONLY the status — a Resend error body can echo request fields (the
      // recipient address, or the raw verify token embedded in html/text), so it
      // is never logged (this module must not leak an email, token, or hash).
      console.error(JSON.stringify({ event: "email-send-failed", status: res.status }))
      return { ok: false, error: `resend_${res.status}` }
    }
    return { ok: true }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "email-send-error", err: error instanceof Error ? error.message : String(error) }),
    )
    return { ok: false, error: "send_error" }
  }
}

export interface SendVerificationArgs {
  to: string
  name?: string | null
  verifyUrl: string
  expiryHours: number
}

/** Render + send the email-verification message. Fail-soft (see sendEmail). */
export function sendVerificationEmail(env: Env, args: SendVerificationArgs): Promise<SendResult> {
  const { subject, html, text } = renderVerifyEmail({
    verifyUrl: args.verifyUrl,
    expiryHours: args.expiryHours,
    ...(args.name ? { name: args.name } : {}),
  })
  return sendEmail(env, { to: args.to, subject, html, text })
}
