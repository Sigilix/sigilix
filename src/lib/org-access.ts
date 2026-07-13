// Central session authorization for one exact GitHub App installation.
//
// Every caller must first prove that its fresh GitHub user token can see the
// requested installation. The rollout flag changes only WHERE the scoped role
// comes from:
//   off (default) -> the exact live GitHub installation scope (back-compat)
//   on            -> org_workspace_access; GitHub admin is used only to seed
//                    the first stored admin atomically
//
// There is deliberately no aggregate "admin of any installation" fallback and
// no live-role OR stored-role authorization in `on` mode.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { resolveExactUserInstallationScope, type UserRole } from "@/src/lib/resolve-user-role"
import {
  bootstrapFirstOrgAdmin,
  hasActiveOrgAdmin,
  isOrgWorkspaceGithubUserId,
  readOrgWorkspaceAccess,
  type OrgWorkspaceAccess,
} from "@/src/features/org-membership"
import type { Env } from "@/src/shared/types/env"

export type OrgAccessRequiredRole = UserRole

export type OrgAccessResult =
  | {
      ok: true
      session: AuthedSession
      accessToken: string
      installationId: number
      githubUserId: string
      login: string
      role: UserRole
    }
  | { ok: false; response: Response }

export type OrgRolePolicyResult = { ok: true; role: UserRole } | { ok: false; response: Response }

export type OrgMembershipMode = "off" | "on"
export type OrgAccessEnv = Env

export interface RequireOrgAccessOptions {
  requiredRole: OrgAccessRequiredRole
}

function jsonError(error: string, status: number): OrgAccessResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  }
}

function roleSatisfies(actual: UserRole, required: OrgAccessRequiredRole): boolean {
  return required === "member" || actual === "admin"
}

function resolveOrgMembershipMode(env: Env): OrgMembershipMode {
  return env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on" ? "on" : "off"
}

type StoredAccessState = { kind: "absent" } | { kind: "active"; access: OrgWorkspaceAccess } | { kind: "denied" }

/**
 * Treat any malformed/cross-tenant row as denied, not absent. Only a genuine
 * null can enter first-admin bootstrap; a helper bug must never bootstrap from
 * a row belonging to another installation or identity.
 */
function classifyStoredAccess(
  access: OrgWorkspaceAccess | null,
  installationId: number,
  githubUserId: string,
): StoredAccessState {
  if (access === null) return { kind: "absent" }
  if (
    access.installationId !== installationId ||
    access.githubUserId !== githubUserId ||
    (access.role !== "admin" && access.role !== "member") ||
    (access.revokedAt !== null && typeof access.revokedAt !== "string")
  ) {
    return { kind: "denied" }
  }
  if (access.revokedAt !== null) return { kind: "denied" }
  return { kind: "active", access }
}

function success(args: {
  session: AuthedSession
  accessToken: string
  installationId: number
  githubUserId: string
  role: UserRole
}): OrgAccessResult {
  return {
    ok: true,
    session: args.session,
    accessToken: args.accessToken,
    installationId: args.installationId,
    githubUserId: args.githubUserId,
    login: args.session.record.login,
    role: args.role,
  }
}

/**
 * Apply the rollout's role policy after the caller has already proven fresh
 * visibility of this exact GitHub installation. `liveRole` is authoritative
 * while rollout mode is off. While it is on, only active stored access grants
 * a role; the live role is consulted solely by the existing zero-admin atomic
 * bootstrap path.
 *
 * This is deliberately not a second authentication entry point. Callers own
 * session/token validation and the exact/default GitHub visibility lookup,
 * then share this one post-visibility policy so overview and mutation routes
 * cannot disagree about the effective role.
 */
export async function resolveOrgRolePolicyForVisibleInstallation(
  env: OrgAccessEnv,
  args: {
    installationId: number
    githubUserId: string | null
    liveRole: UserRole
    requiredRole: OrgAccessRequiredRole
  },
): Promise<OrgRolePolicyResult> {
  if (!Number.isSafeInteger(args.installationId) || args.installationId <= 0) {
    return jsonError("invalid_installation_id", 400)
  }
  if (args.liveRole !== "admin" && args.liveRole !== "member") {
    return jsonError("forbidden", 403)
  }
  if (args.requiredRole !== "admin" && args.requiredRole !== "member") {
    return jsonError("invalid_required_role", 400)
  }

  const membershipMode = resolveOrgMembershipMode(env)
  if (membershipMode === "off") {
    return roleSatisfies(args.liveRole, args.requiredRole)
      ? { ok: true, role: args.liveRole }
      : jsonError("forbidden", 403)
  }

  if (!isOrgWorkspaceGithubUserId(args.githubUserId)) return jsonError("github_account_required", 403)
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) {
    console.error(JSON.stringify({ event: "org-access-db-missing", installationId: args.installationId }))
    return jsonError("misconfigured", 503)
  }

  let storedState: StoredAccessState
  try {
    storedState = classifyStoredAccess(
      await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId),
      args.installationId,
      args.githubUserId,
    )
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-access-store-read-failed",
        installationId: args.installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return jsonError("org_access_unavailable", 503)
  }

  // A revoked or malformed row is an unconditional deny. In particular, it is
  // never reclassified as "missing" and can never enter the bootstrap path.
  if (storedState.kind === "denied") return jsonError("forbidden", 403)

  // Bootstrap only matters when the caller is not already a stored admin and
  // GitHub proves they are an admin of this exact installation. The helper owns
  // the zero-admin check atomically; hasActiveOrgAdmin avoids unnecessary writes
  // and its answer never grants access by itself.
  if (storedState.kind !== "active" || storedState.access.role !== "admin") {
    if (args.liveRole === "admin") {
      try {
        const activeAdminExists = await hasActiveOrgAdmin(db, args.installationId)
        if (typeof activeAdminExists !== "boolean") {
          throw new Error("invalid active-admin result")
        }
        if (activeAdminExists === false) {
          await bootstrapFirstOrgAdmin(db, {
            installationId: args.installationId,
            githubUserId: args.githubUserId,
            nowIso: new Date().toISOString(),
            updatedBy: `github:${args.githubUserId}`,
          })
          // Always re-read THIS caller. A different caller winning the atomic
          // race does not confer access; a same-caller race/retry sees its row.
          storedState = classifyStoredAccess(
            await readOrgWorkspaceAccess(db, args.installationId, args.githubUserId),
            args.installationId,
            args.githubUserId,
          )
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "org-access-bootstrap-failed",
            installationId: args.installationId,
            err: error instanceof Error ? error.message : String(error),
          }),
        )
        return jsonError("org_access_unavailable", 503)
      }
    }
  }

  if (storedState.kind !== "active") return jsonError("forbidden", 403)
  const role = storedState.access.role
  if (!roleSatisfies(role, args.requiredRole)) return jsonError("forbidden", 403)
  return { ok: true, role }
}

/** Resolve and authorize one portal session against one exact installation. */
export async function requireOrgAccess(
  request: Request,
  env: OrgAccessEnv,
  ctx: ExecutionContext | undefined,
  installationId: number,
  options: RequireOrgAccessOptions,
): Promise<OrgAccessResult> {
  const requiredRole = options.requiredRole

  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return jsonError("invalid_installation_id", 400)
  }
  if (requiredRole !== "admin" && requiredRole !== "member") {
    return jsonError("invalid_required_role", 400)
  }

  let session: AuthedSession | null
  try {
    session = await requireSession(request, env, ctx)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "org-access-session-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return jsonError("org_access_unavailable", 503)
  }
  if (!session) return jsonError("unauthorized", 401)

  const numericGithubUserId = session.record.githubUserId
  if (
    typeof numericGithubUserId !== "number" ||
    !Number.isSafeInteger(numericGithubUserId) ||
    numericGithubUserId <= 0
  ) {
    return jsonError("github_account_required", 403)
  }
  const githubUserId = String(numericGithubUserId)

  const encryptionKey = env.OPENCLAW_SESSION_ENCRYPTION_KEY
  if (!encryptionKey) {
    console.error(JSON.stringify({ event: "org-access-encryption-key-missing", installationId }))
    return jsonError("misconfigured", 503)
  }

  let accessToken: string
  try {
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: encryptionKey,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "org-access-token-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return jsonError("org_access_failed", 500)
  }

  let liveScope: Awaited<ReturnType<typeof resolveExactUserInstallationScope>>
  try {
    liveScope = await resolveExactUserInstallationScope(accessToken, session.record.login, installationId)
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-access-github-scope-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return jsonError("forbidden", 403)
  }
  if (liveScope === null || liveScope.installationId !== installationId) {
    return jsonError("forbidden", 403)
  }

  const policy = await resolveOrgRolePolicyForVisibleInstallation(env, {
    installationId,
    githubUserId,
    liveRole: liveScope.role,
    requiredRole,
  })
  if (!policy.ok) return policy
  return success({ session, accessToken, installationId, githubUserId, role: policy.role })
}
