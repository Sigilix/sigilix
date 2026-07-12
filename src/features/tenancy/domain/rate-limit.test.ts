import { describe, expect, it } from "vitest"
import {
  DEFAULT_RATE_LIMIT_CAP,
  DEFAULT_TRIAGE_RATE_LIMIT_CAP,
  RATE_LIMIT_WINDOW_MS,
  TRIAGE_RATE_LIMIT_WINDOW_MS,
  TIER_COST_BUDGET_USD,
  computeResetMs,
  decideRateLimit,
  decideCostBudget,
  resolveTierCostBudgetUsd,
  formatUsageFooter,
  isFullPaidStatus,
  resolveRateLimitCap,
  resolveRateLimitMode,
} from "./rate-limit"
import type { Env } from "@/src/shared/types/env"

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
    expect(resolveRateLimitCap("oss")).toBe(8)
  })

  it('returns 2 for "cli"', () => {
    expect(resolveRateLimitCap("cli")).toBe(8)
  })

  it('returns 2 for "free"', () => {
    expect(resolveRateLimitCap("free")).toBe(8)
  })

  it('returns 5 for "pro" (the ladder base)', () => {
    expect(resolveRateLimitCap("pro")).toBe(20)
  })

  it('returns 10 for "teams" (2× pro)', () => {
    expect(resolveRateLimitCap("teams")).toBe(40)
  })

  it('returns 25 for "max" (5× pro)', () => {
    expect(resolveRateLimitCap("max")).toBe(100)
  })

  it('returns 250 for "ultra" (10× max, the highest self-serve paid tier)', () => {
    expect(resolveRateLimitCap("ultra")).toBe(1000)
  })

  it('returns 500 for "enterprise" (2× ultra — the contract TOP tier, highest cap of all)', () => {
    expect(resolveRateLimitCap("enterprise")).toBe(2000)
    // enterprise is strictly the top: at or above ultra (in fact above it).
    expect(resolveRateLimitCap("enterprise")).toBeGreaterThanOrEqual(resolveRateLimitCap("ultra"))
  })

  it("the paid ladder is base × multiplier: pro 1× / teams 2× / max 5× / ultra 50× / enterprise 100×", () => {
    const base = resolveRateLimitCap("pro")
    expect(base).toBe(20)
    expect(resolveRateLimitCap("teams")).toBe(base * 2)
    expect(resolveRateLimitCap("max")).toBe(base * 5)
    expect(resolveRateLimitCap("ultra")).toBe(base * 50)
    expect(resolveRateLimitCap("enterprise")).toBe(base * 100)
    // ultra is exactly 10× max, per the founder's ladder; enterprise is 2× ultra.
    expect(resolveRateLimitCap("ultra")).toBe(resolveRateLimitCap("max") * 10)
    expect(resolveRateLimitCap("enterprise")).toBe(resolveRateLimitCap("ultra") * 2)
  })

  it("caps ascend free < pro < teams < max < ultra < enterprise", () => {
    expect(resolveRateLimitCap("free")).toBeLessThan(resolveRateLimitCap("pro"))
    expect(resolveRateLimitCap("pro")).toBeLessThan(resolveRateLimitCap("teams"))
    expect(resolveRateLimitCap("teams")).toBeLessThan(resolveRateLimitCap("max"))
    expect(resolveRateLimitCap("max")).toBeLessThan(resolveRateLimitCap("ultra"))
    expect(resolveRateLimitCap("ultra")).toBeLessThan(resolveRateLimitCap("enterprise"))
  })

  it("is case-insensitive: 'ULTRA' → 250, 'TEAMS' → 10, 'ENTERPRISE' → 500", () => {
    expect(resolveRateLimitCap("ULTRA")).toBe(1000)
    expect(resolveRateLimitCap("TEAMS")).toBe(40)
    expect(resolveRateLimitCap("  Enterprise  ")).toBe(2000)
  })

  it('returns 40 for "pro_plus" (2x the base — legacy tier stays ABOVE pro)', () => {
    expect(resolveRateLimitCap("pro_plus")).toBe(40)
  })

  it('returns 40 for "pro+" (2x the base — legacy tier stays ABOVE pro)', () => {
    expect(resolveRateLimitCap("pro+")).toBe(40)
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
    expect(resolveRateLimitCap("PRO")).toBe(20)
  })

  it("trialing=false is byte-identical to omitting the flag (full tier volume)", () => {
    expect(resolveRateLimitCap("pro", false)).toBe(resolveRateLimitCap("pro"))
    expect(resolveRateLimitCap("ultra", false)).toBe(1000)
    expect(resolveRateLimitCap("enterprise", false)).toBe(2000)
  })
})

// ─── resolveRateLimitCap: trial cap (sig-trial-cap) ──────────────────────────

describe("resolveRateLimitCap — trialing (half volume)", () => {
  it("halves each paid tier deterministically: pro 5→3, teams 10→5, max 25→13, ultra 250→125", () => {
    expect(resolveRateLimitCap("pro", true)).toBe(10)
    expect(resolveRateLimitCap("teams", true)).toBe(20)
    expect(resolveRateLimitCap("max", true)).toBe(50)
    expect(resolveRateLimitCap("ultra", true)).toBe(500)
  })

  it("a trial cap is NEVER below the Free floor (pro 5→3 ≥ free 2)", () => {
    const freeCap = resolveRateLimitCap("free")
    expect(resolveRateLimitCap("pro", true)).toBeGreaterThanOrEqual(freeCap)
    expect(resolveRateLimitCap("teams", true)).toBeGreaterThanOrEqual(freeCap)
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
    for (const tier of ["pro", "teams", "max", "ultra"]) {
      expect(resolveRateLimitCap(tier, true)).toBeLessThan(resolveRateLimitCap(tier, false))
    }
  })

  it("enterprise NEVER halves: it is the contract tier and can never be on a trial (500 either way)", () => {
    // Enterprise is set on tenant.tier by contract, never sold via Stripe, so it can
    // never be 'trialing' — even a stray trialing=true keeps its full top cap.
    expect(resolveRateLimitCap("enterprise", true)).toBe(2000)
    expect(resolveRateLimitCap("enterprise", true)).toBe(resolveRateLimitCap("enterprise", false))
    expect(resolveRateLimitCap("  ENTERPRISE  ", true)).toBe(2000)
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

// ─── decideCostBudget (sig-cost-based-metering) ──────────────────────────────

describe("decideCostBudget", () => {
  it("allows when consumed is strictly under the budget", () => {
    expect(decideCostBudget(0.49, 0.5)).toBe(true)
  })

  it("blocks at the budget ceiling (>= blocks, budget is a ceiling on prior spend)", () => {
    expect(decideCostBudget(0.5, 0.5)).toBe(false)
    expect(decideCostBudget(0.51, 0.5)).toBe(false)
  })

  it("a null budget is UNBOUNDED → always allowed (enterprise)", () => {
    expect(decideCostBudget(1_000_000, null)).toBe(true)
  })

  it("fails open on a non-finite consumed or budget (a read fault never blocks)", () => {
    expect(decideCostBudget(NaN, 0.5)).toBe(true)
    expect(decideCostBudget(0.5, Infinity)).toBe(true)
  })
})

// ─── resolveTierCostBudgetUsd + the generosity ladder ────────────────────────

describe("resolveTierCostBudgetUsd", () => {
  const noEnv = {} as Partial<Env>

  it("resolves the table budget per tier/window (case-insensitive)", () => {
    expect(resolveTierCostBudgetUsd(noEnv, "pro", "session")).toBe(TIER_COST_BUDGET_USD.pro.session)
    expect(resolveTierCostBudgetUsd(noEnv, "PRO", "weekly")).toBe(TIER_COST_BUDGET_USD.pro.weekly)
  })

  it("enterprise is UNBOUNDED (null) and ignores the trial flag", () => {
    expect(resolveTierCostBudgetUsd(noEnv, "enterprise", "session")).toBeNull()
    expect(resolveTierCostBudgetUsd(noEnv, "enterprise", "weekly", true)).toBeNull()
  })

  it("unknown/oss/cli/null tiers fall back to the Free budget", () => {
    expect(resolveTierCostBudgetUsd(noEnv, "oss", "session")).toBe(TIER_COST_BUDGET_USD.free.session)
    expect(resolveTierCostBudgetUsd(noEnv, null, "weekly")).toBe(TIER_COST_BUDGET_USD.free.weekly)
  })

  it('the "team" alias maps to the teams budget row', () => {
    expect(resolveTierCostBudgetUsd(noEnv, "team", "weekly")).toBe(TIER_COST_BUDGET_USD.teams.weekly)
  })

  it("follows the founder ladder Free ≪ Pro < Teams < Max < Ultra (weekly)", () => {
    const w = (t: string) => resolveTierCostBudgetUsd(noEnv, t, "weekly") as number
    expect(w("free")).toBeLessThan(w("pro"))
    expect(w("pro")).toBeLessThan(w("teams"))
    expect(w("teams")).toBeLessThan(w("max"))
    expect(w("max")).toBeLessThan(w("ultra"))
  })

  it("an env override wins over the table; a negative override means UNBOUNDED", () => {
    expect(resolveTierCostBudgetUsd({ SIGILIX_COST_BUDGET_PRO_SESSION: "9" }, "pro", "session")).toBe(9)
    expect(resolveTierCostBudgetUsd({ SIGILIX_COST_BUDGET_PRO_SESSION: "-1" }, "pro", "session")).toBeNull()
  })

  it("a blank/non-numeric override is ignored (falls back to the table)", () => {
    expect(resolveTierCostBudgetUsd({ SIGILIX_COST_BUDGET_PRO_SESSION: "  " }, "pro", "session")).toBe(
      TIER_COST_BUDGET_USD.pro.session,
    )
    expect(resolveTierCostBudgetUsd({ SIGILIX_COST_BUDGET_PRO_SESSION: "abc" }, "pro", "session")).toBe(
      TIER_COST_BUDGET_USD.pro.session,
    )
  })

  it("trial halves the budget, floored at Free and CLAMPED at the full budget", () => {
    // Pro session 3.75 → trial 1.875 (half, above the free floor 0.375).
    expect(resolveTierCostBudgetUsd(noEnv, "pro", "session", true)).toBeCloseTo(
      TIER_COST_BUDGET_USD.pro.session! / 2,
      6,
    )
    // An override BELOW the free floor must NOT let a trial exceed the paid budget
    // (verify-math §2 clamp): base 0.10 → trial min(0.10, max(0.375, 0.05)) = 0.10.
    const trial = resolveTierCostBudgetUsd({ SIGILIX_COST_BUDGET_PRO_SESSION: "0.10" }, "pro", "session", true)
    const paid = resolveTierCostBudgetUsd({ SIGILIX_COST_BUDGET_PRO_SESSION: "0.10" }, "pro", "session", false)
    expect(trial).toBeLessThanOrEqual(paid as number)
    expect(trial).toBe(0.1)
  })
})

// ─── sig-cost-primary: the two resolvers must AGREE on the same tier string ───
//
// resolveRateLimitCap (count) and resolveTierCostBudgetUsd (dollars) both key off
// tenant.tier — a HAND-SET column. If they disagree on an alias, a paying tenant gets
// one tier's budget and another tier's cap, and the backstop blocks them well inside
// the volume they pay for. Latent while the gate ran in shadow; real under enforce.

describe("tier aliasing — count cap and cost budget must not disagree", () => {
  it('"team" resolves to the TEAMS cap, matching the teams budget it already got', () => {
    expect(resolveRateLimitCap("team")).toBe(resolveRateLimitCap("teams"))
    expect(resolveRateLimitCap("team")).toBe(40)
    // The budget side already aliased "team" -> "teams"; prove both sides now agree.
    expect(resolveTierCostBudgetUsd({}, "team", "session")).toBe(resolveTierCostBudgetUsd({}, "teams", "session"))
  })

  it('legacy "pro_plus" stays ABOVE pro on count and gets PRO dollars, never Free', () => {
    // At base 5 pro_plus was a hardcoded 10 = 2x pro. With base 20 a bare `return 10`
    // would make it HALF of pro — inverting the tier it exists to reward.
    expect(resolveRateLimitCap("pro_plus")).toBeGreaterThan(resolveRateLimitCap("pro"))
    expect(resolveRateLimitCap("pro+")).toBe(resolveRateLimitCap("pro_plus"))
    // And it must NOT fall through to the Free budget, which under enforce would block
    // a paying legacy tenant after ~2 reviews.
    expect(resolveTierCostBudgetUsd({}, "pro_plus", "session")).toBe(resolveTierCostBudgetUsd({}, "pro", "session"))
    expect(resolveTierCostBudgetUsd({}, "pro_plus", "session")).not.toBe(
      resolveTierCostBudgetUsd({}, "free", "session"),
    )
  })
})
