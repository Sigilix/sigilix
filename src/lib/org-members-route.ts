// Sigilix-managed organization membership mutations.
//
// These routes never mutate GitHub membership. They manage only Sigilix's
// installation-scoped access rows and are available solely while the stored
// membership rollout is on. Every mutation requires a portal session, exact
// live GitHub installation visibility, and a stored Sigilix admin role through
// requireOrgAccess. The target is always an immutable GitHub numeric account
// ID; a login is accepted only from a complete installed-App roster and remains
// display/legacy-seat data.

import {
  addOrgWorkspaceMember,
  removeOrgWorkspaceAccessWithSeatBillingFence,
  setOrgWorkspaceRole,
  type OrgWorkspaceRole,
} from "@/src/features/org-membership"
import {
  acquireOrgSeatBillingLease,
  prepareCancelActiveOrgSeatBillingOperation,
  prepareCancelActiveManagedOrgSeatBillingOperation,
  readActiveOrgSeatBillingOperation,
  releaseOrgSeatBillingLease,
  type OrgSeatBillingOperation,
} from "@/src/features/billing"
import { requireOrgAccess } from "@/src/lib/org-access"
import {
  createCompleteInstallationRosterSnapshot,
  fetchInstallationRoster,
  type CompleteInstallationRosterSnapshot,
} from "@/src/lib/org-members-roster"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const MAX_BODY_BYTES = 4 * 1024
const MEMBER_REMOVAL_LEASE_TTL_MS = 60_000

type AdminAccess = Extract<Awaited<ReturnType<typeof requireOrgAccess>>, { ok: true }>

interface MutationContext {
  access: AdminAccess
  db: D1Database
}

interface RosterTarget {
  githubUserId: string
  login: string
}

interface RosterSnapshotContext {
  snapshot: CompleteInstallationRosterSnapshot
  target: RosterTarget | null
}

type ContextResult = { ok: true; value: MutationContext } | { ok: false; response: Response }
type RosterSnapshotResult = { ok: true; value: RosterSnapshotContext } | { ok: false; response: Response }

/** POST /v1/org/:installationId/members — add or regrant one roster-proven member. */
export async function handleAddOrgMember(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid_installation_id" }, 400)

  const context = await requireMutationContext(request, env, ctx, installationId)
  if (!context.ok) return context.response

  const body = await readObjectBody(request)
  if (!body.ok) return body.response
  const githubUserId = parseGithubUserId(body.value.githubUserId)
  if (githubUserId === null) return json({ error: "invalid_github_user_id" }, 400)

  const roster = await resolveRosterSnapshot(env, installationId, context.value.access.account, githubUserId)
  if (!roster.ok) return roster.response
  if (roster.value.target === null) return json({ error: "member_not_found" }, 404)

  const nowIso = new Date().toISOString()
  try {
    const access = await addOrgWorkspaceMember(context.value.db, {
      installationId,
      githubUserId,
      nowIso,
      updatedBy: `github:${context.value.access.githubUserId}`,
    })
    return json({
      installationId,
      githubUserId,
      login: roster.value.target.login,
      role: access.role,
      updatedAt: access.updatedAt,
    })
  } catch (error) {
    emitFailure("org-member-add-failed", error, installationId, githubUserId)
    return json({ error: "org_membership_unavailable" }, 503)
  }
}

/** PATCH /v1/org/:installationId/members/:githubUserId — change one stored role. */
export async function handleUpdateOrgMemberRole(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  rawGithubUserId: string,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid_installation_id" }, 400)
  const githubUserId = parseGithubUserId(rawGithubUserId)
  if (githubUserId === null) return json({ error: "invalid_github_user_id" }, 400)

  const context = await requireMutationContext(request, env, ctx, installationId)
  if (!context.ok) return context.response

  const body = await readObjectBody(request)
  if (!body.ok) return body.response
  const role = parseRole(body.value.role)
  if (role === null) return json({ error: "invalid_role" }, 400)

  const roster = await resolveRosterSnapshot(env, installationId, context.value.access.account, githubUserId)
  if (!roster.ok) return roster.response
  if (roster.value.target === null) return json({ error: "member_not_found" }, 404)

  const nowIso = new Date().toISOString()
  try {
    const result = await setOrgWorkspaceRole(context.value.db, {
      installationId,
      githubUserId,
      role,
      nowIso,
      updatedBy: `github:${context.value.access.githubUserId}`,
      rosterSnapshot: roster.value.snapshot,
    })
    if (result.status === "last_admin") {
      return json({ error: "last_admin" }, 409)
    }
    if (result.status === "not_found") {
      return json({ error: "member_not_found" }, 404)
    }
    return json({
      installationId,
      githubUserId,
      login: roster.value.target.login,
      role: result.access.role,
      updatedAt: result.access.updatedAt,
    })
  } catch (error) {
    emitFailure("org-member-role-failed", error, installationId, githubUserId)
    return json({ error: "org_membership_unavailable" }, 503)
  }
}

/** DELETE /v1/org/:installationId/members/:githubUserId — remove Sigilix access only. */
export async function handleDeleteOrgMember(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  rawGithubUserId: string,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid_installation_id" }, 400)
  const githubUserId = parseGithubUserId(rawGithubUserId)
  if (githubUserId === null) return json({ error: "invalid_github_user_id" }, 400)

  const context = await requireMutationContext(request, env, ctx, installationId)
  if (!context.ok) return context.response

  // A departed GitHub member remains revocable by immutable stored ID, but the
  // last-admin guard still requires one complete exact-installation snapshot.
  const roster = await resolveRosterSnapshot(env, installationId, context.value.access.account, githubUserId)
  if (!roster.ok) return roster.response

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const leaseToken = crypto.randomUUID()
  const lease = await acquireOrgSeatBillingLease(env, {
    installationId,
    token: leaseToken,
    nowMs,
    ttlMs: MEMBER_REMOVAL_LEASE_TTL_MS,
  })
  if (lease.kind !== "acquired") {
    return json({ error: "org_membership_unavailable" }, 503)
  }
  try {
    const active = await readActiveOrgSeatBillingOperation(env, installationId)
    if (active.kind === "error") {
      return json({ error: "org_membership_unavailable" }, 503)
    }
    if (active.kind === "ok") {
      const sameTarget = activeOperationMatchesMember(active.operation, githubUserId, roster.value.target)
      if (!sameTarget) {
        // An installation has at most one expansion in flight. Settling another
        // member's operation here would unassign that member; wait for recovery
        // to finish instead. A departed target has no trustworthy login to join
        // against for a legacy operation, so it takes the same fail-closed
        // retry path. Managed operations use the persisted immutable user ID.
        return json({ error: "org_membership_busy" }, 503)
      }
    }
    let preparedSettlement: ReturnType<typeof prepareCancelActiveOrgSeatBillingOperation> | null = null
    if (active.kind === "ok") {
      const settlementArgs = {
        installationId,
        operationId: active.operation.operationId,
        revision: active.operation.revision,
        expectedState: active.operation.state === "stripe_applied" ? ("stripe_applied" as const) : ("pending" as const),
        errorCode: "member_removed",
        actorLogin: context.value.access.login,
        nowIso,
        leaseToken,
        leaseAcquiredAtMs: nowMs,
        nowMs,
      }
      switch (active.operation.targetIdentityKind) {
        case "legacy_login":
          preparedSettlement = prepareCancelActiveOrgSeatBillingOperation(context.value.db, settlementArgs)
          break
        case "managed_github":
          preparedSettlement = prepareCancelActiveManagedOrgSeatBillingOperation(context.value.db, settlementArgs)
          break
        case "activity_github":
          return json({ error: "org_membership_busy" }, 503)
        default:
          return assertNever(active.operation.targetIdentityKind)
      }
    }
    if (preparedSettlement?.kind === "error") {
      return json({ error: "org_membership_unavailable" }, 503)
    }
    const result = await removeOrgWorkspaceAccessWithSeatBillingFence(
      context.value.db,
      {
        installationId,
        githubUserId,
        ...(roster.value.target !== null ? { login: roster.value.target.login } : {}),
        nowIso,
        updatedBy: `github:${context.value.access.githubUserId}`,
        rosterSnapshot: roster.value.snapshot,
      },
      {
        leaseToken,
        leaseAcquiredAtMs: nowMs,
        nowMs,
        expectedActiveOperation:
          active.kind === "ok" && preparedSettlement?.kind === "prepared"
            ? {
                operationId: active.operation.operationId,
                revision: active.operation.revision,
                state: active.operation.state === "stripe_applied" ? "stripe_applied" : "pending",
                settlementStatements: preparedSettlement.statements,
              }
            : null,
      },
    )
    if (result.status === "last_admin") {
      return json({ error: "last_admin" }, 409)
    }
    if (result.status === "not_found") {
      return json({ error: "member_not_found" }, 404)
    }
    return json({
      installationId,
      githubUserId,
      login: roster.value.target?.login ?? null,
      removed: true,
      updatedAt: nowIso,
    })
  } catch (error) {
    emitFailure("org-member-remove-failed", error, installationId, githubUserId)
    return json({ error: "org_membership_unavailable" }, 503)
  } finally {
    const released = await releaseOrgSeatBillingLease(env, {
      installationId,
      token: leaseToken,
      acquiredAtMs: nowMs,
    })
    if (released.kind === "error") {
      emitFailure("org-member-remove-lease-release-failed", released.reason, installationId, githubUserId)
    }
  }
}

function activeOperationMatchesMember(
  operation: OrgSeatBillingOperation,
  githubUserId: string,
  rosterTarget: RosterTarget | null,
): boolean {
  switch (operation.targetIdentityKind) {
    case "legacy_login":
      return rosterTarget !== null && operation.login === rosterTarget.login.trim().toLowerCase()
    case "managed_github":
      return operation.targetGithubUserId === githubUserId
    case "activity_github":
      return false
    default:
      return assertNever(operation.targetIdentityKind)
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported seat target identity kind: ${String(value)}`)
}

async function requireMutationContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<ContextResult> {
  // Authenticate before exposing rollout state. In on mode this is both the
  // exact-installation ownership proof and the stored-admin authorization.
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "admin" })
  if (!access.ok) return { ok: false, response: access.response }
  if (access.installationId !== installationId) {
    return { ok: false, response: json({ error: "forbidden" }, 403) }
  }
  if (env.OPENCLAW_ORG_MEMBERSHIP_MODE !== "on") {
    return { ok: false, response: json({ error: "org_membership_disabled" }, 503) }
  }
  // Session cookies are SameSite=None. Requiring JSON forces the browser's
  // portal-origin CORS preflight before any mutation can reach its body.
  if (!hasJsonContentType(request)) {
    return { ok: false, response: json({ error: "content-type must be application/json" }, 415) }
  }
  if (!env.SIGILIX_PLATFORM_DB) {
    return { ok: false, response: json({ error: "org_membership_unavailable" }, 503) }
  }
  return { ok: true, value: { access, db: env.SIGILIX_PLATFORM_DB } }
}

/**
 * Resolve a target exclusively by immutable ID from a COMPLETE exact App
 * roster. A positive hit from a partial roster is not enough for writes: the
 * route requires one authoritative snapshot before using its display login.
 */
async function resolveRosterSnapshot(
  env: Env,
  installationId: number,
  account: AdminAccess["account"],
  githubUserId: string,
): Promise<RosterSnapshotResult> {
  if (account.login === "" || (account.type !== "Organization" && account.type !== "User")) {
    return { ok: false, response: json({ error: "org_roster_unavailable" }, 503) }
  }

  try {
    const roster = await fetchInstallationRoster(env, installationId, account.login, account.type)
    const expectedSource = account.type === "Organization" ? "org" : "collaborators"
    const snapshot = createCompleteInstallationRosterSnapshot(roster)
    if (snapshot === null || roster.source !== expectedSource) {
      return { ok: false, response: json({ error: "org_roster_unavailable" }, 503) }
    }
    const member = roster.members.find((candidate) => candidate.githubUserId === githubUserId)
    return {
      ok: true,
      value: {
        snapshot,
        target: member ? { githubUserId: member.githubUserId, login: member.login } : null,
      },
    }
  } catch (error) {
    emitFailure("org-member-roster-read-failed", error, installationId, githubUserId)
    return { ok: false, response: json({ error: "org_roster_unavailable" }, 503) }
  }
}

async function readObjectBody(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const raw = await readBodyCapped(request, MAX_BODY_BYTES)
  if (raw === null) return { ok: false, response: json({ error: "payload_too_large" }, 413) }
  try {
    const body = JSON.parse(raw) as unknown
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? { ok: true, value: body as Record<string, unknown> }
      : { ok: false, response: json({ error: "invalid_request" }, 400) }
  } catch {
    return { ok: false, response: json({ error: "invalid_request" }, 400) }
  }
}

function parseGithubUserId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value ? value : null
}

function parseRole(value: unknown): OrgWorkspaceRole | null {
  return value === "admin" || value === "member" ? value : null
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

function emitFailure(event: string, error: unknown, installationId: number, githubUserId: string): void {
  console.error(
    JSON.stringify({
      event,
      installationId,
      githubUserId,
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}
