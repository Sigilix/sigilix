// SIG-398 — adapter tests: local shadow output must score IDENTICALLY to
// a posted review. The high-value assertions are the severity-scale
// agreement with `sigilixSeverity` (the posted-review parser) and the
// botCategory passthrough that keeps the dense fixture's testing-coverage
// carve-out working on local runs.

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  buildLocalBaseline,
  rowFlips,
  severityForScore,
  shadowFindingsToFixtureFindings,
  unionFixtureFindings,
  type LocalRawFinding,
} from "@/evals/local-adapter"
import { sigilixSeverity } from "@/evals/normalize"
import { classifyFinding, scoreFixture } from "@/evals/scorer"
import type { FixtureGroundTruth } from "@/evals/fixture-types"

const HERE = dirname(fileURLToPath(import.meta.url))
const DENSE_TRUTH = JSON.parse(
  readFileSync(join(HERE, "fixtures", "fullstack-pr20-dense", "ground-truth.json"), "utf8"),
) as FixtureGroundTruth

function raw(over: Partial<LocalRawFinding> = {}): LocalRawFinding {
  return {
    path: "server/payments.ts",
    line: 178,
    score: 5,
    category: "security",
    headline: "**SQL injection in webhook handler via string interpolation of event.invoiceId**",
    body: "The webhook handler interpolates event.invoiceId into the UPDATE.",
    ...over,
  }
}

describe("severityForScore", () => {
  it("agrees with sigilixSeverity (the posted-review parser) on every score", () => {
    for (const score of [0, 1, 2, 3, 4, 5, 6, 99]) {
      expect(severityForScore(score)).toBe(sigilixSeverity(`<!-- sigilix:severity:${score} -->`))
    }
  })
})

describe("shadowFindingsToFixtureFindings", () => {
  it("maps the shadow shape onto FixtureFinding with role-scoped refs", () => {
    const [f] = shadowFindingsToFixtureFindings("logic", [raw({ score: 4 })])
    expect(f).toMatchObject({
      ref: "logic-1",
      tool: "sigilix",
      commentId: 1,
      path: "server/payments.ts",
      line: 178,
      severity: "P1",
      url: "local",
      botCategory: "security",
    })
    expect(f!.excerpt).toContain("SQL injection")
    expect(f!.bodyText.startsWith(f!.excerpt)).toBe(true)
    expect(f!.bodyText).toContain("interpolates event.invoiceId")
  })

  it("an empty body leaves bodyText = headline (no trailing newline)", () => {
    const [f] = shadowFindingsToFixtureFindings("tests", [raw({ body: "" })])
    expect(f!.bodyText).toBe(f!.excerpt)
  })

  it("adapted findings score against the real dense ground truth (b1 via the security headline)", () => {
    const [f] = shadowFindingsToFixtureFindings("security", [raw()])
    expect(classifyFinding(DENSE_TRUTH, f!)).toEqual({ kind: "bug", id: "b1" })
  })

  it("botCategory passthrough keeps the testing-coverage carve-out working locally", () => {
    const [f] = shadowFindingsToFixtureFindings("tests", [
      raw({
        category: "testing",
        score: 2,
        headline: "**New payments module ships without tests**",
        body: "No tests cover the webhook handler.",
      }),
    ])
    expect(classifyFinding(DENSE_TRUTH, f!)).toEqual({ kind: "out_of_scope", id: "testing-coverage" })
  })

  it("union of roles scores as one finding set", () => {
    const logic = shadowFindingsToFixtureFindings("logic", [
      raw({
        category: "logic",
        score: 4,
        line: 131,
        headline: "**Pagination offset is off-by-one: `page * limit` skips the first page**",
        body: "",
      }),
    ])
    const security = shadowFindingsToFixtureFindings("security", [raw()])
    const score = scoreFixture(DENSE_TRUTH, "sigilix", unionFixtureFindings([logic, security]))
    expect(score.overall.caughtIds).toEqual(["b1", "b7"])
  })
})

describe("buildLocalBaseline / rowFlips", () => {
  const baseline = buildLocalBaseline({
    fixture: "fullstack-pr20-dense",
    repeats: 4,
    generatedAt: "2026-06-10T00:00:00.000Z",
    runs: [
      { caughtIds: ["b1", "b7"], recall: 0.1, precision: 1, highSevFpCount: 0 },
      { caughtIds: ["b1", "b7"], recall: 0.1, precision: 1, highSevFpCount: 0 },
      { caughtIds: ["b1"], recall: 0.05, precision: 0.5, highSevFpCount: 1 },
      { caughtIds: ["b1", "b7", "b9"], recall: 0.15, precision: 1, highSevFpCount: 0 },
    ],
  })

  it("folds runs into per-row caught counts + aggregates", () => {
    expect(baseline.perRow).toEqual({ b1: 4, b7: 3, b9: 1 })
    expect(baseline.aggregate.recallMean).toBeCloseTo(0.1)
    expect(baseline.aggregate.highSevFpTotal).toBe(1)
    expect(baseline.context).toBe("minimal")
  })

  it("rowFlips reports threshold-crossing rows in both directions", () => {
    const { flippedUp, flippedDown } = rowFlips({
      baseline,
      // b9 climbs 1/4 → 4/4 (the lever's win); b7 collapses 3/4 → 0/4.
      current: { repeats: 4, perRow: { b1: 4, b9: 4 } },
    })
    expect(flippedUp).toEqual(["b9"])
    expect(flippedDown).toEqual(["b7"])
  })

  it("an unstable row (mid-band in both) is NOT a flip — noise, not signal", () => {
    const { flippedUp, flippedDown } = rowFlips({
      baseline,
      current: { repeats: 4, perRow: { b1: 4, b7: 3, b9: 2 } },
    })
    expect(flippedUp).toEqual([])
    expect(flippedDown).toEqual([])
  })
})
