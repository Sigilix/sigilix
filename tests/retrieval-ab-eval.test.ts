// SIG-45 — A/B evaluation core tests (pure-vector vs hybrid retrieval).

import { describe, it, expect } from "vitest"
import {
  parseArmFindingsJsonl,
  parseGroundTruthJsonl,
  tallyArm,
  computeAbReport,
  formatAbMarkdown,
  formatAbCsv,
  SHIP_F1_RELATIVE_LIFT,
  type ArmFinding,
  type GroundTruthItem,
} from "../src/lib/retrieval-ab/eval"

describe("parsing", () => {
  it("parses arm findings and drops malformed / bad-arm lines", () => {
    const text = [
      `{"pr":"1","arm":"vector","file":"a.ts","line":10}`,
      `{"pr":"1","arm":"hybrid","file":"a.ts","line":10,"category":"security"}`,
      `{"pr":"1","arm":"bogus","file":"a.ts","line":10}`, // bad arm → dropped
      `not json`, // → dropped
      ``, // blank → skipped, not counted
    ].join("\n")
    const res = parseArmFindingsJsonl(text)
    expect(res.rows).toHaveLength(2)
    expect(res.dropped).toBe(2)
    expect(res.rows[1]!.category).toBe("security")
  })

  it("parses ground truth, requiring pr/file/line", () => {
    const text = [
      `{"pr":"1","file":"a.ts","line":10,"category":"logic"}`,
      `{"pr":"1","file":"a.ts"}`, // missing line → dropped
    ].join("\n")
    const res = parseGroundTruthJsonl(text)
    expect(res.rows).toHaveLength(1)
    expect(res.dropped).toBe(1)
  })

  it("drops fractional / non-positive line numbers instead of truncating them", () => {
    const text = [
      `{"pr":"1","file":"a.ts","line":10}`, // valid
      `{"pr":"1","file":"a.ts","line":10.9}`, // fractional → dropped (no silent trunc to 10)
      `{"pr":"1","file":"a.ts","line":0}`, // non-positive → dropped
      `{"pr":"1","file":"a.ts","line":-3}`, // negative → dropped
    ].join("\n")
    const res = parseGroundTruthJsonl(text)
    expect(res.rows).toEqual([{ pr: "1", file: "a.ts", line: 10 }])
    expect(res.dropped).toBe(3)
  })
})

describe("tallyArm matching", () => {
  const truth: GroundTruthItem[] = [
    { pr: "1", file: "a.ts", line: 10, category: "security" },
    { pr: "1", file: "b.ts", line: 50 },
  ]
  it("matches within line tolerance; categories compatible when both present", () => {
    const findings: ArmFinding[] = [
      { pr: "1", arm: "vector", file: "a.ts", line: 12, category: "security" }, // TP (dist 2)
      { pr: "1", arm: "vector", file: "b.ts", line: 50 }, // TP (no category on truth side)
    ]
    expect(tallyArm(findings, truth, 3)).toEqual({ tp: 2, fp: 0, fn: 0 })
  })
  it("counts a wrong-category hit as FP (when both categorized) and unmatched truth as FN", () => {
    const findings: ArmFinding[] = [
      { pr: "1", arm: "vector", file: "a.ts", line: 10, category: "performance" }, // category mismatch → FP
    ]
    expect(tallyArm(findings, truth, 3)).toEqual({ tp: 0, fp: 1, fn: 2 })
  })
  it("claims each truth item at most once (nearest line wins)", () => {
    const findings: ArmFinding[] = [
      { pr: "1", arm: "vector", file: "a.ts", line: 11 }, // nearer → TP
      { pr: "1", arm: "vector", file: "a.ts", line: 9 }, // truth already claimed → FP
    ]
    const t = tallyArm(findings, truth, 3)
    expect(t.tp).toBe(1)
    expect(t.fp).toBe(1)
  })
  it("does not cross PR boundaries", () => {
    const findings: ArmFinding[] = [{ pr: "2", arm: "vector", file: "a.ts", line: 10 }]
    expect(tallyArm(findings, truth, 3)).toEqual({ tp: 0, fp: 1, fn: 2 })
  })

  it("is independent of findings order (no greedy first-claim corruption)", () => {
    // Regression for the order-dependent greedy: truth T1@10, T2@14 (tol 5).
    // A@8 reaches only T1 (dist 2). B@11 reaches T1 (dist 1) AND T2 (dist 3).
    // A greedy nearest-first pass over [B, A] lets B grab its nearer T1, stranding
    // A → tp 1; over [A, B] → tp 2. Maximum matching pairs A→T1, B→T2 either way.
    const tw: GroundTruthItem[] = [
      { pr: "1", file: "a.ts", line: 10 },
      { pr: "1", file: "a.ts", line: 14 },
    ]
    const A: ArmFinding = { pr: "1", arm: "vector", file: "a.ts", line: 8 }
    const B: ArmFinding = { pr: "1", arm: "vector", file: "a.ts", line: 11 }
    expect(tallyArm([A, B], tw, 5)).toEqual({ tp: 2, fp: 0, fn: 0 })
    expect(tallyArm([B, A], tw, 5)).toEqual({ tp: 2, fp: 0, fn: 0 })
  })
})

describe("computeAbReport decision", () => {
  function findings(spec: Array<[string, ArmFinding["arm"], string, number]>): ArmFinding[] {
    return spec.map(([pr, arm, file, line]) => ({ pr, arm, file, line }))
  }
  function truthFor(prs: number): GroundTruthItem[] {
    return Array.from({ length: prs }, (_, i) => ({ pr: String(i), file: "a.ts", line: 10 }))
  }

  it("ships hybrid when relative F1 lift ≥ 10% and N ≥ minPrs", () => {
    // 4 PRs, minPrs=4. Vector finds 2/4 (recall .5, precision 1 → F1 .667).
    // Hybrid finds 4/4 (F1 1.0) → ~50% lift → ship.
    const v = findings([["0", "vector", "a.ts", 10], ["1", "vector", "a.ts", 10]])
    const h = findings([
      ["0", "hybrid", "a.ts", 10], ["1", "hybrid", "a.ts", 10],
      ["2", "hybrid", "a.ts", 10], ["3", "hybrid", "a.ts", 10],
    ])
    const r = computeAbReport([...v, ...h], truthFor(4), { minPrs: 4 })
    expect(r.decision.shipHybrid).toBe(true)
    expect(r.decision.relativeLift! >= SHIP_F1_RELATIVE_LIFT).toBe(true)
  })

  it("keeps behind flag when lift is below the bar", () => {
    // Identical arms → 0% lift → no ship.
    const v = findings([["0", "vector", "a.ts", 10], ["1", "vector", "a.ts", 10],
      ["2", "vector", "a.ts", 10], ["3", "vector", "a.ts", 10]])
    const h = findings([["0", "hybrid", "a.ts", 10], ["1", "hybrid", "a.ts", 10],
      ["2", "hybrid", "a.ts", 10], ["3", "hybrid", "a.ts", 10]])
    const r = computeAbReport([...v, ...h], truthFor(4), { minPrs: 4 })
    expect(r.decision.shipHybrid).toBe(false)
    expect(r.decision.relativeLift).toBe(0)
  })

  it("flags underpowered and refuses to ship below minPrs even with a lift", () => {
    const v = findings([["0", "vector", "a.ts", 10]])
    const h = findings([["0", "hybrid", "a.ts", 10], ["1", "hybrid", "a.ts", 10]])
    const r = computeAbReport([...v, ...h], truthFor(2), { minPrs: 30 })
    expect(r.decision.underpowered).toBe(true)
    expect(r.decision.shipHybrid).toBe(false)
  })

  it("counts every PR across truth + both arms toward N", () => {
    const r = computeAbReport(
      [{ pr: "x", arm: "vector", file: "a.ts", line: 10 }],
      [{ pr: "y", file: "a.ts", line: 10 }],
      { minPrs: 1 },
    )
    expect(r.prCount).toBe(2)
  })
})

describe("formatters", () => {
  const r = computeAbReport(
    [{ pr: "0", arm: "hybrid", file: "a.ts", line: 10 }],
    [{ pr: "0", file: "a.ts", line: 10 }],
    { minPrs: 1 },
  )
  it("markdown has both arms + a decision line", () => {
    const md = formatAbMarkdown(r)
    expect(md).toContain("| vector |")
    expect(md).toContain("| hybrid |")
    expect(md).toMatch(/Decision: (SHIP|KEEP)/)
  })
  it("csv has a header + two arm rows", () => {
    const lines = formatAbCsv(r).split("\n")
    expect(lines[0]).toContain("precision_ci_lower")
    expect(lines).toHaveLength(3)
  })
})
