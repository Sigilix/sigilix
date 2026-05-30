// SIG-285 PR 2: VerificationMetricsDO — rolling verification-by-execution
// verdict telemetry.
//
// PR 1 emits a `verification-shadow` verdict per score>=4 logic/security finding
// (confirmed | refuted | inconclusive | no-check). That only lived in Worker
// logs. This DO persists rolling per-(verdict × category) daily counters so
// `GET /metrics/verification` can answer the load-bearing question — what
// fraction of our findings are mechanically REFUTABLE — without log access, and
// gate whether PRs 3-4 (rendering + demotion) are worth building.
//
// Single global instance (idFromName("global")) — one increment per checked
// finding, far below any sharding threshold. SQLite gives atomic
// INSERT … ON CONFLICT increments so concurrent reviews never lose a count.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"
// Single source of truth for the verdict enum (the check produces it); imported
// for local use + re-exported as part of this DO's public API.
import type { VerificationVerdict } from "../lib/verification/verify-finding"
export type { VerificationVerdict }

const RETENTION_DAYS = 35 // rolling window kept on disk; GC'd daily by the alarm
const DAY_MS = 86_400_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT NOT NULL,
  verdict TEXT NOT NULL,
  category TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, verdict, category)
);
CREATE INDEX IF NOT EXISTS vrf_daily_counts_by_day ON daily_counts(day);
`

export interface RecordVerificationArgs {
  verdict: VerificationVerdict
  /** "logic" | "security" (the only verified categories), kept as a free string. */
  category: string
  /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
  occurredAt?: string
}

export interface VerificationMetricsQuery {
  /** verdict → category → count. */
  counts: Record<string, Record<string, number>>
  /** Roll-up across all categories: verdict → total. */
  byVerdict: Record<string, number>
  total: number
  /** (confirmed + refuted) / total — the share with a usable check. */
  refutableFraction: number
  /** refuted / total — the share that would demote in enforce (PR 4). */
  refutedFraction: number
  window: { days: number; startDay: string; endDay: string }
}

function utcDay(iso?: string): string {
  return (iso ? new Date(iso) : new Date()).toISOString().slice(0, 10)
}
function utcDayMinus(iso: string, n: number): string {
  return new Date(new Date(iso).getTime() - n * DAY_MS).toISOString().slice(0, 10)
}

export class VerificationMetricsDO extends DurableObject<Env> {
  private ready = false

  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA)
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  /**
   * Record one verdict: `daily_counts(day, verdict, category) += 1`. Runs in a
   * transaction; arms the daily GC alarm if none is pending. Idempotency is not
   * required — each checked finding contributes its own count.
   */
  async record(args: RecordVerificationArgs): Promise<void> {
    const sql = this.sql()
    const day = utcDay(args.occurredAt)
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO daily_counts (day, verdict, category, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(day, verdict, category) DO UPDATE SET count = count + 1`,
        day, args.verdict, args.category,
      )
    })
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    }
  }

  /**
   * Record a whole review's verdicts in ONE transaction (a review checks N
   * findings — batching keeps it to a single RPC + a single best-effort await
   * on the hot path). No-op on an empty batch.
   */
  async recordBatch(items: RecordVerificationArgs[]): Promise<void> {
    if (items.length === 0) return
    const sql = this.sql()
    this.ctx.storage.transactionSync(() => {
      for (const it of items) {
        sql.exec(
          `INSERT INTO daily_counts (day, verdict, category, count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(day, verdict, category) DO UPDATE SET count = count + 1`,
          utcDay(it.occurredAt), it.verdict, it.category,
        )
      }
    })
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    }
  }

  /** Aggregate over the trailing `windowDays` (inclusive). `nowIso` for tests. */
  async query(args: { windowDays: number; nowIso?: string }): Promise<VerificationMetricsQuery> {
    const sql = this.sql()
    const now = args.nowIso ?? new Date().toISOString()
    const endDay = utcDay(now)
    const startDay = utcDayMinus(now, args.windowDays - 1)

    const counts: Record<string, Record<string, number>> = {}
    const byVerdict: Record<string, number> = {}
    let total = 0
    for (const row of sql.exec<{ verdict: string; category: string; total: number }>(
      `SELECT verdict, category, SUM(count) AS total
       FROM daily_counts WHERE day >= ? AND day <= ?
       GROUP BY verdict, category`,
      startDay, endDay,
    )) {
      ;(counts[row.verdict] ??= {})[row.category] = row.total
      byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + row.total
      total += row.total
    }

    const confirmed = byVerdict["confirmed" satisfies VerificationVerdict] ?? 0
    const refuted = byVerdict["refuted" satisfies VerificationVerdict] ?? 0
    const round = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 1000) / 1000)
    return {
      counts,
      byVerdict,
      total,
      refutableFraction: round(confirmed + refuted),
      refutedFraction: round(refuted),
      window: { days: args.windowDays, startDay, endDay },
    }
  }

  /** Daily retention GC: drop buckets older than RETENTION_DAYS. */
  override async alarm(): Promise<void> {
    const sql = this.sql()
    const cutoffDay = utcDayMinus(new Date().toISOString(), RETENTION_DAYS - 1)
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM daily_counts WHERE day < ?", cutoffDay)
    })
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  /** Test-only: raw count for one (day, verdict, category), or null. */
  async debugDayCount(day: string, verdict: string, category: string): Promise<number | null> {
    const sql = this.sql()
    const rows = [
      ...sql.exec<{ count: number }>(
        "SELECT count FROM daily_counts WHERE day = ? AND verdict = ? AND category = ?",
        day, verdict, category,
      ),
    ]
    return rows[0] ? rows[0].count : null
  }
}
