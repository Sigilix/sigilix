// SIG-286 PR2.5: GraphExpansionMetricsDO — rolling daily aggregates of the
// `graph-expansion-shadow` sample (one per PR review).
//
// PR2 (#253) emits the CONTROL-vs-TREATMENT cross-file context measurement
// (`netNewTokens = treatment − control`) to Worker LOGS only. The whole arc is
// measurement-first — the PR3 (inject) GO/KILL decision keys off the MEDIAN
// netNewTokens + the cross-file-context rate — so that number has to be
// readable WITHOUT Cloudflare log access. This DO persists it.
//
// Sibling of SIG-152's GraphMetricsDO: per-day running SUMS (for means/rates) +
// a per-day netNewTokens HISTOGRAM (so the query can report a grouped MEDIAN,
// which a sum can't give). Single global instance (idFromName("global")); read
// via GET /metrics/graph-expansion. Telemetry-only — nothing here changes a
// posted review.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../shared/types/env"

const RETENTION_DAYS = 35
const DAY_MS = 86_400_000

// netNewTokens histogram bucket lower bounds. Edges straddle the documented
// decision thresholds (KILL < 500, GO ≥ 800) so the grouped median has real
// resolution where it matters. Bucket i covers [BUCKET_LOWERS[i], BUCKET_LOWERS[i+1]);
// the last is open-topped [3200, ∞). b0 = [0,1) isolates "no cross-file gain".
export const BUCKET_LOWERS = [0, 1, 200, 500, 800, 1600, 3200] as const
const BUCKET_COUNT = BUCKET_LOWERS.length

/** Map a netNewTokens value to its histogram bucket index (0..BUCKET_COUNT-1). */
export function bucketIndex(netNewTokens: number): number {
  if (!Number.isFinite(netNewTokens)) {
    // netNewTokens is a computed token count, so a non-finite value should be
    // impossible. Surface it instead of silently bucketing as zero, so an
    // upstream measurement bug is visible rather than masked (Sigilix #256).
    console.warn(JSON.stringify({ event: "graph-expansion-metrics-nonfinite-netnew", value: String(netNewTokens) }))
    return 0
  }
  for (let i = BUCKET_COUNT - 1; i >= 0; i--) {
    const lower = BUCKET_LOWERS[i] ?? 0
    if (netNewTokens >= lower) return i
  }
  return 0
}

function bucketLabel(i: number): string {
  const lo = BUCKET_LOWERS[i] ?? 0
  const hi = i + 1 < BUCKET_COUNT ? BUCKET_LOWERS[i + 1] : undefined
  return hi === undefined ? `[${lo},∞)` : `[${lo},${hi})`
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_expansion (
  day TEXT PRIMARY KEY,
  reviews INTEGER NOT NULL DEFAULT 0,
  graph_available INTEGER NOT NULL DEFAULT 0,
  fetch_reviews INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,
  sum_netnew INTEGER NOT NULL DEFAULT 0,
  sum_control INTEGER NOT NULL DEFAULT 0,
  sum_total INTEGER NOT NULL DEFAULT 0,
  sum_fetch_files INTEGER NOT NULL DEFAULT 0,
  sum_fetch_bytes INTEGER NOT NULL DEFAULT 0,
  sum_fetch_elapsed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_expansion_hist (
  day TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);
CREATE TABLE IF NOT EXISTS daily_expansion_mode (
  day TEXT NOT NULL,
  mode TEXT NOT NULL,
  reviews INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mode)
);
CREATE INDEX IF NOT EXISTS expansion_hist_by_day ON daily_expansion_hist(day);
`

/** One PR review's graph-expansion measurement (mirrors the logged event). */
export interface GraphExpansionSample {
  /** effective graph-expansion mode: "shadow" | "post". */
  mode: string
  graphAvailable: boolean
  /** treatment − control: the cross-file context gain the GO/KILL keys off. */
  netNewTokens: number
  /** filesByPath-only tokens (what PR1 saw, no cross-file fetch). */
  controlTokens: number
  /** treatment total tokens (control + cross-file). */
  totalTokens: number
  fetchEnabled: boolean
  fetchFiles: number
  fetchBytes: number
  fetchElapsedMs: number
  budgetExhausted: boolean
}

export interface RecordExpansionSampleArgs {
  occurredAt?: string
  sample: GraphExpansionSample
}

export interface GraphExpansionMetricsQuery {
  window: { days: number; startDay: string; endDay: string }
  reviews: number
  graphAvailableReviews: number
  netNewTokens: {
    /** Grouped-median estimate (interpolated within the median histogram bucket). */
    medianEstimate: number
    /** Histogram bucket the median falls in, e.g. "[800,1600)". */
    medianBucket: string
    mean: number
    /** bucket label → review count. */
    histogram: Record<string, number>
    /** reviews with netNewTokens ≥ 1 (any cross-file gain) / reviews. */
    crossFileRate: number
    /** reviews with netNewTokens ≥ 200 (meaningful cross-file context) / reviews. */
    meaningfulRate: number
  }
  control: { meanTokens: number }
  /** treatment = control + cross-file. */
  treatment: { meanTokens: number }
  fetch: {
    reviews: number
    /** Means are PER FETCH-ENABLED review (÷ reviews), so non-fetch reviews
     *  don't dilute the cross-file fetch cost. 0 when no fetch-enabled reviews. */
    meanFiles: number
    meanBytes: number
    meanElapsedMs: number
    budgetExhaustedReviews: number
  }
  modeReviews: Record<string, number>
  /**
   * The PR3 (inject) decision per the #253-documented criteria:
   *   GO   = median netNewTokens ≥ 800 AND cross-file context on > 40% of reviews
   *   KILL = median netNewTokens < 500
   *   else = BORDERLINE; NO_DATA on an empty window.
   */
  goKill: { verdict: "GO" | "KILL" | "BORDERLINE" | "NO_DATA"; rationale: string }
}

function utcDay(iso?: string): string {
  return (iso ? new Date(iso) : new Date()).toISOString().slice(0, 10)
}
function utcDayMinus(iso: string, n: number): string {
  return new Date(new Date(iso).getTime() - n * DAY_MS).toISOString().slice(0, 10)
}

/** Grouped median over the histogram (interpolated within the median bucket). */
function groupedMedian(hist: number[]): { estimate: number; bucket: string } {
  const total = hist.reduce((a, b) => a + b, 0)
  if (total === 0) return { estimate: 0, bucket: "n/a" }
  const half = total / 2
  let cum = 0
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const count = hist[i] ?? 0
    const next = cum + count
    if (next >= half) {
      const lo = BUCKET_LOWERS[i] ?? 0
      const hi = i + 1 < BUCKET_COUNT ? BUCKET_LOWERS[i + 1] : undefined
      // Report the lower bound (no interpolation) when:
      //  - open-topped bucket (no width), or
      //  - empty median bucket, or
      //  - a width-≤1 bucket — notably b0 = [0,1), whose only value is exactly 0;
      //    interpolating there would round an all-zero-gain corpus to median 1.
      if (hi === undefined || count === 0 || hi - lo <= 1) return { estimate: lo, bucket: bucketLabel(i) }
      const est = lo + ((half - cum) / count) * (hi - lo)
      return { estimate: Math.round(est), bucket: bucketLabel(i) }
    }
    cum = next
  }
  const last = BUCKET_COUNT - 1
  return { estimate: BUCKET_LOWERS[last] ?? 0, bucket: bucketLabel(last) }
}

function round(n: number, places = 3): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/** Every numeric field actually written to the aggregates is finite (computed
 *  counts). The fetch fields are gated to 0 when fetchEnabled=false, so they're
 *  only validated when enabled — otherwise a disabled sample with a stale
 *  non-finite fetch field would be needlessly dropped, undercounting the window
 *  and skewing GO/KILL (CodeRabbit #256). */
function hasFiniteMetrics(s: GraphExpansionSample): boolean {
  const metrics = [s.netNewTokens, s.controlTokens, s.totalTokens]
  if (s.fetchEnabled) metrics.push(s.fetchFiles, s.fetchBytes, s.fetchElapsedMs)
  return metrics.every(Number.isFinite)
}

export class GraphExpansionMetricsDO extends DurableObject<Env> {
  private ready = false

  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA)
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  /**
   * Accumulate one PR review's expansion sample into the day's running sums, the
   * netNewTokens histogram, and the mode review count. Single transaction;
   * schedules the daily GC alarm if none is pending.
   */
  async recordSample(args: RecordExpansionSampleArgs): Promise<void> {
    const sql = this.sql()
    const day = utcDay(args.occurredAt)
    const s = args.sample
    // Drop a malformed sample before it can poison the daily aggregates with a
    // non-finite numeric. Every field here is a computed count → should always
    // be finite; warn rather than mask so an upstream bug stays visible
    // (CodeRabbit #256). Telemetry-only, so dropping one bad sample is safe.
    if (!hasFiniteMetrics(s)) {
      console.warn(JSON.stringify({ event: "graph-expansion-metrics-invalid-sample", mode: s.mode }))
      return
    }
    const ga = s.graphAvailable ? 1 : 0
    const fe = s.fetchEnabled ? 1 : 0
    // Fetch cost only counts when the fetcher was actually wired, so a
    // fetchEnabled=false sample (whose fetch fields should be 0 anyway) can never
    // overstate the per-fetch means (÷ fetch_reviews) or the exhaustion count
    // (CodeRabbit #256).
    const be = s.fetchEnabled && s.budgetExhausted ? 1 : 0
    const fetchFiles = s.fetchEnabled ? s.fetchFiles : 0
    const fetchBytes = s.fetchEnabled ? s.fetchBytes : 0
    const fetchElapsedMs = s.fetchEnabled ? s.fetchElapsedMs : 0

    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO daily_expansion (day, reviews, graph_available, fetch_reviews, budget_exhausted, sum_netnew, sum_control, sum_total, sum_fetch_files, sum_fetch_bytes, sum_fetch_elapsed)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           reviews = reviews + 1,
           graph_available = graph_available + ?,
           fetch_reviews = fetch_reviews + ?,
           budget_exhausted = budget_exhausted + ?,
           sum_netnew = sum_netnew + ?,
           sum_control = sum_control + ?,
           sum_total = sum_total + ?,
           sum_fetch_files = sum_fetch_files + ?,
           sum_fetch_bytes = sum_fetch_bytes + ?,
           sum_fetch_elapsed = sum_fetch_elapsed + ?`,
        day, ga, fe, be, s.netNewTokens, s.controlTokens, s.totalTokens, fetchFiles, fetchBytes, fetchElapsedMs,
        ga, fe, be, s.netNewTokens, s.controlTokens, s.totalTokens, fetchFiles, fetchBytes, fetchElapsedMs,
      )
      sql.exec(
        `INSERT INTO daily_expansion_hist (day, bucket, count) VALUES (?, ?, 1)
         ON CONFLICT(day, bucket) DO UPDATE SET count = count + 1`,
        day, bucketIndex(s.netNewTokens),
      )
      sql.exec(
        `INSERT INTO daily_expansion_mode (day, mode, reviews) VALUES (?, ?, 1)
         ON CONFLICT(day, mode) DO UPDATE SET reviews = reviews + 1`,
        day, s.mode,
      )
    })

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    }
  }

  /** Windowed means + netNewTokens median/rates + the GO/KILL verdict. */
  async query(args: { windowDays: number; nowIso?: string }): Promise<GraphExpansionMetricsQuery> {
    const sql = this.sql()
    const now = args.nowIso ?? new Date().toISOString()
    const endDay = utcDay(now)
    const startDay = utcDayMinus(now, args.windowDays - 1)

    const agg = [
      ...sql.exec<{
        reviews: number; graph_available: number; fetch_reviews: number; budget_exhausted: number
        sum_netnew: number; sum_control: number; sum_total: number
        sum_fetch_files: number; sum_fetch_bytes: number; sum_fetch_elapsed: number
      }>(
        `SELECT
           COALESCE(SUM(reviews), 0) AS reviews,
           COALESCE(SUM(graph_available), 0) AS graph_available,
           COALESCE(SUM(fetch_reviews), 0) AS fetch_reviews,
           COALESCE(SUM(budget_exhausted), 0) AS budget_exhausted,
           COALESCE(SUM(sum_netnew), 0) AS sum_netnew,
           COALESCE(SUM(sum_control), 0) AS sum_control,
           COALESCE(SUM(sum_total), 0) AS sum_total,
           COALESCE(SUM(sum_fetch_files), 0) AS sum_fetch_files,
           COALESCE(SUM(sum_fetch_bytes), 0) AS sum_fetch_bytes,
           COALESCE(SUM(sum_fetch_elapsed), 0) AS sum_fetch_elapsed
         FROM daily_expansion WHERE day >= ? AND day <= ?`,
        startDay, endDay,
      ),
    ][0] ?? {
      reviews: 0, graph_available: 0, fetch_reviews: 0, budget_exhausted: 0,
      sum_netnew: 0, sum_control: 0, sum_total: 0, sum_fetch_files: 0, sum_fetch_bytes: 0, sum_fetch_elapsed: 0,
    }

    const reviews = agg.reviews
    const mean = (sum: number): number => (reviews > 0 ? round(sum / reviews) : 0)
    // Fetch cost means divide by the FETCH-ENABLED review count so non-fetch
    // reviews (which contribute 0 to the fetch sums) don't dilute the average
    // (CodeRabbit #256).
    const fetchMean = (sum: number): number => (agg.fetch_reviews > 0 ? round(sum / agg.fetch_reviews) : 0)

    const hist: number[] = new Array<number>(BUCKET_COUNT).fill(0)
    for (const row of sql.exec<{ bucket: number; count: number }>(
      `SELECT bucket, SUM(count) AS count FROM daily_expansion_hist
       WHERE day >= ? AND day <= ? GROUP BY bucket`,
      startDay, endDay,
    )) {
      if (row.bucket >= 0 && row.bucket < BUCKET_COUNT) hist[row.bucket] = (hist[row.bucket] ?? 0) + row.count
    }

    const histogram: Record<string, number> = {}
    for (let i = 0; i < BUCKET_COUNT; i++) histogram[bucketLabel(i)] = hist[i] ?? 0

    const { estimate: medianEstimate, bucket: medianBucket } = groupedMedian(hist)
    // crossFileRate = netNew ≥ 1 (any gain) = all buckets except b0.
    const crossFileCount = hist.slice(1).reduce((a, b) => a + b, 0)
    // meaningfulRate = netNew ≥ 200 = bucket index ≥ 2 (BUCKET_LOWERS[2] === 200).
    const meaningfulCount = hist.slice(2).reduce((a, b) => a + b, 0)
    const crossFileRate = reviews > 0 ? round(crossFileCount / reviews) : 0
    const meaningfulRate = reviews > 0 ? round(meaningfulCount / reviews) : 0

    const modeReviews: Record<string, number> = {}
    for (const row of sql.exec<{ mode: string; reviews: number }>(
      `SELECT mode, SUM(reviews) AS reviews FROM daily_expansion_mode
       WHERE day >= ? AND day <= ? GROUP BY mode`,
      startDay, endDay,
    )) {
      modeReviews[row.mode] = row.reviews
    }

    const goKill = ((): GraphExpansionMetricsQuery["goKill"] => {
      if (reviews === 0) return { verdict: "NO_DATA", rationale: "no graph-expansion samples in window" }
      const pct = `${Math.round(crossFileRate * 100)}%`
      if (medianEstimate >= 800 && crossFileRate > 0.4) {
        return { verdict: "GO", rationale: `median netNewTokens ${medianEstimate} ≥ 800 AND cross-file context on ${pct} of reviews (> 40%)` }
      }
      if (medianEstimate < 500) {
        return { verdict: "KILL", rationale: `median netNewTokens ${medianEstimate} < 500 — cross-file fetch adds little context` }
      }
      return { verdict: "BORDERLINE", rationale: `median netNewTokens ${medianEstimate}, cross-file rate ${pct} — neither GO (≥ 800 & > 40%) nor KILL (< 500)` }
    })()

    return {
      window: { days: args.windowDays, startDay, endDay },
      reviews,
      graphAvailableReviews: agg.graph_available,
      netNewTokens: {
        medianEstimate,
        medianBucket,
        mean: mean(agg.sum_netnew),
        histogram,
        crossFileRate,
        meaningfulRate,
      },
      control: { meanTokens: mean(agg.sum_control) },
      treatment: { meanTokens: mean(agg.sum_total) },
      fetch: {
        reviews: agg.fetch_reviews,
        meanFiles: fetchMean(agg.sum_fetch_files),
        meanBytes: fetchMean(agg.sum_fetch_bytes),
        meanElapsedMs: fetchMean(agg.sum_fetch_elapsed),
        budgetExhaustedReviews: agg.budget_exhausted,
      },
      modeReviews,
      goKill,
    }
  }

  /** Daily retention GC: drop aggregates older than RETENTION_DAYS. */
  override async alarm(): Promise<void> {
    const sql = this.sql()
    const cutoffDay = utcDayMinus(new Date().toISOString(), RETENTION_DAYS - 1)
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM daily_expansion WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM daily_expansion_hist WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM daily_expansion_mode WHERE day < ?", cutoffDay)
    })
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  /** Test-only: the `reviews` count recorded for a given UTC day, or null. */
  async debugDayReviews(day: string): Promise<number | null> {
    const sql = this.sql()
    const rows = [...sql.exec<{ reviews: number }>("SELECT reviews FROM daily_expansion WHERE day = ?", day)]
    return rows[0] ? rows[0].reviews : null
  }
}
