// SIG-286 PR2.5: GraphExpansionMetricsDO — rolling graph-expansion shadow
// aggregates (netNewTokens histogram → grouped median, cross-file rates, fetch
// cost, GO/KILL verdict). Same real-sqlite harness as the other metrics DOs.

import { describe, expect, it, vi } from "vitest"
import {
  GraphExpansionMetricsDO,
  bucketIndex,
  BUCKET_LOWERS,
  type GraphExpansionSample,
} from "../src/do/graph-expansion-metrics"
import type { Env } from "../src/shared/types/env"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

function makeDo(): { do_: GraphExpansionMetricsDO; getAlarm: () => number | null } {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T { return sqlStorage.transactionSync(fn) },
      async get(): Promise<unknown> { return undefined },
      async put(): Promise<void> {},
      async delete(): Promise<boolean> { return false },
      async setAlarm(t: number): Promise<void> { alarmAt = t },
      async getAlarm(): Promise<number | null> { return alarmAt },
      async deleteAlarm(): Promise<void> { alarmAt = null },
    },
    id: { toString: () => "global", name: "global" },
  }
  return { do_: new GraphExpansionMetricsDO(state as unknown as DurableObjectState, {} as Env), getAlarm: () => alarmAt }
}

const T = "2026-05-31T12:00:00.000Z"

function sample(netNew: number, over: Partial<GraphExpansionSample> = {}): GraphExpansionSample {
  return {
    mode: "shadow",
    graphAvailable: true,
    netNewTokens: netNew,
    controlTokens: 100,
    totalTokens: 100 + netNew,
    fetchEnabled: true,
    fetchFiles: 1,
    fetchBytes: 500,
    fetchElapsedMs: 50,
    budgetExhausted: false,
    ...over,
  }
}

const record = (do_: GraphExpansionMetricsDO, s: GraphExpansionSample, occurredAt = T) =>
  do_.recordSample({ sample: s, occurredAt })

describe("bucketIndex", () => {
  it("maps netNewTokens to the right histogram bucket", () => {
    expect(BUCKET_LOWERS).toEqual([0, 1, 200, 500, 800, 1600, 3200])
    expect(bucketIndex(0)).toBe(0) // exactly-zero is isolated
    expect(bucketIndex(0.4)).toBe(0)
    expect(bucketIndex(1)).toBe(1)
    expect(bucketIndex(199)).toBe(1)
    expect(bucketIndex(200)).toBe(2)
    expect(bucketIndex(499)).toBe(2)
    expect(bucketIndex(500)).toBe(3)
    expect(bucketIndex(800)).toBe(4)
    expect(bucketIndex(1600)).toBe(5)
    expect(bucketIndex(3200)).toBe(6)
    expect(bucketIndex(50_000)).toBe(6)
    expect(bucketIndex(-5)).toBe(0) // defensive: negatives fall in b0
  })

  it("warns + falls to b0 on a non-finite value (so an upstream bug stays visible)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(bucketIndex(NaN)).toBe(0)
    expect(bucketIndex(Infinity)).toBe(0)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe("GraphExpansionMetricsDO.recordSample + query", () => {
  it("KILL: low median netNewTokens demotes the inject decision", async () => {
    const { do_, getAlarm } = makeDo()
    expect(getAlarm()).toBeNull()
    // netNew [0,100,300,900,1000] → buckets b0,b1,b2,b4,b4; sorted median = 300 (b2).
    for (const v of [0, 100, 300, 900, 1000]) await record(do_, sample(v))
    expect(getAlarm()).not.toBeNull() // GC armed after the first record

    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.reviews).toBe(5)
    expect(out.graphAvailableReviews).toBe(5)
    expect(out.netNewTokens.histogram).toEqual({
      "[0,1)": 1, "[1,200)": 1, "[200,500)": 1, "[500,800)": 0, "[800,1600)": 2, "[1600,3200)": 0, "[3200,∞)": 0,
    })
    // grouped median interpolates within b2 [200,500): 200 + ((2.5-2)/1)*300 = 350.
    expect(out.netNewTokens.medianBucket).toBe("[200,500)")
    expect(out.netNewTokens.medianEstimate).toBe(350)
    expect(out.netNewTokens.mean).toBe(460) // sum 2300 / 5
    expect(out.netNewTokens.crossFileRate).toBe(0.8) // 4 of 5 have netNew >= 1
    expect(out.netNewTokens.meaningfulRate).toBe(0.6) // 3 of 5 have netNew >= 200
    expect(out.control.meanTokens).toBe(100)
    expect(out.treatment.meanTokens).toBe(560) // (100+200+400+1000+1100)/5
    expect(out.fetch).toEqual({ reviews: 5, meanFiles: 1, meanBytes: 500, meanElapsedMs: 50, budgetExhaustedReviews: 0 })
    expect(out.modeReviews).toEqual({ shadow: 5 })
    expect(out.goKill.verdict).toBe("KILL")
  })

  it("GO: high median + cross-file context on > 40% of reviews", async () => {
    const { do_ } = makeDo()
    // netNew [850,900,1000,1200,2000] → b4×4 + b5×1; sorted median = 1000 (b4).
    for (const v of [850, 900, 1000, 1200, 2000]) await record(do_, sample(v))
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.netNewTokens.medianBucket).toBe("[800,1600)")
    expect(out.netNewTokens.medianEstimate).toBe(1300) // 800 + ((2.5-0)/4)*800
    expect(out.netNewTokens.crossFileRate).toBe(1) // all >= 1
    expect(out.goKill.verdict).toBe("GO")
  })

  it("BORDERLINE: median in [500,800) is neither GO (>=800) nor KILL (<500)", async () => {
    const { do_ } = makeDo()
    // All in b3 [500,800) → median 650-ish, < 800 and >= 500.
    for (const v of [600, 650, 700]) await record(do_, sample(v))
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.netNewTokens.medianBucket).toBe("[500,800)")
    expect(out.netNewTokens.medianEstimate).toBeGreaterThanOrEqual(500)
    expect(out.netNewTokens.medianEstimate).toBeLessThan(800)
    expect(out.goKill.verdict).toBe("BORDERLINE")
  })

  it("KILL with an honest median of 0 when every review has zero cross-file gain", async () => {
    const { do_ } = makeDo()
    for (const v of [0, 0, 0, 0]) await record(do_, sample(v))
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.reviews).toBe(4)
    // The median falls in the degenerate b0 = [0,1) bucket — report 0, not an
    // interpolated 1 (the headline number must read honestly for an all-zero corpus).
    expect(out.netNewTokens.medianBucket).toBe("[0,1)")
    expect(out.netNewTokens.medianEstimate).toBe(0)
    expect(out.netNewTokens.crossFileRate).toBe(0)
    expect(out.goKill.verdict).toBe("KILL")
  })

  it("NO_DATA + zeroed fields on an empty window (no divide-by-zero)", async () => {
    const { do_, getAlarm } = makeDo()
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(getAlarm()).toBeNull() // nothing recorded → no alarm
    expect(out.reviews).toBe(0)
    expect(out.netNewTokens.medianEstimate).toBe(0)
    expect(out.netNewTokens.crossFileRate).toBe(0)
    expect(out.netNewTokens.mean).toBe(0)
    expect(out.control.meanTokens).toBe(0)
    expect(out.goKill.verdict).toBe("NO_DATA")
  })

  it("tracks fetch cost + budget exhaustion + mode separately, gating disabled samples", async () => {
    const { do_ } = makeDo()
    await record(do_, sample(300, { fetchBytes: 1000, fetchFiles: 6, budgetExhausted: true }))
    // A fetchEnabled=false sample carrying STALE non-zero fetch fields must NOT
    // contribute to the per-fetch means or the exhaustion count (CodeRabbit #256).
    await record(do_, sample(0, { mode: "post", fetchEnabled: false, fetchFiles: 99, fetchBytes: 99, fetchElapsedMs: 99, budgetExhausted: true }))
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.reviews).toBe(2)
    expect(out.fetch.reviews).toBe(1) // only the fetch-enabled one
    // Means divide by the FETCH-ENABLED count (1) and the disabled sample's stale
    // 99s are gated to 0 — so the cross-file cost is not inflated.
    expect(out.fetch.meanFiles).toBe(6)
    expect(out.fetch.meanBytes).toBe(1000)
    expect(out.fetch.meanElapsedMs).toBe(50)
    expect(out.fetch.budgetExhaustedReviews).toBe(1) // disabled sample's budgetExhausted is gated out
    expect(out.modeReviews).toEqual({ shadow: 1, post: 1 })
  })

  it("drops a malformed sample, but keeps a fetch-disabled one with stale non-finite fetch fields", async () => {
    const { do_ } = makeDo()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await record(do_, sample(800)) // a good sample
    await record(do_, sample(Number.NaN)) // malformed netNew → dropped
    await record(do_, sample(900, { controlTokens: Number.POSITIVE_INFINITY })) // malformed control → dropped
    // fetchEnabled=false with stale non-finite fetch fields: those are gated to 0
    // before the write, so they must NOT invalidate the sample — it's KEPT, else
    // we'd undercount the window and skew GO/KILL (CodeRabbit #256).
    await record(do_, sample(700, { fetchEnabled: false, fetchFiles: Number.NaN, fetchBytes: Number.NaN, fetchElapsedMs: Number.NaN }))
    warn.mockRestore()
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.reviews).toBe(2) // the good 800 + the kept disabled 700
    expect(out.fetch.reviews).toBe(1) // only the fetch-enabled good one
    expect(out.netNewTokens.mean).toBe(750) // (800 + 700) / 2
  })

  it("excludes counts outside the trailing window", async () => {
    const { do_ } = makeDo()
    await record(do_, sample(1000), "2026-05-20T12:00:00.000Z") // 11 days before
    await record(do_, sample(1000), T)
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.reviews).toBe(1)
    expect(out.window).toEqual({ days: 7, startDay: "2026-05-25", endDay: "2026-05-31" })
  })

  it("retention keeps EXACTLY 35 days — the boundary day (now-34) is kept, the day before (now-35) is dropped", async () => {
    // RETENTION_DAYS=35 → cutoff = now-(35-1) = now-34, DELETE WHERE day < cutoff.
    // So [now-34 … now] = 35 distinct days are retained (matches GraphMetricsDO /
    // VerificationMetricsDO). Proves the GC is NOT off-by-one.
    const { do_ } = makeDo()
    const dayAt = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString()
    const day34 = dayAt(34) // the 35th day inclusive → KEEP
    const day35 = dayAt(35) // one day past the window → DROP
    await record(do_, sample(800), day34)
    await record(do_, sample(800), day35)
    await do_.alarm()
    expect(await do_.debugDayReviews(day34.slice(0, 10))).toBe(1) // kept (35-day window is inclusive)
    expect(await do_.debugDayReviews(day35.slice(0, 10))).toBeNull() // dropped
  })

  it("alarm GCs buckets older than the retention window", async () => {
    const { do_ } = makeDo()
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    await record(do_, sample(900), old)
    await record(do_, sample(900), new Date().toISOString())
    await do_.alarm()
    // The 40-day-old day is gone; a fresh query over a wide window sees only the recent one.
    const out = await do_.query({ windowDays: 30, nowIso: new Date().toISOString() })
    expect(out.reviews).toBe(1)
  })
})
