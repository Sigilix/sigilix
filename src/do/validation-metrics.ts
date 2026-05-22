// SIG-119: ValidationMetricsDO — rolling per-gate validator shadow telemetry.
//
// The PR-review ensemble's validator gates (security/tests/logic/perf, +
// future gates) emit `pr-review-finding-rejected-validation` events that, in
// shadow mode, record what WOULD be dropped. That data only lived in Worker
// logs, which the rollout dogwatch cannot read. This DO persists rolling
// per-gate × reason × {would-drop, kept} counters, bucketed by UTC day, so
// the `/metrics/validation` endpoint can surface would-drop rates without log
// access (the data that gates the SIG-108/111 enforce flips).
//
// Single global instance (idFromName("global")) — write volume is one row per
// REJECTED finding, far below any need to shard. SQLite gives atomic
// INSERT … ON CONFLICT increments so concurrent reviews never lose a count.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"

// Retention: keep 35 days of daily buckets so the endpoint can serve up to a
// 30-day window with margin. GC runs via a daily alarm; queries always filter
// by day so correctness never depends on the alarm having fired.
const RETENTION_DAYS = 35
// Cap the per-PR head list returned by query() (most-recent first).
const MAX_LAST_SEEN = 100
const DAY_MS = 86_400_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT NOT NULL,
  gate TEXT NOT NULL,
  reason TEXT NOT NULL,
  would_drop INTEGER NOT NULL DEFAULT 0,
  kept INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, gate, reason)
);
CREATE INDEX IF NOT EXISTS daily_counts_by_day ON daily_counts(day);
CREATE TABLE IF NOT EXISTS last_seen_pr (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo, pr_number)
);
CREATE INDEX IF NOT EXISTS last_seen_by_at ON last_seen_pr(last_seen_at);
`

/** One validator-gate rejection (the shape the ensemble collects + forwards). */
export interface ValidationRejectionEvent {
  gate: string
  reason: string
  /** true = actually dropped (enforce mode); false = would-drop (shadow). */
  dropped: boolean
}

export interface RecordBatchArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
  occurredAt?: string
  events: ValidationRejectionEvent[]
}

export interface ValidationMetricsQuery {
  /** aggregated counts: gate → reason → {wouldDrop, kept}. */
  counts: Record<string, Record<string, { wouldDrop: number; kept: number }>>
  window: { days: number; startDay: string; endDay: string }
  lastSeenPrHeads: Array<{
    owner: string
    repo: string
    prNumber: number
    headSha: string
    lastSeenAt: string
  }>
}

/** UTC YYYY-MM-DD for an ISO timestamp (or now). */
function utcDay(iso?: string): string {
  return (iso ? new Date(iso) : new Date()).toISOString().slice(0, 10)
}

/** UTC YYYY-MM-DD `n` days before the given ISO timestamp. */
function utcDayMinus(iso: string, n: number): string {
  return new Date(new Date(iso).getTime() - n * DAY_MS).toISOString().slice(0, 10)
}

export class ValidationMetricsDO extends DurableObject<Env> {
  private ready = false

  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA)
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  /**
   * Record a batch of validator rejections for one PR review. Per event:
   * would_drop += 1; if NOT actually dropped (shadow), kept += 1. Updates the
   * PR's last-seen head SHA. Idempotency is not required — each review run
   * contributes its own counts. Runs in a single transaction; schedules the
   * daily GC alarm if none is pending.
   */
  async recordBatch(args: RecordBatchArgs): Promise<void> {
    if (args.events.length === 0) return
    const sql = this.sql()
    const day = utcDay(args.occurredAt)
    const at = args.occurredAt ?? new Date().toISOString()

    this.ctx.storage.transactionSync(() => {
      for (const e of args.events) {
        sql.exec(
          `INSERT INTO daily_counts (day, gate, reason, would_drop, kept)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(day, gate, reason) DO UPDATE SET
             would_drop = would_drop + 1,
             kept = kept + ?`,
          day, e.gate, e.reason,
          e.dropped ? 0 : 1,
          e.dropped ? 0 : 1,
        )
      }
      sql.exec(
        `INSERT INTO last_seen_pr (owner, repo, pr_number, head_sha, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner, repo, pr_number) DO UPDATE SET
           head_sha = excluded.head_sha,
           last_seen_at = excluded.last_seen_at
         WHERE excluded.last_seen_at >= last_seen_pr.last_seen_at`,
        args.owner, args.repo, args.prNumber, args.headSha, at,
      )
    })

    // Ensure a GC alarm is pending (idempotent — only sets when none exists).
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    }
  }

  /**
   * Aggregate counts over the trailing `windowDays` (inclusive of the end
   * day), plus the most-recent PR head SHAs. `nowIso` overrides "now" for
   * deterministic tests.
   */
  async query(args: { windowDays: number; nowIso?: string }): Promise<ValidationMetricsQuery> {
    const sql = this.sql()
    const now = args.nowIso ?? new Date().toISOString()
    const endDay = utcDay(now)
    const startDay = utcDayMinus(now, args.windowDays - 1)

    const counts: ValidationMetricsQuery["counts"] = {}
    for (const row of sql.exec<{ gate: string; reason: string; would_drop: number; kept: number }>(
      `SELECT gate, reason, SUM(would_drop) AS would_drop, SUM(kept) AS kept
       FROM daily_counts WHERE day >= ? AND day <= ?
       GROUP BY gate, reason`,
      startDay, endDay,
    )) {
      ;(counts[row.gate] ??= {})[row.reason] = { wouldDrop: row.would_drop, kept: row.kept }
    }

    const lastSeenPrHeads = [
      ...sql.exec<{ owner: string; repo: string; pr_number: number; head_sha: string; last_seen_at: string }>(
        `SELECT owner, repo, pr_number, head_sha, last_seen_at
         FROM last_seen_pr ORDER BY last_seen_at DESC LIMIT ?`,
        MAX_LAST_SEEN,
      ),
    ].map((r) => ({
      owner: r.owner,
      repo: r.repo,
      prNumber: r.pr_number,
      headSha: r.head_sha,
      lastSeenAt: r.last_seen_at,
    }))

    return { counts, window: { days: args.windowDays, startDay, endDay }, lastSeenPrHeads }
  }

  /** Daily retention GC: drop buckets + PR heads older than RETENTION_DAYS. */
  override async alarm(): Promise<void> {
    const sql = this.sql()
    const now = new Date().toISOString()
    // Retain exactly RETENTION_DAYS UTC days (today + RETENTION_DAYS-1 prior).
    // `day < cutoffDay` then drops everything strictly older than that window.
    const cutoffDay = utcDayMinus(now, RETENTION_DAYS - 1)
    const cutoffAt = new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString()

    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM daily_counts WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM last_seen_pr WHERE last_seen_at < ?", cutoffAt)
    })

    // Reschedule for the next day so GC keeps running.
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  /** Test-only: raw counts for one (day, gate, reason), or null if absent. */
  async debugDayCount(day: string, gate: string, reason: string): Promise<{ wouldDrop: number; kept: number } | null> {
    const sql = this.sql()
    const rows = [
      ...sql.exec<{ would_drop: number; kept: number }>(
        "SELECT would_drop, kept FROM daily_counts WHERE day = ? AND gate = ? AND reason = ?",
        day, gate, reason,
      ),
    ]
    const r = rows[0]
    return r ? { wouldDrop: r.would_drop, kept: r.kept } : null
  }
}
