import { describe, expect, it } from "vitest"
import {
  emptyAggregate,
  updateAggregate,
  tenantCount,
  isEligible,
  renderFleetInsight,
  FLEET_K,
} from "@/src/shared/domain/fleet-aggregate"
import { type FleetPattern } from "@/src/shared/domain/fleet-pattern"

const SALT = "agg-salt"
const pattern = (over: Partial<FleetPattern> = {}): FleetPattern => ({
  category: "security",
  subType: "sql-injection",
  severity: 5,
  reproduced: false,
  verified: false,
  signature: "security:sql-injection",
  ...over,
})

const withTenants = (n: number, p: FleetPattern = pattern()) => {
  let agg = emptyAggregate(p.signature)
  for (let i = 0; i < n; i++) agg = updateAggregate(agg, p, `tenant-${i}`, SALT)
  return agg
}

describe("fleet-aggregate — k-anonymity gate", () => {
  it("an empty aggregate is not eligible and renders nothing", () => {
    const agg = emptyAggregate("security:sql-injection")
    expect(tenantCount(agg)).toBe(0)
    expect(isEligible(agg)).toBe(false)
    expect(renderFleetInsight(agg)).toBeNull()
  })

  it("stays gated below K distinct tenants", () => {
    const agg = withTenants(FLEET_K - 1)
    expect(isEligible(agg)).toBe(false)
    expect(renderFleetInsight(agg)).toBeNull()
  })

  it("surfaces once ≥ K distinct tenants contribute", () => {
    const agg = withTenants(FLEET_K)
    expect(isEligible(agg)).toBe(true)
    const insight = renderFleetInsight(agg)!
    expect(insight).toContain("security:sql-injection")
    expect(insight).toContain(`~${FLEET_K} teams`)
  })

  it("the same tenant contributing repeatedly does NOT cross the gate (distinct, not volume)", () => {
    let agg = emptyAggregate("security:sql-injection")
    for (let i = 0; i < 20; i++) agg = updateAggregate(agg, pattern(), "one-noisy-tenant", SALT)
    expect(agg.occurrences).toBe(20)
    expect(tenantCount(agg)).toBe(1)
    expect(isEligible(agg)).toBe(false) // 20 occurrences from 1 codebase ≠ a fleet pattern
  })
})

describe("fleet-aggregate — stats + privacy", () => {
  it("accumulates occurrences / reproduced / verified / maxSeverity", () => {
    let agg = emptyAggregate("logic:off-by-one")
    agg = updateAggregate(agg, pattern({ signature: "logic:off-by-one", severity: 3, reproduced: true }), "a", SALT)
    agg = updateAggregate(agg, pattern({ signature: "logic:off-by-one", severity: 5, verified: true }), "b", SALT)
    expect(agg).toMatchObject({ occurrences: 2, reproduced: 1, verified: 1, maxSeverity: 5 })
  })

  it("renders reproduced + verified counts when present", () => {
    let agg = emptyAggregate("security:sql-injection")
    for (let i = 0; i < FLEET_K; i++) {
      agg = updateAggregate(agg, pattern({ reproduced: true, verified: i < 2 }), `t-${i}`, SALT)
    }
    const insight = renderFleetInsight(agg)!
    expect(insight).toContain("reproduced by execution")
    expect(insight).toContain("verified fix exists in 2")
  })

  it("never stores tenant identity (count attribution only)", () => {
    const agg = withTenants(FLEET_K)
    const json = JSON.stringify(agg)
    for (let i = 0; i < FLEET_K; i++) expect(json).not.toContain(`tenant-${i}`)
    expect(renderFleetInsight(agg)).not.toMatch(/tenant-\d/)
  })
})
