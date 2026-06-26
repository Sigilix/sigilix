// SIG-455 (PR B Task 1) — exhaustive tests for the pure backpressure knobs.
// Written before the implementation (TDD red-green).

import { describe, expect, it } from "vitest"
import {
  decorrelatedJitterMs,
  JITTER_BASE_MS,
  JITTER_CAP_MS,
  parseRetryAfterMs,
  MAX_RETRY_AFTER_MS,
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

// ─── parseRetryAfterMs ──────────────────────────────────────────────────────

describe("parseRetryAfterMs", () => {
  const DEFAULT = 3000

  it('parses delta-seconds "30" → 30000ms', () => {
    expect(parseRetryAfterMs("30", 0, DEFAULT)).toBe(30_000)
  })

  it('parses delta-seconds "0" → 0ms', () => {
    expect(parseRetryAfterMs("0", 0, DEFAULT)).toBe(0)
  })

  it("parses an HTTP-date in the future → positive delta from nowMs", () => {
    const nowMs = Date.now()
    const futureMs = nowMs + 60_000
    const header = new Date(futureMs).toUTCString()
    const result = parseRetryAfterMs(header, nowMs, DEFAULT)
    // toUTCString() has second-level precision so the delta can be up to
    // 999ms less than 60000ms. Accept [59000, 60000].
    expect(result).toBeGreaterThanOrEqual(59_000)
    expect(result).toBeLessThanOrEqual(60_000)
  })

  it("parses an HTTP-date in the past → 0ms (not negative)", () => {
    const nowMs = Date.now()
    const pastMs = nowMs - 10_000
    const header = new Date(pastMs).toUTCString()
    expect(parseRetryAfterMs(header, nowMs, DEFAULT)).toBe(0)
  })

  it("returns defaultMs for null header", () => {
    expect(parseRetryAfterMs(null, 0, DEFAULT)).toBe(DEFAULT)
  })

  it("returns defaultMs for empty string", () => {
    expect(parseRetryAfterMs("", 0, DEFAULT)).toBe(DEFAULT)
  })

  it('returns defaultMs for non-numeric non-date "abc"', () => {
    expect(parseRetryAfterMs("abc", 0, DEFAULT)).toBe(DEFAULT)
  })

  it("clamps a very large Retry-After to MAX_RETRY_AFTER_MS (5 minutes)", () => {
    // 1 hour in seconds = 3600 → 3600000ms → clamped to 300000
    expect(parseRetryAfterMs("3600", 0, DEFAULT)).toBe(MAX_RETRY_AFTER_MS)
    expect(MAX_RETRY_AFTER_MS).toBe(300_000)
  })

  it("clamps a far-future HTTP-date to MAX_RETRY_AFTER_MS", () => {
    const nowMs = Date.now()
    const farFuture = new Date(nowMs + 10 * 60 * 1000).toUTCString() // 10 min
    expect(parseRetryAfterMs(farFuture, nowMs, DEFAULT)).toBe(MAX_RETRY_AFTER_MS)
  })

  it("returns defaultMs for negative delta-seconds string", () => {
    expect(parseRetryAfterMs("-5", 0, DEFAULT)).toBe(DEFAULT)
  })

  it("returns defaultMs for a float string (non-integer delta)", () => {
    // "3.5" is not a non-negative integer → treat as invalid → defaultMs
    expect(parseRetryAfterMs("3.5", 0, DEFAULT)).toBe(DEFAULT)
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
