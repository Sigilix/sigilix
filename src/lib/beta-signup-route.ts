// POST /beta/signup — private-beta email capture for app.sigilix.ai.
//
// Accepts a native form post (application/x-www-form-urlencoded) or JSON,
// validates the email, and emails it to BETA_NOTIFY_TO via Resend. Renders the
// branded landing page in its success/error state. Never throws.
//
// Abuse defenses on this unauthenticated, email-sending endpoint:
//   - reject oversized bodies by Content-Length BEFORE buffering;
//   - a hidden honeypot field silently absorbs bots (no email sent);
//   - a per-IP KV rate limit caps real submissions (fail-open on KV error).

import type { Env } from "@/src/shared/types/env"
import { renderBetaLandingPage } from "./beta-landing"
import { sendViaResend } from "./resend-send"

const MAX_BODY_BYTES = 4096
const MAX_EMAIL_LEN = 254
// Pragmatic single-line email check — not RFC-exhaustive, just a sane gate. The
// `\s` class also rejects CR/LF, blocking header-injection via the address.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const DEFAULT_TO = "support@sigilix.ai"
const DEFAULT_FROM = "Sigilix <beta@sigilix.ai>"

// Hidden form field bots tend to fill; humans never see it.
const HONEYPOT_FIELD = "company"

// Per-IP rate limit: at most RL_MAX submissions per RL_WINDOW_SECONDS.
const RL_MAX = 5
const RL_WINDOW_SECONDS = 3600

export async function handleBetaSignupRoute(request: Request, env: Env): Promise<Response> {
  // Reject oversized bodies up front — don't buffer megabytes into memory.
  const declaredLen = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return renderBetaLandingPage({
      status: 413,
      error: "That request was too large.",
    })
  }

  const raw = (await request.text()).slice(0, MAX_BODY_BYTES)
  const contentType = request.headers.get("content-type") ?? ""

  let email = ""
  let honeypot = ""
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as { email?: unknown; [k: string]: unknown }
      email = typeof parsed.email === "string" ? parsed.email.trim() : ""
      const hp = parsed[HONEYPOT_FIELD]
      honeypot = typeof hp === "string" ? hp.trim() : ""
    } catch {
      email = ""
    }
  } else {
    const params = new URLSearchParams(raw)
    email = (params.get("email") ?? "").trim()
    honeypot = (params.get(HONEYPOT_FIELD) ?? "").trim()
  }

  // Honeypot tripped → looks like a bot. Acknowledge without sending anything.
  if (honeypot) {
    return renderBetaLandingPage({ sent: true })
  }

  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    return renderBetaLandingPage({
      status: 400,
      error: "Please enter a valid email address.",
    })
  }

  if (await isRateLimited(env, request)) {
    return renderBetaLandingPage({
      status: 429,
      error: "Too many requests — please try again later.",
    })
  }

  const result = await sendViaResend(env, {
    to: env.BETA_NOTIFY_TO ?? DEFAULT_TO,
    from: env.BETA_NOTIFY_FROM ?? DEFAULT_FROM,
    replyTo: email,
    subject: "New private-beta request",
    text: `New private-beta signup request:\n\n${email}\n`,
  })

  if (!result.ok) {
    // Resend unconfigured or erroring — surface a clear fallback so a lead is
    // never silently lost. 502: the request was valid; our sender failed.
    return renderBetaLandingPage({
      status: 502,
      error: "Something went wrong on our end — please email support@sigilix.ai and we'll add you.",
    })
  }

  return renderBetaLandingPage({ sent: true })
}

// KV-backed per-IP counter. Fail-open: a KV hiccup must not block real signups.
async function isRateLimited(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP")
  if (!ip) return false
  const key = `beta-rl:${ip}`
  try {
    const current = Number((await env.OPENCLAW_STATE.get(key)) ?? "0") || 0
    if (current >= RL_MAX) return true
    await env.OPENCLAW_STATE.put(key, String(current + 1), {
      expirationTtl: RL_WINDOW_SECONDS,
    })
    return false
  } catch {
    return false
  }
}
