import { describe, expect, it } from "vitest"
import {
  DEFAULT_RATE_LIMIT_CAP,
  RATE_LIMIT_WINDOW_MS,
  computeResetMs,
  decideRateLimit,
  formatUsageFooter,
  resolveRateLimitCap,
  resolveRateLimitMode,
} from "./rate-limit"

// ─── resolveRateLimitMode ────────────────────────────────────────────────────

describe("resolveRateLimitMode", () => {
  it('returns "shadow" when SIGILIX_RATE_LIMIT_MODE is unset', () => {
    expect(resolveRateLimitMode({} as never)).toBe("shadow")
  })

  it('returns "shadow" when SIGILIX_RATE_LIMIT_MODE is empty string', () => {
    expect(resolveRateLimitMode({ SIGILIX_RATE_LIMIT_MODE: "" })).toBe("shadow")
  })

  it('returns "shadow" when SIGILIX_RATE_LIMIT_MODE is whitespace-only', () => {
    expect(resolveRateLimitMode({ SIGILIX_RATE_LIMIT_MODE: "  " })).toBe("shadow")
  })

  it('returns "shadow" when SIGILIX_RATE_LIMIT_MODE is an unrecognized value', () => {
    expect(resolveRateLimitMode({ SIGILIX_RATE_LIMIT_MODE: "x" })).toBe("shadow")
  })

  it('returns "shadow" when SIGILIX_RATE_LIMIT_MODE is "shadow"', () => {
    expect(resolveRateLimitMode({ SIGILIX_RATE_LIMIT_MODE: "shadow" })).toBe("shadow")
  })

  it('returns "off" when SIGILIX_RATE_LIMIT_MODE is "off"', () => {
    expect(resolveRateLimitMode({ SIGILIX_RATE_LIMIT_MODE: "off" })).toBe("off")
  })

  it('returns "enforce" when SIGILIX_RATE_LIMIT_MODE is "enforce"', () => {
    expect(resolveRateLimitMode({ SIGILIX_RATE_LIMIT_MODE: "enforce" })).toBe("enforce")
  })

  it('trims + case-folds: " ENFORCE " → "enforce"', () => {
    expect(resolveRateLimitMode({ SIGILIX_RATE_LIMIT_MODE: " ENFORCE " })).toBe("enforce")
  })
})

// ─── resolveRateLimitCap ─────────────────────────────────────────────────────

describe("resolveRateLimitCap", () => {
  it('returns 3 for "oss"', () => {
    expect(resolveRateLimitCap("oss")).toBe(3)
  })

  it('returns 3 for "cli"', () => {
    expect(resolveRateLimitCap("cli")).toBe(3)
  })

  it('returns 3 for "free"', () => {
    expect(resolveRateLimitCap("free")).toBe(3)
  })

  it('returns 5 for "pro"', () => {
    expect(resolveRateLimitCap("pro")).toBe(5)
  })

  it('returns 10 for "pro_plus"', () => {
    expect(resolveRateLimitCap("pro_plus")).toBe(10)
  })

  it('returns 10 for "pro+"', () => {
    expect(resolveRateLimitCap("pro+")).toBe(10)
  })

  it('returns 12 for "enterprise"', () => {
    expect(resolveRateLimitCap("enterprise")).toBe(12)
  })

  it("returns DEFAULT_RATE_LIMIT_CAP for an unknown tier", () => {
    expect(resolveRateLimitCap("unknown_tier")).toBe(DEFAULT_RATE_LIMIT_CAP)
  })

  it("returns DEFAULT_RATE_LIMIT_CAP for null", () => {
    expect(resolveRateLimitCap(null)).toBe(DEFAULT_RATE_LIMIT_CAP)
  })

  it("returns DEFAULT_RATE_LIMIT_CAP for undefined", () => {
    expect(resolveRateLimitCap(undefined)).toBe(DEFAULT_RATE_LIMIT_CAP)
  })

  it("is case-insensitive: 'PRO' → 5", () => {
    expect(resolveRateLimitCap("PRO")).toBe(5)
  })
})

// ─── decideRateLimit ─────────────────────────────────────────────────────────

describe("decideRateLimit", () => {
  it("returns true when used < cap + burst", () => {
    // cap=3, burst=1 → allowed while used < 4
    expect(decideRateLimit(0, 3, 1)).toBe(true)
    expect(decideRateLimit(3, 3, 1)).toBe(true)
  })

  it("returns false when used == cap + burst", () => {
    // cap=3, burst=1 → blocked at used=4
    expect(decideRateLimit(4, 3, 1)).toBe(false)
  })

  it("returns false when used > cap + burst", () => {
    expect(decideRateLimit(5, 3, 1)).toBe(false)
  })

  it("returns true (fail-open) when used is NaN", () => {
    expect(decideRateLimit(NaN, 3, 1)).toBe(true)
  })

  it("returns true (fail-open) when cap is NaN", () => {
    expect(decideRateLimit(5, NaN, 1)).toBe(true)
  })

  it("returns true (fail-open) when used is Infinity", () => {
    expect(decideRateLimit(Infinity, 3, 1)).toBe(true)
  })
})

// ─── computeResetMs ──────────────────────────────────────────────────────────

describe("computeResetMs", () => {
  it("returns 0 when allowed (used < cap + burst)", () => {
    // used=3, cap=3, burst=1 → 3 < 4 → allowed
    expect(computeResetMs([1000, 2000, 3000], RATE_LIMIT_WINDOW_MS, 3, 3, 1, 5000)).toBe(0)
  })

  it("returns oldest row + window - now when over by 1 (needed = 1)", () => {
    // used=4 (==cap+burst), so decideRateLimit → false; needed=1
    // oldest row at index 0 = 1000; resets at 1000 + RATE_LIMIT_WINDOW_MS
    const now = 5000
    const expected = Math.max(0, 1000 + RATE_LIMIT_WINDOW_MS - now)
    expect(computeResetMs([1000, 2000, 3000, 4000], RATE_LIMIT_WINDOW_MS, 4, 3, 1, now)).toBe(expected)
  })

  it("returns windowMs when the needed row is missing (conservative fallback)", () => {
    // used=4 needs index 0 but windowRowsAscMs is empty
    expect(computeResetMs([], RATE_LIMIT_WINDOW_MS, 4, 3, 1, 5000)).toBe(RATE_LIMIT_WINDOW_MS)
  })

  it("returns 0 (not negative) when the slot already aged out", () => {
    // row at index 0 is far in the past; resetAt < now → Math.max(0, negative) = 0
    const now = RATE_LIMIT_WINDOW_MS + 999_999
    expect(computeResetMs([100], RATE_LIMIT_WINDOW_MS, 4, 3, 1, now)).toBe(0)
  })
})

// ─── formatUsageFooter ───────────────────────────────────────────────────────

describe("formatUsageFooter", () => {
  it("omits the reset clause when resetMs is 0 (under cap)", () => {
    expect(formatUsageFooter(2, 3, 0)).toBe("_Sigilix · 2 of 3 reviews used in past 1h_")
  })

  it("includes the reset clause with ceiled minutes when resetMs > 0", () => {
    // 90_000 ms = 1.5 min → ceil = 2m
    expect(formatUsageFooter(4, 3, 90_000)).toBe("_Sigilix · 4 of 3 reviews used in past 1h · resets in 2m_")
  })

  it("floors the reset minute to 1 even for tiny resetMs", () => {
    // 1 ms → ceil(1/60000) = 1 → floored to max(1, 1) = 1
    expect(formatUsageFooter(4, 3, 1)).toBe("_Sigilix · 4 of 3 reviews used in past 1h · resets in 1m_")
  })

  it("renders exact minute boundaries correctly (60 000 ms = 1m)", () => {
    expect(formatUsageFooter(5, 3, 60_000)).toBe("_Sigilix · 5 of 3 reviews used in past 1h · resets in 1m_")
  })
})
