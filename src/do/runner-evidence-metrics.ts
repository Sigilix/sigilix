// SIG-184 PR 5b: RunnerEvidenceMetricsDO — rolling runner-evidence PRESENCE
// telemetry.
//
// In shadow/post mode the PR-review ensemble consults a runner receipt for
// every review and lands in one of three states (verified | evidence-pending |
// runner-absent). That outcome only lived in Worker logs. This DO persists
// rolling per-state (× evidence-pending reason) daily counters + a per-repo
// "latest state" roll, so `GET /metrics/runner-evidence` can surface adoption
// (how many reviews are runner-backed) + the why-pending breakdown without log
// access — the data that gates widening the rollout to customers.
//
// Single global instance (idFromName("global")) — one increment per review,
// far below any sharding threshold. SQLite gives atomic INSERT … ON CONFLICT
// increments so concurrent reviews never lose a count.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"

// Retention: 35 days of daily buckets so the endpoint can serve a 30-day window
// with margin. GC runs via a daily alarm; queries always filter by day so
// correctness never depends on the alarm having fired.
const RETENTION_DAYS = 35
// Cap the per-repo presence list returned by query() (most-recent first).
const MAX_REPO_PRESENCE = 200
const DAY_MS = 86_400_000

/** The three first-class consume outcomes (mirrors RunnerEvidenceState). */
export type RunnerEvidenceConsumeState = "verified" | "evidence-pending" | "runner-absent"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, state, reason)
);
CREATE INDEX IF NOT EXISTS rev_daily_counts_by_day ON daily_counts(day);
CREATE TABLE IF NOT EXISTS repo_presence (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  last_state TEXT NOT NULL,
  last_reason TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo)
);
CREATE INDEX IF NOT EXISTS rev_repo_presence_by_at ON repo_presence(last_seen_at);
`

export interface RecordRunnerEvidenceArgs {
  owner: string
  repo: string
  prNumber: number
  state: RunnerEvidenceConsumeState
  /** The evidence-pending reason; "" / omitted for verified + runner-absent. */
  reason?: string
  /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
  occurredAt?: string
}

export interface RunnerEvidenceMetricsQuery {
  /** state → reason → count (reason "" rolls up verified + runner-absent). */
  counts: Record<string, Record<string, number>>
  window: { days: number; startDay: string; endDay: string }
  /** Per-repo latest observed state (adoption / liveness signal). */
  repoPresence: Array<{
    owner: string
    repo: string
    lastState: string
    lastReason: string
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

export class RunnerEvidenceMetricsDO extends DurableObject<Env> {
  private ready = false

  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA)
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  /**
   * Record one consume outcome for a PR review: `daily_counts(day, state,
   * reason) += 1` and upsert the repo's latest state. `reason` is normalized to
   * "" for non-pending states so verified/runner-absent roll up under a single
   * key. Runs in a single transaction; schedules the daily GC alarm if none is
   * pending. Idempotency is not required — each review contributes its own count.
   */
  async record(args: RecordRunnerEvidenceArgs): Promise<void> {
    const sql = this.sql()
    const day = utcDay(args.occurredAt)
    const at = args.occurredAt ?? new Date().toISOString()
    // Only evidence-pending carries a reason; collapse the rest to "".
    const reason = args.state === "evidence-pending" ? (args.reason ?? "") : ""

    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO daily_counts (day, state, reason, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(day, state, reason) DO UPDATE SET count = count + 1`,
        day, args.state, reason,
      )
      // Upsert the repo's latest state — only advance if this observation is at
      // least as recent (guards out-of-order writes). owner/repo "" (no repo id
      // in scope) is skipped: a presence row needs a real repo to be meaningful.
      if (args.owner !== "" && args.repo !== "") {
        sql.exec(
          `INSERT INTO repo_presence (owner, repo, last_state, last_reason, last_seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(owner, repo) DO UPDATE SET
             last_state = excluded.last_state,
             last_reason = excluded.last_reason,
             last_seen_at = excluded.last_seen_at
           WHERE excluded.last_seen_at >= repo_presence.last_seen_at`,
          args.owner, args.repo, args.state, reason, at,
        )
      }
    })

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    }
  }

  /**
   * Aggregate counts over the trailing `windowDays` (inclusive of the end day),
   * plus the per-repo latest-state roll. `nowIso` overrides "now" for tests.
   */
  async query(args: { windowDays: number; nowIso?: string }): Promise<RunnerEvidenceMetricsQuery> {
    const sql = this.sql()
    const now = args.nowIso ?? new Date().toISOString()
    const endDay = utcDay(now)
    const startDay = utcDayMinus(now, args.windowDays - 1)

    const counts: RunnerEvidenceMetricsQuery["counts"] = {}
    for (const row of sql.exec<{ state: string; reason: string; total: number }>(
      `SELECT state, reason, SUM(count) AS total
       FROM daily_counts WHERE day >= ? AND day <= ?
       GROUP BY state, reason`,
      startDay, endDay,
    )) {
      ;(counts[row.state] ??= {})[row.reason] = row.total
    }

    const repoPresence = [
      ...sql.exec<{ owner: string; repo: string; last_state: string; last_reason: string; last_seen_at: string }>(
        `SELECT owner, repo, last_state, last_reason, last_seen_at
         FROM repo_presence ORDER BY last_seen_at DESC LIMIT ?`,
        MAX_REPO_PRESENCE,
      ),
    ].map((r) => ({
      owner: r.owner,
      repo: r.repo,
      lastState: r.last_state,
      lastReason: r.last_reason,
      lastSeenAt: r.last_seen_at,
    }))

    return { counts, window: { days: args.windowDays, startDay, endDay }, repoPresence }
  }

  /** Daily retention GC: drop buckets + repo rows older than RETENTION_DAYS. */
  override async alarm(): Promise<void> {
    const sql = this.sql()
    // Single clock read so the day-bucket cutoff and the timestamp cutoff can't
    // straddle a UTC midnight (CR).
    const now = new Date().toISOString()
    const nowMs = new Date(now).getTime()
    const cutoffDay = utcDayMinus(now, RETENTION_DAYS - 1)
    const cutoffAt = new Date(nowMs - RETENTION_DAYS * DAY_MS).toISOString()

    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM daily_counts WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM repo_presence WHERE last_seen_at < ?", cutoffAt)
    })

    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }

  /** Test-only: raw count for one (day, state, reason), or null if absent. */
  async debugDayCount(day: string, state: string, reason: string): Promise<number | null> {
    const sql = this.sql()
    const rows = [
      ...sql.exec<{ count: number }>(
        "SELECT count FROM daily_counts WHERE day = ? AND state = ? AND reason = ?",
        day, state, reason,
      ),
    ]
    return rows[0] ? rows[0].count : null
  }
}
