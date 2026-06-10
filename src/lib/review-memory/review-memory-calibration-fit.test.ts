// SIG-280 PR C: the OFFLINE calibration fit — the Beta(1,9) lower-bound
// estimator + the leakage-safe distinct-PR join that turns the shadow
// corpus + dismissal signals into the per-claim-type params blob.
//
// Estimator + join spec: DeepSeek-v4-pro (2026-05-29). Believability-
// dominant: false-soften >> missed-soften, so the prior is pessimistic
// (Beta(1,9), prior mean 0.10) and we gate on the LOWER bound, never the
// point estimate.

import { describe, it, expect } from "vitest"
import {
  betaLowerBound,
  computeClaimCalibration,
  type CalibrationShadowRecord,
  type CalibrationDismissal,
} from "@/lib/review-memory/calibration-fit"
import { CLAIM_SOFTEN_LOWER_BOUND, shouldKeepSoften } from "@/lib/review-memory/calibration"

const DAY = 24 * 60 * 60 * 1000

describe("betaLowerBound — Beta(1,9) posterior 5% quantile (normal approx)", () => {
  it("is strictly more conservative than the Wilson lower bound (the whole point)", () => {
    // 100/100: Wilson lower ~= 0.964; Beta(1,9) normal-approx ~= 0.875.
    const lb = betaLowerBound(100, 100)
    expect(lb).toBeGreaterThan(0.85)
    expect(lb).toBeLessThan(0.9)
    expect(lb).toBeLessThan(0.964) // below Wilson — conservative
  })
  it("clears 0.80 for a strong, well-sampled type (95/100)", () => {
    expect(betaLowerBound(95, 100)).toBeGreaterThanOrEqual(CLAIM_SOFTEN_LOWER_BOUND)
  })
  it("does NOT clear 0.80 for a borderline type (90/100) — pessimistic prior bites", () => {
    expect(betaLowerBound(90, 100)).toBeLessThan(CLAIM_SOFTEN_LOWER_BOUND)
  })
  it("is far below 0.80 on a thin sample even at 90% observed (9/10)", () => {
    expect(betaLowerBound(9, 10)).toBeLessThan(0.6)
  })
  it("returns 0 for n=0 (no data → maximally cold)", () => {
    expect(betaLowerBound(0, 0)).toBe(0)
  })
  it("is clamped into [0,1]", () => {
    expect(betaLowerBound(0, 100)).toBeGreaterThanOrEqual(0)
    expect(betaLowerBound(100, 100)).toBeLessThanOrEqual(1)
  })
})

function rec(
  prNumber: number,
  createdMs: number,
  rows: CalibrationShadowRecord["rows"],
): CalibrationShadowRecord {
  return { prNumber, createdMs, rows }
}

describe("computeClaimCalibration — leakage-safe distinct-PR join", () => {
  const NOW = 1_000 * DAY // arbitrary; mature cutoff = NOW - 14d
  const mature = NOW - 20 * DAY // older than the 14-day lag → included

  it("excludes the memory-FORMING dismissal (signal.prNumber < row.prNumber)", () => {
    // Row at PR 50 carrying claim X; the only dismissal of fid X is at PR 30
    // (BEFORE) — that's the signal that built the memory, NOT a fresh
    // dismissal. So it counts in the denominator but NOT as a success.
    const shadowRecords = [
      rec(50, mature, [{ fid: "fidX", claimType: "auth-gate-is-boundary" }]),
    ]
    const dismissals: CalibrationDismissal[] = [{ fid: "fidX", prNumber: 30 }]
    const blob = computeClaimCalibration({ shadowRecords, dismissals, nowMs: NOW })
    const p = blob["auth-gate-is-boundary"]
    expect(p?.n).toBe(1)
    expect(p?.s).toBe(0)
  })

  it("counts a dismissal on the SAME or a LATER PR as a fresh success", () => {
    const shadowRecords = [
      rec(50, mature, [{ fid: "fidA", claimType: "auth-gate-is-boundary" }]),
      rec(60, mature, [{ fid: "fidB", claimType: "auth-gate-is-boundary" }]),
    ]
    const dismissals: CalibrationDismissal[] = [
      { fid: "fidA", prNumber: 50 }, // same PR → success
      { fid: "fidB", prNumber: 75 }, // later PR → success
    ]
    const blob = computeClaimCalibration({ shadowRecords, dismissals, nowMs: NOW })
    const p = blob["auth-gate-is-boundary"]
    expect(p?.n).toBe(2)
    expect(p?.s).toBe(2)
  })

  it("dedupes the denominator to DISTINCT PRs (no within-PR pseudo-replication)", () => {
    // Two distinct findings of the same claim type on the SAME PR → n counts
    // the PR ONCE, not twice.
    const shadowRecords = [
      rec(50, mature, [
        { fid: "fid1", claimType: "rethrowing-catch-not-swallowed" },
        { fid: "fid2", claimType: "rethrowing-catch-not-swallowed" },
      ]),
    ]
    const dismissals: CalibrationDismissal[] = [{ fid: "fid1", prNumber: 50 }]
    const blob = computeClaimCalibration({ shadowRecords, dismissals, nowMs: NOW })
    const p = blob["rethrowing-catch-not-swallowed"]
    expect(p?.n).toBe(1)
    expect(p?.s).toBe(1)
  })

  it("drops shadow records younger than the 14-day maturity lag (right-censoring guard)", () => {
    const fresh = NOW - 3 * DAY // inside the lag → excluded
    const shadowRecords = [
      rec(50, fresh, [{ fid: "fidF", claimType: "auth-gate-is-boundary" }]),
    ]
    const blob = computeClaimCalibration({ shadowRecords, dismissals: [], nowMs: NOW })
    expect(blob["auth-gate-is-boundary"]).toBeUndefined()
  })

  it("never lets another claim type's dismissal inflate s past n (s <= n invariant)", () => {
    // One PR raises a DISMISSED finding of type A and a NOT-dismissed
    // finding of type B. Type B's success count must NOT pick up type A's
    // dismissal (else s=1 > n=1 for B... here n=1, so s must be 0).
    const shadowRecords = [
      rec(50, mature, [
        { fid: "fidA", claimType: "auth-gate-is-boundary" },
        { fid: "fidB", claimType: "structural-glue-not-test-target" },
      ]),
    ]
    const dismissals: CalibrationDismissal[] = [{ fid: "fidA", prNumber: 50 }]
    const blob = computeClaimCalibration({ shadowRecords, dismissals, nowMs: NOW })
    expect(blob["auth-gate-is-boundary"]).toMatchObject({ n: 1, s: 1 })
    const b = blob["structural-glue-not-test-target"]
    expect(b?.n).toBe(1)
    expect(b?.s).toBe(0) // NOT 1 — A's dismissal must not leak into B
    expect((b?.s ?? 0) <= (b?.n ?? 0)).toBe(true)
  })

  it("skips null-claimType rows (category-no-claim-match has nothing to calibrate)", () => {
    const shadowRecords = [rec(50, mature, [{ fid: "fidN", claimType: null }])]
    const blob = computeClaimCalibration({ shadowRecords, dismissals: [], nowMs: NOW })
    expect(Object.keys(blob)).toHaveLength(0)
  })

  it("marks a thin type cold (n < 100) so it vetoes regardless of bound", () => {
    const shadowRecords = Array.from({ length: 10 }, (_, i) =>
      rec(i + 1, mature, [{ fid: `f${i}`, claimType: "auth-gate-is-boundary" }]),
    )
    const dismissals = shadowRecords.map((r, i) => ({ fid: `f${i}`, prNumber: r.prNumber }))
    const blob = computeClaimCalibration({ shadowRecords, dismissals, nowMs: NOW })
    const p = blob["auth-gate-is-boundary"]
    expect(p?.n).toBe(10)
    expect(p?.trustworthyN).toBe(false)
    expect(p?.cold).toBe(true)
    expect(shouldKeepSoften(p)).toBe(false)
  })

  it("produces a warm, soften-permitting entry for a strong, well-sampled type", () => {
    // 120 distinct PRs, 115 dismissed-on-or-after → high lower bound + n>=100.
    const shadowRecords = Array.from({ length: 120 }, (_, i) =>
      rec(1000 + i, mature, [{ fid: `g${i}`, claimType: "globally-unique-id-is-tenant-isolation" }]),
    )
    const dismissals = shadowRecords
      .slice(0, 115)
      .map((r, i) => ({ fid: `g${i}`, prNumber: r.prNumber }))
    const blob = computeClaimCalibration({ shadowRecords, dismissals, nowMs: NOW })
    const p = blob["globally-unique-id-is-tenant-isolation"]
    expect(p?.n).toBe(120)
    expect(p?.s).toBe(115)
    expect(p?.trustworthyN).toBe(true)
    expect(p?.cold).toBe(false)
    expect(p?.lowerBound).toBeGreaterThanOrEqual(CLAIM_SOFTEN_LOWER_BOUND)
    expect(shouldKeepSoften(p)).toBe(true)
  })
})
