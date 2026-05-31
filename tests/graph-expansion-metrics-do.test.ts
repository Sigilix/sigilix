// SIG-286 PR2.5: GraphExpansionMetricsDO — rolling graph-expansion shadow
// aggregates (netNewTokens histogram → grouped median, cross-file rates, fetch
// cost, GO/KILL verdict). Same real-sqlite harness as the other metrics DOs.

import { describe, expect, it } from "vitest"
import {
  GraphExpansionMetricsDO,
  bucketIndex,
  BUCKET_LOWERS,
  type GraphExpansionSample,
} from "../src/do/graph-expansion-metrics"
import type { Env } from "../src/index"
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
    // Non-finite should be impossible (netNewTokens is a computed count); it
    // falls to b0 but also warns (Sigilix #256) so an upstream bug stays visible.
    expect(bucketIndex(NaN)).toBe(0)
    expect(bucketIndex(Infinity)).toBe(0)
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

  it("tracks fetch cost + budget exhaustion + mode separately", async () => {
    const { do_ } = makeDo()
    await record(do_, sample(300, { fetchBytes: 1000, fetchFiles: 6, budgetExhausted: true }))
    await record(do_, sample(0, { mode: "post", fetchEnabled: false, fetchFiles: 0, fetchBytes: 0, fetchElapsedMs: 0 }))
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.reviews).toBe(2)
    expect(out.fetch.reviews).toBe(1) // only the fetch-enabled one
    // Means divide by the FETCH-ENABLED count (1), not total reviews (2), so the
    // non-fetch review doesn't dilute the cross-file fetch cost.
    expect(out.fetch.meanFiles).toBe(6)
    expect(out.fetch.meanBytes).toBe(1000)
    expect(out.fetch.meanElapsedMs).toBe(50)
    expect(out.fetch.budgetExhaustedReviews).toBe(1)
    expect(out.modeReviews).toEqual({ shadow: 1, post: 1 })
  })

  it("excludes counts outside the trailing window", async () => {
    const { do_ } = makeDo()
    await record(do_, sample(1000), "2026-05-20T12:00:00.000Z") // 11 days before
    await record(do_, sample(1000), T)
    const out = await do_.query({ windowDays: 7, nowIso: T })
    expect(out.reviews).toBe(1)
    expect(out.window).toEqual({ days: 7, startDay: "2026-05-25", endDay: "2026-05-31" })
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
