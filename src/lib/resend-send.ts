// Minimal Resend transactional-email sender (no SDK, no deps).
//
// POSTs to the Resend REST API. Never throws — returns a tagged result so
// callers can degrade gracefully when the key is unset or the API errors.

import type { Env } from "@/src/shared/types/env"

export interface ResendMessage {
  to: string
  from: string
  subject: string
  text: string
  replyTo?: string
}

export type ResendResult = { ok: true; id: string } | { ok: false; status: number; error: string }

export async function sendViaResend(env: Env, msg: ResendMessage): Promise<ResendResult> {
  const key = env.RESEND_API_KEY
  if (!key) {
    return { ok: false, status: 0, error: "RESEND_API_KEY not configured" }
  }

  let res: Response
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: [msg.to],
        from: msg.from,
        subject: msg.subject,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    })
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : "fetch failed",
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return {
      ok: false,
      status: res.status,
      error: body.slice(0, 500) || res.statusText,
    }
  }

  const data = (await res.json().catch(() => ({}))) as { id?: string }
  return { ok: true, id: data.id ?? "" }
}
