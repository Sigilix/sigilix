// SIG-392 — coverage-stamp collapse, calibrated on REAL probe findings
// (probe #28's three cross-file stamps) and the pinned negative-gate
// regression (Kimi sign-off condition).

import { describe, expect, it } from "vitest"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { collapseCoverageStamps, isPureCoverageStamp } from "@/src/lib/ensemble/domain/coverage-stamp-collapse"

function finding(over: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    path: "server/payments.ts",
    line: 182,
    score: 2,
    category: "testing",
    headline: "h",
    body: "b",
    ...over,
  }
}

const prov = (ids: string[]) => ({
  sourceSpecialists: ["tests" as const],
  sourceFindingIds: ids,
  action: "kept" as const,
  verifiedViaRetrieval: false,
})

// Probe #28's actual posted stamps (capped-era prod, verbatim headlines).
const stampA = finding({
  path: "server/payments.ts",
  headline: "Entire payments module ships without any test coverage",
})
const stampB = finding({
  path: "server/auth.ts",
  line: 28,
  headline: "Auth middleware ships without any test coverage",
})
const stampC = finding({
  path: "server/refunds.ts",
  line: 38,
  score: 3,
  headline: "Refund module ships without any test coverage",
})

describe("isPureCoverageStamp", () => {
  it("classifies probe #28's three real stamps", () => {
    expect(isPureCoverageStamp(stampA)).toBe(true)
    expect(isPureCoverageStamp(stampB)).toBe(true)
    expect(isPureCoverageStamp(stampC)).toBe(true)
  })

  it("pinned negative-gate regression: mechanism-naming testing findings are NEVER stamps", () => {
    // When editing MECHANISM_TOKENS, this must keep passing (sign-off condition).
    expect(
      isPureCoverageStamp(
        finding({ headline: "Sibling test only covers the single FINAL case, not multiple matches" }),
      ),
    ).toBe(false)
    expect(isPureCoverageStamp(finding({ headline: "Missing test for the refund race regression" }))).toBe(false)
  })

  it("non-testing categories never classify, regardless of wording", () => {
    expect(isPureCoverageStamp(finding({ category: "logic", headline: "Module ships without tests" }))).toBe(false)
  })
})

describe("collapseCoverageStamps", () => {
  it("collapses probe #28's three cross-file stamps into one pr-scope finding", () => {
    const real = finding({ category: "logic", score: 5, headline: "SQL injection in webhook handler" })
    const out = collapseCoverageStamps(
      [stampA, real, stampB, stampC],
      [prov(["tests-0"]), prov(["logic-1"]), prov(["tests-2"]), prov(["tests-5"])],
    )
    expect(out.findings).toHaveLength(2)
    // highest score (stampC, 3) survives, pr-scoped, body lists the other paths
    const survivor = out.findings.find((f) => f.category === "testing")!
    expect(survivor.headline).toBe("Refund module ships without any test coverage")
    expect(survivor.scope).toBe("pr")
    expect(survivor.body).toContain("Also uncovered: `server/auth.ts`, `server/payments.ts`")
    // the real finding is untouched, alignment preserved
    const realOut = out.findings.find((f) => f.category === "logic")!
    expect(realOut).toEqual(real)
    const survivorProv = out.provenanceFindings[out.findings.indexOf(survivor)]!
    expect(survivorProv.sourceFindingIds).toEqual(["tests-0", "tests-2", "tests-5"])
    expect(out.collapsed).toEqual({
      keptHeadline: "Refund module ships without any test coverage",
      collapsedCount: 2,
      paths: ["server/auth.ts", "server/payments.ts"],
    })
  })

  it("a lone stamp passes through untouched (inputs by reference)", () => {
    const input = [stampA, finding({ category: "logic", headline: "real" })]
    const provs = [prov(["t-0"]), prov(["l-0"])]
    const out = collapseCoverageStamps(input, provs)
    expect(out.findings).toBe(input)
    expect(out.provenanceFindings).toBe(provs)
    expect(out.collapsed).toBeNull()
  })

  it("tie on score keeps the earliest stamp", () => {
    const out = collapseCoverageStamps([stampA, stampB], [prov(["t-0"]), prov(["t-1"])])
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.headline).toBe(stampA.headline)
    expect(out.findings[0]!.body).toContain("`server/auth.ts`")
  })

  it("caps telemetry paths at 10", () => {
    const stamps = Array.from({ length: 13 }, (_, i) =>
      finding({ path: `src/f${String(i).padStart(2, "0")}.ts`, headline: "Module ships without tests" }),
    )
    const out = collapseCoverageStamps(
      stamps,
      stamps.map((_, i) => prov([`t-${i}`])),
    )
    expect(out.findings).toHaveLength(1)
    expect(out.collapsed!.collapsedCount).toBe(12)
    expect(out.collapsed!.paths).toHaveLength(10)
  })
})
