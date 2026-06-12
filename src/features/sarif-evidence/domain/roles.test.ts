import { describe, expect, it } from "vitest"
import { rolesForSarifFinding, sarifFindingHasRole } from "@/src/features/sarif-evidence/domain/roles"

describe("SARIF finding role helpers", () => {
  it("uses non-empty roleHints when present", () => {
    const finding = { roleHint: "logic", roleHints: ["logic", "performance"] } as const

    expect(rolesForSarifFinding(finding)).toEqual(["logic", "performance"])
    expect(sarifFindingHasRole(finding, "logic")).toBe(true)
    expect(sarifFindingHasRole(finding, "performance")).toBe(true)
    expect(sarifFindingHasRole(finding, "security")).toBe(false)
  })

  it("falls back to roleHint when roleHints is missing or empty", () => {
    expect(rolesForSarifFinding({ roleHint: "security" })).toEqual(["security"])
    expect(rolesForSarifFinding({ roleHint: "security", roleHints: [] })).toEqual(["security"])
    expect(sarifFindingHasRole({ roleHint: "security", roleHints: [] }, "security")).toBe(true)
  })
})
