// SIG-382 PR-c1: locks the SpecialistRole / ALL_SPECIALISTS extraction to the
// shared/domain leaf + the ensemble-router re-export. Fails if the extraction is
// reverted (the shared module wouldn't resolve) or if ensemble-router stops
// re-exporting the same binding (which would silently fork the role set).
import { describe, it, expect } from "vitest"
import { ALL_SPECIALISTS } from "@/shared/domain/specialist-role"
import { ALL_SPECIALISTS as ROUTER_ALL_SPECIALISTS } from "@/lib/ensemble-router"

describe("SpecialistRole relocation (SIG-382)", () => {
  it("lives in shared/domain with the canonical role set", () => {
    expect(ALL_SPECIALISTS).toEqual(["logic", "security", "performance", "tests"])
  })

  it("ensemble-router re-exports the SAME shared binding (not a fork)", () => {
    expect(ROUTER_ALL_SPECIALISTS).toBe(ALL_SPECIALISTS)
  })
})
