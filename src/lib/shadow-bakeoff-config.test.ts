// ARC-283 Phase B1b — pin the shadow-bake-off lineup invariants
// (cross-provider fallback, differs-from-prod, role coverage) + the
// `SHADOW_BAKEOFF_ROLES` env parser. Broken shadow lineup gets caught
// here BEFORE the orchestrator wires it up in Task 5.

import { describe, it, expect } from "vitest"

import {
  SHADOW_BAKEOFF_LINEUP,
  parseShadowEnabledRoles,
  resolveShadowConfig,
  type ShadowRole,
} from "@/src/lib/shadow-bakeoff-config"
import { SPECIALIST_CONFIGS, SYNTHESIZER_CONFIG } from "@/src/lib/triage-pr-review-ensemble"

describe("SHADOW_BAKEOFF_LINEUP", () => {
  it("defines a candidate ModelConfig for every shadowable role", () => {
    const roles: ShadowRole[] = ["logic", "security", "performance", "tests", "synth"]
    for (const role of roles) {
      const config = SHADOW_BAKEOFF_LINEUP[role]
      expect(config.primary).toBeTruthy()
      expect(typeof config.retries).toBe("number")
      // fallback may be null but the key must exist.
      expect("fallback" in config).toBe(true)
    }
  })

  it("preserves the cross-provider invariant: primary.family !== fallback.family", () => {
    const familyOf = (model: string): string => {
      // Provider family is everything before the first `-` (deepseek, kimi, glm, qwen, etc).
      const head = model.split(":")[0] ?? ""
      return head.split("-")[0] ?? ""
    }
    for (const [role, config] of Object.entries(SHADOW_BAKEOFF_LINEUP)) {
      if (config.fallback === null) continue
      expect(
        familyOf(config.primary),
        `shadow ${role} primary+fallback are same family`,
      ).not.toBe(familyOf(config.fallback))
    }
  })

  it("uses a unique primary model for each shadow role", () => {
    const primaries = Object.values(SHADOW_BAKEOFF_LINEUP).map((config) => config.primary)
    expect(new Set(primaries).size).toBe(primaries.length)
  })

  it("differs from the production lineup on at least one role (otherwise shadow is pointless)", () => {
    const differs = (a: { primary: string; fallback: string | null }, b: { primary: string; fallback: string | null }) =>
      a.primary !== b.primary || a.fallback !== b.fallback
    const anyDiffers =
      differs(SHADOW_BAKEOFF_LINEUP.logic, SPECIALIST_CONFIGS.logic) ||
      differs(SHADOW_BAKEOFF_LINEUP.security, SPECIALIST_CONFIGS.security) ||
      differs(SHADOW_BAKEOFF_LINEUP.performance, SPECIALIST_CONFIGS.performance) ||
      differs(SHADOW_BAKEOFF_LINEUP.tests, SPECIALIST_CONFIGS.tests) ||
      differs(SHADOW_BAKEOFF_LINEUP.synth, SYNTHESIZER_CONFIG)
    expect(anyDiffers).toBe(true)
  })
})

describe("parseShadowEnabledRoles", () => {
  it("returns empty set when env var unset or empty", () => {
    expect(parseShadowEnabledRoles(undefined)).toEqual(new Set())
    expect(parseShadowEnabledRoles("")).toEqual(new Set())
    expect(parseShadowEnabledRoles("   ")).toEqual(new Set())
  })

  it("parses comma-separated role names case-insensitively, trimming whitespace", () => {
    expect(parseShadowEnabledRoles("synth")).toEqual(new Set(["synth"]))
    expect(parseShadowEnabledRoles("synth,security")).toEqual(new Set(["synth", "security"]))
    expect(parseShadowEnabledRoles(" SYNTH , Security ")).toEqual(new Set(["synth", "security"]))
  })

  it("ignores tokens that are not valid ShadowRoles (no throw on operator typos)", () => {
    expect(parseShadowEnabledRoles("synth,not-a-role,tests")).toEqual(new Set(["synth", "tests"]))
  })
})

describe("resolveShadowConfig", () => {
  it("returns the candidate config when role is in the enabled set", () => {
    expect(resolveShadowConfig("synth", new Set(["synth"]))).toEqual(SHADOW_BAKEOFF_LINEUP.synth)
    expect(resolveShadowConfig("security", new Set(["synth", "security"]))).toEqual(SHADOW_BAKEOFF_LINEUP.security)
  })

  it("returns null when role is NOT enabled", () => {
    expect(resolveShadowConfig("logic", new Set(["synth"]))).toBeNull()
    expect(resolveShadowConfig("synth", new Set())).toBeNull()
  })
})
