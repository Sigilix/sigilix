import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

export type RuntimePrincipal =
  | { kind: "session"; scope: string; session: AuthedSession }
  | { kind: "tenant"; scope: string; installationId: number }

export type RuntimePrincipalAuth = { principal: RuntimePrincipal } | { response: Response }

/**
 * Resolve the persisted namespace for a portal session. GitHub sessions keep
 * their existing numeric namespace because changing an already-persisted DO key
 * would strand MCP OAuth tokens. Provider-agnostic sessions use the durable
 * user_identity UUID. A future namespace migration can move GitHub sessions to
 * userId only after their DO state is copied explicitly; silently switching the
 * key at request time is not migration-safe.
 */
export function runtimeSessionScope(record: Pick<SessionRecord, "githubUserId" | "userId">): string | null {
  if (Number.isSafeInteger(record.githubUserId) && (record.githubUserId ?? 0) > 0) {
    return `session:${record.githubUserId}`
  }
  const userId = record.userId?.trim()
  if (userId && userId.length <= 128) return `session:${userId}`
  return null
}

/** Stable human subject carried through MCP OAuth callback state. Unlike the
 * vault scope, this prefers the provider-agnostic user identity so a refreshed
 * browser session can complete the same flow without depending on a cookie id. */
export function runtimeSessionSubject(record: Pick<SessionRecord, "githubUserId" | "userId">): string | null {
  const userId = record.userId?.trim()
  if (userId && userId.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(userId)) return userId
  if (Number.isSafeInteger(record.githubUserId) && (record.githubUserId ?? 0) > 0) {
    return String(record.githubUserId)
  }
  return null
}

/**
 * Durable runtime namespaces must identify one real portal seat or one real
 * installation. DeepResearchDO receives the creator as opaque persisted state,
 * so it re-validates the shape before using it as an MCP DO name instead of
 * trusting that an internal caller always passed the route-resolved value.
 */
export function isStableRuntimeScope(scope: string): boolean {
  if (scope.startsWith("session:")) {
    const subject = scope.slice("session:".length).trim()
    return (
      subject.length > 0 &&
      subject.length <= 128 &&
      subject !== "anon" &&
      subject !== "anonymous" &&
      !/[\u0000-\u001f\u007f]/.test(subject)
    )
  }
  if (!scope.startsWith("tenant:")) return false
  const rawId = scope.slice("tenant:".length)
  if (!/^\d+$/.test(rawId)) return false
  const installationId = Number(rawId)
  return Number.isSafeInteger(installationId) && installationId > 0
}

/**
 * Shared session-or-API-key identity gate for customer-controlled runtimes.
 * Unlike operator routes, runtime data and credentials must always bind to one
 * stable seat or one real installation. The legacy global bearer (-1) has no
 * tenant boundary and is therefore denied here.
 */
export async function requireRuntimePrincipal(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<RuntimePrincipalAuth> {
  const session = await requireSession(request, env, ctx)
  if (session) {
    const scope = runtimeSessionScope(session.record)
    if (!scope) return { response: jsonError("stable_identity_required", 401) }
    return { principal: { kind: "session", scope, session } }
  }

  const tenant = await requireApiTenant(request, env, ctx)
  if ("response" in tenant) return tenant
  const installationId = tenant.caller.installationId
  if (
    installationId === LEGACY_TENANT_INSTALLATION_ID ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0
  ) {
    return { response: jsonError("tenant_scope_required", 403) }
  }
  return { principal: { kind: "tenant", scope: `tenant:${installationId}`, installationId } }
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  })
}
