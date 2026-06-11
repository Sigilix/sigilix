// SIG-397 — recall-regression harness tests.
//
// Two layers:
//   1. Unit tests for the matcher/scorer semantics (synthetic findings).
//   2. The CALIBRATION suite: the committed equivalence rules, run against
//      the committed frozen snapshots, must reproduce the Jun-9 hand
//      scoring of the dense benchmark EXACTLY (and the labeled Jun-6
//      fullstack-17 control). This pins the encoded rules to the human
//      ground truth — if a rule edit shifts any mapping, this fails.

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { classifyFinding, formatDeltaMarkdown, formatScoreMarkdown, scoreFixture } from "./scorer"
import { matchableBody, sigilixSeverity } from "./normalize"
import { scoreTargetFromArgs } from "./io"
import type { FixtureFinding, FixtureGroundTruth } from "./fixture-types"

const HERE = dirname(fileURLToPath(import.meta.url))

function loadTruth(fixture: string): FixtureGroundTruth {
  return JSON.parse(readFileSync(join(HERE, "fixtures", fixture, "ground-truth.json"), "utf8")) as FixtureGroundTruth
}
function loadFindings(fixture: string, tool: string): FixtureFinding[] {
  return JSON.parse(readFileSync(join(HERE, "fixtures", fixture, `findings.${tool}.json`), "utf8")) as FixtureFinding[]
}

function finding(over: Partial<FixtureFinding> & { ref: string }): FixtureFinding {
  return {
    tool: "sigilix",
    commentId: 1,
    path: "server/payments.ts",
    line: 10,
    excerpt: "",
    bodyText: "",
    severity: null,
    url: "https://example.test",
    ...over,
  }
}

// ─── severity parsing ────────────────────────────────────────────

describe("sigilixSeverity", () => {
  it("maps the numeric marker to the renderer's P-labels (5→P0, 4→P1, 3→P2, 1-2→P3)", () => {
    expect(sigilixSeverity("x <!-- sigilix:severity:5 --> y")).toBe("P0")
    expect(sigilixSeverity("<!-- sigilix:severity:4 -->")).toBe("P1")
    expect(sigilixSeverity("<!-- sigilix:severity:3 -->")).toBe("P2")
    expect(sigilixSeverity("<!-- sigilix:severity:2 -->")).toBe("P3")
    expect(sigilixSeverity("<!-- sigilix:severity:1 -->")).toBe("P3")
    expect(sigilixSeverity("no marker")).toBeNull()
  })

  it("rejects scores outside the engine's 1-5 scale instead of coercing", () => {
    expect(sigilixSeverity("<!-- sigilix:severity:0 -->")).toBeNull()
    expect(sigilixSeverity("<!-- sigilix:severity:99 -->")).toBeNull()
  })
})

describe("matchableBody", () => {
  it("strips HTML comment markers and keeps the rest", () => {
    expect(matchableBody("<!-- sigilix:pr-review-finding -->\nThe **bug** text")).toBe("The **bug** text")
  })
})

// ─── matcher semantics ───────────────────────────────────────────

const SYNTH_TRUTH: FixtureGroundTruth = {
  schemaVersion: 1,
  fixture: "synthetic",
  owner: "o",
  repo: "r",
  pr: 1,
  headSha: "abc",
  bugs: [
    {
      id: "x1",
      title: "alpha bug",
      paths: ["server/payments.ts"],
      tier: "EASY",
      category: "logic",
      severity: "P1",
      match: { anyOf: [{ allKeywords: ["alpha"] }] },
    },
    {
      id: "x2",
      title: "beta bug",
      paths: ["server/payments.ts"],
      tier: "MEDIUM",
      category: "logic",
      severity: "P2",
      match: { anyOf: [{ allKeywords: ["beta"], notKeywords: ["alpha"] }] },
    },
    {
      id: "x3",
      title: "line-anchored bug",
      paths: ["server/refunds.ts"],
      tier: "LOW",
      category: "perf",
      severity: "P3",
      match: { anyOf: [{ allKeywords: ["gamma"], lineRanges: [[40, 50]], lineSlack: 0 }] },
    },
  ],
  traps: [
    {
      id: "tx1",
      title: "trap",
      paths: ["server/payments.ts"],
      whySafe: "safe",
      match: { anyOf: [{ allKeywords: ["delta"] }] },
    },
  ],
  outOfScope: [
    {
      id: "coverage",
      title: "tests coverage",
      match: { anyOf: [{ allKeywords: ["tests"], botCategories: ["testing"] }] },
    },
  ],
}

describe("classifyFinding", () => {
  it("maps a finding to a bug row by path + keywords", () => {
    const v = classifyFinding(SYNTH_TRUTH, finding({ ref: "f1", bodyText: "the ALPHA issue" }))
    expect(v).toEqual({ kind: "bug", id: "x1" })
  })

  it("path mismatch never matches, regardless of keywords", () => {
    const v = classifyFinding(SYNTH_TRUTH, finding({ ref: "f1", path: "server/other.ts", bodyText: "alpha" }))
    expect(v).toEqual({ kind: "unmatched" })
  })

  it("notKeywords blocks a clause", () => {
    const v = classifyFinding(SYNTH_TRUTH, finding({ ref: "f1", bodyText: "beta but also alpha" }))
    // "beta"+"alpha" → x2 blocked by notKeywords, x1 matches on "alpha".
    expect(v).toEqual({ kind: "bug", id: "x1" })
  })

  it("a compound finding matching two BUG rows credits both (two root causes, two rows)", () => {
    const compound: FixtureGroundTruth = {
      ...SYNTH_TRUTH,
      bugs: SYNTH_TRUTH.bugs.map((b) => (b.id === "x2" ? { ...b, match: { anyOf: [{ allKeywords: ["beta"] }] } } : b)),
    }
    const v = classifyFinding(compound, finding({ ref: "f1", bodyText: "alpha and beta" }))
    expect(v).toEqual({ kind: "bug", id: "x1", bugIds: ["x1", "x2"] })
    const s = scoreFixture(compound, "sigilix", [finding({ ref: "f1", bodyText: "alpha and beta" })])
    expect(s.overall.caughtIds).toEqual(["x1", "x2"])
  })

  it("a bug-and-trap double match also throws", () => {
    expect(() => classifyFinding(SYNTH_TRUTH, finding({ ref: "f1", bodyText: "alpha delta" }))).toThrow(
      /ambiguous equivalence/,
    )
  })

  it("line ranges constrain when present (slack 0)", () => {
    const inRange = finding({ ref: "f1", path: "server/refunds.ts", line: 45, bodyText: "gamma" })
    const outRange = finding({ ref: "f2", path: "server/refunds.ts", line: 60, bodyText: "gamma" })
    expect(classifyFinding(SYNTH_TRUTH, inRange)).toEqual({ kind: "bug", id: "x3" })
    expect(classifyFinding(SYNTH_TRUTH, outRange)).toEqual({ kind: "unmatched" })
  })

  it("out-of-scope rules win before bug/trap matching and respect botCategories", () => {
    const covered = finding({ ref: "f1", bodyText: "alpha ships without tests", botCategory: "testing" })
    expect(classifyFinding(SYNTH_TRUTH, covered)).toEqual({ kind: "out_of_scope", id: "coverage" })
    const notCovered = finding({ ref: "f2", bodyText: "alpha ships without tests", botCategory: "logic" })
    expect(classifyFinding(SYNTH_TRUTH, notCovered)).toEqual({ kind: "bug", id: "x1" })
  })

  it("an empty anyOf rule throws — the row would be silently uncatchable", () => {
    const bad: FixtureGroundTruth = {
      ...SYNTH_TRUTH,
      bugs: [{ ...SYNTH_TRUTH.bugs[0]!, match: { anyOf: [] } }],
      traps: [],
      outOfScope: [],
    }
    expect(() => classifyFinding(bad, finding({ ref: "f1", bodyText: "alpha" }))).toThrow(/empty anyOf/)
  })

  it("an empty allKeywords clause is rejected — line proximity alone is not a matcher", () => {
    const bad: FixtureGroundTruth = {
      ...SYNTH_TRUTH,
      bugs: [
        {
          ...SYNTH_TRUTH.bugs[0]!,
          match: { anyOf: [{ allKeywords: [], lineRanges: [[1, 5]] }] },
        },
      ],
      traps: [],
      outOfScope: [],
    }
    expect(() => classifyFinding(bad, finding({ ref: "f1", line: 3, bodyText: "anything" }))).toThrow(
      /empty allKeywords/,
    )
  })
})

describe("scoreFixture", () => {
  it("derives all denominators from the ground truth, never hardcoded", () => {
    const s = scoreFixture(SYNTH_TRUTH, "sigilix", [])
    expect(s.overall.total).toBe(3)
    expect(s.highSeverity.total).toBe(1) // only x1 is P0/P1
    expect(s.byTier.EASY.total).toBe(1)
    expect(s.byTier.MEDIUM.total).toBe(1)
    expect(s.byTier.LOW.total).toBe(1)
    expect(s.byTier.UNGODLY.total).toBe(0)
    expect(s.byTier.UNGODLY.recall).toBeNull()
  })

  it("precision excludes out-of-scope findings from both sides; traps and unmatched count against", () => {
    const s = scoreFixture(SYNTH_TRUTH, "sigilix", [
      finding({ ref: "f1", bodyText: "alpha" }),
      finding({ ref: "f2", bodyText: "delta", severity: "P0" }), // trap flag at P0
      finding({ ref: "f3", bodyText: "unrelated claim" }), // hallucination candidate
      finding({ ref: "f4", bodyText: "needs tests", botCategory: "testing" }), // out of scope
    ])
    expect(s.precisionNumerator).toBe(1)
    expect(s.precisionDenominator).toBe(3)
    expect(s.outOfScope).toHaveLength(1)
    expect(s.highSevFalsePositives).toHaveLength(1)
    expect(s.highSevFalsePositives[0]!.ref).toBe("f2")
  })
})

// ─── CALIBRATION: the frozen snapshots must reproduce the hand scoring ──

describe("calibration — fullstack-pr20-dense (Jun-9 hand scoring)", () => {
  const truth = loadTruth("fullstack-pr20-dense")

  it("ground truth has 20 bug rows, 15 P0/P1, 7 UNGODLY, 4 traps (derived, not prose)", () => {
    expect(truth.bugs).toHaveLength(20)
    expect(truth.bugs.filter((b) => b.severity === "P0" || b.severity === "P1")).toHaveLength(15)
    expect(truth.bugs.filter((b) => b.tier === "UNGODLY")).toHaveLength(7)
    expect(truth.traps).toHaveLength(4)
  })

  it("Sigilix: 8/20 recall on exactly the hand-scored rows; 10/11 precision; the one soft P0 trap flag", () => {
    const s = scoreFixture(truth, "sigilix", loadFindings("fullstack-pr20-dense", "sigilix"))
    expect(s.overall.caughtIds).toEqual(["b1", "b2", "b3", "b6", "b7", "b9", "b11", "b13"])
    expect(s.overall.total).toBe(20)
    // Per-finding mapping, pinned ref by ref.
    const verdicts = Object.fromEntries(s.findings.map((f) => [f.ref, f.verdict]))
    expect(verdicts).toEqual({
      s1: { kind: "bug", id: "b1" },
      s2: { kind: "bug", id: "b3" },
      s3: { kind: "trap", id: "t1" }, // the recorded soft P0 false alarm
      s4: { kind: "bug", id: "b9" },
      s5: { kind: "bug", id: "b2" },
      s6: { kind: "out_of_scope", id: "testing-coverage" },
      s7: { kind: "bug", id: "b2" },
      s8: { kind: "bug", id: "b7" },
      s9: { kind: "bug", id: "b6" },
      s10: { kind: "bug", id: "b11" },
      s11: { kind: "out_of_scope", id: "testing-coverage" },
      s12: { kind: "out_of_scope", id: "testing-coverage" },
      s13: { kind: "bug", id: "b3" },
      s14: { kind: "bug", id: "b13" },
      s15: { kind: "out_of_scope", id: "testing-coverage" },
    })
    expect(s.precisionNumerator).toBe(10)
    expect(s.precisionDenominator).toBe(11)
    expect(s.highSevFalsePositives.map((f) => f.ref)).toEqual(["s3"])
  })

  it("Greptile: 9/20 incl. the unique b20 HMAC catch; 9/9 precision; 0 high-sev FP", () => {
    const s = scoreFixture(truth, "greptile", loadFindings("fullstack-pr20-dense", "greptile"))
    expect(s.overall.caughtIds).toEqual(["b1", "b2", "b4", "b6", "b7", "b9", "b11", "b13", "b20"])
    expect(s.precisionNumerator).toBe(9)
    expect(s.precisionDenominator).toBe(9)
    expect(s.highSevFalsePositives).toHaveLength(0)
    expect(s.trapFlags).toHaveLength(0)
  })

  it("CodeRabbit: frozen empty baseline (cooldown) — 0/20, precision null", () => {
    const s = scoreFixture(truth, "coderabbit", loadFindings("fullstack-pr20-dense", "coderabbit"))
    expect(s.overall.caught).toBe(0)
    expect(s.precision).toBeNull()
  })
})

describe("calibration — fullstack-low-density control (Jun-6 labels)", () => {
  const truth = loadTruth("fullstack-low-density")

  it("Sigilix maps exactly to its labeled rows (s1→r1, s2→r2)", () => {
    const s = scoreFixture(truth, "sigilix", loadFindings("fullstack-low-density", "sigilix"))
    const verdicts = Object.fromEntries(s.findings.map((f) => [f.ref, f.verdict]))
    expect(verdicts).toEqual({
      s1: { kind: "bug", id: "r1" },
      s2: { kind: "bug", id: "r2" },
    })
    expect(s.overall.total).toBe(5)
  })

  it("CodeRabbit maps exactly to its labeled rows (c1→r3, c2→r4, c3→r5)", () => {
    const s = scoreFixture(truth, "coderabbit", loadFindings("fullstack-low-density", "coderabbit"))
    const verdicts = Object.fromEntries(s.findings.map((f) => [f.ref, f.verdict]))
    expect(verdicts).toEqual({
      c1: { kind: "bug", id: "r3" },
      c2: { kind: "bug", id: "r4" },
      c3: { kind: "bug", id: "r5" },
    })
  })

  it("Greptile (reviewed after labeling) classifies without ambiguity errors", () => {
    const s = scoreFixture(truth, "greptile", loadFindings("fullstack-low-density", "greptile"))
    expect(s.overall.caughtIds).toEqual(["r3", "r4"])
    expect(s.unmatched).toHaveLength(3)
  })
})

// ─── score CLI target routing ────────────────────────────────────

describe("scoreTargetFromArgs", () => {
  it("no repo and no --pr → frozen snapshot (undefined)", () => {
    expect(scoreTargetFromArgs(undefined, undefined)).toBeUndefined()
    expect(scoreTargetFromArgs(undefined, "")).toBeUndefined()
  })

  it("positional/--repo forms resolve to a live target", () => {
    expect(scoreTargetFromArgs("Sigilix/sigilix-e2e-fullstack#20", undefined)).toBe("Sigilix/sigilix-e2e-fullstack#20")
    expect(scoreTargetFromArgs("Sigilix/sigilix-e2e-fullstack", "20")).toBe("Sigilix/sigilix-e2e-fullstack#20")
  })

  it("--pr alone carrying OWNER/REPO#N resolves to a live target", () => {
    expect(scoreTargetFromArgs(undefined, "Sigilix/sigilix-e2e-fullstack#20")).toBe("Sigilix/sigilix-e2e-fullstack#20")
  })

  it("a numeric --pr without a repo fails fast instead of silently scoring the snapshot", () => {
    expect(() => scoreTargetFromArgs(undefined, "20")).toThrow(/without --repo/)
  })
})

// ─── report formatting ───────────────────────────────────────────

describe("report formatting", () => {
  const truth = loadTruth("fullstack-pr20-dense")
  const base = scoreFixture(truth, "sigilix", loadFindings("fullstack-pr20-dense", "sigilix"))

  it("score markdown carries the three metrics and the missed-row list", () => {
    const md = formatScoreMarkdown(base)
    expect(md).toContain("| Recall (all rows) | 8/20 (40.0%) |")
    expect(md).toContain("| Precision | 90.9% (10/11) |")
    expect(md).toContain("| High-sev false positives | 1 |")
    expect(md).toContain("Missed: b4, b5, b8, b10, b12, b14, b15, b16, b17, b18, b19, b20")
  })

  it("delta refuses mismatched fixture/tool score pairs", () => {
    const other = { ...base, fixture: "fullstack-low-density" }
    expect(() => formatDeltaMarkdown(base, other, "x")).toThrow(/matching scores/)
    const otherTool = { ...base, tool: "greptile" as const }
    expect(() => formatDeltaMarkdown(base, otherTool, "x")).toThrow(/matching scores/)
  })

  it("delta markdown reports pp deltas vs a baseline", () => {
    const improved = {
      ...base,
      overall: { ...base.overall, caught: 12, recall: 12 / 20 },
    }
    const md = formatDeltaMarkdown(base, improved, "sig-393-l1-shadow")
    expect(md).toContain("sig-393-l1-shadow")
    expect(md).toContain("+20.0pp")
  })
})
