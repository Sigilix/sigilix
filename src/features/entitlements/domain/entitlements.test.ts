import { describe, it, expect } from "vitest"
import {
  ENTITLED_TIERS,
  isFeatureEntitled,
  normalizePlan,
  type EntitledFeature,
} from "@/src/features/entitlements/domain/entitlements"

const ALL_FEATURES: EntitledFeature[] = ["ci_triage", "slack", "linear", "cli_byok"]

describe("ENTITLED_TIERS", () => {
  it("is exactly {pro, teams, max, ultra} (teams is feature-complete, like the top tier)", () => {
    expect([...ENTITLED_TIERS].sort()).toEqual(["max", "pro", "teams", "ultra"])
  })
})

describe("normalizePlan", () => {
  it("lowercases and trims", () => {
    expect(normalizePlan("  Pro ")).toBe("pro")
    expect(normalizePlan("ULTRA")).toBe("ultra")
  })
  it("maps null/undefined/blank to empty string", () => {
    expect(normalizePlan(null)).toBe("")
    expect(normalizePlan(undefined)).toBe("")
    expect(normalizePlan("   ")).toBe("")
  })
})

describe("isFeatureEntitled — entitled tiers", () => {
  // teams is FEATURE-COMPLETE: it gets ALL entitled features like the top tier, not
  // a pro-limited subset. "  TEAMS  " proves the case/space-insensitive match too.
  for (const plan of ["pro", "teams", "max", "ultra", "Pro", "  MAX  ", "  TEAMS  "]) {
    for (const feature of ALL_FEATURES) {
      it(`allows plan=${JSON.stringify(plan)} for ${feature}`, () => {
        expect(isFeatureEntitled(plan, feature)).toBe(true)
      })
    }
  }
})

describe("isFeatureEntitled — fail-closed for every other plan", () => {
  const denied = ["free", "individual", "team", "enterprise", "default", "trial", "unknown", "", "  ", null, undefined]
  for (const plan of denied) {
    for (const feature of ALL_FEATURES) {
      it(`denies plan=${JSON.stringify(plan)} for ${feature}`, () => {
        expect(isFeatureEntitled(plan, feature)).toBe(false)
      })
    }
  }
})
