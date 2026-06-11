// ARC-190 Task 1 + SIG-174 — resolveDoConfig env validator tests.

import { describe, it, expect } from "vitest"
import { resolveDoConfig } from "@/src/do/config"
import type { Env } from "@/src/shared/types/env"

function envWith(over: Record<string, string | undefined> = {}): Env {
  return over as unknown as Env
}

describe("resolveDoConfig — defaults", () => {
  it("all-undefined env → locked numeric defaults", () => {
    const c = resolveDoConfig(envWith())
    expect(c.maxRetries).toBe(3)
    // SIG-329: watchdog lowered 20 min → 10 min (now an absolute backstop);
    // liveness gap-detector added.
    expect(c.watchdogMs).toBe(600000)
    expect(c.livenessMs).toBe(90000)
    expect(c.historyLimit).toBe(10)
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
  it("non-numeric → default 600000", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "soon" })).watchdogMs).toBe(600000)
  })
})

describe("resolveDoConfig — livenessMs clamp [45000, 300000] (SIG-329)", () => {
  // SIG-329 PR #370 finding #3: the floor must exceed the consumer's 30s
  // HEARTBEAT_INTERVAL_MS, else the first liveness alarm fires before the
  // first heartbeat and false-declares a live consumer dead.
  it("30000 → 45000 (clamp low — below the 30s heartbeat interval is rejected)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_LIVENESS_MS: "30000" })).livenessMs).toBe(45000)
  })
  it("600000 → 300000 (clamp high)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_LIVENESS_MS: "600000" })).livenessMs).toBe(300000)
  })
  it("60000 → 60000 (in-range)", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_LIVENESS_MS: "60000" })).livenessMs).toBe(60000)
  })
  it("non-numeric → default 90000", () => {
    expect(resolveDoConfig(envWith({ OPENCLAW_PR_REVIEW_DO_LIVENESS_MS: "later" })).livenessMs).toBe(90000)
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
  it("custom retries + custom watchdog + custom liveness + custom history", () => {
    const c = resolveDoConfig(
      envWith({
        OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "5",
        OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "900000",
        OPENCLAW_PR_REVIEW_DO_LIVENESS_MS: "60000",
        OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "20",
      }),
    )
    expect(c).toEqual({
      maxRetries: 5,
      watchdogMs: 900000,
      livenessMs: 60000,
      historyLimit: 20,
    })
  })
})
