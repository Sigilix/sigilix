// sig-admin-metrics — GET /v1/admin/metrics. STAFF-ONLY platform aggregates
// (adoption / usage / cost / revenue / margin) powering admin.sigilix.ai.
//
// AUTH (fail-closed, server-to-server ONLY): gated by the ADMIN_API_SECRET bearer
// via requireBearerToken (constant-time SHA-256 compare). The secret is unset →
// 503 (never an open dashboard); present-but-wrong → 401. This endpoint is NEVER
// called from a browser — the admin site's SERVER routes call it with the secret
// AFTER independently enforcing GitHub-org membership. There is no session/cookie
// path and no query-param bypass.
//
// DATA HONESTY: every field is aggregated ONLY from data Sigilix actually persists
// (D1 SIGILIX_PLATFORM_DB + the live Stripe key). Where a metric genuinely cannot be
// derived from the current store, the field is null and a human-readable note is
// appended to `gaps` — nothing is fabricated. Each D1 read is fail-soft in its own
// try/catch and degrades to its empty value; the only non-2xx paths are the auth
// 401/503. Revenue degrades to `available:false` (never a wrong MRR) if Stripe is
// unset or the list call fails/ is truncated.

import { requireBearerToken } from "@/src/lib/auth-bearer"
import { resolvePriceTierConfig } from "@/src/features/billing"
import { listAllSubscriptions } from "@/src/lib/admin/stripe-admin"
import {
  toDailySeries,
  toWeeklySeries,
  estimateInferenceCostUsd,
  rollupRevenue,
  grossMarginUsd,
  type TimePoint,
  type DayCountRow,
} from "@/src/lib/admin/admin-metrics-aggregate"
import { DEFAULT_PRICING } from "@/src/shared/domain/model-pricing"
import { loadMemoryGardenerDigest } from "@/src/lib/memory-gardener-digest"
import { readPtsSessionUsageSince } from "@/src/features/tenancy"
import type { Env } from "@/src/shared/types/env"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_DAYS = 30
const MIN_WINDOW_DAYS = 1
const MAX_WINDOW_DAYS = 365

// The four SIG-303 usage_events meters we surface as usage series.
const USAGE_METERS = ["coding_agent", "chatbot", "slack", "linear_triage"] as const

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function parseWindowDays(raw: string | null): number {
  if (!raw) return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return DEFAULT_WINDOW_DAYS
  const n = Number(m[1])
  if (!Number.isInteger(n)) return DEFAULT_WINDOW_DAYS
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, n))
}

/**
 * Fault accumulator. A degraded-to-zero/empty read on a D1 FAULT (as opposed to a
 * genuinely-empty table) sets `hit`, so the handler can append a gap and the
 * dashboard NEVER presents a fabricated zero as a real number (data-honesty).
 */
interface Faults {
  hit: boolean
}

/** A scalar COUNT/SUM read that fails soft to 0 (recording the fault). */
async function scalar(db: D1Database, faults: Faults, sql: string, binds: unknown[] = []): Promise<number> {
  try {
    const row = await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: unknown }>()
    return Number(row?.n) || 0
  } catch (error) {
    faults.hit = true
    console.warn(JSON.stringify({ event: "admin-metrics-scalar-failed", err: errMsg(error) }))
    return 0
  }
}

/** A `(day,n)` GROUP-BY read that fails soft to [] (recording the fault). */
async function dayRows(db: D1Database, faults: Faults, sql: string, binds: unknown[]): Promise<DayCountRow[]> {
  try {
    const { results } = await db
      .prepare(sql)
      .bind(...binds)
      .all<{ day: unknown; n: unknown }>()
    return results.map((r) => ({ day: String(r.day ?? ""), n: Number(r.n) || 0 }))
  } catch (error) {
    faults.hit = true
    console.warn(JSON.stringify({ event: "admin-metrics-dayrows-failed", err: errMsg(error) }))
    return []
  }
}

/**
 * Activity-based active-user count over the trailing `days` window: distinct
 * identities that produced ANY tracked activity — usage_ledger authors (GitHub
 * login) UNION usage_events seats (user_key). NOTE the two key spaces don't
 * dedupe a person across surfaces, so this can slightly OVER-count; it is an
 * activity proxy, not a login-session DAU (user_identity stores only the latest
 * login, not a history). Flagged in `gaps`. Fails soft to 0.
 */
async function activeUsers(db: D1Database, faults: Faults, nowMs: number, days: number): Promise<number> {
  const sinceIso = new Date(nowMs - days * DAY_MS).toISOString()
  return scalar(
    db,
    faults,
    "SELECT COUNT(*) AS n FROM (" +
      " SELECT DISTINCT lower(author_login) AS u FROM usage_ledger WHERE created_at >= ? AND author_login IS NOT NULL" +
      " UNION" +
      " SELECT DISTINCT user_key AS u FROM usage_events WHERE created_at >= ? AND user_key IS NOT NULL" +
      ")",
    [sinceIso, sinceIso],
  )
}

/** Per-tier tenant counts (the plan distribution). Fails soft to [] (recording the fault). */
async function perPlanCounts(db: D1Database, faults: Faults): Promise<Array<{ tier: string; count: number }>> {
  try {
    const { results } = await db
      .prepare(
        "SELECT COALESCE(NULLIF(lower(trim(tier)),''),'unknown') AS tier, COUNT(*) AS n FROM tenant GROUP BY 1 ORDER BY n DESC",
      )
      .all<{ tier: unknown; n: unknown }>()
    return results.map((r) => ({ tier: String(r.tier ?? "unknown"), count: Number(r.n) || 0 }))
  } catch (error) {
    faults.hit = true
    console.warn(JSON.stringify({ event: "admin-metrics-perplan-failed", err: errMsg(error) }))
    return []
  }
}

/** Per-meter daily usage series from usage_events. Fails soft to empty series. */
async function usageMeterSeries(
  db: D1Database,
  faults: Faults,
  nowMs: number,
  windowDays: number,
  sinceIso: string,
): Promise<Record<string, TimePoint[]>> {
  const rowsByMeter = new Map<string, DayCountRow[]>()
  try {
    const { results } = await db
      .prepare(
        "SELECT meter, substr(created_at,1,10) AS day, COUNT(*) AS n FROM usage_events WHERE created_at >= ? GROUP BY meter, day",
      )
      .bind(sinceIso)
      .all<{ meter: unknown; day: unknown; n: unknown }>()
    for (const r of results) {
      const meter = String(r.meter ?? "")
      if (!rowsByMeter.has(meter)) rowsByMeter.set(meter, [])
      rowsByMeter.get(meter)!.push({ day: String(r.day ?? ""), n: Number(r.n) || 0 })
    }
  } catch (error) {
    faults.hit = true
    console.warn(JSON.stringify({ event: "admin-metrics-usage-meters-failed", err: errMsg(error) }))
  }
  const out: Record<string, TimePoint[]> = {}
  for (const meter of USAGE_METERS) {
    out[meter] = toDailySeries(rowsByMeter.get(meter) ?? [], nowMs, windowDays)
  }
  return out
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** GET /v1/admin/metrics — see file header. */
export async function handleAdminMetricsRoute(request: Request, env: Env): Promise<Response> {
  // ── Auth gate (fail-closed) ──────────────────────────────────
  const secret = env.ADMIN_API_SECRET
  if (!secret) return json({ error: "admin_metrics_not_configured" }, 503)
  if (!(await requireBearerToken(request, secret))) return json({ error: "unauthorized" }, 401)

  const db = env.SIGILIX_PLATFORM_DB
  const url = new URL(request.url)
  const windowDays = parseWindowDays(url.searchParams.get("window"))
  const nowMs = Date.now()
  const sinceIso = new Date(nowMs - windowDays * DAY_MS).toISOString()
  const gaps: string[] = []
  const faults: Faults = { hit: false }

  if (!db) {
    // No platform DB bound → we can still answer honestly (all-empty adoption/usage)
    // rather than 500. Revenue is attempted independently below.
    gaps.push("SIGILIX_PLATFORM_DB is not bound — adoption/usage aggregates are empty.")
  }

  // ── Adoption ────────────────────────────────────────────────
  const [totalUsers, totalOrgs, totalRepos, dau, wau, mau, perPlan, signupRows, orgSignupRows] = db
    ? await Promise.all([
        scalar(db, faults, "SELECT COUNT(*) AS n FROM user_identity"),
        scalar(db, faults, "SELECT COUNT(*) AS n FROM tenant"),
        scalar(db, faults, "SELECT COUNT(*) AS n FROM repo"),
        activeUsers(db, faults, nowMs, 1),
        activeUsers(db, faults, nowMs, 7),
        activeUsers(db, faults, nowMs, 30),
        perPlanCounts(db, faults),
        dayRows(
          db,
          faults,
          "SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM user_identity WHERE created_at >= ? GROUP BY day",
          [sinceIso],
        ),
        dayRows(
          db,
          faults,
          "SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM tenant WHERE created_at >= ? GROUP BY day",
          [sinceIso],
        ),
      ])
    : [0, 0, 0, 0, 0, 0, [], [], []]

  const signupsDaily = toDailySeries(signupRows, nowMs, windowDays)
  const orgSignupsDaily = toDailySeries(orgSignupRows, nowMs, windowDays)

  // ── Usage ───────────────────────────────────────────────────
  const [prReviewRows, totalReviewTokens, meterSeries] = db
    ? await Promise.all([
        dayRows(
          db,
          faults,
          "SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM usage_ledger WHERE created_at >= ? GROUP BY day",
          [sinceIso],
        ),
        scalar(db, faults, "SELECT SUM(tokens) AS n FROM usage_ledger WHERE created_at >= ?", [sinceIso]),
        usageMeterSeries(db, faults, nowMs, windowDays, sinceIso),
      ])
    : [[], 0, { coding_agent: [], chatbot: [], slack: [], linear_triage: [] } as Record<string, TimePoint[]>]

  if (faults.hit) {
    // A D1 read FAULTED (not a genuinely-empty table). The degraded value is a
    // zero/empty placeholder, NOT a real number — say so rather than let the
    // dashboard present a fabricated zero as truth.
    gaps.push(
      "One or more D1 aggregate reads faulted (see worker logs) — affected adoption/usage figures degraded to 0/empty and may UNDER-report. They are not real zeros.",
    )
  }

  gaps.push(
    "Per-served-model token volume (Boreas/Pyroeis/Astraeus) is NOT persisted: usage_ledger.tokens is a single total per PR review with no per-model split. Session token counts DO exist per-run in usage_events (surfaced under `pts`), but not split per served model.",
  )

  // ── Cost (estimate — flagged) ───────────────────────────────
  // Windowed estimate (over the selected window), PLUS a 30-day-normalized figure
  // so margin can be compared against monthly MRR on the same time basis.
  const estimatedInferenceUsd = estimateInferenceCostUsd(totalReviewTokens, DEFAULT_PRICING)
  const estimatedMonthlyUsd = windowDays > 0 ? Math.round(estimatedInferenceUsd * (30 / windowDays) * 100) / 100 : 0
  gaps.push(
    "Inference cost is an ESTIMATE: total review tokens × the platform's blended fallback rate (DEFAULT_PRICING). Per-provider (Vertex/Turbo/Bedrock/OpenRouter) cost breakdown is not derivable — no per-provider token ledger exists in D1.",
  )
  gaps.push(
    "Active users (DAU/WAU/MAU) are ACTIVITY-based (distinct usage_ledger authors ∪ usage_events seats over 1/7/30d), not login sessions — user_identity stores only the latest login. The two key spaces don't dedupe a person across surfaces, so counts may slightly over-count.",
  )

  // ── Revenue (Stripe — degrades to unavailable, never wrong) ──
  let revenue: {
    available: boolean
    mrrUsd: number | null
    perTier: Array<{ tier: string; mrrUsd: number; count: number }> | null
    activeCount: number | null
    trialingCount: number | null
    canceledCount: number | null
    error?: string
  } = { available: false, mrrUsd: null, perTier: null, activeCount: null, trialingCount: null, canceledCount: null }

  if (!env.SIGILIX_STRIPE_SECRET_KEY) {
    gaps.push("Revenue unavailable: SIGILIX_STRIPE_SECRET_KEY is not set on the worker.")
  } else {
    const listed = await listAllSubscriptions(env.SIGILIX_STRIPE_SECRET_KEY, resolvePriceTierConfig(env))
    if (!listed.ok) {
      // Surface only a status code — never an upstream/transport string that could
      // (however unlikely) carry request context. The worker logs hold the detail.
      revenue = { ...revenue, error: "stripe_unavailable" }
      gaps.push(`Revenue unavailable: Stripe subscription list failed (status ${listed.status}).`)
    } else {
      const r = rollupRevenue(listed.subscriptions)
      revenue = {
        available: true,
        mrrUsd: r.mrrUsd,
        perTier: r.perTier,
        activeCount: r.activeCount,
        trialingCount: r.trialingCount,
        canceledCount: r.canceledCount,
      }
      gaps.push(
        "Revenue is a CURRENT Stripe snapshot (window-independent): MRR + active/trialing are live subscription state; the canceled count is LIFETIME cancellations, not cancellations within the selected window.",
      )
    }
  }

  // ── Margin ──────────────────────────────────────────────────
  // Monthly MRR − monthly-normalized estimated cost (same time basis).
  const grossUsd = grossMarginUsd(revenue.mrrUsd, estimatedMonthlyUsd)

  // ── Memory Gardener digest (read-only) ──────────────────────
  // The last decay + consolidation shadow/enforce output, so the founder can see
  // reap/merge eligibility without `wrangler tail`. Fail-soft: absent/unreadable
  // → null (never blocks the metrics response).
  const memoryGardener = await loadMemoryGardenerDigest(env)

  // ── PTS token-cost telemetry (SIG-583 M0) ───────────────────
  // Per-tenant token-cost of agentic SESSIONS (coding_agent + chatbot) — the
  // token-cost half of the Persistent-Task-State wedge, made visible live per
  // tenant. HONESTY: this is session COST, not state-loss/retention. Prod runs
  // are bounded and never compact the context window, so there is no reset event
  // to score retention against live (see gap below); the retention metric lives
  // in the eval harness (SIG-578).
  const ptsRead = await readPtsSessionUsageSince(env, sinceIso)
  // Round each per-tenant cost to cents so a row never renders as a float artifact
  // (0.07000000000000001) next to the cent-rounded total below.
  const ptsPerTenant = (ptsRead.ok ? ptsRead.rows : []).map((r) => ({
    ...r,
    costUsd: Math.round(r.costUsd * 100) / 100,
  }))
  if (!ptsRead.ok) {
    gaps.push("PTS session token-cost read faulted — the per-tenant table degraded to empty and may under-report.")
  }
  gaps.push(
    "PTS state-loss/continuity is NOT yet measured in prod: agentic runs are bounded and never compact the context window, so there is no reset event to score retention against. Only session token-cost is surfaced under `pts`; the retention metric lives in the eval harness (SIG-578) and needs prod compaction to surface live.",
  )
  // The session meters (coding_agent + chatbot) are SEAT-scoped, keyed by user_key,
  // not by installation. Runs with no org context are written with installation_id=0
  // (see d1-usage-events.ts), so the installationId:0 row is a BLENDED bucket across
  // distinct seats/tenants — not one tenant. Flag it so `perTenant` is not read as
  // exact tenant granularity.
  if (ptsPerTenant.some((r) => r.installationId === 0)) {
    gaps.push(
      "PTS `perTenant` includes an installationId:0 row — session meters are seat-scoped and org-less runs are recorded under installation_id=0, so that row blends multiple seats/tenants and is NOT a single tenant.",
    )
  }
  const ptsTotals = ptsPerTenant.reduce(
    (acc, r) => ({
      sessions: acc.sessions + r.sessions,
      tokens: acc.tokens + r.tokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { sessions: 0, tokens: 0, costUsd: 0 },
  )

  return json(
    {
      generatedAt: new Date(nowMs).toISOString(),
      window: { days: windowDays },
      adoption: {
        totalUsers,
        totalOrgs,
        totalInstallations: totalOrgs,
        totalRepos,
        activeUsers: { dau, wau, mau },
        perPlan,
        signups: { daily: signupsDaily, weekly: toWeeklySeries(signupsDaily) },
        orgSignups: { daily: orgSignupsDaily },
      },
      usage: {
        prReviews: toDailySeries(prReviewRows, nowMs, windowDays),
        cli: meterSeries.coding_agent,
        chatbot: meterSeries.chatbot,
        slack: meterSeries.slack,
        linearTriage: meterSeries.linear_triage,
        totalReviewTokens,
        perModelTokens: null,
      },
      cost: {
        estimatedInferenceUsd,
        estimatedMonthlyUsd,
        method: "totalReviewTokens × blended DEFAULT_PRICING rate (estimate)",
        perProvider: null,
      },
      revenue,
      margin: { grossUsd },
      pts: {
        perTenant: ptsPerTenant,
        totals: { ...ptsTotals, costUsd: Math.round(ptsTotals.costUsd * 100) / 100 },
      },
      memoryGardener,
      gaps,
    },
    200,
  )
}
