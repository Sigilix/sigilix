// SIG-398 — offline tests for the fixture-eval driver's pure half
// (fixture loading, run folding, report rendering). The live test pairs
// with this the same way logic-recall-eval pairs with its score tests:
// model calls live in `.live.test.ts`, everything decidable offline is
// pinned here so CI covers it without the key.

import { describe, expect, it } from "vitest"
import { foldRuns, formatLocalEvalReport, loadFixture, type RepeatOutcome } from "@/e2e/fixture-eval-lib"
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
