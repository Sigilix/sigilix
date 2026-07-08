import { describe, expect, it } from "vitest"
import {
  DEFAULT_RATE_LIMIT_CAP,
  DEFAULT_TRIAGE_RATE_LIMIT_CAP,
  RATE_LIMIT_WINDOW_MS,
  TRIAGE_RATE_LIMIT_WINDOW_MS,
  computeResetMs,
  decideRateLimit,
  formatUsageFooter,
  isFullPaidStatus,
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
  it('returns 2 for "oss"', () => {
    expect(resolveRateLimitCap("oss")).toBe(2)
  })

  it('returns 2 for "cli"', () => {
    expect(resolveRateLimitCap("cli")).toBe(2)
  })

  it('returns 2 for "free"', () => {
    expect(resolveRateLimitCap("free")).toBe(2)
  })

  it('returns 5 for "pro"', () => {
    expect(resolveRateLimitCap("pro")).toBe(5)
  })

  it('returns 10 for "max"', () => {
    expect(resolveRateLimitCap("max")).toBe(10)
  })

  it('returns 20 for "ultra" (the highest paid consumer tier)', () => {
    expect(resolveRateLimitCap("ultra")).toBe(20)
  })

  it("caps ascend free < pro < max < ultra", () => {
    expect(resolveRateLimitCap("free")).toBeLessThan(resolveRateLimitCap("pro"))
    expect(resolveRateLimitCap("pro")).toBeLessThan(resolveRateLimitCap("max"))
    expect(resolveRateLimitCap("max")).toBeLessThan(resolveRateLimitCap("ultra"))
  })

  it("is case-insensitive: 'ULTRA' → 20", () => {
    expect(resolveRateLimitCap("ULTRA")).toBe(20)
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

  it("trialing=false is byte-identical to omitting the flag (full tier volume)", () => {
    expect(resolveRateLimitCap("pro", false)).toBe(resolveRateLimitCap("pro"))
    expect(resolveRateLimitCap("ultra", false)).toBe(20)
  })
})

// ─── resolveRateLimitCap: trial cap (sig-trial-cap) ──────────────────────────

describe("resolveRateLimitCap — trialing (half volume)", () => {
  it("halves each paid tier deterministically: pro 5→3, max 10→5, ultra 20→10", () => {
    expect(resolveRateLimitCap("pro", true)).toBe(3)
    expect(resolveRateLimitCap("max", true)).toBe(5)
    expect(resolveRateLimitCap("ultra", true)).toBe(10)
  })

  it("a trial cap is NEVER below the Free floor (pro 5→3 ≥ free 2)", () => {
    const freeCap = resolveRateLimitCap("free")
    expect(resolveRateLimitCap("pro", true)).toBeGreaterThanOrEqual(freeCap)
    expect(resolveRateLimitCap("max", true)).toBeGreaterThanOrEqual(freeCap)
    expect(resolveRateLimitCap("ultra", true)).toBeGreaterThanOrEqual(freeCap)
  })

  it("free stays at the floor when trialing (2→2, never below)", () => {
    expect(resolveRateLimitCap("free", true)).toBe(DEFAULT_RATE_LIMIT_CAP)
  })

  it("an unknown/null tier trialing floors at DEFAULT_RATE_LIMIT_CAP (never 0/negative)", () => {
    expect(resolveRateLimitCap(null, true)).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(resolveRateLimitCap("unknown_tier", true)).toBe(DEFAULT_RATE_LIMIT_CAP)
  })

  it("a trial cap is always < the full paid cap for that tier (halving is real)", () => {
    for (const tier of ["pro", "max", "ultra"]) {
      expect(resolveRateLimitCap(tier, true)).toBeLessThan(resolveRateLimitCap(tier, false))
    }
  })
})

// ─── isFullPaidStatus (sig-trial-cap) ────────────────────────────────────────

describe("isFullPaidStatus", () => {
  it("returns true ONLY for 'active' (case/space-insensitive)", () => {
    expect(isFullPaidStatus("active")).toBe(true)
    expect(isFullPaidStatus("  ACTIVE ")).toBe(true)
  })

  it("returns false for 'trialing' → trial (half volume)", () => {
    expect(isFullPaidStatus("trialing")).toBe(false)
  })

  it("FAIL-SAFE RESTRICTIVE: null/undefined/blank/unknown are NOT full-paid", () => {
    expect(isFullPaidStatus(null)).toBe(false)
    expect(isFullPaidStatus(undefined)).toBe(false)
    expect(isFullPaidStatus("")).toBe(false)
    expect(isFullPaidStatus("   ")).toBe(false)
    expect(isFullPaidStatus("past_due")).toBe(false)
    expect(isFullPaidStatus("canceled")).toBe(false)
    expect(isFullPaidStatus("whatever")).toBe(false)
  })
})

// ─── decideRateLimit ─────────────────────────────────────────────────────────

describe("decideRateLimit", () => {
  it("returns true when used < cap + burst", () => {
    // cap=3, burst=0 → allowed while used < 3
    expect(decideRateLimit(0, 3, 0)).toBe(true)
    expect(decideRateLimit(2, 3, 0)).toBe(true)
  })

  it("returns false when used == cap + burst", () => {
    // cap=3, burst=0 → blocked at used=3
    expect(decideRateLimit(3, 3, 0)).toBe(false)
  })

  it("returns false when used > cap + burst", () => {
    expect(decideRateLimit(4, 3, 0)).toBe(false)
  })

  it("returns true (fail-open) when used is NaN", () => {
    expect(decideRateLimit(NaN, 3, 0)).toBe(true)
  })

  it("returns true (fail-open) when cap is NaN", () => {
    expect(decideRateLimit(5, NaN, 0)).toBe(true)
  })

  it("returns true (fail-open) when used is Infinity", () => {
    expect(decideRateLimit(Infinity, 3, 0)).toBe(true)
  })
})

// ─── computeResetMs ──────────────────────────────────────────────────────────

describe("computeResetMs", () => {
  it("returns 0 when allowed (used < cap + burst)", () => {
    // used=2, cap=3, burst=0 → 2 < 3 → allowed
    expect(computeResetMs([1000, 2000], RATE_LIMIT_WINDOW_MS, 2, 3, 0, 5000)).toBe(0)
  })

  it("returns oldest row + window - now when over by 1 (needed = 1)", () => {
    // used=3 (==cap+burst=3+0), so decideRateLimit → false; needed=1
    // oldest row at index 0 = 1000; resets at 1000 + RATE_LIMIT_WINDOW_MS
    const now = 5000
    const expected = Math.max(0, 1000 + RATE_LIMIT_WINDOW_MS - now)
    expect(computeResetMs([1000, 2000, 3000], RATE_LIMIT_WINDOW_MS, 3, 3, 0, now)).toBe(expected)
  })

  it("returns windowMs when the needed row is missing (conservative fallback)", () => {
    // used=3 needs index 0 but windowRowsAscMs is empty
    expect(computeResetMs([], RATE_LIMIT_WINDOW_MS, 3, 3, 0, 5000)).toBe(RATE_LIMIT_WINDOW_MS)
  })

  it("returns 0 (not negative) when the slot already aged out", () => {
    // row at index 0 is far in the past; resetAt < now → Math.max(0, negative) = 0
    const now = RATE_LIMIT_WINDOW_MS + 999_999
    expect(computeResetMs([100], RATE_LIMIT_WINDOW_MS, 3, 3, 0, now)).toBe(0)
  })
})

// ─── formatUsageFooter ───────────────────────────────────────────────────────

describe("formatUsageFooter", () => {
  it("omits the reset clause when resetMs is 0 (under cap)", () => {
    expect(formatUsageFooter(2, 3, 0)).toBe("_Sigilix · 2 of 3 reviews used in past 5h_")
  })

  it("includes the reset clause with ceiled minutes when resetMs > 0", () => {
    // 90_000 ms = 1.5 min → ceil = 2m
    expect(formatUsageFooter(4, 3, 90_000)).toBe("_Sigilix · 4 of 3 reviews used in past 5h · resets in 2m_")
  })

  it("floors the reset minute to 1 even for tiny resetMs", () => {
    // 1 ms → ceil(1/60000) = 1 → floored to max(1, 1) = 1
    expect(formatUsageFooter(4, 3, 1)).toBe("_Sigilix · 4 of 3 reviews used in past 5h · resets in 1m_")
  })

  it("renders exact minute boundaries correctly (60 000 ms = 1m)", () => {
    expect(formatUsageFooter(5, 3, 60_000)).toBe("_Sigilix · 5 of 3 reviews used in past 5h · resets in 1m_")
  })
})

// ─── Linear-triage window/cap constants (SIG-38 free-launch caps) ───────────

describe("triage rate-limit constants", () => {
  it("TRIAGE_RATE_LIMIT_WINDOW_MS is a 5-hour window", () => {
    expect(TRIAGE_RATE_LIMIT_WINDOW_MS).toBe(5 * 60 * 60 * 1000)
  })

  it("DEFAULT_TRIAGE_RATE_LIMIT_CAP is 3 (upper end of the 2-3 free-tier range)", () => {
    expect(DEFAULT_TRIAGE_RATE_LIMIT_CAP).toBe(3)
  })

  it("both PR-review and Linear-triage windows equal 5h today", () => {
    // Note: this only confirms the CURRENT values match, not that the two
    // constants are independent bindings — a runtime equality check can't
    // distinguish "two separate `export const`s that happen to be equal"
    // from "one aliased to the other". That independence is a source-level
    // property (see rate-limit.ts: two separate `export const` statements,
    // each retunable without touching the other) verified by reading the
    // source, not by this test.
    expect(RATE_LIMIT_WINDOW_MS).toBe(5 * 60 * 60 * 1000)
    expect(TRIAGE_RATE_LIMIT_WINDOW_MS).toBe(5 * 60 * 60 * 1000)
  })
})
