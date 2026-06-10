// Validates the subtle-logic recall scorer + corpus shape WITHOUT a model, so the
// harness plumbing (tests/logic-recall-eval.live.test.ts) is regression-guarded in CI. The
// real baseline run (which calls the logic specialist) is a manual `npm run
// logic-recall-eval` with OLLAMA_API_KEY.

import { describe, it, expect } from "vitest"
import {
  LOGIC_RECALL_CASES,
  scoreCase,
  aggregate,
  buildRightFileByPathFromDiff,
  type LogicRecallCase,
  type ScoredFinding,
} from "./logic-recall-corpus"

const vuln = (): LogicRecallCase => LOGIC_RECALL_CASES.find((c) => c.id === "toctou-balance")!
const safe = (): LogicRecallCase => LOGIC_RECALL_CASES.find((c) => c.id === "safe-toctou-atomic")!

describe("logic recall scorer", () => {
  it("vuln is CAUGHT when a score>=3 finding lands within the window of the defect", () => {
    const f: ScoredFinding[] = [{ path: "src/wallet.ts", line: 14, score: 4 }]
    expect(scoreCase(vuln(), f).caught).toBe(true)
  })
  it("vuln is MISSED when the finding is out of window", () => {
    const f: ScoredFinding[] = [{ path: "src/wallet.ts", line: 40, score: 4 }]
    expect(scoreCase(vuln(), f).caught).toBe(false)
  })
  it("vuln is MISSED when the finding is on a different file", () => {
    const f: ScoredFinding[] = [{ path: "src/other.ts", line: 13, score: 4 }]
    expect(scoreCase(vuln(), f).caught).toBe(false)
  })
  it("low-score nits (<3) do not count as a catch", () => {
    const f: ScoredFinding[] = [{ path: "src/wallet.ts", line: 13, score: 2 }]
    expect(scoreCase(vuln(), f).caught).toBe(false)
  })
  it("safe case is a FALSE POSITIVE when the specialist flags the correct code", () => {
    const f: ScoredFinding[] = [{ path: "src/wallet.ts", line: 12, score: 4 }]
    expect(scoreCase(safe(), f).falsePositive).toBe(true)
  })
  it("safe case is clean when no score>=3 finding lands on its path", () => {
    expect(scoreCase(safe(), [{ path: "src/wallet.ts", line: 12, score: 2 }]).falsePositive).toBe(false)
    expect(scoreCase(safe(), []).falsePositive).toBe(false)
  })
  it("aggregate computes recall + fp-rate", () => {
    const r = aggregate([
      scoreCase(vuln(), [{ path: "src/wallet.ts", line: 13, score: 4 }]),
      scoreCase(safe(), [{ path: "src/wallet.ts", line: 12, score: 4 }]),
    ])
    expect(r.recall).toBe(1)
    expect(r.fpRate).toBe(1)
  })
})

describe("corpus shape", () => {
  it("has vuln + safe cases across multiple bug classes", () => {
    const vulns = LOGIC_RECALL_CASES.filter((c) => c.label === "vuln")
    const safes = LOGIC_RECALL_CASES.filter((c) => c.label === "safe")
    expect(vulns.length).toBeGreaterThanOrEqual(8)
    expect(safes.length).toBeGreaterThanOrEqual(4)
    expect(new Set(vulns.map((c) => c.bugClass)).size).toBeGreaterThanOrEqual(5)
  })
  it("every case has a unified diff; every vuln has a positive buggyLine", () => {
    for (const c of LOGIC_RECALL_CASES) {
      expect(c.diff, c.id).toContain("diff --git")
      expect(c.diff, c.id).toContain("@@")
      if (c.label === "vuln") expect(c.buggyLine, c.id).toBeGreaterThan(0)
    }
  })
  it("case ids are unique", () => {
    const ids = LOGIC_RECALL_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("right-side file reconstruction for post-filtered live evals", () => {
  it("preserves new-side line numbers from corpus diffs", () => {
    const c = LOGIC_RECALL_CASES.find((x) => x.id === "safe-literal-substring-filter")!
    const source = buildRightFileByPathFromDiff(c.diff).get("src/search/filter.ts")
    expect(source?.split("\n")[0]).toBe("export function filterRows(rows: Row[], req: Req): Row[] {")
    expect(source?.split("\n")[1]).toBe("  const needle = String(req.query.q ?? \"\")")
    expect(source?.split("\n")[2]).toBe("  return rows.filter((r) => r.name.includes(needle))")
  })

  it("omits removed lines while advancing context and added lines", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2,3 +2,4 @@",
      " keep",
      "-old",
      "+new",
      " tail",
    ].join("\n")
    expect(buildRightFileByPathFromDiff(diff).get("src/a.ts")?.split("\n")).toEqual(["", "keep", "new", "tail"])
  })

  it("uses hunk header context only to fill missing wrapper lines", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,2 @@ export function f() {",
      " context",
      "+added",
      "@@ -10,2 +10,2 @@ wrong replacement {",
      " context",
      "+more",
    ].join("\n")
    const lines = buildRightFileByPathFromDiff(diff).get("src/a.ts")?.split("\n")
    expect(lines?.[8]).toBe("export function f() {")
    expect(lines?.[9]).toBe("context")
    expect(lines?.[10]).toBe("more")
  })
})
