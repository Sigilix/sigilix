// Auth middleware: read the session cookie, look up the KV record,
// validate, and return either the live session or null. Used by
// /auth/welcome, /auth/me, and any future authenticated route.
//
// Touches the session's lastSeenAt as a fire-and-forget side effect so
// active users keep their sliding 30-day window.

import {
  deleteSession,
  getSession,
  readCookie,
  SESSION_COOKIE_NAME,
  type SessionRecord,
  touchSession,
} from "./auth-session"
import { findSessionIdentityProof } from "./user-identity-store"

interface AuthMiddlewareEnv {
  OPENCLAW_STATE: KVNamespace
  SIGILIX_PLATFORM_DB?: D1Database
}

export interface AuthedSession {
  sessionId: string
  record: SessionRecord
}

type IdentityRejectionReason = "missing_user_id" | "identity_deleted" | "github_identity_mismatch"

async function rejectDefinitivelyStaleSession(
  env: AuthMiddlewareEnv,
  sessionId: string,
  reason: IdentityRejectionReason,
): Promise<null> {
  console.log(JSON.stringify({ event: "auth-session-identity-rejected", reason }))
  try {
    await deleteSession({ kv: env.OPENCLAW_STATE, sessionId })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "auth-session-stale-revoke-failed",
        reason,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  return null
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

  // KV is the encrypted session store, not the durable account authority. Once
  // the platform DB is present, prove that this exact account still exists
  // before the session can authorize work or refresh its sliding TTL. Direct
  // D1Database reads execute on the primary, so a request beginning after the
  // account-deletion batch observes the committed user_identity deletion.
  if (env.SIGILIX_PLATFORM_DB) {
    if (typeof record.userId !== "string" || record.userId.trim().length === 0) {
      return rejectDefinitivelyStaleSession(env, sessionId, "missing_user_id")
    }

    let identity: Awaited<ReturnType<typeof findSessionIdentityProof>>
    try {
      identity = await findSessionIdentityProof(env.SIGILIX_PLATFORM_DB, record.userId)
    } catch (error) {
      // Backend ambiguity is not proof of deletion: fail closed without
      // destroying or refreshing a potentially recoverable live session.
      console.error(
        JSON.stringify({
          event: "auth-session-identity-backend-unavailable",
          err: error instanceof Error ? error.message : String(error),
        }),
      )
      return null
    }

    if (!identity) return rejectDefinitivelyStaleSession(env, sessionId, "identity_deleted")
    if (record.githubUserId != null && identity.githubUserId !== String(record.githubUserId)) {
      return rejectDefinitivelyStaleSession(env, sessionId, "github_identity_mismatch")
    }
  }

  // Sliding TTL refresh — fire-and-forget so cold paths aren't slowed.
  if (ctx) {
    ctx.waitUntil(touchSession({ kv: env.OPENCLAW_STATE, sessionId, record }))
  }
  return { sessionId, record }
}
