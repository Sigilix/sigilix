// GET /auth/session — cheap session-presence + identity probe for portal gates.
//
// Unlike /auth/me, this route deliberately does NOT resolve a GitHub role or
// decrypt/refresh a provider token. It proves only that the opaque server-side
// session cookie maps to a live SessionRecord and returns that record's identity.
// Authorization consumers must keep using installation-scoped gates (or
// /auth/me for the legacy aggregate settings role); session presence never
// implies admin authority.

import { requireSession } from "@/src/lib/auth-middleware"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export async function handleAuthSessionProbeRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  return json(
    {
      user: {
        login: authed.record.login,
        name: authed.record.name ?? null,
        githubUserId: authed.record.githubUserId ?? null,
        userId: authed.record.userId ?? null,
        email: authed.record.email ?? null,
        provider: authed.record.provider ?? "github",
      },
    },
    200,
  )
}
