// SIG-455 (PR B Task 2) — tests for parseRetryAfterMs (moved from backpressure.test.ts).
// TDD red written before the implementation file exists.

import { describe, expect, it } from "vitest"
import { parseRetryAfterMs, MAX_RETRY_AFTER_MS } from "@/src/shared/util/retry-after"

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
