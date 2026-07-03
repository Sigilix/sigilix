// SIG-303 full usage metering — GET /v1/usage.
//
// Powers the portal "Plan usage" panel + the CLI `/usage` bars with the caller's
// REAL, live usage against the caps Sigilix actually enforces — never fabricated,
// never overstated, NO per-model data.
//
// TWO INDEPENDENT POOLS (founder model):
//   • ORG pool  (scope=org)  — a single shared org limit consumed by org AUTOMATION:
//       pr_reviews (read from usage_ledger) + linear_triage + slack (usage_events).
//       Keyed by installation. Admin `?author=` drills into who triggered org usage.
//   • SEAT pool (scope=user) — a per-dev limit consumed by DIRECT personal use:
//       coding_agent + chatbot (usage_events), keyed by the caller's seat.
//   The pools are INDEPENDENT: an org event never moves a seat counter and vice
//   versa. Per-meter `used` is a breakdown; `totals` is the pool aggregate that
//   enforcement actually gates on (`limit` = the shared pool cap).
//
// Windows: 5h rolling (session/burst) AND a FIXED weekly window that resets every
// Monday 09:00 UTC (the headline cap) — weekly resets_at is the next Monday 09:00.
// Everything is COUNT-based (runs / messages / reviews) — never per-minute/cost.
//
// Auth mirrors workspace-prs / org-overview: portal SESSION cookie first
// (requireSession → SEAT scope by default), else a bearer API key (requireApiTenant
// → ORG scope by default). `?scope=` overrides; org scope + `?author=` is ADMIN-only
// and always tenant-isolated to the caller's own installation. CORS'd in index.ts.

import { requireSession } from "@/src/lib/auth-middleware"
import { resolvePlanFromEnv, type PlanName } from "@/src/lib/resolve-plan"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import {
  resolveUsageMeterMode,
  resolveUsagePoolCap,
  usagePct,
  readTenantUsageSince,
  readUsageEventCount,
  readUsageEventAuthorBreakdown,
  readRollingReviewCount,
  ORG_METERS,
  SEAT_METERS,
  USAGE_SESSION_WINDOW_MS,
  weeklyWindowStartMs,
  weeklyWindowResetMs,
  USAGE_WINDOW_LABEL,
} from "@/src/features/tenancy"
import type { UsageMeter, UsageMeterMode, UsagePool } from "@/src/features/tenancy"
import type { Env } from "@/src/shared/types/env"

const MAX_INSTALLATION_PAGES = 20

// Plan name/type live in resolve-plan.ts (the billing seam) so /v1/usage and
// /v1/profile can never disagree about a user's plan.
type UsagePlan = PlanName

/** One window of one meter/total: usage vs the (shared pool) cap. */
export interface UsageMeterWindow {
  used: number
  /** The shared pool cap for this window. null → no hard cap (usage-only, no bar). */
  limit: number | null
  /** 0–100 rounded; null when limit is null. */
  pct: number | null
}

export interface UsageMeterBars {
  session: UsageMeterWindow
  weekly: UsageMeterWindow
}

/** Contract scope label: "user" ⇒ SEAT pool, "org" ⇒ ORG pool. */
export type UsageScope = "user" | "org"

export interface UsageResponse {
  plan: UsagePlan
  account: string
  scope: UsageScope
  mode: UsageMeterMode
  windows: {
    session: { window_label: string; resets_at: string }
    weekly: { window_label: string; resets_at: string }
  }
  /** Per-meter breakdown for the scope's pool. Keys vary by scope (see file header). */
  meters: Partial<Record<UsageMeter, UsageMeterBars>>
  /** The pool aggregate — the enforced total (sum of the pool's meters vs the shared cap). */
  totals: UsageMeterBars & { since_session: string; since_weekly: string }
  /** Optional admin breakdown of who triggered ORG usage (scope=org only). */
  authors?: Array<{ user_key: string; session: number; weekly: number }>
  generated_at: string
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

function parseInstallationIdParam(url: URL): number | null {
  const raw = url.searchParams.get("installationId")
  if (raw === null || raw.trim() === "") return null
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

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
        event: "usage-account-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return ""
  }
}

/** Resolved caller scope for the usage read. */
interface ResolvedScope {
  scope: UsageScope
  installationId: number
  /** Seat key for scope=user (e.g. "gh:<id>" | "inst:<id>"). */
  seatKey: string | null
  /** Admin per-author filter for scope=org (matches usage_events.user_key / pr author). */
  authorFilter: string | null
  account: string
}

/**
 * Count one ORG-pool meter for an installation in [since, now]. pr_reviews reads
 * usage_ledger (per-author when `author` is set); linear_triage/slack read
 * usage_events. Returns null on a fault; the caller's `cell()` renders that as 0
 * with the cap (the safe direction — a read fault never inflates usage against a
 * cap, so it can't wrongly block).
 *
 * INTENTIONAL: the `author` drill-down is only meaningful for pr_reviews, whose
 * usage_ledger.author_login IS a GitHub login. slack rows are user-keyed as
 * `slack:<id>` (a Slack id, not a GitHub login) and linear_triage rows have a NULL
 * user_key, so an `author=<github-login>` filter legitimately returns 0 for those
 * two — org drill-down by GitHub identity is a pr_reviews concept.
 */
async function readOrgMeter(
  env: Env,
  meter: UsageMeter,
  installationId: number,
  author: string | null,
  sinceIso: string,
): Promise<number | null> {
  if (meter === "pr_reviews") {
    if (author) {
      const res = await readRollingReviewCount(env, { installationId, authorLogin: author, sinceIso, limit: 1 })
      return res.ok ? res.count : null
    }
    const res = await readTenantUsageSince(env, installationId, sinceIso)
    return res.ok ? res.reviews : null
  }
  if (meter === "linear_triage" || meter === "slack") {
    const res = await readUsageEventCount(env, {
      meter,
      installationId,
      ...(author ? { userKey: author } : {}),
      sinceIso,
    })
    return res.ok ? res.count : null
  }
  return null
}

/** Count one SEAT-pool meter (coding_agent | chatbot) for a seat in [since, now]. */
async function readSeatMeter(env: Env, meter: UsageMeter, seatKey: string, sinceIso: string): Promise<number | null> {
  if (meter !== "coding_agent" && meter !== "chatbot") return null
  const res = await readUsageEventCount(env, { meter, userKey: seatKey, sinceIso })
  return res.ok ? res.count : null
}

/**
 * Build a { used, limit, pct } window cell. A null `used` (a read fault) collapses
 * to 0 here — deliberately the SAFE direction: a fault shows 0 usage rather than a
 * fabricated high number, so a display read can never overstate consumption against
 * the cap. (Enforcement lives in checkUsagePool, which fails OPEN on the same fault.)
 */
function cell(used: number | null, cap: number | null): UsageMeterWindow {
  const u = used ?? 0
  return { used: u, limit: cap, pct: usagePct(u, cap) }
}

/** GET /v1/usage — see file header. */
export async function handleUsageRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const nowMs = Date.now()
  const mode = resolveUsageMeterMode(env)
  const plan = resolvePlanFromEnv(env)

  const session = await requireSession(request, env, ctx)
  let resolved: ResolvedScope

  if (session) {
    if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
      console.error(JSON.stringify({ event: "usage-encryption-key-missing" }))
      return json({ error: "misconfigured" }, 503)
    }
    let accessToken: string
    try {
      accessToken = await decryptAccessToken(
        { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
        session.sessionId,
        env.OPENCLAW_SESSION_ENCRYPTION_KEY,
      )
    } catch (error) {
      console.error(
        JSON.stringify({ event: "usage-decrypt-failed", err: error instanceof Error ? error.message : String(error) }),
      )
      return json({ error: "usage_failed" }, 500)
    }
    const requested = parseInstallationIdParam(url)
    const ownedIds = await fetchUserInstallationIds(accessToken)
    const current = requested !== null && ownedIds.includes(requested) ? requested : (ownedIds[0] ?? 0)
    const account = current > 0 ? await readAccountLogin(env, current) : ""

    // Default = the caller's own SEAT usage. The org Billing→Usage tab may request
    // `?scope=org` (org pool) or `?scope=org&author=<login>` (drill into who
    // triggered org usage) — both ADMIN-only, always the caller's own installation
    // (tenant isolation). A member (or absent param) always falls back to self.
    // SIG-303: the admin check MUST be scoped to `current` (this installation) via
    // isAdminOfInstallation — NOT the aggregate resolveUserRole, which returns
    // "admin" for anyone owning ANY personal install and would let a mere member of
    // this org read its aggregate + per-developer usage.
    const wantsOrg = url.searchParams.get("scope") === "org"
    const authorParam = url.searchParams.get("author")?.trim() || null

    if (wantsOrg && current > 0) {
      const isAdmin = await isAdminOfInstallation(accessToken, session.record.login, current)
      if (isAdmin) {
        resolved = { scope: "org", installationId: current, seatKey: null, authorFilter: authorParam, account }
      } else {
        // non-admin → own seat (never the org aggregate)
        resolved = {
          scope: "user",
          installationId: current,
          seatKey: `gh:${session.record.githubUserId ?? session.record.userId ?? "anon"}`,
          authorFilter: null,
          account,
        }
      }
    } else {
      resolved = {
        scope: "user",
        installationId: current,
        seatKey: `gh:${session.record.githubUserId}`,
        authorFilter: null,
        account,
      }
    }
  } else {
    const apiAuth = await requireApiTenant(request, env, ctx)
    if ("response" in apiAuth) return apiAuth.response
    const installationId = apiAuth.caller.installationId
    const scopedInstallationId = installationId === LEGACY_TENANT_INSTALLATION_ID ? 0 : installationId
    const account = scopedInstallationId > 0 ? await readAccountLogin(env, scopedInstallationId) : ""
    // An API key represents an installation → default ORG scope; `?scope=user`
    // reports the key's own SEAT (its CLI coding_agent / chatbot usage).
    const wantsUser = url.searchParams.get("scope") === "user"
    const authorParam = url.searchParams.get("author")?.trim() || null
    if (wantsUser) {
      resolved = {
        scope: "user",
        installationId: scopedInstallationId,
        seatKey: `inst:${scopedInstallationId}`,
        authorFilter: null,
        account,
      }
    } else {
      resolved = {
        scope: "org",
        installationId: scopedInstallationId,
        seatKey: null,
        authorFilter: authorParam,
        account,
      }
    }
  }

  const pool: UsagePool = resolved.scope === "org" ? "org" : "seat"
  const capSession = resolveUsagePoolCap(env, pool, "session")
  const capWeekly = resolveUsagePoolCap(env, pool, "weekly")
  // Session = 5h ROLLING; weekly = since the most recent Monday-09:00 UTC anchor
  // (FIXED weekly reset — see usage-meters.ts).
  const sinceSession = new Date(nowMs - USAGE_SESSION_WINDOW_MS).toISOString()
  const sinceWeekly = new Date(weeklyWindowStartMs(nowMs)).toISOString()

  const metersOut: Partial<Record<UsageMeter, UsageMeterBars>> = {}
  let sumSession = 0
  let sumWeekly = 0

  const meterList = pool === "org" ? ORG_METERS : SEAT_METERS
  for (const meter of meterList) {
    let usedS: number | null
    let usedW: number | null
    if (pool === "org" && resolved.installationId > 0) {
      ;[usedS, usedW] = await Promise.all([
        readOrgMeter(env, meter, resolved.installationId, resolved.authorFilter, sinceSession),
        readOrgMeter(env, meter, resolved.installationId, resolved.authorFilter, sinceWeekly),
      ])
    } else if (pool === "seat" && resolved.seatKey) {
      ;[usedS, usedW] = await Promise.all([
        readSeatMeter(env, meter, resolved.seatKey, sinceSession),
        readSeatMeter(env, meter, resolved.seatKey, sinceWeekly),
      ])
    } else {
      usedS = 0
      usedW = 0
    }
    metersOut[meter] = { session: cell(usedS, capSession), weekly: cell(usedW, capWeekly) }
    sumSession += usedS ?? 0
    sumWeekly += usedW ?? 0
  }

  // Optional ORG per-author breakdown ("who triggered org usage") — merged across
  // the usage_events org meters (slack + linear_triage). Only when scope=org, an
  // installation is resolved, and no author filter is already applied. Best-effort:
  // a fault just omits the breakdown (never fails the response).
  let authors: UsageResponse["authors"]
  if (pool === "org" && resolved.installationId > 0 && !resolved.authorFilter) {
    const acc = new Map<string, { session: number; weekly: number }>()
    for (const [win, since] of [
      ["session", sinceSession],
      ["weekly", sinceWeekly],
    ] as const) {
      for (const meter of ["slack", "linear_triage"] as const) {
        const res = await readUsageEventAuthorBreakdown(env, {
          meter,
          installationId: resolved.installationId,
          sinceIso: since,
        })
        if (!res.ok) continue
        for (const a of res.authors) {
          const cur = acc.get(a.userKey) ?? { session: 0, weekly: 0 }
          cur[win] += a.count
          acc.set(a.userKey, cur)
        }
      }
    }
    if (acc.size > 0) {
      authors = [...acc.entries()]
        .map(([user_key, v]) => ({ user_key, session: v.session, weekly: v.weekly }))
        .sort((a, b) => b.weekly - a.weekly || b.session - a.session)
    }
  }

  // session: 5h ROLLING → clears by now+5h (upper bound). weekly: FIXED schedule →
  // the exact NEXT Monday-09:00 UTC boundary (honest "Resets Mon 9:00 AM" label).
  const sessionResetsAt = new Date(nowMs + USAGE_SESSION_WINDOW_MS).toISOString()
  const weeklyResetsAt = new Date(weeklyWindowResetMs(nowMs)).toISOString()

  const body: UsageResponse = {
    plan,
    account: resolved.account,
    scope: resolved.scope,
    mode,
    windows: {
      session: { window_label: USAGE_WINDOW_LABEL.session, resets_at: sessionResetsAt },
      weekly: { window_label: USAGE_WINDOW_LABEL.weekly, resets_at: weeklyResetsAt },
    },
    meters: metersOut,
    totals: {
      session: cell(sumSession, capSession),
      weekly: cell(sumWeekly, capWeekly),
      since_session: sinceSession,
      since_weekly: sinceWeekly,
    },
    ...(authors ? { authors } : {}),
    generated_at: new Date(nowMs).toISOString(),
  }
  return json(body, 200)
}
