// sig-metrics-dashboard — pure aggregation unit tests.

import { describe, expect, it } from "vitest"
import {
  aggregateReviewComments,
  avgReviewIterationsPerPr,
  reviewerTimeSavedHours,
  roleToCategory,
  scoreToSeverity,
  bandToolFindings,
  toolFindingKind,
  MIN_PER_COMMENT,
  type PostedFinding,
} from "@/src/lib/metrics-dashboard/aggregate"

describe("scoreToSeverity", () => {
  it("bands scores to the four tiers", () => {
    expect(scoreToSeverity(5)).toBe("critical")
    expect(scoreToSeverity(4)).toBe("major")
    expect(scoreToSeverity(3)).toBe("minor")
    expect(scoreToSeverity(2)).toBe("trivial")
    expect(scoreToSeverity(0)).toBe("trivial")
    expect(scoreToSeverity(6)).toBe("critical") // clamps upward
  })
})

describe("roleToCategory", () => {
  it("maps only real specialist roles; drops unknown", () => {
    expect(roleToCategory("logic")).toBe("functionalCorrectness")
    expect(roleToCategory("security")).toBe("security")
    expect(roleToCategory("performance")).toBe("performance")
    expect(roleToCategory("tests")).toBe("stability")
    expect(roleToCategory("bogus")).toBeNull()
    // dataIntegrity has no producing role — never mapped.
    expect(roleToCategory("dataIntegrity")).toBeNull()
  })
})

describe("aggregateReviewComments", () => {
  it("counts posted/accepted, bands severity, maps category; a dismissal marks not-accepted", () => {
    const findings: PostedFinding[] = [
      { key: "1:aa", score: 5, roles: ["logic"] }, // critical / functionalCorrectness
      { key: "1:bb", score: 3, roles: ["security"] }, // minor / security
      { key: "2:cc", score: 4, roles: ["performance"] }, // major / performance
    ]
    const dismissed = new Set<string>(["1:aa"]) // the critical one was dismissed
    const agg = aggregateReviewComments(findings, dismissed)

    expect(agg.posted).toBe(3)
    expect(agg.accepted).toBe(2)
    expect(agg.acceptanceRate).toBeCloseTo(2 / 3, 6)

    // severity always returns all four bands.
    expect(agg.severity.map((s) => s.key)).toEqual(["critical", "major", "minor", "trivial"])
    expect(agg.severity.find((s) => s.key === "critical")).toMatchObject({ posted: 1, accepted: 0 })
    expect(agg.severity.find((s) => s.key === "major")).toMatchObject({ posted: 1, accepted: 1 })
    expect(agg.severity.find((s) => s.key === "trivial")).toMatchObject({ posted: 0, accepted: 0 })

    // category only includes observed keys, never a fabricated zero.
    const catKeys = agg.category.map((c) => c.key)
    expect(catKeys).toContain("functionalCorrectness")
    expect(catKeys).toContain("security")
    expect(catKeys).toContain("performance")
    expect(catKeys).not.toContain("dataIntegrity")
  })

  it("de-dupes findings by join key (a re-posted finding counts once)", () => {
    const findings: PostedFinding[] = [
      { key: "1:aa", score: 5, roles: ["logic"] },
      { key: "1:aa", score: 5, roles: ["logic"] },
    ]
    const agg = aggregateReviewComments(findings, new Set())
    expect(agg.posted).toBe(1)
    expect(agg.accepted).toBe(1)
  })

  it("picks a single primary category for a multi-role finding (coherent sums)", () => {
    const findings: PostedFinding[] = [{ key: "1:aa", score: 4, roles: ["logic", "security"] }]
    const agg = aggregateReviewComments(findings, new Set())
    // security outranks functionalCorrectness in the priority order.
    expect(agg.category).toEqual([{ key: "security", posted: 1, accepted: 1 }])
    const totalCatPosted = agg.category.reduce((n, c) => n + c.posted, 0)
    expect(totalCatPosted).toBe(agg.posted)
  })

  it("acceptanceRate is null when nothing was posted", () => {
    const agg = aggregateReviewComments([], new Set())
    expect(agg.posted).toBe(0)
    expect(agg.acceptanceRate).toBeNull()
    expect(agg.category).toEqual([])
  })
})

describe("reviewerTimeSavedHours", () => {
  it("estimates accepted * MIN_PER_COMMENT / 60", () => {
    expect(reviewerTimeSavedHours(12)).toBeCloseTo((12 * MIN_PER_COMMENT) / 60, 6)
    expect(reviewerTimeSavedHours(0)).toBe(0)
    expect(reviewerTimeSavedHours(-3)).toBe(0)
  })
})

describe("avgReviewIterationsPerPr", () => {
  it("is rows/PRs, or null when there are no PRs", () => {
    expect(avgReviewIterationsPerPr(10, 4)).toBe(2.5)
    expect(avgReviewIterationsPerPr(0, 0)).toBeNull()
    expect(avgReviewIterationsPerPr(5, 0)).toBeNull()
  })
})

describe("toolFindingKind", () => {
  it("bands a security-primary cataloged tool to sast", () => {
    expect(toolFindingKind("semgrep")).toBe("sast")
    expect(toolFindingKind("gitleaks")).toBe("sast")
    expect(toolFindingKind("osv-scanner")).toBe("sast")
  })
  it("bands a logic/style cataloged tool to linter", () => {
    expect(toolFindingKind("eslint")).toBe("linter")
    expect(toolFindingKind("tsc")).toBe("linter")
  })
  it("bands an unknown but shape-safe id to other", () => {
    expect(toolFindingKind("customtool")).toBe("other")
  })
})

describe("bandToolFindings", () => {
  it("sums result counts into sast/linter/other bands", () => {
    expect(
      bandToolFindings([
        { toolId: "semgrep", resultCount: 3 },
        { toolId: "eslint", resultCount: 5 },
        { toolId: "customtool", resultCount: 2 },
      ]),
    ).toEqual({ sast: 3, linter: 5, other: 2 })
  })
  it("floors negative/non-finite counts to 0", () => {
    expect(
      bandToolFindings([
        { toolId: "semgrep", resultCount: -4 },
        { toolId: "eslint", resultCount: Number.NaN },
      ]),
    ).toEqual({ sast: 0, linter: 0, other: 0 })
  })
})
