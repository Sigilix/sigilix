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
import type { Env } from "../shared/types/env"
// Single source of truth for the verdict enum (the check produces it); imported
// for local use + re-exported as part of this DO's public API.
import type { VerificationVerdict } from "../lib/verification/verify-finding"
export type { VerificationVerdict }
// SIG Trust Ledger v0: the per-finding trust tier is recorded as the `verdict`
// column under TRUSTLEDGER_CATEGORY (a separate corpus, like receipt-join).
// SIG-363: imported from the shared/domain leaf (not the `../lib/triage-pr-review`
// god-file) so the sink port can reference `RecordVerificationArgs`'s closure
// without an outward god-file dependency.
import type { FindingTrustTier } from "@/shared/domain/pr-review-finding"

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

/** The categories a verification record can carry. Worker-token verification only
 *  checks `logic`/`security` findings; the receipt-join check records under
 *  RECEIPTJOIN_CATEGORY. A closed union (not a free `string`) so a typo can't
 *  silently misclassify a record and leak across the corpus split. */
export type VerificationCategory = "logic" | "security" | "receiptjoin" | "trustledger"

/**
 * One verdict record. Discriminated by `category` so the `verdict` value can't be
 * mismatched to the wrong corpus: `query()` splits worker-token / receipt-join /
 * trust-ledger purely by `category`, so a stray `FindingTrustTier` under a
 * worker-token category (or vice-versa) would silently corrupt the fractions that
 * drive the SIG-285 go/no-go calls. The union makes that pairing a type error.
 * (Both still share the DO's generic `verdict` TEXT column at the storage layer.)
 */
export type RecordVerificationArgs =
  | {
      /** Trust Ledger corpus — the per-finding trust tier. */
      category: "trustledger"
      verdict: FindingTrustTier
      /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
      occurredAt?: string
    }
  | {
      /** Worker-token verdicts (`logic`/`security`) + the receipt-join corpus. */
      category: Exclude<VerificationCategory, "trustledger">
      verdict: VerificationVerdict
      /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
      occurredAt?: string
    }

/** Sentinel `category` the receipt-join check (SIG-285 v2) records under, so it
 *  shares the DO without a schema migration but is reported separately from the
 *  worker-token verification. */
export const RECEIPTJOIN_CATEGORY = "receiptjoin"

/** Sentinel `category` the SIG Trust Ledger records under — the per-finding trust
 *  tier distribution, a SEPARATE corpus from the worker-token / receipt-join
 *  verdicts (no schema migration; kept out of the worker-token aggregates). */
export const TRUSTLEDGER_CATEGORY = "trustledger"

export interface VerificationMetricsQuery {
  /** verdict → category → count. WORKER-TOKEN only (excludes receipt-join). */
  counts: Record<string, Record<string, number>>
  /** Roll-up across all categories: verdict → total. Worker-token only. */
  byVerdict: Record<string, number>
  /** Worker-token total (excludes receipt-join). */
  total: number
  /** (confirmed + refuted) / total — the worker-token share with a usable check. */
  refutableFraction: number
  /** refuted / total — the worker-token share that would demote in enforce (PR 4). */
  refutedFraction: number
  /** SIG-285 v2 PR2: the receipt-join verdict distribution (separate corpus).
   *  `refutableEligibleFraction` = inconclusive / (confirmed + inconclusive) —
   *  the load-bearing unknown that decides PR4/5 (demote) vs receipts-as-trust. */
  receiptJoin: {
    confirmed: number
    inconclusive: number
    /** confirmed + inconclusive (the receipt-join-ELIGIBLE findings). */
    total: number
    refutableEligibleFraction: number
  }
  /** SIG Trust Ledger v0: the per-finding trust tier distribution (separate
   *  corpus). `byTier` maps each FindingTrustTier → count over the window. */
  trustLedger: {
    byTier: Record<string, number>
    total: number
  }
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
    const rjByVerdict: Record<string, number> = {}
    const tlByTier: Record<string, number> = {}
    let total = 0
    let tlTotal = 0
    for (const row of sql.exec<{ verdict: string; category: string; total: number }>(
      `SELECT verdict, category, SUM(count) AS total
       FROM daily_counts WHERE day >= ? AND day <= ?
       GROUP BY verdict, category`,
      startDay, endDay,
    )) {
      // SIG-285 v2 / Trust Ledger: receipt-join + trust-ledger rows share the DO
      // under their sentinel categories but are SEPARATE corpora — keep them out
      // of the worker-token counts / byVerdict / fractions so no measurement
      // contaminates another.
      if (row.category === RECEIPTJOIN_CATEGORY) {
        rjByVerdict[row.verdict] = (rjByVerdict[row.verdict] ?? 0) + row.total
        continue
      }
      if (row.category === TRUSTLEDGER_CATEGORY) {
        tlByTier[row.verdict] = (tlByTier[row.verdict] ?? 0) + row.total
        tlTotal += row.total
        continue
      }
      ;(counts[row.verdict] ??= {})[row.category] = row.total
      byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + row.total
      total += row.total
    }

    const confirmed = byVerdict["confirmed" satisfies VerificationVerdict] ?? 0
    const refuted = byVerdict["refuted" satisfies VerificationVerdict] ?? 0
    const ratio = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000)

    const rjConfirmed = rjByVerdict["confirmed" satisfies VerificationVerdict] ?? 0
    const rjInconclusive = rjByVerdict["inconclusive" satisfies VerificationVerdict] ?? 0
    const rjTotal = rjConfirmed + rjInconclusive

    return {
      counts,
      byVerdict,
      total,
      refutableFraction: ratio(confirmed + refuted, total),
      refutedFraction: ratio(refuted, total),
      receiptJoin: {
        confirmed: rjConfirmed,
        inconclusive: rjInconclusive,
        total: rjTotal,
        refutableEligibleFraction: ratio(rjInconclusive, rjTotal),
      },
      trustLedger: { byTier: tlByTier, total: tlTotal },
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
