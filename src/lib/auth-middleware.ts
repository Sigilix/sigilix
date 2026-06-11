// Auth middleware: read the session cookie, look up the KV record,
// validate, and return either the live session or null. Used by
// /auth/welcome, /auth/me, and any future authenticated route.
//
// Touches the session's lastSeenAt as a fire-and-forget side effect so
// active users keep their sliding 30-day window.

import { getSession, readCookie, SESSION_COOKIE_NAME, type SessionRecord, touchSession } from "./auth-session"

interface AuthMiddlewareEnv {
  OPENCLAW_STATE: KVNamespace
}

export interface AuthedSession {
  sessionId: string
  record: SessionRecord
}

export async function requireSession(
  request: Request,
  env: AuthMiddlewareEnv,
  ctx?: ExecutionContext,
): Promise<AuthedSession | null> {
  const sessionId = readCookie(request, SESSION_COOKIE_NAME)
  if (!sessionId) return null
  const record = await getSession({ kv: env.OPENCLAW_STATE, sessionId })
  if (!record) return null

  // Sliding TTL refresh — fire-and-forget so cold paths aren't slowed.
  if (ctx) {
    ctx.waitUntil(touchSession({ kv: env.OPENCLAW_STATE, sessionId, record }))
  }
  return { sessionId, record }
}
