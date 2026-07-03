// GET /auth/me — session-authed identity + role endpoint. The portal gates
// its settings UI on the `role` field: "admin" (can manage org settings) vs
// "member" (read-only). Role is derived from GitHub on every call via
// resolve-user-role.ts (no caching) using the session's decrypted GitHub
// user-to-server token.
//
// FAIL-SAFE: role derivation is wrapped so a missing encryption key, a
// decrypt failure, or a GitHub outage never turns into a 500 here — it just
// falls back to the least-privileged "member". Only /auth/me's own
// session-lookup failure (no cookie / expired session) returns 401.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { resolveUserRole, type UserRole } from "@/src/lib/resolve-user-role"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Never throws — any failure along this path resolves to "member" (least privilege). */
async function resolveRoleFailSafe(authed: AuthedSession, env: Env): Promise<UserRole> {
  try {
    if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
      console.error(JSON.stringify({ event: "auth-me-role-encryption-key-missing" }))
      return "member"
    }
    const accessToken = await decryptAccessToken(
      { encryptedAccessToken: authed.record.encryptedAccessToken, iv: authed.record.iv },
      authed.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
    return await resolveUserRole(accessToken, authed.record.login)
  } catch (error) {
    // Never log the token itself — only the fact that role derivation failed.
    console.error(
      JSON.stringify({
        event: "auth-me-role-derivation-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return "member"
  }
}

/** GET /auth/me — session-authed. Returns identity + the portal's admin/member gate. */
export async function handleAuthMeRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  const role = await resolveRoleFailSafe(authed, env)

  // Identity is nested under `user` (the portal reads `me.data.user.{login,
  // name,role}` — see the portal's setup/api.ts MeResponse). `name` is the
  // display name captured at login, null when the user has none or for a session
  // minted before that field existed (consumers fall back to `login`).
  //
  // sig-user-identity: also surface the persistent identity fields — `userId`
  // (the provider-agnostic account key), `email` (null until captured; the
  // portal shows its email-capture step when null), and `provider` (which login
  // minted this session). githubUserId is null for Google / email-password
  // sessions.
  return json(
    {
      user: {
        login: authed.record.login,
        name: authed.record.name ?? null,
        githubUserId: authed.record.githubUserId ?? null,
        userId: authed.record.userId ?? null,
        email: authed.record.email ?? null,
        provider: authed.record.provider ?? "github",
        role,
      },
    },
    200,
  )
}
