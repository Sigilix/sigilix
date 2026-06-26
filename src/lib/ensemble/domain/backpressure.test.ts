// SIG-455 (PR B Task 1) — exhaustive tests for the pure backpressure knobs.
// Written before the implementation (TDD red-green).
//
// parseRetryAfterMs / MAX_RETRY_AFTER_MS tests have been moved to
// @/src/shared/util/retry-after.test.ts (Task 2 relocation).

import { describe, expect, it } from "vitest"
import {
  decorrelatedJitterMs,
  JITTER_BASE_MS,
  JITTER_CAP_MS,
  resolveCooldownMode,
} from "@/src/lib/ensemble/domain/backpressure"

// ─── decorrelatedJitterMs ───────────────────────────────────────────────────

describe("decorrelatedJitterMs", () => {
  it("returns base when rand=0", () => {
    expect(decorrelatedJitterMs(500, 5000, 0)).toBe(500)
  })

  it("returns ~cap when rand approaches 1", () => {
    // rand=0.9999 → 500 + 0.9999 * (5000 - 500) = 500 + 4499.55 = 4999.55 → 5000
    expect(decorrelatedJitterMs(500, 5000, 0.9999)).toBe(5000)
  })

  it("returns midpoint value at rand=0.5", () => {
    // 500 + 0.5 * 4500 = 2750
    expect(decorrelatedJitterMs(500, 5000, 0.5)).toBe(2750)
  })

  it("exported JITTER_BASE_MS=500 and JITTER_CAP_MS=5000 are sane defaults", () => {
    expect(JITTER_BASE_MS).toBe(500)
    expect(JITTER_CAP_MS).toBe(5000)
    // With defaults at rand=0 → 500
    expect(decorrelatedJitterMs(JITTER_BASE_MS, JITTER_CAP_MS, 0)).toBe(500)
  })

  it("clamps to base when cap < base", () => {
    // cap < base → treat cap as base, return base
    expect(decorrelatedJitterMs(500, 100, 0.5)).toBe(500)
    expect(decorrelatedJitterMs(500, 100, 0)).toBe(500)
    expect(decorrelatedJitterMs(500, 100, 0.9999)).toBe(500)
  })

  it("never returns a negative value even with base=0", () => {
    expect(decorrelatedJitterMs(0, 0, 0)).toBe(0)
    expect(decorrelatedJitterMs(0, 0, 0.5)).toBe(0)
  })

  it("round-trips correctly for arbitrary rand values", () => {
    const result = decorrelatedJitterMs(200, 1000, 0.25)
    // 200 + 0.25 * 800 = 400
    expect(result).toBe(400)
  })
})

// ─── resolveCooldownMode ────────────────────────────────────────────────────

describe("resolveCooldownMode", () => {
  it('returns "enforce" when SIGILIX_PROVIDER_COOLDOWN_MODE is "enforce"', () => {
    expect(resolveCooldownMode({ SIGILIX_PROVIDER_COOLDOWN_MODE: "enforce" })).toBe("enforce")
  })

  it('returns "shadow" when SIGILIX_PROVIDER_COOLDOWN_MODE is "shadow"', () => {
    expect(resolveCooldownMode({ SIGILIX_PROVIDER_COOLDOWN_MODE: "shadow" })).toBe("shadow")
  })

  it('returns "off" when SIGILIX_PROVIDER_COOLDOWN_MODE is "off"', () => {
    expect(resolveCooldownMode({ SIGILIX_PROVIDER_COOLDOWN_MODE: "off" })).toBe("off")
  })

  it('returns "off" when SIGILIX_PROVIDER_COOLDOWN_MODE is absent', () => {
    // exactOptionalPropertyTypes: omit the key rather than setting it to undefined
    expect(resolveCooldownMode({})).toBe("off")
  })

  it('returns "off" for unknown/garbage values', () => {
    expect(resolveCooldownMode({ SIGILIX_PROVIDER_COOLDOWN_MODE: "on" })).toBe("off")
    expect(resolveCooldownMode({ SIGILIX_PROVIDER_COOLDOWN_MODE: "ENFORCE" })).toBe("off")
    expect(resolveCooldownMode({ SIGILIX_PROVIDER_COOLDOWN_MODE: "" })).toBe("off")
    expect(resolveCooldownMode({ SIGILIX_PROVIDER_COOLDOWN_MODE: "garbage" })).toBe("off")
  })
})
