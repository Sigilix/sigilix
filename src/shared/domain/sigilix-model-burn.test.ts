// sig-cost-based-metering — unit tests for the per-model burn rate + upsell nudge.

import { describe, expect, it } from "vitest"
import {
  SIGILIX_MODEL_BURN_USD_PER_MTOK,
  REPRESENTATIVE_TASK_TOKENS,
  cheapestBurnModel,
  priciestBurnModel,
  modelBurnTable,
  approxTasksRemaining,
  usageUpsellHint,
} from "./sigilix-model-burn"

describe("cheapest / priciest burn model", () => {
  it("boreas is the cheapest, astraeus the priciest (per the rate table)", () => {
    expect(cheapestBurnModel()).toBe("boreas")
    expect(priciestBurnModel()).toBe("astraeus")
  })
})

describe("modelBurnTable", () => {
  it("is cheapest-first with the cheapest at 1.0×", () => {
    const table = modelBurnTable()
    expect(table[0]).toEqual({ model: "boreas", relative: 1 })
    // astraeus ≈ 1.9 / 0.3 ≈ 6.3×
    const astraeus = table.find((t) => t.model === "astraeus")
    expect(astraeus?.relative).toBeGreaterThan(5)
    expect(astraeus?.relative).toBeLessThan(8)
  })

  it("every relative is the model rate over the cheapest rate", () => {
    const min = SIGILIX_MODEL_BURN_USD_PER_MTOK[cheapestBurnModel()]!
    for (const { model, relative } of modelBurnTable()) {
      expect(relative).toBeCloseTo(Math.round((SIGILIX_MODEL_BURN_USD_PER_MTOK[model]! / min) * 10) / 10, 6)
    }
  })
})

describe("approxTasksRemaining", () => {
  it("translates remaining USD into whole Boreas tasks (floored)", () => {
    const perTask = (REPRESENTATIVE_TASK_TOKENS / 1_000_000) * SIGILIX_MODEL_BURN_USD_PER_MTOK.boreas!
    // e.g. 400k tokens × $0.30/MTok = $0.12/task → $1.50 remaining ≈ 12 tasks
    expect(approxTasksRemaining(1.5, "boreas")).toBe(Math.floor(1.5 / perTask))
  })

  it("a premium model funds FEWER tasks for the same budget than the cheap one", () => {
    expect(approxTasksRemaining(1.5, "astraeus")!).toBeLessThan(approxTasksRemaining(1.5, "boreas")!)
  })

  it("null (unbounded) budget → null; unknown model → null", () => {
    expect(approxTasksRemaining(null, "boreas")).toBeNull()
    expect(approxTasksRemaining(1.5, "nope")).toBeNull()
  })
})

describe("usageUpsellHint", () => {
  it("fires only when the budget is low (<= threshold)", () => {
    expect(usageUpsellHint(80)).toBeNull()
    const hint = usageUpsellHint(10)
    expect(hint).toContain("Astraeus")
    expect(hint).toContain("Boreas")
    expect(hint).toContain("upgrade")
  })

  it("never fires on an unbounded (null) remaining pct", () => {
    expect(usageUpsellHint(null)).toBeNull()
  })
})
