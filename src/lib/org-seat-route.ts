// sig seat management — POST /v1/org/:installationId/members/:login/seat.
//
// Admin-only assign (`{ assigned: true }`) / unassign (`{ assigned: false }`) of
// one member's BILLABLE seat, driving the org's billed-seat count. Powers the
// portal Organization → Members seat control (OrganizationPanel.tsx →
// setMemberSeat in the portal's api.ts).
//
// A "seat" is DERIVED from real activity (distinct usage_ledger.author_login for
// the installation — see org-overview-route.ts); this route stores an admin's
// explicit OVERRIDE of the default-assigned state in org_seat_assignment (0007).
// The overview reads that override back as each seat's `assigned` flag +
// `assignedSeatCount` (the billed subset).
//
// AUTH — SESSION-ONLY, by design. Unlike the dual-authed READ routes (overview /
// usage accept a bearer api key), this billing-affecting WRITE requires a portal
// SESSION cookie: the admin gate + the last-admin guard both key off a real
// GitHub identity, and a per-installation service key has no such identity. No
// session → 401.
//
// ADMIN GATE — PER-INSTALLATION, not aggregate. The caller must be an admin of
// THIS installation via isAdminOfInstallation (NOT resolveUserRole, whose
// aggregate "admin of ANY connected install" would let a mere member of org B
// mutate org B's seats). Not an admin of this installation → 403. This also
// enforces TENANT ISOLATION: an installation the caller's token can't see is
// never an installation they're an admin of, so a cross-tenant target 403s and
// no row is written.
//
// TARGET — must be a MEMBER of the installation, proven case-insensitively by
// either real usage activity or the installed App's GitHub roster. A complete
// activity + roster miss → 404; an incomplete/unavailable proof source → 503.
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
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { fetchInstallationRoster } from "@/src/lib/org-members-roster"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"

/** Success body — mirrors the portal's SeatMutationResponse (setup/api.ts). */
export interface SeatMutationResponse {
  installationId: number
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
 * Upsert the seat override. `assigned` sets the billable flag; `knownAdmin`
 * (true only when the caller acts on their OWN verified-admin seat) marks the
 * seat as a known-admin seat — MAX() preserves a prior admin mark so a later
 * non-admin-context write never clears it.
 */
async function writeSeat(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: {
    installationId: number
    loginKey: string
    assigned: boolean
    knownAdmin: boolean
    updatedBy: string
    nowIso: string
  },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) throw new Error("org seat write: SIGILIX_PLATFORM_DB binding absent")
  await env.SIGILIX_PLATFORM_DB.prepare(
    "INSERT INTO org_seat_assignment (installation_id, login, assigned, is_admin, updated_at, updated_by)" +
      " VALUES (?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(installation_id, login) DO UPDATE SET" +
      " assigned = excluded.assigned," +
      " is_admin = MAX(org_seat_assignment.is_admin, excluded.is_admin)," +
      " updated_at = excluded.updated_at," +
      " updated_by = excluded.updated_by",
  )
    .bind(
      args.installationId,
      args.loginKey,
      args.assigned ? 1 : 0,
      args.knownAdmin ? 1 : 0,
      args.nowIso,
      args.updatedBy,
    )
    .run()
}

/**
 * POST /v1/org/:installationId/members/:login/seat — see file header.
 * `installationId` / `login` are the already-decoded path segments.
 */
export async function handleOrgSeatRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  login: string,
): Promise<Response> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  const targetLogin = login.trim()
  if (targetLogin === "") return json({ error: "invalid member login" }, 400)

  const session = await requireSession(request, env, ctx)
  if (!session) return json({ error: "unauthorized" }, 401)

  // CSRF guard (see portal-cors.ts's hasJsonContentType doc): required because
  // the session cookie is SameSite=None — force a preflight before the body.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const assigned = await parseAssigned(request)
  if (assigned === null) return json({ error: "body must be { assigned: boolean }" }, 400)

  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "org-seat-encryption-key-missing" }))
    return json({ error: "misconfigured" }, 503)
  }

  let accessToken: string
  try {
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
  } catch (error) {
    // Never log the token — only that decryption failed.
    console.error(
      JSON.stringify({ event: "org-seat-decrypt-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return json({ error: "seat_failed" }, 500)
  }

  const callerLogin = session.record.login
  // Per-installation admin gate. Also enforces tenant isolation: an installation
  // the caller's token can't see is never one they're an admin of → 403.
  const isAdmin = await isAdminOfInstallation(accessToken, callerLogin, installationId)
  if (!isAdmin) return json({ error: "forbidden" }, 403)

  if (!env.SIGILIX_PLATFORM_DB) {
    console.error(JSON.stringify({ event: "org-seat-platform-db-missing", installationId }))
    return json({ error: "seat_unavailable" }, 503)
  }

  const targetKey = targetLogin.toLowerCase()
  const callerKey = callerLogin.toLowerCase()

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
  // is gated on GitHub admin role (isAdminOfInstallation), not on holding a seat,
  // so any admin can always sign back in and re-assign a seat to recover.
  if (!assigned) {
    const targetIsKnownAdmin = targetKey === callerKey || (await storedTargetIsAdmin(env, installationId, targetKey))
    if (targetIsKnownAdmin && (await countOtherAssignedAdmins(env, installationId, targetKey)) === 0) {
      return json({ error: "cannot unassign the last admin seat" }, 409)
    }
  }

  const nowIso = new Date().toISOString()
  try {
    await writeSeat(env, {
      installationId,
      loginKey: targetKey,
      assigned,
      // Mark known-admin only for the caller's own verified-admin seat.
      knownAdmin: targetKey === callerKey,
      updatedBy: callerLogin,
      nowIso,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "org-seat-write-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "seat_failed" }, 500)
  }

  return json({ installationId, login: targetLogin, assigned, updatedAt: nowIso } satisfies SeatMutationResponse, 200)
}
