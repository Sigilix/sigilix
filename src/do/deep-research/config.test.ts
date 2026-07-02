import { describe, it, expect } from "vitest"
import { resolveResearchConfig, parseTier, parseEffort, TIER_MODELS } from "./config"
import type { Env } from "@/src/shared/types/env"

function env(over: Partial<Env> = {}): Env {
  return over as unknown as Env
}

describe("tier → heavy-role model mapping (addendum §1)", () => {
  it("astraeus routes heavy roles to the astraeus model, classify/extract stay on boreas", () => {
    const cfg = resolveResearchConfig(env(), { model: "astraeus" })
    expect(cfg.tier).toBe("astraeus")
    for (const role of ["planner", "synthesis", "stopCheck", "finalReport"] as const) {
      expect(cfg.models[role]).toBe(TIER_MODELS.astraeus)
    }
    expect(cfg.models.classify).toBe(TIER_MODELS.boreas)
    expect(cfg.models.extract).toBe(TIER_MODELS.boreas)
  })

  it("pyroeis routes heavy roles to the mid-tier, classify/extract stay on boreas", () => {
    const cfg = resolveResearchConfig(env(), { model: "pyroeis" })
    expect(cfg.models.planner).toBe(TIER_MODELS.pyroeis)
    expect(cfg.models.finalReport).toBe(TIER_MODELS.pyroeis)
    expect(cfg.models.classify).toBe(TIER_MODELS.boreas)
  })

  it("boreas puts EVERY role on boreas", () => {
    const cfg = resolveResearchConfig(env(), { model: "boreas" })
    for (const role of ["planner", "synthesis", "stopCheck", "finalReport", "classify", "extract"] as const) {
      expect(cfg.models[role]).toBe(TIER_MODELS.boreas)
    }
  })

  it("defaults to astraeus when no model is given", () => {
    expect(resolveResearchConfig(env()).tier).toBe("astraeus")
  })

  it("a per-role env override wins over the tier default", () => {
    const cfg = resolveResearchConfig(env({ OPENCLAW_RESEARCH_PLANNER_MODEL: "custom/model" }), { model: "astraeus" })
    expect(cfg.models.planner).toBe("custom/model")
    // Other heavy roles still use the tier default.
    expect(cfg.models.synthesis).toBe(TIER_MODELS.astraeus)
  })
})

describe("effort → budget presets (addendum §2)", () => {
  it("low", () => {
    const c = resolveResearchConfig(env(), { effort: "low" })
    expect([c.maxRounds, c.maxQueriesPerRound, c.maxPagesPerRound, c.maxTimeMs]).toEqual([3, 2, 3, 120_000])
  })
  it("medium (default = original quad)", () => {
    const c = resolveResearchConfig(env(), { effort: "medium" })
    expect([c.maxRounds, c.maxQueriesPerRound, c.maxPagesPerRound, c.maxTimeMs]).toEqual([8, 4, 5, 300_000])
    expect(resolveResearchConfig(env()).maxRounds).toBe(8) // default effort is medium
  })
  it("high", () => {
    const c = resolveResearchConfig(env(), { effort: "high" })
    expect([c.maxRounds, c.maxQueriesPerRound, c.maxPagesPerRound, c.maxTimeMs]).toEqual([12, 5, 6, 480_000])
  })

  it("minRounds (2) and the empty-round kill (2) apply at EVERY effort", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const c = resolveResearchConfig(env(), { effort })
      expect(c.minRounds).toBe(2)
      expect(c.maxEmptyRounds).toBe(2)
    }
  })

  it("an explicit env cap wins over the effort preset", () => {
    // high preset would be 12 rounds; an env cap of 4 must win.
    const c = resolveResearchConfig(env({ OPENCLAW_RESEARCH_MAX_ROUNDS: "4" }), { effort: "high" })
    expect(c.maxRounds).toBe(4)
    // Non-overridden knobs keep the high preset.
    expect(c.maxTimeMs).toBe(480_000)
  })
})

describe("validators", () => {
  it("parseTier accepts the three tiers, rejects everything else", () => {
    expect(parseTier("boreas")).toBe("boreas")
    expect(parseTier("pyroeis")).toBe("pyroeis")
    expect(parseTier("astraeus")).toBe("astraeus")
    expect(parseTier("gpt-4")).toBeNull()
    expect(parseTier("")).toBeNull()
    expect(parseTier(undefined)).toBeNull()
    expect(parseTier(3)).toBeNull()
  })

  it("parseEffort accepts the three levels, rejects everything else", () => {
    expect(parseEffort("low")).toBe("low")
    expect(parseEffort("medium")).toBe("medium")
    expect(parseEffort("high")).toBe("high")
    expect(parseEffort("extreme")).toBeNull()
    expect(parseEffort(null)).toBeNull()
  })
})
