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
// Counts remain an anti-abuse dimension; real USD model spend is reported separately
// and is the primary admission dimension where a comparable seat/author budget exists.
//
// Auth mirrors workspace-prs / org-overview: portal SESSION cookie first
// (requireSession → SEAT scope by default), else a bearer API key (requireApiTenant
// → ORG scope by default). `?scope=` overrides; org scope + `?author=` is ADMIN-only
// and always tenant-isolated to the caller's own installation. CORS'd in index.ts.

import { requireSession } from "@/src/lib/auth-middleware"
import { resolveInstallationPlan, type PlanName } from "@/src/lib/resolve-plan"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import { isLinkedToInstallation } from "@/src/lib/api-key-store"
import { resolveGithubAuthors } from "@/src/shared/adapters/github/resolve-authors"
import {
  resolveUsageMeterMode,
  resolveRateLimitMode,
  resolveUsagePoolCap,
  resolveTierCostBudgetUsd,
  readTenantSubscriptionStatus,
  isFullPaidStatus,
  usagePct,
  readTenantUsageSince,
  readUsageEventCount,
  readUsageEventCostSince,
  readUsageEventAuthorBreakdown,
  readRollingReviewCount,
  ORG_METERS,
  SEAT_METERS,
  USAGE_SESSION_WINDOW_MS,
  weeklyWindowStartMs,
  weeklyWindowResetMs,
  USAGE_WINDOW_LABEL,
} from "@/src/features/tenancy"
import type { RateLimitMode, UsageMeter, UsageMeterMode, UsagePool } from "@/src/features/tenancy"
import {
  modelBurnTable,
  approxTasksRemaining,
  usageUpsellHint,
  type ModelBurn,
} from "@/src/shared/domain/sigilix-model-burn"
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

/** sig-cost-based-metering — the COST dimension of a window: real spend vs the
 *  tier's USD budget. `budget_usd: null` ⇒ UNBOUNDED (enterprise) → the UI shows
 *  "Unlimited" and all pct/remaining fields are null. */
export interface UsageCostWindow {
  /** Blended model spend consumed in the window (USD), rounded to 4 dp. */
  used_usd: number
  /** The tier's per-window USD budget, or null when unbounded/not comparable.
   *  `budget_state` disambiguates those cases. */
  budget_usd: number | null
  /** max(0, budget − used), or null when unbounded/not comparable. */
  remaining_usd: number | null
  /** 0–100 % of the budget CONSUMED; null when unbounded. */
  pct: number | null
  /** 0–100 % of the budget REMAINING (100 − pct); null when unbounded. */
  remaining_pct: number | null
  /** Intuitive "≈ N Boreas tasks left" from remaining_usd; null when unbounded. */
  approx_boreas_tasks_remaining: number | null
  /** Why the budget fields are numeric or null. Distinguishes a genuinely
   * unbounded seat from an org aggregate that has no comparable shared budget. */
  budget_state: "limited" | "unbounded" | "not_applicable"
  /** Whether this window's used_usd and budget_usd describe the same admission scope. */
  budget_applies_to_used: boolean
}

export interface UsageCost {
  session: UsageCostWindow
  weekly: UsageCostWindow
}

export interface UsageEnforcement {
  /** Shared source for seat-pool and Slack-pool count/cost admission. */
  usage_pool_mode: UsageMeterMode
  /** Independent source used by per-author PR-review admission. */
  pr_review_mode: RateLimitMode
  /** The subject one effective tier budget belongs to. */
  cost_budget_scope: "seat" | "author"
  /** Windows that can currently block the resolved cost subject. */
  cost_windows: { session: boolean; weekly: boolean }
  /** Whether the effective numeric budget is reduced from the tier's full budget. */
  volume: "full" | "reduced"
}

/** Contract scope label: "user" ⇒ SEAT pool, "org" ⇒ ORG pool. */
export type UsageScope = "user" | "org"

export interface UsageResponse {
  plan: UsagePlan
  account: string
  scope: UsageScope
  mode: UsageMeterMode
  /** Explicit current admission facts. `mode` remains as the compatibility alias
   * for enforcement.usage_pool_mode. */
  enforcement: UsageEnforcement
  windows: {
    session: { window_label: string; resets_at: string }
    weekly: { window_label: string; resets_at: string }
  }
  /** Per-meter breakdown for the scope's pool. Keys vary by scope (see file header). */
  meters: Partial<Record<UsageMeter, UsageMeterBars>>
  /** The pool aggregate (sum of the pool's meters vs its count cap). Whether that
   * comparison can block is explicit in mode/enforcement, never implied by this field. */
  totals: UsageMeterBars & { since_session: string; since_weekly: string }
  /** sig-cost-based-metering — real model spend plus an effective tier budget only
   *  when both values share a seat/author scope. Unfiltered org aggregates keep spend
   *  but mark their budget not_applicable, so clients never render a fake balance. */
  cost: UsageCost
  /** Per-model RELATIVE burn rate (cheapest = 1.0×) so the user understands why a
   *  premium-model session drains the budget faster. Every model is available on
   *  every tier — this is transparency, not a gate. */
  model_burn: ModelBurn[]
  /** Soft upsell nudge when the (enforced session) budget runs low, else null. */
  hint: string | null
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
  /**
   * When set, SEAT reads are ALSO scoped to this installation_id (tenant-safety
   * for an admin's per-member drill: only seat events attributed to the admin's
   * own org are counted, never the member's usage in another org). Undefined for
   * a caller's own-seat read (their full seat, matching enforcement).
   */
  seatInstallationScope?: number
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

/**
 * Count one SEAT-pool meter (coding_agent | chatbot) for a seat in [since, now].
 * When `installationId` is provided the count is ALSO scoped to that org — the
 * admin per-member drill passes it so a member's usage in ANOTHER org can never
 * be read (tenant-safety). An own-seat read omits it (the full seat).
 */
async function readSeatMeter(
  env: Env,
  meter: UsageMeter,
  seatKey: string,
  sinceIso: string,
  installationId?: number,
): Promise<number | null> {
  if (meter !== "coding_agent" && meter !== "chatbot") return null
  const res = await readUsageEventCount(env, {
    meter,
    userKey: seatKey,
    ...(installationId !== undefined ? { installationId } : {}),
    sinceIso,
  })
  return res.ok ? res.count : null
}

/**
 * sig-cost-based-metering — sum the USD model spend of ONE meter for the resolved
 * scope in [since, now]. Mirrors readOrgMeter/readSeatMeter's scoping exactly, but
 * returns cost instead of a count:
 *   • pr_reviews (org)          → usage_ledger cost (per-author when an admin drill
 *                                 filter is set, else installation-wide).
 *   • linear_triage/slack (org) → usage_events cost (0 until those surfaces report it).
 *   • coding_agent/chatbot (seat)→ usage_events cost for the seat.
 * Returns null on a read fault; the caller's `costCell` renders null as 0 (the SAFE
 * direction — a fault never inflates spend against a budget, so it can't wrongly block).
 */
async function readMeterCost(
  env: Env,
  meter: UsageMeter,
  resolved: ResolvedScope,
  pool: UsagePool,
  sinceIso: string,
): Promise<number | null> {
  if (pool === "org") {
    if (meter === "pr_reviews") {
      if (resolved.authorFilter) {
        const res = await readRollingReviewCount(env, {
          installationId: resolved.installationId,
          authorLogin: resolved.authorFilter,
          sinceIso,
          limit: 1,
        })
        return res.ok ? res.costUsd : null
      }
      const res = await readTenantUsageSince(env, resolved.installationId, sinceIso)
      return res.ok ? res.costUsd : null
    }
    if (meter === "linear_triage" || meter === "slack") {
      const res = await readUsageEventCostSince(env, {
        meter,
        installationId: resolved.installationId,
        ...(resolved.authorFilter ? { userKey: resolved.authorFilter } : {}),
        sinceIso,
      })
      return res.ok ? res.costUsd : null
    }
    return null
  }
  // seat pool
  if (meter === "coding_agent" || meter === "chatbot") {
    if (!resolved.seatKey) return 0
    const res = await readUsageEventCostSince(env, {
      meter,
      userKey: resolved.seatKey,
      ...(resolved.seatInstallationScope !== undefined ? { installationId: resolved.seatInstallationScope } : {}),
      sinceIso,
    })
    return res.ok ? res.costUsd : null
  }
  return null
}

/** Round a USD figure to 4 dp so the JSON never carries float64 dust. */
function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0
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
  const prReviewMode = resolveRateLimitMode(env)

  const session = await requireSession(request, env, ctx)
  let resolved: ResolvedScope

  if (session) {
    if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
      console.error(JSON.stringify({ event: "usage-encryption-key-missing" }))
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
    const scopeParam = url.searchParams.get("scope")
    const wantsOrg = scopeParam === "org"
    const wantsUser = scopeParam === "user"
    const authorParam = url.searchParams.get("author")?.trim() || null
    const ownSeatKey = `gh:${session.record.githubUserId ?? session.record.userId ?? "anon"}`
    const ownSeat: ResolvedScope = {
      scope: "user",
      installationId: current,
      seatKey: ownSeatKey,
      authorFilter: null,
      account,
    }

    if (wantsUser && authorParam && current > 0) {
      // SIG-303 admin per-member SEAT drill: `?scope=user&author=<login>`. ADMIN
      // of THIS installation only (isAdminOfInstallation — scoped, NOT the
      // aggregate role), and the target must be a MEMBER of it (account_tenant
      // link — the same trust link the CLI/setup writes and the member's own
      // seat events are stamped with). The read is then installation-scoped
      // (seatInstallationScope), so even a resolved id can only ever surface
      // seat events attributed to the admin's OWN org — never cross-tenant. A
      // non-admin, an unresolvable login, or a non-member all resolve to a ZEROED
      // member seat (seatKey null → honest "no usage"), NEVER another member's
      // real data and NEVER the caller's own numbers relabeled as the member: the
      // only caller who sends `author` is one whose client believes it is an
      // admin, so were the server to disagree, returning the caller's own seat
      // would mislabel it under the member's name — a zeroed drill is airtight.
      const isAdmin = await isAdminOfInstallation(accessToken, session.record.login, current)
      const memberId = isAdmin
        ? (await resolveGithubAuthors([authorParam], accessToken)).get(authorParam.toLowerCase())?.id
        : undefined
      const linked =
        memberId !== undefined && env.SIGILIX_PLATFORM_DB
          ? await isLinkedToInstallation(env.SIGILIX_PLATFORM_DB, String(memberId), current)
          : false
      resolved = {
        scope: "user",
        installationId: current,
        // null seatKey → the seat read yields zeros (honest "no usage" for a
        // non-admin caller, an unresolvable login, or a non-member).
        seatKey: linked ? `gh:${memberId}` : null,
        seatInstallationScope: current,
        authorFilter: null,
        account,
      }
    } else if (wantsOrg && current > 0) {
      const isAdmin = await isAdminOfInstallation(accessToken, session.record.login, current)
      if (isAdmin) {
        resolved = { scope: "org", installationId: current, seatKey: null, authorFilter: authorParam, account }
      } else {
        // non-admin → own seat (never the org aggregate)
        resolved = ownSeat
      }
    } else {
      resolved = ownSeat
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

  // Plan is the REAL tenant.tier for the resolved installation (the authoritative
  // entitlement source), not the OPENCLAW_PLAN placeholder — so the usage panel
  // header reads the org's true tier (e.g. "Ultra"), never a blanket "Free".
  const [plan, subscriptionStatus] = await Promise.all([
    resolveInstallationPlan(env, resolved.installationId),
    readTenantSubscriptionStatus(env, resolved.installationId),
  ])

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
  // sig-cost-based-metering: pool COST spend (USD) alongside the counts.
  let costSession = 0
  let costWeekly = 0

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
        readSeatMeter(env, meter, resolved.seatKey, sinceSession, resolved.seatInstallationScope),
        readSeatMeter(env, meter, resolved.seatKey, sinceWeekly, resolved.seatInstallationScope),
      ])
    } else {
      usedS = 0
      usedW = 0
    }
    metersOut[meter] = { session: cell(usedS, capSession), weekly: cell(usedW, capWeekly) }
    sumSession += usedS ?? 0
    sumWeekly += usedW ?? 0

    // Cost for the same meter/scope/windows (null fault → 0, the safe direction).
    const [costS, costW] = await Promise.all([
      readMeterCost(env, meter, resolved, pool, sinceSession),
      readMeterCost(env, meter, resolved, pool, sinceWeekly),
    ])
    costSession += costS ?? 0
    costWeekly += costW ?? 0
  }

  // Use the exact subscription-status scaler admission uses, so a trial/unknown paid
  // tenant never sees a full budget while enforcement is already using the reduced one.
  const reduced = !isFullPaidStatus(subscriptionStatus)
  const fullCostBudgetSession = resolveTierCostBudgetUsd(env, plan, "session")
  const fullCostBudgetWeekly = resolveTierCostBudgetUsd(env, plan, "weekly")
  const effectiveCostBudgetSession = resolveTierCostBudgetUsd(env, plan, "session", reduced)
  const effectiveCostBudgetWeekly = resolveTierCostBudgetUsd(env, plan, "weekly", reduced)
  const volume: UsageEnforcement["volume"] =
    fullCostBudgetSession !== effectiveCostBudgetSession || fullCostBudgetWeekly !== effectiveCostBudgetWeekly
      ? "reduced"
      : "full"

  // A tier budget is per seat/PR author. It is comparable to a user-seat read and an
  // explicit org author drill, but NEVER to an unfiltered org-wide aggregate.
  const budgetAppliesToUsed = pool === "seat" || resolved.authorFilter !== null
  const costWindow = (used: number, budget: number | null, applies: boolean): UsageCostWindow => {
    if (!applies) {
      return {
        used_usd: round4(used),
        budget_usd: null,
        remaining_usd: null,
        pct: null,
        remaining_pct: null,
        approx_boreas_tasks_remaining: null,
        budget_state: "not_applicable",
        budget_applies_to_used: false,
      }
    }
    const remaining = budget === null ? null : Math.max(0, budget - used)
    const pctConsumed = usagePct(used, budget) // % of the budget consumed
    const remainingPct = pctConsumed === null ? null : Math.max(0, 100 - pctConsumed)
    return {
      used_usd: round4(used),
      budget_usd: budget,
      remaining_usd: remaining === null ? null : round4(remaining),
      pct: pctConsumed,
      remaining_pct: remainingPct,
      approx_boreas_tasks_remaining: approxTasksRemaining(remaining, "boreas"),
      budget_state: budget === null ? "unbounded" : "limited",
      budget_applies_to_used: true,
    }
  }
  const costOut: UsageCost = {
    session: costWindow(costSession, effectiveCostBudgetSession, budgetAppliesToUsed),
    weekly: costWindow(costWeekly, effectiveCostBudgetWeekly, budgetAppliesToUsed),
  }
  // Transparency + upsell: the per-model relative burn rate, and a soft nudge keyed
  // on the ENFORCED (session) window's remaining budget. Every model is on every
  // tier — the premium model just burns the budget faster (no gating).
  const modelBurn = modelBurnTable()
  const hint = budgetAppliesToUsed ? usageUpsellHint(costOut.session.remaining_pct) : null

  const costWindows: UsageEnforcement["cost_windows"] =
    pool === "seat"
      ? { session: mode === "enforce", weekly: mode === "enforce" }
      : resolved.authorFilter !== null
        ? { session: prReviewMode === "enforce", weekly: false }
        : { session: false, weekly: false }
  const enforcement: UsageEnforcement = {
    usage_pool_mode: mode,
    pr_review_mode: prReviewMode,
    cost_budget_scope: pool === "seat" ? "seat" : "author",
    cost_windows: costWindows,
    volume,
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
    enforcement,
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
    cost: costOut,
    model_burn: modelBurn,
    hint,
    ...(authors ? { authors } : {}),
    generated_at: new Date(nowMs).toISOString(),
  }
  return json(body, 200)
}
