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
import type { Env } from "@/src/shared/types/env"
// Single source of truth for the verdict enum (the check produces it); imported
// for local use + re-exported as part of this DO's public API.
import type { VerificationVerdict } from "@/src/lib/verification/verify-finding"
export type { VerificationVerdict }
// SIG Trust Ledger v0: the per-finding trust tier is recorded as the `verdict`
// column under TRUSTLEDGER_CATEGORY (a separate corpus, like receipt-join).
// SIG-363: imported from the shared/domain leaf (not the `../lib/triage-pr-review`
// god-file) so the sink port can reference `RecordVerificationArgs`'s closure
// without an outward god-file dependency.
import type { FindingTrustTier } from "@/src/shared/domain/pr-review-finding"

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
export type VerificationCategory =
  | "logic"
  | "security"
  | "receiptjoin"
  | "trustledger"
  | "selfconfirm"
  | "reproduce_eligibility"
  | "reproduce_result"

/** SIG-476 PR2: the in-worker self-confirmation verdict (the `selfconfirm` corpus).
 *  Both `uplift` and `redundant` imply the finding was CONFIRMED by our independent
 *  in-worker AST engine; they differ in whether the `deterministic-confirmed` tier
 *  GENUINELY raised the finding (`uplift`) or merely relabelled a finding already at
 *  an equal-or-higher tier (`redundant` — the "near-subset of existing GROUNDED"
 *  case the GO/NO-GO watches for). `inconclusive` = eligible but not confirmed. A
 *  closed union so the metric corpus can't be silently miscounted. */
export type SelfConfirmVerdict = "uplift" | "redundant" | "inconclusive"

/** SIG-477 PR-1: the execution-sandbox eligibility verdict (the `reproduce_eligibility`
 *  corpus). `eligible` = the finding's cited code is safe + standalone enough that a
 *  future sandbox could reproduce it (the executable set); `ineligible` = it isn't
 *  (the under-strict-safe fail-open). A closed union so the corpus can't be silently
 *  miscounted. The eligible FRACTION is the GO/NO-GO deciding whether the engine
 *  (PR-2+) is worth building. */
export type ReproduceEligibilityVerdict = "eligible" | "ineligible"

/** SIG-477 PR-3: the execution-HARNESS result verdict (the `reproduce_result` corpus).
 *  `reproduced` = the sandbox actually re-ran the finding's cited code and observed the
 *  predicted failure (e.g. a ReDoS regex's catastrophic backtracking — the honest
 *  two-sided test fired); `inconclusive` = the harness ran but could NOT prove the
 *  failure (it NEVER refutes); `skipped` = nothing to run / over-budget / a fail-safe.
 *  A closed union so the corpus can't be silently miscounted. `reproducedFraction` =
 *  reproduced / (reproduced + inconclusive) is the GO/NO-GO for the PR-5 customer flip;
 *  `skipped` is reported separately (it isn't an attempt that produced a verdict). */
export type ReproduceResultVerdict = "reproduced" | "inconclusive" | "skipped"

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
      /** SIG-476 PR2 — the in-worker self-confirmation corpus. */
      category: "selfconfirm"
      verdict: SelfConfirmVerdict
      /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
      occurredAt?: string
    }
  | {
      /** SIG-477 PR-1 — the execution-sandbox eligibility corpus. */
      category: "reproduce_eligibility"
      verdict: ReproduceEligibilityVerdict
      /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
      occurredAt?: string
    }
  | {
      /** SIG-477 PR-3 — the execution-HARNESS result corpus. */
      category: "reproduce_result"
      verdict: ReproduceResultVerdict
      /** ISO timestamp; the UTC date prefix is the bucket. Defaults to now. */
      occurredAt?: string
    }
  | {
      /** Worker-token verdicts (`logic`/`security`) + the receipt-join corpus. */
      category: Exclude<
        VerificationCategory,
        "trustledger" | "selfconfirm" | "reproduce_eligibility" | "reproduce_result"
      >
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

/** Sentinel `category` the SIG-476 in-worker self-confirmation records under — the
 *  confirmed/uplift distribution, a SEPARATE corpus from worker-token / receipt-join
 *  / trust-ledger (no schema migration; kept out of the worker-token aggregates). */
export const SELFCONFIRM_CATEGORY = "selfconfirm"

/** Sentinel `category` the SIG-477 execution-sandbox eligibility gate records under —
 *  the eligible/ineligible distribution, a SEPARATE corpus from all the others (no
 *  schema migration; kept out of the worker-token aggregates). */
export const REPRODUCE_ELIGIBILITY_CATEGORY = "reproduce_eligibility"

/** Sentinel `category` the SIG-477 PR-3 execution HARNESS records its result under —
 *  the reproduced/inconclusive/skipped distribution, a SEPARATE corpus from all the
 *  others (no schema migration; kept out of the worker-token aggregates). */
export const REPRODUCE_RESULT_CATEGORY = "reproduce_result"

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
  /** SIG-476 PR2: the in-worker self-confirmation distribution (separate corpus).
   *  `confirmed = uplift + redundant; total = confirmed + inconclusive`.
   *  `confirmedFraction = confirmed / total` (how often an eligible finding is
   *  independently confirmed) and `upliftFraction = uplift / confirmed` (how often
   *  a confirmation GENUINELY raises the tier vs merely relabels an already-grounded
   *  one) — together THE GO/NO-GO deciding whether `deterministic-confirmed` earns a
   *  distinct pill (PR3) or should be a GROUNDED sub-state. */
  selfConfirm: {
    uplift: number
    redundant: number
    inconclusive: number
    confirmed: number
    total: number
    confirmedFraction: number
    upliftFraction: number
  }
  /** SIG-477 PR-1: the execution-sandbox eligibility distribution (separate corpus).
   *  `eligibleFraction = eligible / (eligible + ineligible)` — THE GO/NO-GO deciding
   *  whether the reproduce engine (PR-2+) is worth building. Divide-by-zero guarded
   *  (empty corpus → 0). */
  reproduceEligibility: {
    eligible: number
    ineligible: number
    total: number
    eligibleFraction: number
  }
  /** SIG-477 PR-3: the execution-HARNESS result distribution (separate corpus).
   *  `reproducedFraction = reproduced / (reproduced + inconclusive)` — the share of
   *  ATTEMPTED reproductions that succeeded (the GO/NO-GO for the PR-5 customer flip).
   *  `skipped` is reported separately (it isn't an attempt that produced a verdict),
   *  so it is EXCLUDED from the fraction denominator. Divide-by-zero guarded. */
  reproduceResult: {
    reproduced: number
    inconclusive: number
    skipped: number
    /** reproduced + inconclusive (the harness runs that produced a verdict). */
    total: number
    reproducedFraction: number
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
        day,
        args.verdict,
        args.category,
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
          utcDay(it.occurredAt),
          it.verdict,
          it.category,
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
    const scByVerdict: Record<string, number> = {}
    const reByVerdict: Record<string, number> = {}
    const rrByVerdict: Record<string, number> = {}
    let total = 0
    let tlTotal = 0
    for (const row of sql.exec<{ verdict: string; category: string; total: number }>(
      `SELECT verdict, category, SUM(count) AS total
       FROM daily_counts WHERE day >= ? AND day <= ?
       GROUP BY verdict, category`,
      startDay,
      endDay,
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
      if (row.category === SELFCONFIRM_CATEGORY) {
        scByVerdict[row.verdict] = (scByVerdict[row.verdict] ?? 0) + row.total
        continue
      }
      if (row.category === REPRODUCE_ELIGIBILITY_CATEGORY) {
        reByVerdict[row.verdict] = (reByVerdict[row.verdict] ?? 0) + row.total
        continue
      }
      if (row.category === REPRODUCE_RESULT_CATEGORY) {
        rrByVerdict[row.verdict] = (rrByVerdict[row.verdict] ?? 0) + row.total
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

    // SIG-476 PR2: self-confirmation corpus. uplift + redundant both imply CONFIRMED;
    // confirmedFraction = confirmed/total tells us how often an eligible finding is
    // independently confirmed, and upliftFraction = uplift/confirmed how often that
    // confirmation GENUINELY raises the tier (vs relabeling an already-grounded one).
    const scUplift = scByVerdict["uplift" satisfies SelfConfirmVerdict] ?? 0
    const scRedundant = scByVerdict["redundant" satisfies SelfConfirmVerdict] ?? 0
    const scInconclusive = scByVerdict["inconclusive" satisfies SelfConfirmVerdict] ?? 0
    const scConfirmed = scUplift + scRedundant
    const scTotal = scConfirmed + scInconclusive

    // SIG-477 PR-1: execution-sandbox eligibility corpus. eligibleFraction =
    // eligible/(eligible+ineligible) — the GO/NO-GO deciding whether the reproduce
    // engine (PR-2+) is worth building.
    const reEligible = reByVerdict["eligible" satisfies ReproduceEligibilityVerdict] ?? 0
    const reIneligible = reByVerdict["ineligible" satisfies ReproduceEligibilityVerdict] ?? 0
    const reTotal = reEligible + reIneligible

    // SIG-477 PR-3: execution-HARNESS result corpus. reproducedFraction =
    // reproduced/(reproduced+inconclusive) — the share of ATTEMPTED reproductions
    // that succeeded (the GO/NO-GO for the PR-5 customer flip). `skipped` is reported
    // but EXCLUDED from the denominator (it isn't an attempt that produced a verdict).
    const rrReproduced = rrByVerdict["reproduced" satisfies ReproduceResultVerdict] ?? 0
    const rrInconclusive = rrByVerdict["inconclusive" satisfies ReproduceResultVerdict] ?? 0
    const rrSkipped = rrByVerdict["skipped" satisfies ReproduceResultVerdict] ?? 0
    const rrTotal = rrReproduced + rrInconclusive

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
      selfConfirm: {
        uplift: scUplift,
        redundant: scRedundant,
        inconclusive: scInconclusive,
        confirmed: scConfirmed,
        total: scTotal,
        confirmedFraction: ratio(scConfirmed, scTotal),
        upliftFraction: ratio(scUplift, scConfirmed),
      },
      reproduceEligibility: {
        eligible: reEligible,
        ineligible: reIneligible,
        total: reTotal,
        eligibleFraction: ratio(reEligible, reTotal),
      },
      reproduceResult: {
        reproduced: rrReproduced,
        inconclusive: rrInconclusive,
        skipped: rrSkipped,
        total: rrTotal,
        reproducedFraction: ratio(rrReproduced, rrTotal),
      },
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
        day,
        verdict,
        category,
      ),
    ]
    return rows[0] ? rows[0].count : null
  }
}
