// sig-training-data-consent — plan-based DEFAULT consent resolver (fail-closed).
import { describe, expect, it } from "vitest"
import {
  normalizePlan,
  OPT_OUT_PLANS,
  resolveDefaultConsent,
} from "@/src/features/training-consent/domain/plan-default"

describe("resolveDefaultConsent — plan-based default (opt-out allowlist)", () => {
  it("GRANTS (opt-out) for the self-serve / individual plans (free included)", () => {
    for (const plan of ["free", "individual", "pro", "max", "ultra"]) {
      expect(resolveDefaultConsent(plan)).toBe("granted")
    }
  })

  it("is case/whitespace-insensitive on the allowlist", () => {
    expect(resolveDefaultConsent("  PRO ")).toBe("granted")
    expect(resolveDefaultConsent("Individual")).toBe("granted")
    expect(resolveDefaultConsent(" FREE ")).toBe("granted")
  })

  it("DENIES (opt-in) for team and enterprise", () => {
    expect(resolveDefaultConsent("team")).toBe("denied")
    expect(resolveDefaultConsent("enterprise")).toBe("denied")
  })

  it("fail-closed: DENIES for unknown / unset / blank / typo / default", () => {
    for (const plan of ["default", "oss", "cli", "enterprisex", "", "   "]) {
      expect(resolveDefaultConsent(plan)).toBe("denied")
    }
    expect(resolveDefaultConsent(null)).toBe("denied")
    expect(resolveDefaultConsent(undefined)).toBe("denied")
  })

  it("the allowlist never contains a team/enterprise plan", () => {
    expect(OPT_OUT_PLANS.has("team")).toBe(false)
    expect(OPT_OUT_PLANS.has("enterprise")).toBe(false)
  })

  it("the allowlist DOES contain free (individual default-on tier)", () => {
    expect(OPT_OUT_PLANS.has("free")).toBe(true)
  })

  it("normalizePlan lowercases + trims, maps nullish to empty", () => {
    expect(normalizePlan(" PRO ")).toBe("pro")
    expect(normalizePlan(null)).toBe("")
    expect(normalizePlan(undefined)).toBe("")
  })
})
