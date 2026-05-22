// SIG-152: GraphMetricsDO — rolling daily aggregates of the SIG-138
// `pr-review-graph-retrieval` shadow sample (one per PR review).
//
// Sibling of SIG-119's ValidationMetricsDO, but the graph signal is
// CONTINUOUS metrics (jaccard, added-context counts, blast counts) rather than
// categorical event counts — so we store per-day running SUMS + a review count
// and divide at query time to report averages. Single global instance
// (idFromName("global")); read via GET /metrics/graph. Makes the SIG-138 graph
// shadow telemetry curl-able without Cloudflare log access (the read the
// `post` flip depends on).

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"

const RETENTION_DAYS = 35
const MAX_LAST_SEEN = 100
const DAY_MS = 86_400_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_graph (
  day TEXT PRIMARY KEY,
  reviews INTEGER NOT NULL DEFAULT 0,
  sum_jaccard REAL NOT NULL DEFAULT 0,
  sum_added INTEGER NOT NULL DEFAULT 0,
  sum_nodes INTEGER NOT NULL DEFAULT 0,
  sum_capped INTEGER NOT NULL DEFAULT 0,
  sum_blast_caller INTEGER NOT NULL DEFAULT 0,
  sum_blast_dependent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_graph_mode (
  day TEXT NOT NULL,
  mode TEXT NOT NULL,
  reviews INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mode)
);
CREATE TABLE IF NOT EXISTS last_seen_pr (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo, pr_number)
);
CREATE INDEX IF NOT EXISTS graph_last_seen_by_at ON last_seen_pr(last_seen_at);
`

/** One PR review's graph-retrieval measurement (mirrors the logged event). */
export interface GraphRetrievalSample {
  /** effective graph-retrieval mode: "shadow" | "post". */
  mode: string
  jaccard: number
  addedCount: number
  nodeCount: number
  cappedNodeCount: number
  blastCallerCount: number
  blastDependentCount: number
}

export interface RecordSampleArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  occurredAt?: string
  sample: GraphRetrievalSample
}

export interface GraphMetricsQuery {
  window: { days: number; startDay: string; endDay: string }
  reviews: number
  averages: {
    jaccard: number
    addedCount: number
    nodeCount: number
    cappedNodeCount: number
    blastCallerCount: number
    blastDependentCount: number
  }
  modeReviews: Record<string, number>
  lastSeenPrHeads: Array<{ owner: string; repo: string; prNumber: number; headSha: string; lastSeenAt: string }>
}

function utcDay(iso?: string): string {
  return (iso ? new Date(iso) : new Date()).toISOString().slice(0, 10)
}

function utcDayMinus(iso: string, n: number): string {
  return new Date(new Date(iso).getTime() - n * DAY_MS).toISOString().slice(0, 10)
}

export class GraphMetricsDO extends DurableObject<Env> {
  private ready = false

  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA)
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  /**
   * Accumulate one PR review's graph sample into the day's running sums + the
   * mode review count, and update the PR's last-seen head. Single transaction;
   * schedules the daily GC alarm if none is pending.
   */
  async recordSample(args: RecordSampleArgs): Promise<void> {
    const sql = this.sql()
    const day = utcDay(args.occurredAt)
    const at = args.occurredAt ?? new Date().toISOString()
    const s = args.sample

    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO daily_graph (day, reviews, sum_jaccard, sum_added, sum_nodes, sum_capped, sum_blast_caller, sum_blast_dependent)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           reviews = reviews + 1,
           sum_jaccard = sum_jaccard + ?,
           sum_added = sum_added + ?,
           sum_nodes = sum_nodes + ?,
           sum_capped = sum_capped + ?,
           sum_blast_caller = sum_blast_caller + ?,
           sum_blast_dependent = sum_blast_dependent + ?`,
        day,
        s.jaccard, s.addedCount, s.nodeCount, s.cappedNodeCount, s.blastCallerCount, s.blastDependentCount,
        s.jaccard, s.addedCount, s.nodeCount, s.cappedNodeCount, s.blastCallerCount, s.blastDependentCount,
      )
      sql.exec(
        `INSERT INTO daily_graph_mode (day, mode, reviews) VALUES (?, ?, 1)
         ON CONFLICT(day, mode) DO UPDATE SET reviews = reviews + 1`,
        day, s.mode,
      )
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

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
    }
  }

  /** Windowed averages + per-mode review counts + recent PR heads. */
  async query(args: { windowDays: number; nowIso?: string }): Promise<GraphMetricsQuery> {
    const sql = this.sql()
    const now = args.nowIso ?? new Date().toISOString()
    const endDay = utcDay(now)
    const startDay = utcDayMinus(now, args.windowDays - 1)

    const agg = [
      ...sql.exec<{
        reviews: number; sum_jaccard: number; sum_added: number; sum_nodes: number
        sum_capped: number; sum_blast_caller: number; sum_blast_dependent: number
      }>(
        `SELECT
           COALESCE(SUM(reviews), 0) AS reviews,
           COALESCE(SUM(sum_jaccard), 0) AS sum_jaccard,
           COALESCE(SUM(sum_added), 0) AS sum_added,
           COALESCE(SUM(sum_nodes), 0) AS sum_nodes,
           COALESCE(SUM(sum_capped), 0) AS sum_capped,
           COALESCE(SUM(sum_blast_caller), 0) AS sum_blast_caller,
           COALESCE(SUM(sum_blast_dependent), 0) AS sum_blast_dependent
         FROM daily_graph WHERE day >= ? AND day <= ?`,
        startDay, endDay,
      ),
    ][0] ?? { reviews: 0, sum_jaccard: 0, sum_added: 0, sum_nodes: 0, sum_capped: 0, sum_blast_caller: 0, sum_blast_dependent: 0 }

    const reviews = agg.reviews
    const avg = (sum: number): number => (reviews > 0 ? sum / reviews : 0)

    const modeReviews: Record<string, number> = {}
    for (const row of sql.exec<{ mode: string; reviews: number }>(
      `SELECT mode, SUM(reviews) AS reviews FROM daily_graph_mode
       WHERE day >= ? AND day <= ? GROUP BY mode`,
      startDay, endDay,
    )) {
      modeReviews[row.mode] = row.reviews
    }

    const lastSeenPrHeads = [
      ...sql.exec<{ owner: string; repo: string; pr_number: number; head_sha: string; last_seen_at: string }>(
        `SELECT owner, repo, pr_number, head_sha, last_seen_at
         FROM last_seen_pr ORDER BY last_seen_at DESC LIMIT ?`,
        MAX_LAST_SEEN,
      ),
    ].map((r) => ({ owner: r.owner, repo: r.repo, prNumber: r.pr_number, headSha: r.head_sha, lastSeenAt: r.last_seen_at }))

    return {
      window: { days: args.windowDays, startDay, endDay },
      reviews,
      averages: {
        jaccard: avg(agg.sum_jaccard),
        addedCount: avg(agg.sum_added),
        nodeCount: avg(agg.sum_nodes),
        cappedNodeCount: avg(agg.sum_capped),
        blastCallerCount: avg(agg.sum_blast_caller),
        blastDependentCount: avg(agg.sum_blast_dependent),
      },
      modeReviews,
      lastSeenPrHeads,
    }
  }

  /** Daily retention GC: drop aggregates + PR heads older than RETENTION_DAYS. */
  override async alarm(): Promise<void> {
    const sql = this.sql()
    const now = new Date().toISOString()
    const cutoffDay = utcDayMinus(now, RETENTION_DAYS - 1)
    const cutoffAt = new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString()

    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM daily_graph WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM daily_graph_mode WHERE day < ?", cutoffDay)
      sql.exec("DELETE FROM last_seen_pr WHERE last_seen_at < ?", cutoffAt)
    })

    await this.ctx.storage.setAlarm(Date.now() + DAY_MS)
  }
}
