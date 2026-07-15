// sig-org-overview — GET /v1/org/overview.
//
// Powers the portal's Organization page: the org headline (account + plan), the
// list of billable SEATS (people who actually USE Sigilix — i.e. have review
// activity in D1 usage_ledger, NOT every GitHub org member), and per-seat
// billing placeholders. A "seat" is a distinct usage_ledger.author_login scoped
// to the caller's own installation — that distinct set is what gets billed
// per-seat, so it is derived from real activity rather than the GitHub member
// roster.
//
// Auth (mirrors workspace-prs-route.ts): a portal browser SESSION cookie
// (requireSession) is tried FIRST since this is a portal-first page; a request
// with no session falls back to a bearer API key (requireApiTenant). Neither →
// 401. CORS'd for the portal origins (portal-cors.ts, wired in index.ts's
// isPortalCorsPath alongside /v1/workspace/prs).
//
// Installation scoping (mirrors workspace-prs-route.ts's resolution):
//   - Session path: every installation the session's GitHub user-to-server
//     token can see via `GET /user/installations` (fetchUserInstallationIds,
//     the same call the setup wizard + workspace-prs page use). Unlike
//     workspace-prs (which scans across ALL of them), an org page shows ONE org
//     at a time. An explicit `?installationId=` must be visible to the caller or
//     the route fails closed with 403; a request with no query keeps the legacy
//     default of GitHub's first visible installation. The ledger scan and role
//     decision are both scoped to exactly that one installation.
//   - Api-key path: the key's own installationId. The legacy global-key
//     sentinel (LEGACY_TENANT_INSTALLATION_ID) stays broad on purpose — it is
//     Sigilix-internal, never handed to an external tenant — matching
//     callerOwnsInstallation's existing legacy semantics; it scans "all"
//     installations. A real per-tenant key is scoped to exactly its own
//     installation and can never see another tenant's seats.
//
// Role gating (resolve-user-role.ts + org-access.ts):
//   - Rollout off: the exact live GitHub installation role.
//   - OPENCLAW_ORG_MEMBERSHIP_MODE=on: the exact active stored workspace role
//     after fresh GitHub installation visibility. Missing/revoked/broken access
//     fails closed before org data is read.
//   - ADMIN: the full response — org headline + full paginated seat list +
//     billing placeholder.
//   - MEMBER: a limited response — the same org headline + billing placeholder
//     + the real total seatCount, but `seats` contains ONLY the caller's own
//     seat (never another member's login / activity / role). An authorized
//     member gets 200; missing/revoked managed access is denied before this.
//   The api-key path has no GitHub identity to run an installation role check against; a
//   per-installation key is a tenant-scoped service credential with full access
//   to its own installation's data (the same access workspace-prs grants it), so
//   it is treated as "admin" for its installation.
//
// Tenant isolation (CRITICAL): the usage_ledger seat query filters by the
// caller's exact installation_id via bound `?` placeholders (never string-
// concatenated values) — mirroring d1-workspace-prs-read.ts's WHERE-clause
// pattern. Seats never leak across installations.
//
// Fail-soft enrichment: account, usage, seat-assignment, and roster reads
// degrade to a best-effort response. Managed authorization and stored-role
// reads deliberately fail closed with 403/5xx; they must never fabricate roles
// that disagree with the mutation routes. While rollout mode is off, a missing
// encryption key or decrypt failure retains the legacy empty-200 behavior:
// installationId is forced to 0 so no account/org data can be read through an
// unverified ?installationId= query (see resolveSessionScope). Managed mode
// instead matches central org-access's 503/500 failure semantics.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import {
  isOrgWorkspaceGithubUserId,
  listOrgWorkspaceAccess,
  type OrgWorkspaceAccess,
} from "@/src/features/org-membership"
import { resolveOrgRolePolicyForVisibleInstallation } from "@/src/lib/org-access"
import { fetchInstallationRoster } from "@/src/lib/org-members-roster"
import {
  resolveDefaultUserInstallationScope,
  resolveExactUserInstallationScope,
  type UserRole,
} from "@/src/lib/resolve-user-role"
import { resolveInstallationPlan, type PlanName } from "@/src/lib/resolve-plan"
import type { Env } from "@/src/shared/types/env"

// Distinct-author scan cap: read up to this many seats from D1 before
// in-memory case-insensitive de-dup + pagination. Generous relative to any
// real org's seat count; a bound purely to keep an anomalous installation from
// scanning unbounded.
const SEAT_SCAN_LIMIT = 1000

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200

// The org plan tiers are exactly the canonical PlanName set (resolve-plan.ts) —
// alias so the two can never drift as tiers are added.
export type OrgPlan = PlanName

interface OrgSeatBase {
  login: string
  role: UserRole
  reviews: number
  lastActiveAt: string
  /** Whether this seat holds a BILLABLE seat. An admin flips it via POST …/seat
   * (org-seat-route.ts), persisted in org_seat_assignment (0007) and read back
   * here. Default true for an ACTIVE seat (derived-from-activity); default false
   * for a roster-only member (a GitHub member with no activity yet — an admin
   * assigns them a seat explicitly). */
  assigned: boolean
  /** GitHub avatar URL for the roster (sig-org-members). Omitted for an
   * activity-only seat we never matched to the GitHub roster; the portal then
   * falls back to `https://github.com/{login}.png`. */
  avatarUrl?: string
}

type OrgRosterSeat = OrgSeatBase & {
  /** Immutable GitHub account identity from the exact installation roster;
   * login remains display-only and may change. */
  githubUserId: string
  identityProvenance: "roster"
  /** Stored Sigilix workspace access. Omitted when a partial roster proves the
   * identity but cannot safely advertise an add/regrant action. */
  accessState?: "active" | "available" | undefined
}

type OrgActivitySeat = OrgSeatBase & {
  githubUserId?: undefined
  identityProvenance?: undefined
  accessState?: undefined
}

export type OrgSeat = OrgRosterSeat | OrgActivitySeat

export interface OrgOverviewResponse {
  org: { account: string; installationId: number; plan: OrgPlan }
  role: UserRole
  seatCount: number
  /** The billed subset — seats currently assigned (seatCount minus unassigned overrides). */
  assignedSeatCount: number
  seats: OrgSeat[]
  billing: { model: "per-seat"; perSeatMonthly: number | null; note: string }
  nextCursor?: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// ─── Config helpers (plan + billing placeholders) ─────────────

/**
 * The org's REAL plan — the authoritative `tenant.tier` for this installation
 * (resolveInstallationPlan reads it through the same entitlements source the
 * gate enforces on), falling back to the deployment default only when there is
 * no tenant row / an unknown tier / a D1 fault. This is why a paid org (e.g.
 * tier "ultra"/"enterprise") reads its true plan on the Organization page rather
 * than the OPENCLAW_PLAN placeholder that previously defaulted every org to "free".
 * PlanName and OrgPlan share the same members, so the result is a valid OrgPlan.
 */
async function resolvePlan(
  env: Pick<Env, "OPENCLAW_PLAN" | "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<OrgPlan> {
  return resolveInstallationPlan(env, installationId)
}

/** Per-seat billing placeholder from OPENCLAW_PER_SEAT_PRICE, or null ("billing at launch"). */
function resolveBilling(env: Pick<Env, "OPENCLAW_PER_SEAT_PRICE">): OrgOverviewResponse["billing"] {
  const raw = env.OPENCLAW_PER_SEAT_PRICE
  const parsed = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN
  const perSeatMonthly = Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  return {
    model: "per-seat",
    perSeatMonthly,
    note: perSeatMonthly !== null ? "per-seat monthly (USD)" : "billing at launch",
  }
}

// ─── Opaque offset cursor ─────────────────────────────────────

/** base64(JSON) offset cursor. A malformed cursor decodes to 0 (restart from the top). */
function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset }))
}

function decodeCursor(raw: string | null): number {
  if (!raw) return 0
  try {
    const obj = JSON.parse(atob(raw)) as { o?: unknown }
    return typeof obj.o === "number" && Number.isInteger(obj.o) && obj.o >= 0 ? obj.o : 0
  } catch {
    return 0
  }
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_PAGE_LIMIT
  return Math.min(n, MAX_PAGE_LIMIT)
}

type InstallationSelection = { kind: "default" } | { kind: "exact"; installationId: number } | { kind: "invalid" }

function parseInstallationSelection(url: URL): InstallationSelection {
  const raw = url.searchParams.get("installationId")
  if (raw === null || raw.trim() === "") return { kind: "default" }
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  // Real installation ids are always positive (0 and the legacy sentinel
  // LEGACY_TENANT_INSTALLATION_ID = -1 are never something a query param
  // should be able to request into scope).
  return Number.isInteger(n) && n > 0 ? { kind: "exact", installationId: n } : { kind: "invalid" }
}

// ─── Resolved caller scope ────────────────────────────────────

interface OrgScope {
  /** The single installation the org headline describes (or the legacy sentinel). */
  installationId: number
  /** The ledger scan scope: one owned installation, or "all" for the legacy global key. */
  ledgerScope: number[] | "all"
  /** The caller's role for this exact installation. */
  role: UserRole
  /** The caller's own login (session path); null on the api-key path (no GitHub identity). */
  login: string | null
  /** Immutable caller identity for managed session responses; null for API keys/legacy fallback. */
  githubUserId: string | null
}

type OrgScopeResult = { scope: OrgScope } | { response: Response }

/**
 * Resolve a portal browser session to its org scope. Explicit selections are
 * exact and fail closed when not visible; the no-query branch uses the named
 * legacy default selector. The returned role belongs to that installation only.
 * Best-effort: a missing session-
 * encryption key or a token-decrypt failure degrades to an empty scope +
 * "member" (telemetered) rather than throwing — see the file header.
 */
async function resolveSessionScope(
  env: Env,
  session: AuthedSession,
  selection: Exclude<InstallationSelection, { kind: "invalid" }>,
): Promise<OrgScopeResult> {
  const login = session.record.login
  const numericGithubUserId = session.record.githubUserId
  const githubUserId =
    typeof numericGithubUserId === "number" && Number.isSafeInteger(numericGithubUserId) && numericGithubUserId > 0
      ? String(numericGithubUserId)
      : null
  if (env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on" && githubUserId === null) {
    return { response: json({ error: "github_account_required" }, 403) }
  }

  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "org-overview-encryption-key-missing" }))
    if (env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on") {
      return { response: json({ error: "misconfigured" }, 503) }
    }
    // installationId is forced to 0 (never the caller-supplied, unverified
    // explicit selection) so readAccountInfo's `installationId <= 0`
    // guard short-circuits — a genuinely empty panel, not a cross-tenant leak.
    return { scope: { installationId: 0, ledgerScope: [], role: "member", login, githubUserId } }
  }

  let accessToken: string
  try {
    // sig-portal-bugs: refresh the short-lived GitHub App user token before the
    // installation-scope + role lookups — a stale token 401s both and would
    // downgrade an org owner to "member" with an empty seat list.
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
  } catch (error) {
    // Never log the token itself — only that decryption failed.
    console.error(
      JSON.stringify({
        event: "org-overview-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    // Same rationale as the missing-key branch above: force installationId to
    // 0, never an unverified explicit selection.
    if (env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on") {
      return { response: json({ error: "org_access_failed" }, 500) }
    }
    return { scope: { installationId: 0, ledgerScope: [], role: "member", login, githubUserId } }
  }

  const resolved =
    selection.kind === "exact"
      ? await resolveExactUserInstallationScope(accessToken, login, selection.installationId)
      : await resolveDefaultUserInstallationScope(accessToken, login)
  if (resolved === null && selection.kind === "exact") {
    return { response: json({ error: "forbidden" }, 403) }
  }
  if (resolved === null) {
    return { scope: { installationId: 0, ledgerScope: [], role: "member", login, githubUserId } }
  }

  const policy = await resolveOrgRolePolicyForVisibleInstallation(env, {
    installationId: resolved.installationId,
    githubUserId,
    liveRole: resolved.role,
    requiredRole: "member",
    account: resolved.account,
  })
  if (!policy.ok) return { response: policy.response }

  return {
    scope: {
      installationId: resolved.installationId,
      ledgerScope: [resolved.installationId],
      role: policy.role,
      login,
      githubUserId,
    },
  }
}

/** Resolve an api-key caller to its org scope (see the file header for the admin rationale). */
function resolveApiKeyScope(installationId: number): OrgScope {
  if (installationId === LEGACY_TENANT_INSTALLATION_ID) {
    // Legacy global key — broad by design (Sigilix-internal); scans every installation.
    return { installationId, ledgerScope: "all", role: "admin", login: null, githubUserId: null }
  }
  return { installationId, ledgerScope: [installationId], role: "admin", login: null, githubUserId: null }
}

// ─── D1 reads (raw, scoped by installation_id) ────────────────

interface SeatAggRow {
  login: unknown
  reviews: unknown
  lastActiveAt: unknown
}

/**
 * Distinct billable seats for the scoped installation(s): each distinct
 * usage_ledger.author_login with a review count + latest activity timestamp.
 *
 * Tenant isolation: `ledgerScope` other than "all" produces a
 * `WHERE ... installation_id IN (?, ?, …)` filter bound with `?` placeholders
 * (never value-concatenated) — mirrors d1-workspace-prs-read.ts. "all" is the
 * legacy global-key sentinel only.
 *
 * KNOWN LIMITATION: seat roles cannot be resolved per-member here without extra
 * GitHub org-read permission, so only the CALLER's own login (when confirmed
 * admin) is marked "admin"; every other seat defaults to "member". Full per-
 * member role sync is a follow-up.
 *
 * De-dup is case-insensitive (author_login casing can vary across rows —
 * matching workspace-prs's case-insensitive collapse); reviews are summed and
 * the latest activity wins. Ordered newest-active-first, then login for a
 * stable, cursor-friendly order.
 */
async function readInstallationSeats(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  ledgerScope: number[] | "all",
  callerLogin: string | null,
  callerRole: UserRole,
): Promise<OrgSeat[]> {
  if (!env.SIGILIX_PLATFORM_DB) return []
  if (ledgerScope !== "all" && ledgerScope.length === 0) return []

  const db = env.SIGILIX_PLATFORM_DB
  const sql =
    "SELECT author_login AS login, COUNT(*) AS reviews, MAX(created_at) AS lastActiveAt" +
    " FROM usage_ledger" +
    " WHERE author_login IS NOT NULL" +
    (ledgerScope === "all" ? "" : ` AND installation_id IN (${ledgerScope.map(() => "?").join(",")})`) +
    " GROUP BY author_login ORDER BY lastActiveAt DESC LIMIT ?"

  const stmt =
    ledgerScope === "all"
      ? db.prepare(sql).bind(SEAT_SCAN_LIMIT)
      : db.prepare(sql).bind(...ledgerScope, SEAT_SCAN_LIMIT)

  const { results } = await stmt.all<SeatAggRow>()

  // Case-insensitive collapse: sum reviews, keep the latest activity (and its
  // login casing, since rows arrive newest-first).
  const byLogin = new Map<string, OrgSeat>()
  const callerKey = callerLogin ? callerLogin.toLowerCase() : null
  for (const r of results) {
    const login = typeof r.login === "string" ? r.login : ""
    if (login === "") continue
    const reviews = Number(r.reviews) || 0
    const lastActiveAt = typeof r.lastActiveAt === "string" ? r.lastActiveAt : ""
    const key = login.toLowerCase()
    const existing = byLogin.get(key)
    if (existing) {
      existing.reviews += reviews
      if (lastActiveAt > existing.lastActiveAt) existing.lastActiveAt = lastActiveAt
    } else {
      // Only the caller's own login is marked admin, and only when the caller is
      // confirmed admin (see the KNOWN LIMITATION note above).
      const role: UserRole = callerRole === "admin" && callerKey !== null && key === callerKey ? "admin" : "member"
      // Default-assigned; an explicit unassign override is applied later from
      // org_seat_assignment (see applySeatAssignments).
      byLogin.set(key, { login, role, reviews, lastActiveAt, assigned: true })
    }
  }

  return [...byLogin.values()].sort((a, b) => {
    if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt < b.lastActiveAt ? 1 : -1
    return a.login < b.login ? -1 : a.login > b.login ? 1 : 0
  })
}

/** The tenant's account_login + account_type ("Organization" | "User") for the
 * headline + the roster-source decision. Fail-soft to empty strings (missing
 * binding, no row, or D1 error). */
async function readAccountInfo(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<{ login: string; type: string }> {
  if (!env.SIGILIX_PLATFORM_DB || installationId <= 0) return { login: "", type: "" }
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT account_login, account_type FROM tenant WHERE installation_id = ?",
    )
      .bind(installationId)
      .first<{ account_login: unknown; account_type: unknown }>()
    return {
      login: row != null && typeof row.account_login === "string" ? row.account_login : "",
      type: row != null && typeof row.account_type === "string" ? row.account_type : "",
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-overview-account-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { login: "", type: "" }
  }
}

/**
 * The EXPLICIT seat-assignment overrides for an installation — a login
 * (lowercased) → its stored `assigned` flag from org_seat_assignment. A login
 * NOT in this map keeps its per-seat default (an active seat defaults assigned;
 * a roster-only member defaults unassigned). Tenant-isolated by a bound
 * installation_id `?`. Fail-soft to an empty map (missing binding, no table yet,
 * or a D1 fault) — the panel then shows each seat at its default state, not 500.
 */
async function readSeatAssignmentMap(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (!env.SIGILIX_PLATFORM_DB || installationId <= 0) return out
  try {
    const { results } = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT login, assigned FROM org_seat_assignment WHERE installation_id = ?",
    )
      .bind(installationId)
      .all<{ login: unknown; assigned: unknown }>()
    for (const r of results) {
      if (typeof r.login === "string" && r.login !== "") out.set(r.login.toLowerCase(), Number(r.assigned) === 1)
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-overview-seat-assignments-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  return out
}

/** Apply the stored overrides in place; returns the billed (assigned) seat count.
 * A seat present in the map takes its stored flag; otherwise it keeps the
 * default `seat.assigned` set at construction (active → true, roster-only → false). */
function applySeatAssignments(seats: OrgSeat[], overrides: Map<string, boolean>): number {
  let assignedCount = 0
  for (const seat of seats) {
    const override = overrides.get(seat.login.toLowerCase())
    if (override !== undefined) seat.assigned = override
    if (seat.assigned) assignedCount++
  }
  return assignedCount
}

interface ManagedSeatAssignmentState {
  byGithubUserId: Map<string, boolean>
  assignedQuantity: number
}

/**
 * Managed billing state is authoritative and therefore fail-closed. Only an
 * explicit immutable-id seat row joined to active access can count; neither a
 * mutable login nor historical activity can synthesize a managed charge.
 */
async function readManagedSeatAssignmentState(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<ManagedSeatAssignmentState | null> {
  if (!env.SIGILIX_PLATFORM_DB || installationId <= 0) return null
  try {
    const { results } = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT seat.github_user_id, seat.assigned, access.role, access.revoked_at
         FROM org_workspace_seat_assignment AS seat
         LEFT JOIN org_workspace_access AS access
           ON access.installation_id = seat.installation_id
          AND access.github_user_id = seat.github_user_id
        WHERE seat.installation_id = ?`,
    )
      .bind(installationId)
      .all<{
        github_user_id: unknown
        assigned: unknown
        role: unknown
        revoked_at: unknown
      }>()
    const byGithubUserId = new Map<string, boolean>()
    let assignedQuantity = 0
    for (const row of results) {
      if (
        !isOrgWorkspaceGithubUserId(row.github_user_id) ||
        (row.assigned !== 0 && row.assigned !== 1) ||
        (row.role !== "admin" && row.role !== "member") ||
        (row.revoked_at !== null && typeof row.revoked_at !== "string") ||
        byGithubUserId.has(row.github_user_id)
      ) {
        throw new Error("invalid managed seat assignment row")
      }
      const assigned = row.assigned === 1 && row.revoked_at === null
      byGithubUserId.set(row.github_user_id, assigned)
      if (assigned) assignedQuantity += 1
    }
    return { byGithubUserId, assignedQuantity }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-overview-managed-seat-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

function applyManagedSeatAssignments(seats: OrgSeat[], state: ManagedSeatAssignmentState): void {
  for (const seat of seats) {
    seat.assigned =
      seat.identityProvenance === "roster" && seat.accessState === "active"
        ? (state.byGithubUserId.get(seat.githubUserId) ?? false)
        : false
  }
}

/**
 * sig-org-members: merge the installation's GitHub member roster into the
 * activity-derived `seats` (in place, admin scope only). An active seat that
 * matches a roster member gains its avatar; a roster member with NO activity is
 * appended as a new seat (reviews 0, "never" active, default UNASSIGNED — an
 * admin assigns them a billable seat explicitly). De-dup is case-insensitive on
 * login, matching readInstallationSeats. Fully fail-soft (see fetchInstallationRoster):
 * an empty roster leaves `seats` exactly as it was.
 */
async function mergeGitHubRoster(
  env: Env,
  seats: OrgSeat[],
  installationId: number,
  account: { login: string; type: string },
): Promise<boolean> {
  const roster = await fetchInstallationRoster(env, installationId, account.login, account.type)
  if (roster.reason) {
    console.warn(
      JSON.stringify({ event: "org-overview-roster", installationId, source: roster.source, reason: roster.reason }),
    )
  }
  if (roster.members.length === 0) return roster.complete

  const byLogin = new Map<string, OrgSeat>()
  for (const seat of seats) byLogin.set(seat.login.toLowerCase(), seat)

  for (const member of roster.members) {
    const key = member.login.toLowerCase()
    const existing = byLogin.get(key)
    if (existing) {
      // The roster is the identity authority: enrich the activity-derived
      // display row with the immutable account id used by member mutations.
      const enriched: OrgRosterSeat = {
        ...existing,
        githubUserId: member.githubUserId,
        identityProvenance: "roster",
        // Prefer the GitHub avatar for a seat we can now match to the roster.
        ...(member.avatarUrl !== "" ? { avatarUrl: member.avatarUrl } : {}),
      }
      const index = seats.indexOf(existing)
      if (index !== -1) seats[index] = enriched
      byLogin.set(key, enriched)
      continue
    }
    // Roster-only member: no activity yet, so default UNASSIGNED (an admin
    // grants the seat). An org_seat_assignment override is applied afterwards.
    const seat: OrgRosterSeat = {
      githubUserId: member.githubUserId,
      identityProvenance: "roster",
      login: member.login,
      role: "member",
      reviews: 0,
      lastActiveAt: "",
      assigned: false,
      ...(member.avatarUrl !== "" ? { avatarUrl: member.avatarUrl } : {}),
    }
    byLogin.set(key, seat)
    seats.push(seat)
  }
  return roster.complete
}

function validManagedAccess(access: OrgWorkspaceAccess, installationId: number): boolean {
  return (
    access.installationId === installationId &&
    isOrgWorkspaceGithubUserId(access.githubUserId) &&
    (access.role === "admin" || access.role === "member") &&
    (access.revokedAt === null || typeof access.revokedAt === "string")
  )
}

/**
 * Overlay exact-installation stored roles onto roster-proven identities. The
 * store is read once, never once per member. Missing/revoked access becomes an
 * actionable `available` state only when the roster is complete; partial roster
 * identities remain display-only and omit accessState. Mutates the request-local
 * seats array in place, matching roster and assignment enrichment above.
 */
async function applyManagedAccess(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  seats: OrgSeat[],
  installationId: number,
  rosterComplete: boolean,
): Promise<Response | null> {
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "misconfigured" }, 503)

  let accessRows: OrgWorkspaceAccess[]
  try {
    accessRows = await listOrgWorkspaceAccess(env.SIGILIX_PLATFORM_DB, installationId)
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-overview-access-list-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "org_access_unavailable" }, 503)
  }

  const byGithubUserId = new Map<string, OrgWorkspaceAccess>()
  for (const access of accessRows) {
    if (!validManagedAccess(access, installationId)) {
      console.warn(
        JSON.stringify({
          event: "org-overview-access-row-invalid",
          installationId,
          rowInstallationId: access.installationId,
          githubUserId: access.githubUserId,
        }),
      )
      return json({ error: "org_access_unavailable" }, 503)
    }
    byGithubUserId.set(access.githubUserId, access)
  }

  for (let index = 0; index < seats.length; index++) {
    const seat = seats[index]!
    if (seat.identityProvenance !== "roster") continue
    const access = byGithubUserId.get(seat.githubUserId)
    if (access?.revokedAt === null) {
      seats[index] = { ...seat, role: access.role, accessState: "active" }
    } else if (rosterComplete) {
      seats[index] = { ...seat, role: "member", accessState: "available" }
    } else {
      const { accessState: _accessState, ...readOnlySeat } = seat
      seats[index] = readOnlySeat
    }
  }
  return null
}

// ─── Handler ──────────────────────────────────────────────────

/** GET /v1/org/overview — see file header. */
export async function handleOrgOverviewRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(request, env, ctx)

  const url = new URL(request.url)
  const selection = parseInstallationSelection(url)

  let scope: OrgScope
  if (session) {
    if (selection.kind === "invalid") return json({ error: "invalid installation id" }, 400)
    const resolved = await resolveSessionScope(env, session, selection)
    if ("response" in resolved) return resolved.response
    scope = resolved.scope
  } else {
    const apiAuth = await requireApiTenant(request, env, ctx)
    if ("response" in apiAuth) return apiAuth.response // 401
    scope = resolveApiKeyScope(apiAuth.caller.installationId)
  }

  const plan = await resolvePlan(env, scope.installationId)
  const billing = resolveBilling(env)

  // Best-effort org headline + seats. Any D1 fault degrades to an empty seat
  // list at 200 — never a 500 (see the file header).
  let accountInfo = { login: "", type: "" }
  let seats: OrgSeat[] = []
  try {
    ;[accountInfo, seats] = await Promise.all([
      readAccountInfo(env, scope.installationId),
      readInstallationSeats(env, scope.ledgerScope, scope.login, scope.role),
    ])
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-overview-read-failed",
        installationId: scope.installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    accountInfo = { login: "", type: "" }
    seats = []
  }

  // sig-org-members: an ADMIN sees the org's ACTUAL GitHub roster (fetched via
  // the installed App token), merged with the activity-derived seats — so the
  // Members tab lists everyone, not only people who've already used Sigilix. A
  // MEMBER only ever sees their own seat (below), so the roster fetch is skipped
  // for them (bounded cost + no cross-member disclosure). Fully fail-soft.
  let rosterComplete = false
  if (scope.role === "admin") {
    rosterComplete = await mergeGitHubRoster(env, seats, scope.installationId, accountInfo)
    // Re-sort the merged list: recently-active seats first (real lastActiveAt,
    // newest wins), then the never-active roster members by login — a stable,
    // cursor-friendly order matching readInstallationSeats' own ordering.
    seats.sort((a, b) => {
      if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt < b.lastActiveAt ? 1 : -1
      return a.login.toLowerCase() < b.login.toLowerCase() ? -1 : a.login.toLowerCase() > b.login.toLowerCase() ? 1 : 0
    })
  }

  // Stored access is authorization state, not a fail-soft enrichment. In
  // managed mode an admin/API-key response must either show the exact stored
  // roles and mutation states or fail closed; fabricating every row as member
  // would make the Portal disagree with the mutation endpoints.
  if (env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on" && scope.role === "admin" && scope.installationId > 0) {
    // Members never receive the roster and therefore have no peer mutation
    // targets to enrich; their existing own-seat privacy branch stays below.
    const accessFailure = await applyManagedAccess(env, seats, scope.installationId, rosterComplete)
    if (accessFailure) return accessFailure
  }

  const org = { account: accountInfo.login, installationId: scope.installationId, plan }
  const seatCount = seats.length

  let assignedSeatCount: number
  if (env.OPENCLAW_ORG_MEMBERSHIP_MODE === "on" && scope.installationId > 0) {
    const managedSeats = await readManagedSeatAssignmentState(env, scope.installationId)
    if (managedSeats === null) return json({ error: "seat_billing_unavailable" }, 503)
    applyManagedSeatAssignments(seats, managedSeats)
    assignedSeatCount = managedSeats.assignedQuantity
    if (scope.role !== "admin" && scope.githubUserId !== null) {
      const ownSeat = seats.find((seat) => seat.login.toLowerCase() === scope.login?.toLowerCase())
      if (ownSeat) ownSeat.assigned = managedSeats.byGithubUserId.get(scope.githubUserId) ?? false
    }
  } else {
    // Rollout-off keeps the activity/login override contract byte-for-byte.
    const overrides = await readSeatAssignmentMap(env, scope.installationId)
    assignedSeatCount = applySeatAssignments(seats, overrides)
  }

  // MEMBER: never expose other members' logins/activity/roles — return only the
  // caller's own seat (if present), no pagination.
  if (scope.role !== "admin") {
    const callerKey = scope.login ? scope.login.toLowerCase() : null
    const ownSeat = callerKey !== null ? seats.find((s) => s.login.toLowerCase() === callerKey) : undefined
    return json(
      {
        org,
        role: scope.role,
        seatCount,
        assignedSeatCount,
        seats: ownSeat ? [ownSeat] : [],
        billing,
      } satisfies OrgOverviewResponse,
      200,
    )
  }

  // ADMIN: full, paginated seat list.
  const limit = parseLimit(url.searchParams.get("limit"))
  const offset = decodeCursor(url.searchParams.get("cursor"))
  const page = seats.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  const nextCursor = nextOffset < seatCount ? encodeCursor(nextOffset) : undefined

  return json(
    {
      org,
      role: scope.role,
      seatCount,
      assignedSeatCount,
      seats: page,
      billing,
      ...(nextCursor ? { nextCursor } : {}),
    } satisfies OrgOverviewResponse,
    200,
  )
}
