// sig-usage — GET /v1/usage.
//
// Powers the "Plan usage limits" panel in the portal AND the CLI's `/usage`
// slash-command limit bars. Returns the caller's REAL, live usage against the
// limits Sigilix actually enforces — never fabricated numbers.
//
// What is real today (audited against the metering pipeline):
//   • `session` — the SIG-38 per-developer rolling-window PR-review cap. Written
//     to D1 `usage_ledger` on every finalized review (session.ts → appendUsage,
//     author = pr.user.login) and read here through the SAME adapters the
//     enforcement gate uses (readRollingReviewCount + resolveRateLimitCap +
//     decideRateLimit + computeResetMs). used/limit/resets are exactly what the
//     gate would compute — the panel can never overstate the cap.
//   • `weekly` — trailing-7d PR-review usage for the same scope. There is NO
//     weekly CAP in Sigilix yet, so `limit`/`pct`/`resets_at` are null (honest:
//     usage shown, no bar fill). Do NOT invent a weekly cap here.
//   • `totals` — trailing-7d raw model-call/token totals. Only attributable at
//     the INSTALLATION (org) grain via readTenantUsageSince, so on the per-user
//     scope those are null (we don't have per-author token attribution).
//
// Cap parity (CRITICAL): the enforcement gate (index-dispatch-rate-limit-gate)
// calls checkRateLimit WITHOUT a tier, so the effective enforced cap is
// resolveRateLimitCap(undefined) = DEFAULT_RATE_LIMIT_CAP for every tenant right
// now. This route mirrors that exactly (no tier passed) so the displayed limit
// is always the limit that is actually enforced. When SIG-41 wires tier into the
// gate, pass the same tier here.
//
// Plan name is a display label from OPENCLAW_PLAN (mirrors org-overview-route.ts);
// it is independent of the enforced cap until SIG-41.
//
// Auth mirrors workspace-prs / org-overview: portal SESSION cookie first
// (requireSession, per-user scope), else a bearer API key (requireApiTenant).
// On the api-key path the caller may pass `?author=<github-login>` to get the
// same per-developer scope the portal gets; without it the scope is the whole
// installation (org) and `session` uses the installation-wide review count with
// a null cap (the cap is per-developer, so an org total has no single cap).
// CORS'd for the portal origins (portal-cors.ts, wired in index.ts).

import { requireSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { resolveUserRole } from "@/src/lib/resolve-user-role"
import {
  resolveRateLimitMode,
  resolveRateLimitCap,
  decideRateLimit,
  computeResetMs,
  readRollingReviewCount,
  readTenantUsageSince,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_BURST,
} from "@/src/features/tenancy"
import type { RateLimitMode } from "@/src/features/tenancy"
import type { Env } from "@/src/shared/types/env"

const MAX_INSTALLATION_PAGES = 20
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const USAGE_PLANS = ["free", "pro", "max", "ultra", "team", "enterprise"] as const
type UsagePlan = (typeof USAGE_PLANS)[number]

/** A single usage row the portal/CLI renders as a bar. `limit === null` → no hard cap (no fill). */
export interface UsageBar {
  key: string
  label: string
  used: number
  limit: number | null
  /** 0–100, rounded. null when `limit` is null (no cap → no percentage). */
  pct: number | null
  window_ms: number
  window_label: string
  /** ISO instant the window next frees a slot / rolls; null when nothing to reset. */
  resets_at: string | null
  resets_in_ms: number | null
}

export interface UsageResponse {
  plan: UsagePlan
  account: string
  scope: "user" | "org"
  mode: RateLimitMode
  session: UsageBar | null
  weekly: UsageBar | null
  totals: {
    reviews: number | null
    model_calls: number | null
    tokens: number | null
    since: string
  }
  generated_at: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Plan display label from OPENCLAW_PLAN (validated against the known set), else "free". */
function resolvePlan(env: Pick<Env, "OPENCLAW_PLAN">): UsagePlan {
  const raw = env.OPENCLAW_PLAN
  return (USAGE_PLANS as readonly string[]).includes(raw ?? "") ? (raw as UsagePlan) : "free"
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

function parseInstallationIdParam(url: URL): number | null {
  const raw = url.searchParams.get("installationId")
  if (raw === null || raw.trim() === "") return null
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
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
        event: "usage-account-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return ""
  }
}

function roundPct(used: number, limit: number | null): number | null {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
}

/** Resolved caller scope for the usage read. */
interface UsageScope {
  scope: "user" | "org"
  installationId: number
  /** The per-developer login for the rolling window; null → org-wide (no per-user cap). */
  authorLogin: string | null
  account: string
}

/**
 * Build the per-developer `session` bar: the SIG-38 rolling-window PR-review cap.
 * Reads through the SAME adapters + math the enforcement gate uses so used/limit/
 * resets can never overstate the enforced cap. Returns null on a D1 fault (the
 * caller renders an honest "unavailable" state rather than a fake zero).
 */
async function buildUserSessionBar(
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE">,
  installationId: number,
  authorLogin: string,
  nowMs: number,
): Promise<UsageBar | null> {
  // Mirror the enforcement gate exactly: no tier → the actually-enforced cap.
  const cap = resolveRateLimitCap(undefined)
  const burst = RATE_LIMIT_BURST
  const sinceIso = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString()
  const res = await readRollingReviewCount(env, {
    installationId,
    authorLogin,
    sinceIso,
    limit: cap + burst + 1,
  })
  if (!res.ok) return null

  const used = res.count
  const rows = res.windowRowsAscMs
  let resetsInMs: number | null = null
  if (rows.length > 0) {
    resetsInMs = decideRateLimit(used, cap, burst)
      ? Math.max(0, rows[0]! + RATE_LIMIT_WINDOW_MS - nowMs) // under cap: when the count next drops
      : computeResetMs(rows, RATE_LIMIT_WINDOW_MS, used, cap, burst, nowMs) // over cap: when a slot frees
  }

  return {
    key: "pr_reviews",
    label: "PR reviews",
    used,
    limit: cap,
    pct: roundPct(used, cap),
    window_ms: RATE_LIMIT_WINDOW_MS,
    window_label: "5h",
    resets_at: resetsInMs === null ? null : new Date(nowMs + resetsInMs).toISOString(),
    resets_in_ms: resetsInMs,
  }
}

/**
 * Build the trailing-7d `weekly` bar for a single developer. Reviews only — the
 * per-author token/model-call figures are not attributable, and there is no
 * weekly CAP, so limit/pct/resets are null (honest usage, no fill). Returns null
 * on a D1 fault.
 */
async function buildUserWeeklyBar(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
  authorLogin: string,
  nowMs: number,
): Promise<UsageBar | null> {
  const sinceIso = new Date(nowMs - WEEKLY_WINDOW_MS).toISOString()
  const res = await readRollingReviewCount(env, { installationId, authorLogin, sinceIso, limit: 1 })
  if (!res.ok) return null
  return {
    key: "pr_reviews_weekly",
    label: "PR reviews · this week",
    used: res.count,
    limit: null,
    pct: null,
    window_ms: WEEKLY_WINDOW_MS,
    window_label: "7d",
    resets_at: null,
    resets_in_ms: null,
  }
}

/** GET /v1/usage — see file header. */
export async function handleUsageRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const nowMs = Date.now()
  const mode = resolveRateLimitMode(env)
  const plan = resolvePlan(env)

  // ── Resolve caller scope ──────────────────────────────────────────────────
  const session = await requireSession(request, env, ctx)
  let resolved: UsageScope

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

    // Default is the caller's OWN per-developer usage. The org Billing→Usage
    // tab may request `?scope=org` (installation-wide) or `?author=<login>`
    // (drill into a specific member) — both are ADMIN-only and always scoped to
    // the caller's own installation (tenant isolation). A member (or an absent
    // param) always falls back to self, so a member can never read another
    // member's usage. resolveUserRole is only consulted when a privileged param
    // is present, so the common personal path stays a single GitHub call.
    const selfLogin = session.record.login
    const wantsOrg = url.searchParams.get("scope") === "org"
    const authorParam = url.searchParams.get("author")?.trim()
    const wantsOtherAuthor = !!authorParam && authorParam.toLowerCase() !== selfLogin.toLowerCase()

    let scopeKind: "user" | "org" = "user"
    let effectiveAuthor: string | null = selfLogin
    if ((wantsOrg || wantsOtherAuthor) && current > 0) {
      const role = await resolveUserRole(accessToken, selfLogin)
      if (role === "admin") {
        if (wantsOrg) {
          scopeKind = "org"
          effectiveAuthor = null
        } else if (authorParam) {
          effectiveAuthor = authorParam
        }
      }
      // non-admin → stays self (never another member's usage)
    }
    resolved = { scope: scopeKind, installationId: current, authorLogin: effectiveAuthor, account }
  } else {
    const apiAuth = await requireApiTenant(request, env, ctx)
    if ("response" in apiAuth) return apiAuth.response // 401
    const installationId = apiAuth.caller.installationId
    // An api-key caller may pass its own developer login to get per-user scope;
    // without it we report the whole installation (org) grain.
    const authorParam = url.searchParams.get("author")?.trim()
    const authorLogin = authorParam && authorParam !== "" ? authorParam : null
    // The legacy global key is Sigilix-internal and installation-broad; a real
    // per-tenant key is scoped to exactly its own installation.
    const scopedInstallationId = installationId === LEGACY_TENANT_INSTALLATION_ID ? 0 : installationId
    const account = scopedInstallationId > 0 ? await readAccountLogin(env, scopedInstallationId) : ""
    resolved = {
      scope: authorLogin ? "user" : "org",
      installationId: scopedInstallationId,
      authorLogin,
      account,
    }
  }

  // ── Build the bars from real ledger data ──────────────────────────────────
  const since7dIso = new Date(nowMs - WEEKLY_WINDOW_MS).toISOString()
  let sessionBar: UsageBar | null = null
  let weeklyBar: UsageBar | null = null
  let totals: UsageResponse["totals"] = { reviews: null, model_calls: null, tokens: null, since: since7dIso }

  if (resolved.installationId > 0 && resolved.authorLogin) {
    // Per-developer scope: the accurate, launch-critical path (portal session).
    ;[sessionBar, weeklyBar] = await Promise.all([
      buildUserSessionBar(env, resolved.installationId, resolved.authorLogin, nowMs),
      buildUserWeeklyBar(env, resolved.installationId, resolved.authorLogin, nowMs),
    ])
    // Org-grain raw totals are still useful context alongside the per-user bars.
    const rollup = await readTenantUsageSince(env, resolved.installationId, since7dIso)
    if (rollup.ok) {
      totals = { reviews: rollup.reviews, model_calls: rollup.modelCalls, tokens: rollup.tokens, since: since7dIso }
    }
  } else if (resolved.installationId > 0) {
    // Org scope (api key, no author): installation-wide usage. The cap is
    // per-developer, so an org total has no single cap → limit null (usage only).
    const [window5h, rollup] = await Promise.all([
      readTenantUsageSince(env, resolved.installationId, new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString()),
      readTenantUsageSince(env, resolved.installationId, since7dIso),
    ])
    if (window5h.ok) {
      sessionBar = {
        key: "pr_reviews",
        label: "PR reviews (org)",
        used: window5h.reviews,
        limit: null,
        pct: null,
        window_ms: RATE_LIMIT_WINDOW_MS,
        window_label: "5h",
        resets_at: null,
        resets_in_ms: null,
      }
    }
    if (rollup.ok) {
      weeklyBar = {
        key: "pr_reviews_weekly",
        label: "PR reviews · this week (org)",
        used: rollup.reviews,
        limit: null,
        pct: null,
        window_ms: WEEKLY_WINDOW_MS,
        window_label: "7d",
        resets_at: null,
        resets_in_ms: null,
      }
      totals = { reviews: rollup.reviews, model_calls: rollup.modelCalls, tokens: rollup.tokens, since: since7dIso }
    }
  }

  const body: UsageResponse = {
    plan,
    account: resolved.account,
    scope: resolved.scope,
    mode,
    session: sessionBar,
    weekly: weeklyBar,
    totals,
    generated_at: new Date(nowMs).toISOString(),
  }
  return json(body, 200)
}
