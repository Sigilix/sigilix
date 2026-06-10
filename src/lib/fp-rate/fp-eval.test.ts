// SIG-114 PR 2 — unit tests for the labeled-corpus precision / FP-rate eval.

import { describe, expect, it } from "vitest"
import {
  computeEvalReport,
  EVAL_CSV_HEADER,
  formatEvalCsv,
  joinFindingsToLabels,
  parseFindingsJsonl,
  parseLabelCsv,
  type EvalFinding,
  type EvalLabel,
  type EvalLabelRow,
} from "@/lib/fp-rate/eval"

function f(findingId: string, category: string): EvalFinding {
  return { findingId, category }
}
function l(findingId: string, label: EvalLabel): EvalLabelRow {
  return { findingId, label }
}

describe("joinFindingsToLabels", () => {
  it("joins by findingId and surfaces unmatched on both sides", () => {
    const findings = [f("a", "logic"), f("b", "security"), f("c", "tests")]
    const labels = [l("a", "TP"), l("b", "FP"), l("z", "TP")] // c unlabeled, z orphan
    const j = joinFindingsToLabels(findings, labels)
    expect(j.labeled.map((x) => x.findingId)).toEqual(["a", "b"])
    expect(j.findingsWithoutLabel).toBe(1) // c
    expect(j.labelsWithoutFinding).toBe(1) // z
  })

  it("first label wins on duplicate findingId", () => {
    const j = joinFindingsToLabels([f("a", "logic")], [l("a", "TP"), l("a", "FP")])
    expect(j.labeled).toHaveLength(1)
    expect(j.labeled[0]!.label).toBe("TP")
  })

  it("counts DISTINCT orphan labels (a duplicated orphan is one)", () => {
    const j = joinFindingsToLabels([f("a", "logic")], [l("a", "TP"), l("z", "TP"), l("z", "FP")])
    expect(j.labelsWithoutFinding).toBe(1) // z counted once, not twice
  })
})

describe("parseLabelCsv", () => {
  it("parses findingId+label, skips header anywhere, handles quotes/CRLF/commas-in-reason", () => {
    const csv = [
      "findingId,label,labelReason", // header (will be skipped even if not line 0)
      `a1,TP,"Real bug, with a comma in the reason"`, // comma in unread 3rd col
      `"b2","FP",nitpick`, // quoted findingId + quoted label
      "c3,borderline,unsure",
    ].join("\r\n") // CRLF
    const r = parseLabelCsv(csv)
    expect(r.rows).toEqual([
      { findingId: "a1", label: "TP" },
      { findingId: "b2", label: "FP" },
      { findingId: "c3", label: "borderline" },
    ])
    expect(r.dropped).toBe(0)
  })

  it("skips a header that follows leading blank lines", () => {
    const csv = ["", "  ", "findingId,label", "a1,TP"].join("\n")
    const r = parseLabelCsv(csv)
    expect(r.rows).toEqual([{ findingId: "a1", label: "TP" }])
  })

  it("drops rows with an invalid label or no second column, and counts them", () => {
    const csv = ["a1,TP", "a2,NOPE,reason", "a3", "a4,FP"].join("\n")
    const r = parseLabelCsv(csv)
    expect(r.rows.map((x) => x.findingId)).toEqual(["a1", "a4"])
    expect(r.dropped).toBe(2) // a2 (bad label) + a3 (no comma)
  })
})

describe("parseFindingsJsonl", () => {
  it("parses valid lines, skips blanks, drops malformed/incomplete + counts", () => {
    const jsonl = [
      JSON.stringify({ findingId: "a1", category: "logic" }),
      "",
      "{not json",
      JSON.stringify({ category: "security" }), // no findingId
      JSON.stringify({ findingId: "a2" }), // no category -> uncategorized
    ].join("\n")
    const r = parseFindingsJsonl(jsonl)
    expect(r.rows).toEqual([
      { findingId: "a1", category: "logic" },
      { findingId: "a2", category: "uncategorized" },
    ])
    expect(r.dropped).toBe(2) // bad json + missing findingId
  })
})

describe("computeEvalReport", () => {
  it("computes FP rate + precision overall, excluding borderline from the point estimate", () => {
    // 6 TP, 3 FP, 1 borderline -> fpRate = 3/9 = 33.3%, precision = 6/9
    const findings = [
      ...Array.from({ length: 6 }, (_, i) => f(`tp${i}`, "logic")),
      ...Array.from({ length: 3 }, (_, i) => f(`fp${i}`, "logic")),
      f("bl0", "logic"),
    ]
    const labels = [
      ...Array.from({ length: 6 }, (_, i) => l(`tp${i}`, "TP")),
      ...Array.from({ length: 3 }, (_, i) => l(`fp${i}`, "FP")),
      l("bl0", "borderline"),
    ]
    const report = computeEvalReport(joinFindingsToLabels(findings, labels), { minN: 5 })
    const overall = report.groups.find((g) => g.group === "overall")!
    expect(overall.tp).toBe(6)
    expect(overall.fp).toBe(3)
    expect(overall.borderline).toBe(1)
    expect(overall.n).toBe(9) // borderline excluded from denominator
    expect(overall.fpRate).toBeCloseTo(1 / 3, 5)
    expect(overall.precision).toBeCloseTo(2 / 3, 5)
    expect(overall.wilsonUpper).toBeGreaterThan(overall.fpRate!)
  })

  it("worst-case meets-target counts borderline as potentially FP", () => {
    // 30 posted: 0 FP labeled, 4 borderline -> point fpRate 0%, but worst case
    // 4/30 = 13.3% > 10% target -> NOT meets.
    const findings = [
      ...Array.from({ length: 26 }, (_, i) => f(`tp${i}`, "logic")),
      ...Array.from({ length: 4 }, (_, i) => f(`bl${i}`, "logic")),
    ]
    const labels = [
      ...Array.from({ length: 26 }, (_, i) => l(`tp${i}`, "TP")),
      ...Array.from({ length: 4 }, (_, i) => l(`bl${i}`, "borderline")),
    ]
    const overall = computeEvalReport(joinFindingsToLabels(findings, labels), { minN: 20, target: 0.1 }).groups[0]!
    expect(overall.fpRate).toBe(0) // labeled FP rate
    expect(overall.meetsTarget).toBe(false) // worst case 4/30 > 10%
  })

  it("gates on min-n", () => {
    const j = joinFindingsToLabels([f("a", "logic"), f("b", "logic")], [l("a", "TP"), l("b", "FP")])
    const overall = computeEvalReport(j, { minN: 20 }).groups[0]!
    expect(overall.sufficientN).toBe(false)
    expect(overall.meetsTarget).toBeNull()
    expect(overall.fpRate).toBeCloseTo(0.5, 5) // rate still computed, just flagged
  })

  it("breaks down per category, sorted, with overall first", () => {
    const findings = [f("a", "security"), f("b", "security"), f("c", "logic")]
    const labels = [l("a", "FP"), l("b", "FP"), l("c", "TP")]
    const report = computeEvalReport(joinFindingsToLabels(findings, labels), { minN: 1 })
    expect(report.groups[0]!.group).toBe("overall")
    const cats = report.groups.slice(1).map((g) => g.group)
    expect(cats).toEqual(["logic", "security"]) // sorted
    const sec = report.groups.find((g) => g.group === "security")!
    expect(sec.fpRate).toBe(1) // 2/2
  })

  it("handles an empty corpus without crashing", () => {
    const report = computeEvalReport(joinFindingsToLabels([], []), { minN: 20 })
    expect(report.groups).toHaveLength(1) // overall only
    expect(report.groups[0]!.fpRate).toBeNull()
    expect(report.groups[0]!.wilsonLower).toBe(0)
    expect(report.groups[0]!.wilsonUpper).toBe(1)
  })
})

describe("formatEvalCsv", () => {
  it("emits header + a row per group", () => {
    const j = joinFindingsToLabels([f("a", "logic"), f("b", "security")], [l("a", "TP"), l("b", "FP")])
    const csv = formatEvalCsv(computeEvalReport(j, { minN: 1 }))
    const lines = csv.split("\n")
    expect(lines[0]).toBe(EVAL_CSV_HEADER)
    expect(lines).toHaveLength(4) // header + overall + logic + security
    expect(lines.some((x) => x.startsWith("overall,"))).toBe(true)
  })
})
