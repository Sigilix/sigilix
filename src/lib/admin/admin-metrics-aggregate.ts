// sig-admin-metrics — PURE aggregation helpers for the staff-only admin metrics
// endpoint (GET /v1/admin/metrics). No IO, no env, no clock: every function is a
// deterministic transform over already-fetched rows, so the arithmetic (cost
// estimate, MRR normalization, margin) is unit-testable without a DB or Stripe.
//
// DATA HONESTY: this module NEVER fabricates a metric. Where the underlying store
// genuinely cannot answer a question (per-served-model token split, per-provider
// cost breakdown), the route returns null and appends a human-readable string to
// `gaps` — it does not invent a number. The one DERIVED figure here (estimated
// inference cost) is explicitly labelled an ESTIMATE and carries its method.

import { DEFAULT_PRICING, type ModelPricing } from "@/src/shared/domain/model-pricing"

/** One point in a daily/weekly time series. `bucket` is an ISO date (YYYY-MM-DD). */
export interface TimePoint {
  bucket: string
  count: number
}

/** A raw `(day, n)` row as returned by a `GROUP BY substr(created_at,1,10)` query. */
export interface DayCountRow {
  day: string
  n: number
}

/**
 * Densify a sparse list of `(day,count)` rows into a continuous daily series over
 * the trailing `windowDays` ending at `nowMs` — missing days become 0 so a chart
 * never draws a misleading gap. Days are UTC (created_at is stored as UTC ISO).
 */
export function toDailySeries(rows: DayCountRow[], nowMs: number, windowDays: number): TimePoint[] {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    if (typeof r.day === "string" && r.day.length === 10) byDay.set(r.day, (byDay.get(r.day) ?? 0) + (Number(r.n) || 0))
  }
  const out: TimePoint[] = []
  const dayMs = 24 * 60 * 60 * 1000
  // Walk oldest→newest so the series is chronological.
  const startMs = nowMs - (windowDays - 1) * dayMs
  for (let i = 0; i < windowDays; i++) {
    const bucket = new Date(startMs + i * dayMs).toISOString().slice(0, 10)
    out.push({ bucket, count: byDay.get(bucket) ?? 0 })
  }
  return out
}

/** Roll a daily series up into ISO-week buckets (keyed by the week's Monday date). */
export function toWeeklySeries(daily: TimePoint[]): TimePoint[] {
  const byWeek = new Map<string, number>()
  for (const p of daily) {
    const d = new Date(`${p.bucket}T00:00:00.000Z`)
    // Shift to the Monday of this UTC week.
    const dow = (d.getUTCDay() + 6) % 7 // 0 = Monday
    const monday = new Date(d.getTime() - dow * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    byWeek.set(monday, (byWeek.get(monday) ?? 0) + p.count)
  }
  return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, count]) => ({ bucket, count }))
}

/**
 * Estimate inference cost from a total token count using a blended per-MTok rate.
 * This is an ESTIMATE, not a billed figure: usage_ledger stores ONE `tokens` total
 * per PR review with NO input/output split and NO per-served-model attribution, so
 * we apply the midpoint of a representative rate (default: the platform's own
 * DEFAULT_PRICING, the high-end fallback used by the cost governor). Returned to
 * the caller alongside `method` so the dashboard can label it honestly.
 */
export function estimateInferenceCostUsd(totalTokens: number, pricing: ModelPricing = DEFAULT_PRICING): number {
  const tokens = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0
  const blendedPerMTok = (pricing.inputPerMTokUsd + pricing.outputPerMTokUsd) / 2
  return (tokens / 1_000_000) * blendedPerMTok
}

/** A subscription normalized for MRR math (see stripe-admin.ts). */
export interface NormalizedSubscription {
  id: string
  status: string
  tier: string
  /** Monthly-normalized amount in USD (yearly ÷ 12), quantity already applied. */
  monthlyUsd: number
}

export interface RevenueRollup {
  mrrUsd: number
  activeCount: number
  trialingCount: number
  canceledCount: number
  perTier: Array<{ tier: string; mrrUsd: number; count: number }>
}

/**
 * Roll normalized subscriptions into MRR + per-tier + status counts. MRR counts
 * ONLY `active` subscriptions (the standard definition — trialing revenue is not
 * yet realized); trialing/canceled are surfaced as their own counts so churn and
 * trial pipeline stay visible. Deterministic and pure.
 */
export function rollupRevenue(subs: NormalizedSubscription[]): RevenueRollup {
  let mrrUsd = 0
  let activeCount = 0
  let trialingCount = 0
  let canceledCount = 0
  const perTier = new Map<string, { mrrUsd: number; count: number }>()
  for (const s of subs) {
    if (s.status === "active") {
      activeCount++
      mrrUsd += s.monthlyUsd
      const t = perTier.get(s.tier) ?? { mrrUsd: 0, count: 0 }
      t.mrrUsd += s.monthlyUsd
      t.count++
      perTier.set(s.tier, t)
    } else if (s.status === "trialing") {
      trialingCount++
    } else if (s.status === "canceled" || s.status === "incomplete_expired" || s.status === "unpaid") {
      canceledCount++
    }
  }
  return {
    mrrUsd: round2(mrrUsd),
    activeCount,
    trialingCount,
    canceledCount,
    perTier: [...perTier.entries()]
      .map(([tier, v]) => ({ tier, mrrUsd: round2(v.mrrUsd), count: v.count }))
      .sort((a, b) => b.mrrUsd - a.mrrUsd),
  }
}

/** Gross margin = revenue − cost. Null when revenue is unavailable (Stripe unset/failed). */
export function grossMarginUsd(mrrUsd: number | null, inferenceCostUsd: number): number | null {
  if (mrrUsd === null) return null
  return round2(mrrUsd - inferenceCostUsd)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
