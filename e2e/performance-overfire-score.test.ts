// SIG-341: deterministic tests for the performance-overfire eval scorer.

import { describe, expect, it } from "vitest"
import {
  PERFORMANCE_OVERFIRE_CASES,
  applyPerfEvidenceGate,
  scoreCase,
  type PerformanceScoredFinding,
} from "./performance-overfire-corpus"
import { buildChangedLineTextByPath } from "@/src/lib/ensemble/domain/gates/validate-logic-finding"

const nPlusOneCase = PERFORMANCE_OVERFIRE_CASES.find((c) => c.id === "real-n-plus-one-request")!
const safeLoopCase = PERFORMANCE_OVERFIRE_CASES.find((c) => c.id === "safe-tiny-fixed-loop")!
const safeSerialEvalCase = PERFORMANCE_OVERFIRE_CASES.find((c) => c.id === "safe-serial-live-eval-loop")!

describe("performance-overfire corpus", () => {
  it("all corpus diffs expose their target path to the perf evidence gate", () => {
    for (const c of PERFORMANCE_OVERFIRE_CASES) {
      expect(buildChangedLineTextByPath(c.diff).has(c.path), c.id).toBe(true)
    }
  })
})

describe("performance-overfire post-gate scoring", () => {
  it("keeps a high-severity finding anchored only by complexityEstimate", () => {
    const finding: PerformanceScoredFinding = {
      path: nPlusOneCase.path,
      line: nPlusOneCase.targetLine,
      score: 4,
      category: "performance",
      headline: "Sequential round trips in request handler",
      body: "The loop waits on one user lookup per request id.",
      complexityEstimate: "O(n) sequential round-trips on `ids`",
    }

    expect(applyPerfEvidenceGate(nPlusOneCase, [finding])).toEqual([finding])
  })

  it("keeps a high-severity finding anchored only by hotPathIdentifier", () => {
    const finding: PerformanceScoredFinding = {
      path: nPlusOneCase.path,
      line: nPlusOneCase.targetLine,
      score: 4,
      category: "performance",
      headline: "Sequential round trips in request handler",
      body: "The handler waits on one user lookup per request id.",
      hotPathIdentifier: "users",
    }

    expect(applyPerfEvidenceGate(nPlusOneCase, [finding])).toEqual([finding])
  })

  it("drops a vague high-severity finding on a changed path", () => {
    const finding: PerformanceScoredFinding = {
      path: nPlusOneCase.path,
      line: nPlusOneCase.targetLine,
      score: 4,
      category: "performance",
      headline: "This change is slow",
      body: "The new code may hurt performance under load.",
    }

    expect(applyPerfEvidenceGate(nPlusOneCase, [finding])).toEqual([])
  })

  it("scores a safe-case false positive as clean after the post-gate removes it", () => {
    const finding: PerformanceScoredFinding = {
      path: safeLoopCase.path,
      line: safeLoopCase.targetLine,
      score: 4,
      category: "performance",
      headline: "This fixed loop may be slow",
      body: "The loop might waste CPU.",
    }

    expect(scoreCase(safeLoopCase, [finding]).falsePositive).toBe(true)
    expect(scoreCase(safeLoopCase, applyPerfEvidenceGate(safeLoopCase, [finding])).falsePositive).toBe(false)
  })

  it("scores the intentional serial live-eval false positive as clean after the post-gate caps severity", () => {
    const finding: PerformanceScoredFinding = {
      path: safeSerialEvalCase.path,
      line: safeSerialEvalCase.targetLine,
      score: 4,
      category: "performance",
      headline: "Serial live-eval loop should parallelize `runCase`",
      body: "The loop awaits `runCase` for every case instead of using Promise.all.",
      complexityEstimate: "O(k*n) sequential `runCase` calls over `repeats` x `cases`",
    }

    const postGate = applyPerfEvidenceGate(safeSerialEvalCase, [finding])

    expect(scoreCase(safeSerialEvalCase, [finding]).falsePositive).toBe(true)
    expect(postGate).toHaveLength(1)
    expect(postGate[0]!.score).toBe(3)
    expect(scoreCase(safeSerialEvalCase, postGate).falsePositive).toBe(false)
  })
})
