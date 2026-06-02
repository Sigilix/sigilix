// SIG-149 — pin the cost/SLO math and the `review-slo-summary` event
// shape. The event is the anchor a CF Logs dashboard aggregates and a
// p95-latency / cost-breach alert keys on, so a dropped or renamed field
// here breaks production observability silently — catch it in the test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  type EnsembleRunCtx,
} from "../src/lib/ensemble-perf-telemetry"
import {
  type TokenUsageByModel,
  MODEL_PRICING,
  DEFAULT_PRICING,
  SLO_TARGETS,
  DEFAULT_TIER,
  pricingForModel,
  makeTokenRecorder,
  computeReviewCost,
  resolveSloTarget,
  evaluateReviewSlo,
  emitReviewSlo,
} from "../src/lib/ensemble-slo-telemetry"

const CTX: EnsembleRunCtx = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 149,
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
}

let logSpy: ReturnType<typeof vi.spyOn>

function lastLogged(): Record<string, unknown> {
  const calls = logSpy.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const last = calls[calls.length - 1]?.[0]
  expect(typeof last).toBe("string")
  return JSON.parse(last as string)
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
})

// ─── pricingForModel ────────────────────────────────────────────────

describe("pricingForModel", () => {
  it("returns the table entry for a known model", () => {
    expect(pricingForModel("deepseek-v4-pro:cloud")).toBe(
      MODEL_PRICING["deepseek-v4-pro:cloud"],
    )
  })

  it("falls back to DEFAULT_PRICING for an unknown model (never $0)", () => {
    expect(pricingForModel("some-new-model-we-forgot:cloud")).toBe(DEFAULT_PRICING)
  })
})

// ─── makeTokenRecorder ──────────────────────────────────────────────

describe("makeTokenRecorder", () => {
  it("accumulates across attempts of the same model", () => {
    const sink: TokenUsageByModel = {}
    const record = makeTokenRecorder(sink)
    record("m1", 100, 10)
    record("m1", 50, 5)
    expect(sink).toEqual({ m1: { inputTokens: 150, outputTokens: 15 } })
  })

  it("keeps models separate", () => {
    const sink: TokenUsageByModel = {}
    const record = makeTokenRecorder(sink)
    record("m1", 100, 10)
    record("m2", 200, 20)
    expect(sink["m1"]).toEqual({ inputTokens: 100, outputTokens: 10 })
    expect(sink["m2"]).toEqual({ inputTokens: 200, outputTokens: 20 })
  })

  it("treats undefined as no-data, not zero (model stays absent)", () => {
    const sink: TokenUsageByModel = {}
    const record = makeTokenRecorder(sink)
    record("m1", undefined, undefined)
    expect(sink).toEqual({})
  })

  it("records a one-sided count without zero-filling the other side", () => {
    const sink: TokenUsageByModel = {}
    const record = makeTokenRecorder(sink)
    record("m1", 100, undefined)
    expect(sink["m1"]).toEqual({ inputTokens: 100, outputTokens: 0 })
  })
})

// ─── computeReviewCost ──────────────────────────────────────────────

describe("computeReviewCost", () => {
  it("sums tokens and converts to USD per the pricing table", () => {
    // 1M input + 1M output on deepseek = 0.6 + 1.7 = 2.3 USD.
    const usage: TokenUsageByModel = {
      "deepseek-v4-pro:cloud": { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    }
    const cost = computeReviewCost(usage)
    expect(cost.totalInputTokens).toBe(1_000_000)
    expect(cost.totalOutputTokens).toBe(1_000_000)
    expect(cost.totalUsd).toBeCloseTo(2.3, 6)
    expect(cost.byModelUsd["deepseek-v4-pro:cloud"]).toBeCloseTo(2.3, 6)
  })

  it("sums across multiple models", () => {
    const usage: TokenUsageByModel = {
      "deepseek-v4-pro:cloud": { inputTokens: 1_000_000, outputTokens: 0 }, // 0.6
      "qwen3:cloud": { inputTokens: 1_000_000, outputTokens: 0 }, // 0.3
    }
    expect(computeReviewCost(usage).totalUsd).toBeCloseTo(0.9, 6)
  })

  it("uses DEFAULT_PRICING for an untracked model", () => {
    const usage: TokenUsageByModel = {
      mystery: { inputTokens: 1_000_000, outputTokens: 0 },
    }
    expect(computeReviewCost(usage).totalUsd).toBeCloseTo(DEFAULT_PRICING.inputPerMTokUsd, 6)
  })

  it("is zero for empty usage (stale-head bail before fan-out)", () => {
    const cost = computeReviewCost({})
    expect(cost.totalUsd).toBe(0)
    expect(cost.totalInputTokens).toBe(0)
    expect(cost.totalOutputTokens).toBe(0)
    expect(cost.byModelUsd).toEqual({})
  })
})

// ─── resolveSloTarget / evaluateReviewSlo ───────────────────────────

describe("resolveSloTarget", () => {
  it("returns the default tier when no tier is given", () => {
    expect(resolveSloTarget()).toBe(SLO_TARGETS[DEFAULT_TIER])
  })

  it("falls back to default for an unknown tier (forward-compat with SIG-41)", () => {
    expect(resolveSloTarget("enterprise-tier-not-yet-defined")).toBe(
      SLO_TARGETS[DEFAULT_TIER],
    )
  })
})

describe("evaluateReviewSlo", () => {
  const target = SLO_TARGETS[DEFAULT_TIER]!

  it("does not breach when both metrics are under budget", () => {
    const e = evaluateReviewSlo({ totalMs: 1_000, costUsd: 0.01 })
    expect(e.latencyOverBudget).toBe(false)
    expect(e.costOverBudget).toBe(false)
    expect(e.sloBreached).toBe(false)
  })

  it("breaches on latency alone", () => {
    const e = evaluateReviewSlo({ totalMs: target.timeToFullReviewMs + 1, costUsd: 0 })
    expect(e.latencyOverBudget).toBe(true)
    expect(e.costOverBudget).toBe(false)
    expect(e.sloBreached).toBe(true)
  })

  it("breaches on cost alone", () => {
    const e = evaluateReviewSlo({ totalMs: 0, costUsd: target.costPerReviewUsd + 0.01 })
    expect(e.latencyOverBudget).toBe(false)
    expect(e.costOverBudget).toBe(true)
    expect(e.sloBreached).toBe(true)
  })

  it("does not breach exactly at budget (strict >)", () => {
    const e = evaluateReviewSlo({
      totalMs: target.timeToFullReviewMs,
      costUsd: target.costPerReviewUsd,
    })
    expect(e.sloBreached).toBe(false)
  })
})

// ─── emitReviewSlo (event shape) ────────────────────────────────────

describe("emitReviewSlo", () => {
  it("emits a review-slo-summary with the full field set + correlation", () => {
    const usage: TokenUsageByModel = {
      "deepseek-v4-pro:cloud": { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    }
    emitReviewSlo(CTX, { status: "posted", totalMs: 42_000, usage })
    const ev = lastLogged()
    expect(ev["event"]).toBe("review-slo-summary")
    // correlation fields, headSha truncated to 7
    expect(ev["owner"]).toBe("Sigilix")
    expect(ev["repo"]).toBe("sigilix")
    expect(ev["prNumber"]).toBe(149)
    expect(ev["headSha"]).toBe("abcdef1")
    // roll-up fields
    expect(ev["tier"]).toBe(DEFAULT_TIER)
    expect(ev["status"]).toBe("posted")
    expect(ev["totalMs"]).toBe(42_000)
    expect(ev["latencyBudgetMs"]).toBe(SLO_TARGETS[DEFAULT_TIER]!.timeToFullReviewMs)
    expect(ev["latencyOverBudget"]).toBe(false)
    expect(ev["totalInputTokens"]).toBe(1_000_000)
    expect(ev["totalOutputTokens"]).toBe(1_000_000)
    expect(ev["costUsd"]).toBeCloseTo(2.3, 6)
    expect(ev["costBudgetUsd"]).toBe(SLO_TARGETS[DEFAULT_TIER]!.costPerReviewUsd)
    expect(ev["costOverBudget"]).toBe(true) // 2.3 > 0.5
    expect(ev["sloBreached"]).toBe(true)
    expect(ev["byModelUsd"]).toEqual({ "deepseek-v4-pro:cloud": expect.closeTo(2.3, 6) })
  })

  it("emits with zeros + no breach for an empty (pre-fanout bail) review", () => {
    const e = emitReviewSlo(CTX, { status: "stale_head", totalMs: 500, usage: {} })
    const ev = lastLogged()
    expect(ev["status"]).toBe("stale_head")
    expect(ev["costUsd"]).toBe(0)
    expect(ev["sloBreached"]).toBe(false)
    expect(e.sloBreached).toBe(false)
  })

  it("returns the evaluation it emitted", () => {
    const e = emitReviewSlo(CTX, {
      status: "posted",
      totalMs: SLO_TARGETS[DEFAULT_TIER]!.timeToFullReviewMs + 1,
      usage: {},
    })
    expect(e.latencyOverBudget).toBe(true)
    expect(e.sloBreached).toBe(true)
  })
})
