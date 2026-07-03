// Auth-attempt rate limiting (sig-user-identity) — a rolling fixed-window
// counter in KV, keyed per (action, subject). Used by the email/password login
// and signup routes to blunt credential-stuffing / signup-spam.
//
// Fail-direction: FAIL-OPEN. A KV fault must not lock legitimate users out of
// sign-in (availability > a soft abuse control here); it logs and allows. The
// hard security guarantee (a wrong password never authenticates) lives in the
// constant-time verify, not in this limiter.
//
// Keys are hashed subjects, never a raw email — this module never persists or
// logs an email address or password.

import { sha256Hex } from "./auth-bearer"

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
}

/**
 * Increment the counter for `${action}:${subject}` within a fixed window and
 * decide whether the attempt is allowed. `subject` (e.g. an email or client IP)
 * is hashed before it becomes part of the KV key so no address is stored.
 */
export async function checkAuthRateLimit(
  kv: KVNamespace,
  action: string,
  subject: string,
  opts: { max: number; windowSeconds: number },
): Promise<RateLimitDecision> {
  try {
    const bucket = Math.floor(Date.now() / 1000 / opts.windowSeconds)
    const subjectHash = (await sha256Hex(subject)).slice(0, 24)
    const key = `auth_rl:${action}:${bucket}:${subjectHash}`
    const current = Number((await kv.get(key)) ?? "0")
    const next = current + 1
    // Refresh TTL each write so the window key self-expires ~one window after
    // the last attempt (bounded, cheap).
    await kv.put(key, String(next), { expirationTtl: opts.windowSeconds * 2 })
    const remaining = Math.max(0, opts.max - next)
    return { allowed: next <= opts.max, remaining }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "auth-rate-limit-fail-open",
        action,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { allowed: true, remaining: opts.max }
  }
}

/** Best-effort client IP for rate-limit keying (Cloudflare sets cf-connecting-ip). */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown"
}
