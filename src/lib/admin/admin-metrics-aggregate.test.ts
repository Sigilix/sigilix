// sig-admin-metrics — pure aggregation helper tests. No IO: deterministic
// transforms over fixture rows (time bucketing, cost estimate, MRR, margin).

import { describe, expect, it } from "vitest"
import {
  toDailySeries,
  toWeeklySeries,
  estimateInferenceCostUsd,
  rollupRevenue,
  grossMarginUsd,
  type NormalizedSubscription,
} from "@/src/lib/admin/admin-metrics-aggregate"

// A fixed "now" on a known UTC day for stable bucket assertions.
const NOW = Date.parse("2026-07-08T12:00:00.000Z")

describe("toDailySeries", () => {
  it("densifies missing days to 0 across the window, chronological", () => {
    const rows = [
      { day: "2026-07-08", n: 3 },
      { day: "2026-07-06", n: 5 },
    ]
    const series = toDailySeries(rows, NOW, 3)
    expect(series).toEqual([
      { bucket: "2026-07-06", count: 5 },
      { bucket: "2026-07-07", count: 0 },
      { bucket: "2026-07-08", count: 3 },
    ])
  })

  it("ignores malformed day keys and sums duplicates", () => {
    const rows = [
      { day: "bad", n: 9 },
      { day: "2026-07-08", n: 1 },
      { day: "2026-07-08", n: 2 },
    ]
    const series = toDailySeries(rows, NOW, 1)
    expect(series).toEqual([{ bucket: "2026-07-08", count: 3 }])
  })
})

describe("toWeeklySeries", () => {
  it("rolls daily points into Monday-keyed week buckets", () => {
    // 2026-07-06 is a Monday; 07-08 is the same week; 07-13 is the next Monday.
    const daily = [
      { bucket: "2026-07-06", count: 1 },
      { bucket: "2026-07-08", count: 2 },
      { bucket: "2026-07-13", count: 4 },
    ]
    expect(toWeeklySeries(daily)).toEqual([
      { bucket: "2026-07-06", count: 3 },
      { bucket: "2026-07-13", count: 4 },
    ])
  })
})

describe("estimateInferenceCostUsd", () => {
  it("applies the blended (input+output)/2 per-MTok rate", () => {
    // pricing midpoint = (2 + 4)/2 = 3 USD / MTok; 2,000,000 tok → 6 USD.
    const cost = estimateInferenceCostUsd(2_000_000, { inputPerMTokUsd: 2, outputPerMTokUsd: 4 })
    expect(cost).toBeCloseTo(6, 6)
  })

  it("is 0 for non-positive / non-finite token counts", () => {
    expect(estimateInferenceCostUsd(0)).toBe(0)
    expect(estimateInferenceCostUsd(-5)).toBe(0)
    expect(estimateInferenceCostUsd(Number.NaN)).toBe(0)
  })
})

describe("rollupRevenue", () => {
  const subs: NormalizedSubscription[] = [
    { id: "s1", status: "active", tier: "pro", monthlyUsd: 30 },
    { id: "s2", status: "active", tier: "teams", monthlyUsd: 40 },
    { id: "s3", status: "trialing", tier: "pro", monthlyUsd: 30 },
    { id: "s4", status: "canceled", tier: "max", monthlyUsd: 60 },
  ]

  it("counts MRR from active only, and tracks trialing/canceled separately", () => {
    const r = rollupRevenue(subs)
    expect(r.mrrUsd).toBe(70)
    expect(r.activeCount).toBe(2)
    expect(r.trialingCount).toBe(1)
    expect(r.canceledCount).toBe(1)
  })

  it("breaks MRR down per tier, active-only, sorted by revenue", () => {
    const r = rollupRevenue(subs)
    expect(r.perTier).toEqual([
      { tier: "teams", mrrUsd: 40, count: 1 },
      { tier: "pro", mrrUsd: 30, count: 1 },
    ])
  })
})

describe("grossMarginUsd", () => {
  it("is revenue − cost when revenue is known", () => {
    expect(grossMarginUsd(100, 12.5)).toBe(87.5)
  })
  it("is null when revenue is unavailable", () => {
    expect(grossMarginUsd(null, 12.5)).toBeNull()
  })
})
