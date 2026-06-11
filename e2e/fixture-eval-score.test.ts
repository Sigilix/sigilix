// SIG-398 — offline tests for the fixture-eval driver's pure half
// (fixture loading, run folding, report rendering). The live test pairs
// with this the same way logic-recall-eval pairs with its score tests:
// model calls live in `.live.test.ts`, everything decidable offline is
// pinned here so CI covers it without the key.

import { describe, expect, it } from "vitest"
import {
  foldRuns,
  formatLocalEvalReport,
  loadFixture,
  splitSectionIntoRegions,
  type RepeatOutcome,
} from "@/e2e/fixture-eval-lib"
import { scoreFixture } from "@/evals/scorer"
import { shadowFindingsToFixtureFindings } from "@/evals/local-adapter"

describe("loadFixture", () => {
  it("loads the committed dense fixture: truth + diff + a non-coaching PR title", () => {
    const f = loadFixture("fullstack-pr20-dense")
    expect(f.truth.bugs).toHaveLength(20)
    expect(f.diff).toContain("server/payments.ts")
    expect(f.prTitle).toBe("feat: payments & refunds — charges, refunds, balances, provider webhook")
  })

  it("loads the low-density control (diff frozen alongside the truth)", () => {
    const f = loadFixture("fullstack-low-density")
    expect(f.truth.bugs).toHaveLength(5)
    expect(f.diff).toContain("server/webhooks.ts")
  })

  it("throws a freeze-the-diff error when a fixture has no pr.diff", () => {
    expect(() => loadFixture("does-not-exist")).toThrow()
  })
})

describe("splitSectionIntoRegions", () => {
  const section = (added: number) =>
    [
      "diff --git a/x.ts b/x.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/x.ts",
      "@@ -0,0 +1," + added + " @@",
      ...Array.from({ length: added }, (_, i) => `+line ${i + 1}`),
    ].join("\n")

  it("keeps small files whole with the full new-line span", () => {
    const regions = splitSectionIntoRegions("x.ts", section(40))
    expect(regions).toHaveLength(1)
    expect(regions[0]!.label).toBe("x.ts")
    expect(regions[0]!.newLineRange).toEqual([1, 40])
  })

  it("windows a big file with overlap; spans are monotonic and overlap-contiguous", () => {
    const regions = splitSectionIntoRegions("x.ts", section(183))
    expect(regions.length).toBeGreaterThan(2)
    for (let i = 0; i < regions.length; i++) {
      const [lo, hi] = regions[i]!.newLineRange
      expect(lo).toBeLessThanOrEqual(hi)
      if (i > 0) {
        const [prevLo, prevHi] = regions[i - 1]!.newLineRange
        expect(lo).toBeGreaterThan(prevLo) // strictly advancing — no infinite loop
        expect(lo).toBeLessThanOrEqual(prevHi + 1) // no coverage gap (overlap or contiguous)
      }
    }
    expect(regions[regions.length - 1]!.newLineRange[1]).toBe(183)
    expect(regions[0]!.label).toBe("x.ts#w1")
  })

  it("terminates even when windowAdded <= overlapAdded (the step-back bound)", () => {
    const regions = splitSectionIntoRegions("x.ts", section(30), {
      maxAddedLines: 10,
      windowAdded: 5,
      overlapAdded: 9,
    })
    expect(regions.length).toBeGreaterThan(0)
    expect(regions.length).toBeLessThan(60)
  })

  it("tracks new-file line numbers across multiple @@ hunks", () => {
    const multi = [
      "diff --git a/y.ts b/y.ts",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1,2 +10,3 @@",
      " ctx",
      "+added at 11",
      " ctx",
      "@@ -20,2 +50,3 @@",
      " ctx",
      "+added at 51",
      " ctx",
    ].join("\n")
    const [region] = splitSectionIntoRegions("y.ts", multi)
    expect(region!.newLineRange).toEqual([10, 52])
  })

  it("a section with no hunks falls back to a whole-file region", () => {
    const [region] = splitSectionIntoRegions("z.ts", "diff --git a/z.ts b/z.ts\n+++ b/z.ts")
    expect(region!.label).toBe("z.ts")
  })
})

// Synthetic outcomes built through the REAL adapter + scorer chain, so
// the folding/rendering tests exercise the same shapes the live run does.
function outcomeFor(
  repeat: number,
  headlines: Array<{ headline: string; line: number; score: number }>,
): RepeatOutcome {
  const truth = loadFixture("fullstack-pr20-dense").truth
  const findings = shadowFindingsToFixtureFindings(
    "logic",
    headlines.map((h) => ({
      path: "server/payments.ts",
      line: h.line,
      score: h.score,
      category: "logic",
      headline: h.headline,
      body: "",
    })),
  )
  return { repeat, score: scoreFixture(truth, "sigilix", findings), erroredRoles: [], elapsedMs: 90_000 }
}

const B7 = { headline: "**Pagination offset is off-by-one: `page * limit` skips the first page**", line: 131, score: 4 }

describe("foldRuns + formatLocalEvalReport", () => {
  const outcomes: RepeatOutcome[] = [
    outcomeFor(1, [B7]),
    outcomeFor(2, [B7]),
    { ...outcomeFor(3, []), erroredRoles: ["logic", "security"] },
  ]
  const baseline = foldRuns({
    fixture: "fullstack-pr20-dense",
    repeats: 3,
    generatedAt: "2026-06-10T00:00:00.000Z",
    outcomes,
  })

  it("folds per-repeat scores into per-row caught counts", () => {
    expect(baseline.perRow).toEqual({ b7: 2 })
    expect(baseline.repeats).toBe(3)
    expect(baseline.context).toBe("minimal")
  })

  it("renders the context-gap banner, per-repeat rows, errored roles, and ✓/~/✗ stability markers", () => {
    const report = formatLocalEvalReport({
      fixture: "fullstack-pr20-dense",
      truth: loadFixture("fullstack-pr20-dense").truth,
      outcomes,
      baseline,
    })
    expect(report).toContain("context: minimal")
    expect(report).toContain("never the prod posted-review numbers")
    expect(report).toContain("| 3 | 0/20 (0.0%)")
    expect(report).toContain("logic, security")
    expect(report).toContain("| b7 ~ |") // mid-band 2/3 → noise marker
    expect(report).toContain("| b1 ✗ |") // never caught
    expect(report).toMatch(/\| b7 ~ \| MEDIUM \| P1 \| 2\/3 \|/)
  })
})
