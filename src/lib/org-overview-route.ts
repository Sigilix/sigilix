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
//     at a time, so we pick a "current" installation: the `?installationId=`
//     query param IFF the caller actually owns it (tenant-isolation guard),
//     else the first owned installation. The ledger scan is scoped to exactly
//     that one installation.
//   - Api-key path: the key's own installationId. The legacy global-key
//     sentinel (LEGACY_TENANT_INSTALLATION_ID) stays broad on purpose — it is
//     Sigilix-internal, never handed to an external tenant — matching
//     callerOwnsInstallation's existing legacy semantics; it scans "all"
//     installations. A real per-tenant key is scoped to exactly its own
//     installation and can never see another tenant's seats.
//
// Role gating (resolve-user-role.ts):
//   - ADMIN: the full response — org headline + full paginated seat list +
//     billing placeholder.
//   - MEMBER: a limited response — the same org headline + billing placeholder
//     + the real total seatCount, but `seats` contains ONLY the caller's own
//     seat (never another member's login / activity / role). A member is NEVER
//     403'd — always 200 with the role-appropriate shape.
//   The api-key path has no GitHub identity to run resolveUserRole against; a
//   per-installation key is a tenant-scoped service credential with full access
//   to its own installation's data (the same access workspace-prs grants it), so
//   it is treated as "admin" for its installation.
//
// Tenant isolation (CRITICAL): the usage_ledger seat query filters by the
// caller's exact installation_id via bound `?` placeholders (never string-
// concatenated values) — mirroring d1-workspace-prs-read.ts's WHERE-clause
// pattern. Seats never leak across installations.
//
// Fail-soft: every D1 read and every GitHub call is wrapped; on any failure the
// route degrades to a best-effort 200 with an empty seat list rather than
// throwing (auth-layer failures ahead of that — requireSession/requireApiTenant
// — are unaffected and can still surface their own status). Unlike
// workspace-prs-route.ts (which 503s on a missing session-encryption key and
// 500s on a decrypt failure), this route treats those as best-effort-empty at
// 200 too — an authenticated user whose token we transiently can't use still
// gets a rendered (empty) panel, the underlying fault is telemetered for
// observability, and installationId is forced to 0 in that degraded scope so
// no cross-tenant account/org data can be read via an unverified
// ?installationId= query param (see resolveSessionScope).

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { resolveUserRole, type UserRole } from "@/src/lib/resolve-user-role"
import type { Env } from "@/src/shared/types/env"

// Defensive pagination cap on GET /user/installations (session→installation
// bridge) — mirrors workspace-prs-route.ts.
const MAX_INSTALLATION_PAGES = 20

// Distinct-author scan cap: read up to this many seats from D1 before
// in-memory case-insensitive de-dup + pagination. Generous relative to any
// real org's seat count; a bound purely to keep an anomalous installation from
// scanning unbounded.
const SEAT_SCAN_LIMIT = 1000

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200

const ORG_PLANS = ["free", "pro", "max", "ultra", "team", "enterprise"] as const
export type OrgPlan = (typeof ORG_PLANS)[number]

export interface OrgSeat {
  login: string
  role: UserRole
  reviews: number
  lastActiveAt: string
}

export interface OrgOverviewResponse {
  org: { account: string; installationId: number; plan: OrgPlan }
  role: UserRole
  seatCount: number
  seats: OrgSeat[]
  billing: { model: "per-seat"; perSeatMonthly: number | null; note: string }
  nextCursor?: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: Array<{ id?: number }>
}

/** Every installation id the session's GitHub user-to-server token can see. Soft-fails to []. */
async function fetchUserInstallationIds(accessToken: string): Promise<number[]> {
  const ids: number[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(accessToken),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: UserInstallationsResponse
    try {
      body = (await res.json()) as UserInstallationsResponse
    } catch {
      break
    }
    const installs = Array.isArray(body.installations) ? body.installations : []
    for (const inst of installs) {
      if (typeof inst.id === "number") ids.push(inst.id)
    }
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return ids
}

// ─── Config helpers (plan + billing placeholders) ─────────────

/** Plan from OPENCLAW_PLAN (validated against the known set), else "free". */
function resolvePlan(env: Pick<Env, "OPENCLAW_PLAN">): OrgPlan {
  const raw = env.OPENCLAW_PLAN
  return (ORG_PLANS as readonly string[]).includes(raw ?? "") ? (raw as OrgPlan) : "free"
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

function parseInstallationIdParam(url: URL): number | null {
  const raw = url.searchParams.get("installationId")
  if (raw === null || raw.trim() === "") return null
  const n = Number(raw)
  // Real installation ids are always positive (0 and the legacy sentinel
  // LEGACY_TENANT_INSTALLATION_ID = -1 are never something a query param
  // should be able to request into scope).
  return Number.isInteger(n) && n > 0 ? n : null
}

// ─── Resolved caller scope ────────────────────────────────────

interface OrgScope {
  /** The single installation the org headline describes (or the legacy sentinel). */
  installationId: number
  /** The ledger scan scope: one owned installation, or "all" for the legacy global key. */
  ledgerScope: number[] | "all"
  /** The caller's aggregate role. */
  role: UserRole
  /** The caller's own login (session path); null on the api-key path (no GitHub identity). */
  login: string | null
}

/**
 * Resolve a portal browser session to its org scope: the installation ids its
 * GitHub token can see, a "current" one (the `?installationId=` param if owned,
 * else the first), and its admin/member role. Best-effort: a missing session-
 * encryption key or a token-decrypt failure degrades to an empty scope +
 * "member" (telemetered) rather than throwing — see the file header.
 */
async function resolveSessionScope(
  env: Env,
  session: AuthedSession,
  requestedInstallationId: number | null,
): Promise<OrgScope> {
  const login = session.record.login

  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "org-overview-encryption-key-missing" }))
    // installationId is forced to 0 (never the caller-supplied, unverified
    // requestedInstallationId) so readAccountLogin's `installationId <= 0`
    // guard short-circuits — a genuinely empty panel, not a cross-tenant leak.
    return { installationId: 0, ledgerScope: [], role: "member", login }
  }

  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch (error) {
    // Never log the token itself — only that decryption failed.
    console.error(
      JSON.stringify({
        event: "org-overview-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    // Same rationale as the missing-key branch above: force installationId to
    // 0, never the unverified requestedInstallationId.
    return { installationId: 0, ledgerScope: [], role: "member", login }
  }

  const [ownedIds, role] = await Promise.all([
    fetchUserInstallationIds(accessToken),
    resolveUserRole(accessToken, login),
  ])

  // Current installation: the requested one IFF the caller owns it (tenant-
  // isolation guard — never scope to an installation the token can't see),
  // else the first owned installation, else none.
  const current =
    requestedInstallationId !== null && ownedIds.includes(requestedInstallationId)
      ? requestedInstallationId
      : (ownedIds[0] ?? 0)

  return {
    installationId: current,
    ledgerScope: current > 0 ? [current] : [],
    role,
    login,
  }
}

/** Resolve an api-key caller to its org scope (see the file header for the admin rationale). */
function resolveApiKeyScope(installationId: number): OrgScope {
  if (installationId === LEGACY_TENANT_INSTALLATION_ID) {
    // Legacy global key — broad by design (Sigilix-internal); scans every installation.
    return { installationId, ledgerScope: "all", role: "admin", login: null }
  }
  return { installationId, ledgerScope: [installationId], role: "admin", login: null }
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
      byLogin.set(key, { login, role, reviews, lastActiveAt })
    }
  }

  return [...byLogin.values()].sort((a, b) => {
    if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt < b.lastActiveAt ? 1 : -1
    return a.login < b.login ? -1 : a.login > b.login ? 1 : 0
  })
}

/** The tenant's account_login for the headline. Fail-soft to "" (missing binding, no row, or D1 error). */
async function readAccountLogin(env: Pick<Env, "SIGILIX_PLATFORM_DB">, installationId: number): Promise<string> {
  if (!env.SIGILIX_PLATFORM_DB || installationId <= 0) return ""
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare("SELECT account_login FROM tenant WHERE installation_id = ?")
      .bind(installationId)
      .first<{ account_login: unknown }>()
    return row != null && typeof row.account_login === "string" ? row.account_login : ""
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "org-overview-account-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return ""
  }
}

// ─── Handler ──────────────────────────────────────────────────

/** GET /v1/org/overview — see file header. */
export async function handleOrgOverviewRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(request, env, ctx)

  const url = new URL(request.url)
  const requestedInstallationId = parseInstallationIdParam(url)

  let scope: OrgScope
  if (session) {
    scope = await resolveSessionScope(env, session, requestedInstallationId)
  } else {
    const apiAuth = await requireApiTenant(request, env, ctx)
    if ("response" in apiAuth) return apiAuth.response // 401
    scope = resolveApiKeyScope(apiAuth.caller.installationId)
  }

  const plan = resolvePlan(env)
  const billing = resolveBilling(env)

  // Best-effort org headline + seats. Any D1 fault degrades to an empty seat
  // list at 200 — never a 500 (see the file header).
  let account = ""
  let seats: OrgSeat[] = []
  try {
    ;[account, seats] = await Promise.all([
      readAccountLogin(env, scope.installationId),
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
    account = ""
    seats = []
  }

  const org = { account, installationId: scope.installationId, plan }
  const seatCount = seats.length

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
      seats: page,
      billing,
      ...(nextCursor ? { nextCursor } : {}),
    } satisfies OrgOverviewResponse,
    200,
  )
}
