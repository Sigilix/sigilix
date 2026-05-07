// ARC-190 Task 1 — resolveDoConfig env validator tests.

import { describe, it, expect } from "vitest"
import { resolveDoConfig } from "../src/do/config"
import type { Env } from "../src/index"

function envWith(over: Record<string, string | undefined> = {}): Env {
  return over as unknown as Env
}

describe("resolveDoConfig — defaults", () => {
  it("all-undefined env → mode=off, locked numeric defaults", () => {
    const c = resolveDoConfig(envWith())
    expect(c.mode).toBe("off")
    expect(c.maxRetries).toBe(3)
    expect(c.watchdogMs).toBe(1200000)
    expect(c.historyLimit).toBe(10)
  })
})

describe("resolveDoConfig — mode validation", () => {
  it.each(["off", "shadow", "post"] as const)("accepts literal %s", (mode) => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_MODE: mode })).mode).toBe(mode)
  })

  it("garbage mode value → off", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_MODE: "bogus" })).mode).toBe("off")
  })

  it("empty string mode → off", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_MODE: "" })).mode).toBe("off")
  })

  it("uppercase mode → off (case-sensitive)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_MODE: "POST" })).mode).toBe("off")
  })
})

describe("resolveDoConfig — maxRetries clamp [1, 10]", () => {
  it("0 → 1", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "0" })).maxRetries).toBe(1)
  })
  it("11 → 10", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "11" })).maxRetries).toBe(10)
  })
  it("5 → 5", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "5" })).maxRetries).toBe(5)
  })
  it("-3 → 1", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "-3" })).maxRetries).toBe(1)
  })
  it("non-numeric → default 3", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "abc" })).maxRetries).toBe(3)
  })
})

describe("resolveDoConfig — watchdogMs clamp [60000, 1800000]", () => {
  it("30000 → 60000 (clamp low)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "30000" })).watchdogMs).toBe(60000)
  })
  it("3600000 → 1800000 (clamp high)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "3600000" })).watchdogMs).toBe(1800000)
  })
  it("600000 → 600000 (in-range)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "600000" })).watchdogMs).toBe(600000)
  })
  it("non-numeric → default 1200000", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "soon" })).watchdogMs).toBe(1200000)
  })
})

describe("resolveDoConfig — historyLimit clamp [1, 100]", () => {
  it("0 → 1", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "0" })).historyLimit).toBe(1)
  })
  it("999 → 100", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "999" })).historyLimit).toBe(100)
  })
  it("25 → 25 (in-range)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "25" })).historyLimit).toBe(25)
  })
  it("non-numeric → default 10", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "many" })).historyLimit).toBe(10)
  })
})

describe("resolveDoConfig — combined", () => {
  it("post mode + custom retries + custom watchdog + custom history", () => {
    const c = resolveDoConfig(envWith({
      OPENCLAW_PR_REVIEW_MODE: "post",
      OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "5",
      OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "900000",
      OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "20",
    }))
    expect(c).toEqual({
      mode: "post",
      maxRetries: 5,
      watchdogMs: 900000,
      historyLimit: 20,
    })
  })
})
