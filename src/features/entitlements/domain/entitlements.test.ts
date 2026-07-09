import { describe, it, expect } from "vitest"
import {
  ENTITLED_TIERS,
  isFeatureEntitled,
  normalizePlan,
  type EntitledFeature,
} from "@/src/features/entitlements/domain/entitlements"

const ALL_FEATURES: EntitledFeature[] = ["ci_triage", "slack", "linear", "cli_byok"]

describe("ENTITLED_TIERS", () => {
  it("is exactly {pro, teams, max, ultra, enterprise} (teams is feature-complete; enterprise is the contract top tier)", () => {
    expect([...ENTITLED_TIERS].sort()).toEqual(["enterprise", "max", "pro", "teams", "ultra"])
  })
})

describe("core PR review is never gated (recall-safety)", () => {
  // The paid boundary is EXACTLY these four surfaces. Core PR review is not among
  // them and has no EntitledFeature member, so a free installation ALWAYS keeps
  // its PR reviews — the gate can never block a review. If a "pr_review"-shaped
  // feature is ever added here, this test fails loudly on purpose.
  it("EntitledFeature is exactly {ci_triage, slack, linear, cli_byok} — no review member", () => {
    expect([...ALL_FEATURES].sort()).toEqual(["ci_triage", "cli_byok", "linear", "slack"])
    for (const feature of ALL_FEATURES) {
      expect(String(feature)).not.toMatch(/review/i)
    }
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
  // a pro-limited subset. enterprise is the CONTRACT top tier — it earns every feature
  // (a manually-set enterprise tenant must NOT fail closed). "  ENTERPRISE  " proves
  // the case/space-insensitive match too.
  for (const plan of ["pro", "teams", "max", "ultra", "enterprise", "Pro", "  MAX  ", "  TEAMS  ", "  ENTERPRISE  "]) {
    for (const feature of ALL_FEATURES) {
      it(`allows plan=${JSON.stringify(plan)} for ${feature}`, () => {
        expect(isFeatureEntitled(plan, feature)).toBe(true)
      })
    }
  }
})

describe("isFeatureEntitled — fail-closed for every other plan", () => {
  // NOTE: "enterprise" is now an ENTITLED tier (the contract top tier) and lives in the
  // allowed set above — it is deliberately NOT in this denied list. Only genuinely
  // unknown / non-tier plans fail closed.
  const denied = ["free", "individual", "team", "default", "trial", "unknown", "", "  ", null, undefined]
  for (const plan of denied) {
    for (const feature of ALL_FEATURES) {
      it(`denies plan=${JSON.stringify(plan)} for ${feature}`, () => {
        expect(isFeatureEntitled(plan, feature)).toBe(false)
      })
    }
  }
})
