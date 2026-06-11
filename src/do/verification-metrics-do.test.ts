// SIG-285 PR 2 — VerificationMetricsDO: rolling verdict telemetry. Same harness
// as the other metrics DOs (real in-memory node:sqlite).

import { describe, expect, it } from "vitest"
import { VerificationMetricsDO, RECEIPTJOIN_CATEGORY, TRUSTLEDGER_CATEGORY } from "@/src/do/verification-metrics"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

function makeDo(): { do_: VerificationMetricsDO; getAlarm: () => number | null } {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T {
        return sqlStorage.transactionSync(fn)
      },
      async get(): Promise<unknown> {
        return undefined
      },
      async put(): Promise<void> {},
      async delete(): Promise<boolean> {
        return false
      },
      async setAlarm(t: number): Promise<void> {
        alarmAt = t
      },
      async getAlarm(): Promise<number | null> {
        return alarmAt
      },
      async deleteAlarm(): Promise<void> {
        alarmAt = null
      },
    },
    id: { toString: () => "global", name: "global" },
  }
  return {
    do_: new VerificationMetricsDO(state as unknown as DurableObjectState, {} as Env),
    getAlarm: () => alarmAt,
  }
}

const T = "2026-05-30T12:00:00.000Z"

describe("VerificationMetricsDO.record/recordBatch + query", () => {
  it("counts verdicts per (verdict, category) and rolls up byVerdict", async () => {
    const { do_ } = makeDo()
    await do_.record({ verdict: "refuted", category: "security", occurredAt: T })
    await do_.record({ verdict: "refuted", category: "logic", occurredAt: T })
    await do_.record({ verdict: "confirmed", category: "security", occurredAt: T })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.counts.refuted).toEqual({ security: 1, logic: 1 })
    expect(out.counts.confirmed).toEqual({ security: 1 })
    expect(out.byVerdict).toEqual({ refuted: 2, confirmed: 1 })
    expect(out.total).toBe(3)
  })

  it("derives refutableFraction = (confirmed+refuted)/total and refutedFraction = refuted/total", async () => {
    const { do_ } = makeDo()
    // 2 confirmed, 1 refuted, 1 inconclusive, 6 no-check → total 10.
    await do_.recordBatch([
      { verdict: "confirmed", category: "logic", occurredAt: T },
      { verdict: "confirmed", category: "logic", occurredAt: T },
      { verdict: "refuted", category: "security", occurredAt: T },
      { verdict: "inconclusive", category: "logic", occurredAt: T },
      ...Array.from({ length: 6 }, () => ({
        verdict: "no-check" as const,
        category: "logic" as const,
        occurredAt: T,
      })),
    ])
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.total).toBe(10)
    expect(out.refutableFraction).toBe(0.3) // (2+1)/10
    expect(out.refutedFraction).toBe(0.1) // 1/10
  })

  it("returns zeroed fractions on an empty window (no divide-by-zero)", async () => {
    const { do_ } = makeDo()
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out).toMatchObject({
      total: 0,
      refutableFraction: 0,
      refutedFraction: 0,
      byVerdict: {},
      counts: {},
    })
  })

  it("recordBatch is a no-op on an empty array", async () => {
    const { do_, getAlarm } = makeDo()
    await do_.recordBatch([])
    expect(getAlarm()).toBeNull()
    expect((await do_.query({ windowDays: 7, nowIso: T })).total).toBe(0)
  })

  it("excludes counts outside the trailing window", async () => {
    const { do_ } = makeDo()
    await do_.record({
      verdict: "refuted",
      category: "logic",
      occurredAt: "2026-05-20T12:00:00.000Z",
    }) // 10d before
    await do_.record({ verdict: "refuted", category: "logic", occurredAt: T })
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.byVerdict.refuted).toBe(1)
    expect(out.window).toEqual({ days: 7, startDay: "2026-05-24", endDay: "2026-05-30" })
  })

  it("SIG-285 v2: receipt-join verdicts are a SEPARATE corpus from worker-token", async () => {
    const { do_ } = makeDo()
    await do_.recordBatch([
      { verdict: "confirmed", category: "security", occurredAt: T }, // worker-token
      { verdict: "refuted", category: "logic", occurredAt: T }, // worker-token
      { verdict: "confirmed", category: RECEIPTJOIN_CATEGORY, occurredAt: T },
      { verdict: "confirmed", category: RECEIPTJOIN_CATEGORY, occurredAt: T },
      { verdict: "inconclusive", category: RECEIPTJOIN_CATEGORY, occurredAt: T },
    ])
    const out = await do_.query({ windowDays: 7, nowIso: T })
    // Worker-token aggregates EXCLUDE receipt-join — no contamination either way.
    expect(out.total).toBe(2)
    expect(out.byVerdict).toEqual({ confirmed: 1, refuted: 1 })
    expect(out.counts.confirmed).toEqual({ security: 1 })
    expect(out.counts.confirmed?.[RECEIPTJOIN_CATEGORY]).toBeUndefined()
    // Receipt-join is its own corpus with the load-bearing fraction.
    expect(out.receiptJoin).toEqual({
      confirmed: 2,
      inconclusive: 1,
      total: 3,
      refutableEligibleFraction: 0.333, // inconclusive / (confirmed+inconclusive) = 1/3
    })
  })

  it("receiptJoin is zeroed (no divide-by-zero) on an empty corpus", async () => {
    const { do_ } = makeDo()
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.receiptJoin).toEqual({
      confirmed: 0,
      inconclusive: 0,
      total: 0,
      refutableEligibleFraction: 0,
    })
  })

  it("Trust Ledger: tier rows are a SEPARATE corpus from worker-token + receipt-join", async () => {
    const { do_ } = makeDo()
    await do_.recordBatch([
      { verdict: "confirmed", category: "security", occurredAt: T }, // worker-token
      { verdict: "refuted", category: "logic", occurredAt: T }, // worker-token
      { verdict: "confirmed", category: RECEIPTJOIN_CATEGORY, occurredAt: T }, // receipt-join
      { verdict: "runner-confirmed", category: TRUSTLEDGER_CATEGORY, occurredAt: T }, // trust tiers ↓
      { verdict: "grounded-model", category: TRUSTLEDGER_CATEGORY, occurredAt: T },
      { verdict: "grounded-model", category: TRUSTLEDGER_CATEGORY, occurredAt: T },
      { verdict: "body-only-ungrounded", category: TRUSTLEDGER_CATEGORY, occurredAt: T },
    ])
    const out = await do_.query({ windowDays: 7, nowIso: T })
    // Worker-token aggregates EXCLUDE both other corpora.
    expect(out.total).toBe(2)
    expect(out.byVerdict).toEqual({ confirmed: 1, refuted: 1 })
    // Trust-tier rows never leak into the worker-token `counts` map.
    expect(out.counts.confirmed?.[TRUSTLEDGER_CATEGORY]).toBeUndefined()
    expect(out.counts["runner-confirmed"]).toBeUndefined()
    // The trust ledger is its own corpus keyed by tier.
    expect(out.trustLedger).toEqual({
      byTier: { "runner-confirmed": 1, "grounded-model": 2, "body-only-ungrounded": 1 },
      total: 4,
    })
  })

  it("trustLedger is zeroed on an empty corpus", async () => {
    const { do_ } = makeDo()
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.trustLedger).toEqual({ byTier: {}, total: 0 })
  })

  it("arms a GC alarm after the first record, and the alarm drops out-of-window buckets", async () => {
    const { do_, getAlarm } = makeDo()
    expect(getAlarm()).toBeNull()
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    await do_.record({ verdict: "refuted", category: "logic", occurredAt: old })
    expect(getAlarm()).not.toBeNull()
    await do_.record({
      verdict: "refuted",
      category: "logic",
      occurredAt: new Date().toISOString(),
    })
    await do_.alarm()
    expect(await do_.debugDayCount(old.slice(0, 10), "refuted", "logic")).toBeNull()
    expect(await do_.debugDayCount(new Date().toISOString().slice(0, 10), "refuted", "logic")).not.toBeNull()
  })
})
