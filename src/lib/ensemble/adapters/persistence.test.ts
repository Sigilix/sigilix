// SIG-417 — the per-day COST accumulator (`incrementDailyCostUsd`), kept
// SEPARATE from the existing call-count budget (`incrementDailyBudget`). Pins:
// parseFloat/JSON storage under a distinct key, additive accumulation, the
// date-rollover reset, the no-op on bad input, and that the call-count budget is
// untouched by a cost write (and vice versa).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { incrementDailyBudget, incrementDailyCostUsd } from "@/src/lib/ensemble/adapters/persistence"

function makeEnv(initial: Record<string, string> = {}): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>(Object.entries(initial))
  const env = {
    OPENCLAW_STATE: {
      get: async (key: string): Promise<string | null> => kv.get(key) ?? null,
      put: async (key: string, value: string): Promise<void> => {
        kv.set(key, value)
      },
    } as unknown as KVNamespace,
  } as unknown as Env
  return { env, kv }
}

const TODAY = "2026-06-14"

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("incrementDailyCostUsd", () => {
  it("writes a JSON {date, usd} record under the cost key (NOT the budget key)", async () => {
    const { env, kv } = makeEnv()
    await incrementDailyCostUsd(env, 0.42)
    expect(kv.has(`ensemble-budget:${TODAY}`)).toBe(false)
    expect(JSON.parse(kv.get(`ensemble-cost-usd:${TODAY}`)!)).toEqual({ date: TODAY, usd: 0.42 })
  })

  it("accumulates dollar decimals additively (parseFloat — not parseInt)", async () => {
    const { env, kv } = makeEnv()
    await incrementDailyCostUsd(env, 0.1)
    await incrementDailyCostUsd(env, 0.2)
    await incrementDailyCostUsd(env, 0.05)
    expect(JSON.parse(kv.get(`ensemble-cost-usd:${TODAY}`)!).usd).toBeCloseTo(0.35, 6)
  })

  it("resets (does not compound) when the stored record is for a PRIOR day", async () => {
    const stale = JSON.stringify({ date: "2026-06-13", usd: 99.99 })
    const { env, kv } = makeEnv({ [`ensemble-cost-usd:${TODAY}`]: stale })
    await incrementDailyCostUsd(env, 0.5)
    // The stale prior-day total is ignored; today's record starts fresh.
    expect(JSON.parse(kv.get(`ensemble-cost-usd:${TODAY}`)!)).toEqual({ date: TODAY, usd: 0.5 })
  })

  it("resets on a corrupt stored value rather than throwing", async () => {
    const { env, kv } = makeEnv({ [`ensemble-cost-usd:${TODAY}`]: "{not json" })
    await incrementDailyCostUsd(env, 0.25)
    expect(JSON.parse(kv.get(`ensemble-cost-usd:${TODAY}`)!)).toEqual({ date: TODAY, usd: 0.25 })
  })

  it("is a no-op on non-finite or non-positive input (never corrupts the accumulator)", async () => {
    const { env, kv } = makeEnv()
    await incrementDailyCostUsd(env, 0)
    await incrementDailyCostUsd(env, -1)
    await incrementDailyCostUsd(env, Number.NaN)
    expect(kv.has(`ensemble-cost-usd:${TODAY}`)).toBe(false)
  })
})

describe("incrementDailyBudget (call-count) stays separate from the cost accumulator", () => {
  it("a cost write does not touch the call-count key, and vice versa", async () => {
    const { env, kv } = makeEnv()
    await incrementDailyBudget(env, 12) // 12 model calls
    await incrementDailyCostUsd(env, 0.42) // $0.42 spend
    // Call-count budget: a bare integer string under the budget key.
    expect(kv.get(`ensemble-budget:${TODAY}`)).toBe("12")
    // Cost: JSON under the distinct cost key.
    expect(JSON.parse(kv.get(`ensemble-cost-usd:${TODAY}`)!)).toEqual({ date: TODAY, usd: 0.42 })
  })
})
