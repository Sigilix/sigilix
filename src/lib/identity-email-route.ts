// Email capture (launch P0 — sig-user-identity).
//
//   POST /v1/identity/email  { email }  -> 200 { ok: true }
//
// A GitHub login can arrive with a PRIVATE email (GitHub returns null), so the
// identity row is created without one. The portal shows a small "What's your
// email?" step whenever /auth/me reports no email, and PATCHes it here. Session-
// authed (the same cookie as the rest of the portal), CSRF-guarded (JSON
// Content-Type), validated + persisted to user_identity, and mirrored onto the
// live session so the prompt disappears without a re-login.

import { requireSession } from "./auth-middleware"
import { setSessionEmail } from "./auth-session"
import { hasJsonContentType } from "./portal-cors"
import { isPlausibleEmail, normalizeEmail, setIdentityEmail } from "./user-identity-store"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export async function handleIdentityEmailRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)

  // The identity PK is required to target the right row. Legacy sessions minted
  // before sig-user-identity lack it — fail closed (they can re-login to get one).
  const userId = authed.record.userId
  if (!userId) return json({ error: "identity_not_linked" }, 409)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const rawEmail = (body as Record<string, unknown> | null)?.email
  if (typeof rawEmail !== "string") return json({ error: "email is required" }, 400)
  const email = normalizeEmail(rawEmail)
  if (!email || !isPlausibleEmail(email)) return json({ error: "invalid_email" }, 400)

  try {
    await setIdentityEmail(env.SIGILIX_PLATFORM_DB, userId, email)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // The UNIQUE index rejects an email already owned by another account.
    if (/UNIQUE|constraint/i.test(msg)) return json({ error: "email_taken" }, 409)
    console.error(JSON.stringify({ event: "identity-email-set-failed", err: msg }))
    return json({ error: "email_update_failed" }, 500)
  }

  // Best-effort mirror onto the session so /auth/me reflects it immediately.
  try {
    await setSessionEmail({ kv: env.OPENCLAW_STATE, sessionId: authed.sessionId, record: authed.record, email })
  } catch {
    // Non-fatal: the DB is the source of truth; /auth/me re-reads it.
  }

  return json({ ok: true, email }, 200)
}
