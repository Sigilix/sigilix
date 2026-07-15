// Operator-only recovery for a Sigilix workspace whose final stored admin is no
// longer reachable. This endpoint is deliberately outside portal CORS and uses
// OPENCLAW_ADMIN_TOKEN, not a browser session. It can only restore an immutable
// GitHub user ID proven present in the exact installation's complete App roster.

import { recoverOrgWorkspaceAdmin } from "@/src/features/org-membership"
import { requireBearerToken } from "@/src/lib/auth-bearer"
import { fetchInstallationRoster } from "@/src/lib/org-members-roster"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { getAppInstallation } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const MAX_BODY_BYTES = 4 * 1024

interface RecoveryBody {
  installationId: number
  githubUserId: string
}

interface TenantInstallationRow {
  installation_id: unknown
}

export async function handleAdminOrgAccessRecoveryRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) return json({ error: "admin_endpoint_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)
  if (env.OPENCLAW_ORG_MEMBERSHIP_MODE !== "on") {
    return json({ error: "org_membership_disabled" }, 503)
  }
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const body = await parseBody(request)
  if (body instanceof Response) return body
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "org_access_unavailable" }, 503)

  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare("SELECT installation_id FROM tenant WHERE installation_id = ?")
      .bind(body.installationId)
      .first<TenantInstallationRow>()
    if (row === null) return json({ error: "installation_not_found" }, 404)
    if (row.installation_id !== body.installationId) throw new Error("tenant installation binding was malformed")
  } catch (error) {
    emitFailure("org-access-recovery-tenant-read-failed", error, body.installationId)
    return json({ error: "org_access_unavailable" }, 503)
  }

  let installation: Awaited<ReturnType<typeof getAppInstallation>>
  try {
    installation = await getAppInstallation(env.GITHUB_APP_ID ?? "", env.GITHUB_PRIVATE_KEY ?? "", body.installationId)
  } catch (error) {
    emitFailure("org-access-recovery-installation-lookup-failed", error, body.installationId)
    return json({ error: "org_access_unavailable" }, 503)
  }
  if (installation === null) return json({ error: "installation_not_found" }, 404)

  const roster = await fetchInstallationRoster(
    env,
    body.installationId,
    installation.accountLogin,
    installation.accountType,
  )
  if (!roster.complete) return json({ error: "org_roster_unavailable" }, 503)
  if (!roster.members.some((member) => member.githubUserId === body.githubUserId)) {
    return json({ error: "member_not_found" }, 404)
  }

  const nowIso = new Date().toISOString()
  try {
    const access = await recoverOrgWorkspaceAdmin(env.SIGILIX_PLATFORM_DB, {
      installationId: body.installationId,
      githubUserId: body.githubUserId,
      nowIso,
      updatedBy: "system:admin-token",
    })
    console.log(
      JSON.stringify({
        event: "org-access-operator-recovered",
        installationId: body.installationId,
        githubUserId: body.githubUserId,
      }),
    )
    return json({
      recovered: true,
      installationId: access.installationId,
      githubUserId: access.githubUserId,
      role: access.role,
    })
  } catch (error) {
    emitFailure("org-access-recovery-write-failed", error, body.installationId)
    return json({ error: "org_access_unavailable" }, 503)
  }
}

async function parseBody(request: Request): Promise<RecoveryBody | Response> {
  const raw = await readBodyCapped(request, MAX_BODY_BYTES)
  if (raw === null) return json({ error: "payload_too_large" }, 413)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return json({ error: "invalid_request" }, 400)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== "githubUserId,installationId") {
    return json({ error: "invalid_request" }, 400)
  }
  if (!Number.isSafeInteger(record.installationId) || Number(record.installationId) <= 0) {
    return json({ error: "invalid_installation_id" }, 400)
  }
  if (typeof record.githubUserId !== "string" || !/^[1-9]\d*$/.test(record.githubUserId)) {
    return json({ error: "invalid_github_user_id" }, 400)
  }
  return { installationId: Number(record.installationId), githubUserId: record.githubUserId }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

function emitFailure(event: string, error: unknown, installationId: number): void {
  console.error(
    JSON.stringify({
      event,
      installationId,
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}
