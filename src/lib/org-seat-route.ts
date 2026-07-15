// sig seat management — POST /v1/org/:installationId/members/:memberKey/seat.
//
// Admin-only assign (`{ assigned: true }`) / unassign (`{ assigned: false }`) of
// one member's BILLABLE seat, driving the org's billed-seat count. Powers the
// portal Organization → Members seat control (OrganizationPanel.tsx →
// setMemberSeat in the portal's api.ts).
//
// Rollout off preserves the legacy activity/login override in
// org_seat_assignment (0007). Rollout on resolves the target through the exact
// App roster, authorizes its immutable GitHub id in org_workspace_access, and
// stores only org_workspace_seat_assignment (0028). Login is display metadata.
//
// AUTH — SESSION-ONLY, by design. Unlike the dual-authed READ routes (overview /
// usage accept a bearer api key), this billing-affecting WRITE requires a portal
// SESSION cookie: the admin gate + the last-admin guard both key off a real
// GitHub identity, and a per-installation service key has no such identity. No
// session → 401.
//
// ADMIN GATE — PER-INSTALLATION, not aggregate. requireOrgAccess proves exact
// live GitHub installation visibility and resolves the authoritative role from
// org_workspace_access while managed membership is on (or the exact live role
// while rollout is off). A revoked stored admin cannot mutate billable seats.
// Cross-tenant targets fail closed and no row is written.
//
// TARGET — rollout off accepts the legacy login proven by activity or roster.
// Rollout on prefers the immutable numeric GitHub id; a roster-resolved login
// remains a transition-only Portal compatibility path but never becomes the
// stored authority. Active exact-installation Sigilix access is also required.
//
// LAST-ADMIN GUARD — fail-closed. Unassigning a KNOWN admin seat (the caller's
// own seat is always known-admin; other seats via org_seat_assignment.is_admin)
// is refused with 409 when it would leave zero assigned admin seats. Prevents an
// admin from locking the org (and its billing) out of all admin access.
//
// FAIL-CLOSED overall: a missing session-encryption key → 503, a token-decrypt
// failure → 500, any auth/ownership doubt → 403, and any membership-store or
// provider doubt → 503. A write only happens once every gate has passed.

import { requireSession } from "@/src/lib/auth-middleware"
import { reconcileOrgSeatAssignment } from "@/src/features/billing"
import { readOrgWorkspaceAccess } from "@/src/features/org-membership"
import { fetchInstallationRoster } from "@/src/lib/org-members-roster"
import { requireOrgAccess } from "@/src/lib/org-access"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"

/** Success body — mirrors the portal's SeatMutationResponse (setup/api.ts). */
export interface SeatMutationResponse {
  installationId: number
  githubUserId?: string
  login: string
  assigned: boolean
  updatedAt: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Parse the `{ assigned: boolean }` body. Returns null on any malformed input. */
async function parseAssigned(request: Request): Promise<boolean | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  if (typeof body !== "object" || body === null) return null
  const assigned = (body as { assigned?: unknown }).assigned
  return typeof assigned === "boolean" ? assigned : null
}

/**
 * Membership proof for a seat target. A successful activity query is enough;
 * otherwise a COMPLETE installed-App roster is authoritative. Any D1/provider
 * uncertainty remains distinct from a complete miss so callers return 503,
 * never a misleading 404.
 */
type InstallationMemberResolution = "member" | "not_member" | "unavailable"

async function resolveInstallationMember(
  env: Env,
  installationId: number,
  loginKey: string,
): Promise<InstallationMemberResolution> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db || installationId <= 0) return "unavailable"

  let account: { login: string; type: "Organization" | "User" }
  try {
    const activity = await db
      .prepare(
        "SELECT 1 AS present FROM usage_ledger" +
          " WHERE installation_id = ? AND author_login IS NOT NULL AND LOWER(author_login) = ? LIMIT 1",
      )
      .bind(installationId, loginKey)
      .first<{ present: unknown }>()
    if (activity != null) return "member"

    const tenant = await db
      .prepare("SELECT account_login, account_type FROM tenant WHERE installation_id = ?")
      .bind(installationId)
      .first<{ account_login: unknown; account_type: unknown }>()
    if (
      tenant == null ||
      typeof tenant.account_login !== "string" ||
      tenant.account_login === "" ||
      (tenant.account_type !== "Organization" && tenant.account_type !== "User")
    ) {
      return "unavailable"
    }
    account = { login: tenant.account_login, type: tenant.account_type }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-seat-member-check-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return "unavailable"
  }

  try {
    const roster = await fetchInstallationRoster(env, installationId, account.login, account.type)
    // A returned member is positive proof even if a later page failed. A miss
    // is trustworthy only when every page completed; an incomplete miss stays
    // unavailable rather than becoming a false 404.
    if (roster.members.some((member) => member.login.toLowerCase() === loginKey)) return "member"
    return roster.complete ? "not_member" : "unavailable"
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-seat-roster-check-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return "unavailable"
  }
}

type ManagedInstallationMemberResolution =
  | { kind: "member"; githubUserId: string; login: string }
  | { kind: "not_member" }
  | { kind: "unavailable" }

/**
 * Resolve managed targets through the exact installation roster, then require
 * active stored access by immutable GitHub id. A non-numeric key remains a
 * temporary compatibility path for the Portal's login-addressed client; it is
 * never persisted or compared as authority. Numeric-looking keys are treated
 * only as ids, so they cannot fall through and spoof a login.
 */
async function resolveManagedInstallationMember(
  env: Env,
  installationId: number,
  memberKey: string,
): Promise<ManagedInstallationMemberResolution> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db || installationId <= 0) return { kind: "unavailable" }

  let account: { login: string; type: "Organization" | "User" }
  try {
    const tenant = await db
      .prepare("SELECT account_login, account_type FROM tenant WHERE installation_id = ?")
      .bind(installationId)
      .first<{ account_login: unknown; account_type: unknown }>()
    if (
      tenant == null ||
      typeof tenant.account_login !== "string" ||
      tenant.account_login === "" ||
      (tenant.account_type !== "Organization" && tenant.account_type !== "User")
    ) {
      return { kind: "unavailable" }
    }
    account = { login: tenant.account_login, type: tenant.account_type }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-seat-managed-tenant-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { kind: "unavailable" }
  }

  try {
    const roster = await fetchInstallationRoster(env, installationId, account.login, account.type)
    const numericMemberKey = Number(memberKey)
    const byId =
      /^[1-9]\d*$/.test(memberKey) &&
      Number.isSafeInteger(numericMemberKey) &&
      numericMemberKey > 0 &&
      String(numericMemberKey) === memberKey
    const member = roster.members.find((candidate) =>
      byId ? candidate.githubUserId === memberKey : candidate.login.toLowerCase() === memberKey.toLowerCase(),
    )
    if (!member) return roster.complete ? { kind: "not_member" } : { kind: "unavailable" }
    const access = await readOrgWorkspaceAccess(db, installationId, member.githubUserId)
    if (access === null || access.revokedAt !== null) return { kind: "not_member" }
    return { kind: "member", githubUserId: member.githubUserId, login: member.login }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-seat-managed-member-check-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { kind: "unavailable" }
  }
}

/**
 * Count assigned admin seats for `installationId` EXCLUDING `targetKey`
 * (lowercased). Reads org_seat_assignment rows with is_admin = 1 AND
 * assigned = 1. Used by the last-admin guard: 0 remaining ⇒ the target is the
 * last assigned admin seat. Fail-closed to 0 on a fault (guard blocks).
 */
async function countOtherAssignedAdmins(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
  targetKey: string,
): Promise<number> {
  if (!env.SIGILIX_PLATFORM_DB) return 0
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS n FROM org_seat_assignment" +
        " WHERE installation_id = ? AND is_admin = 1 AND assigned = 1 AND login != ?",
    )
      .bind(installationId, targetKey)
      .first<{ n: unknown }>()
    return row != null && Number.isFinite(Number(row.n)) ? Number(row.n) : 0
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-seat-admin-count-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return 0
  }
}

/**
 * Is the target's stored seat marked a known-admin seat? FAIL-CLOSED: a missing
 * binding or a D1 read fault returns TRUE (treat as possibly-admin) so the guard
 * that consumes this never SKIPS on an unverifiable read — an unassign we can't
 * vet is refused, not waved through.
 */
async function storedTargetIsAdmin(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
  targetKey: string,
): Promise<boolean> {
  if (!env.SIGILIX_PLATFORM_DB) return true
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT is_admin FROM org_seat_assignment WHERE installation_id = ? AND login = ?",
    )
      .bind(installationId, targetKey)
      .first<{ is_admin: unknown }>()
    return row != null && Number(row.is_admin) === 1
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-seat-stored-admin-check-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return true // fail-closed: an unverifiable read must not skip the guard
  }
}

/**
 * POST /v1/org/:installationId/members/:memberKey/seat — see file header.
 * `installationId` / `memberKey` are the already-decoded path segments.
 */
export async function handleOrgSeatRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  memberKey: string,
): Promise<Response> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  const targetMemberKey = memberKey.trim()
  if (targetMemberKey === "") return json({ error: "invalid member login" }, 400)

  const session = await requireSession(request, env, ctx)
  if (!session) return json({ error: "unauthorized" }, 401)

  // CSRF guard (see portal-cors.ts's hasJsonContentType doc): required because
  // the session cookie is SameSite=None — force a preflight before the body.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const assigned = await parseAssigned(request)
  if (assigned === null) return json({ error: "body must be { assigned: boolean }" }, 400)

  // Keep the cheap session check above the CSRF/body validation so anonymous
  // callers still receive 401, then run the central exact-installation gate
  // only after the request is safe to authorize. In managed mode its stored
  // role is authoritative even when GitHub still reports the caller as admin.
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "admin" })
  if (!access.ok) return access.response

  const callerLogin = access.login

  if (!env.SIGILIX_PLATFORM_DB) {
    console.error(JSON.stringify({ event: "org-seat-platform-db-missing", installationId }))
    return json({ error: "seat_unavailable" }, 503)
  }

  const targetKey = targetMemberKey.toLowerCase()
  const callerKey = callerLogin.toLowerCase()

  if (env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on") {
    const member = await resolveManagedInstallationMember(env, installationId, targetMemberKey)
    if (member.kind === "unavailable") return json({ error: "seat_unavailable" }, 503)
    if (member.kind === "not_member") return json({ error: "not a member of this installation" }, 404)

    const reconciled = await reconcileOrgSeatAssignment(env, {
      installationId,
      target: {
        kind: "managed_github",
        githubUserId: member.githubUserId,
        lastKnownLogin: member.login,
      },
      requestedAssigned: assigned,
      actorLogin: callerLogin,
      ...(ctx ? { ctx } : {}),
    })
    if (reconciled.kind === "busy") return json({ error: "seat_reconciliation_busy" }, 503)
    if (reconciled.kind === "last_admin") return json({ error: "cannot unassign the last admin seat" }, 409)
    if (reconciled.kind === "pending") {
      return json(
        {
          installationId,
          githubUserId: member.githubUserId,
          login: member.login,
          assigned: reconciled.assigned,
          updatedAt: reconciled.updatedAt,
          pending: true,
          operationId: reconciled.operationId,
        },
        202,
      )
    }
    if (reconciled.kind !== "applied") {
      console.warn(
        JSON.stringify({
          event: "org-seat-reconcile-failed",
          installationId,
          kind: reconciled.kind,
          error: reconciled.error,
        }),
      )
      return json({ error: reconciled.error }, reconciled.kind === "invalid" ? 400 : 503)
    }
    return json(
      {
        installationId,
        githubUserId: member.githubUserId,
        login: member.login,
        assigned: reconciled.assigned,
        updatedAt: reconciled.updatedAt,
      } satisfies SeatMutationResponse,
      200,
    )
  }

  // The target must be proven by activity or the installed-App roster. Roster
  // presence is positive proof; only a roster miss needs complete pagination.
  const member = await resolveInstallationMember(env, installationId, targetKey)
  if (member === "unavailable") {
    return json({ error: "seat_unavailable" }, 503)
  }
  if (member === "not_member") {
    return json({ error: "not a member of this installation" }, 404)
  }

  // Last-admin guard (fail-closed) — only on an UNASSIGN of a known-admin seat.
  // The caller acting on their OWN seat is always a known-admin seat (the gate
  // above verified it); other seats are known-admin only via a stored mark.
  //
  // KNOWN LIMITATION: a member's admin role can't be resolved with the CALLER's
  // GitHub token (GET /user/memberships/orgs returns only the caller's own
  // memberships — the same constraint org-overview-route.ts documents). So the
  // guard reliably protects the case we CAN verify (self-lockout) plus any seat
  // an admin has self-marked by managing it, but two never-self-marked admins
  // could unassign each other. That is bounded, NOT a lockout: endpoint access
  // is gated on the installation-scoped org admin role, not on holding a seat,
  // so any active admin can always sign back in and re-assign a seat to recover.
  if (!assigned) {
    const targetIsKnownAdmin = targetKey === callerKey || (await storedTargetIsAdmin(env, installationId, targetKey))
    if (targetIsKnownAdmin && (await countOtherAssignedAdmins(env, installationId, targetKey)) === 0) {
      return json({ error: "cannot unassign the last admin seat" }, 409)
    }
  }

  const reconciled = await reconcileOrgSeatAssignment(env, {
    installationId,
    target: { kind: "legacy_login", login: targetKey, targetIsAdmin: targetKey === callerKey },
    requestedAssigned: assigned,
    actorLogin: callerLogin,
    ...(ctx ? { ctx } : {}),
  })
  if (reconciled.kind === "busy") return json({ error: "seat_reconciliation_busy" }, 503)
  if (reconciled.kind === "last_admin") return json({ error: "cannot unassign the last admin seat" }, 409)
  if (reconciled.kind === "pending") {
    return json(
      {
        installationId,
        login: targetMemberKey,
        assigned: reconciled.assigned,
        updatedAt: reconciled.updatedAt,
        pending: true,
        operationId: reconciled.operationId,
      },
      202,
    )
  }
  if (reconciled.kind !== "applied") {
    console.warn(
      JSON.stringify({
        event: "org-seat-reconcile-failed",
        installationId,
        kind: reconciled.kind,
        error: reconciled.error,
      }),
    )
    return json({ error: reconciled.error }, reconciled.kind === "invalid" ? 400 : 503)
  }
  return json(
    {
      installationId,
      login: targetMemberKey,
      assigned: reconciled.assigned,
      updatedAt: reconciled.updatedAt,
    } satisfies SeatMutationResponse,
    200,
  )
}
