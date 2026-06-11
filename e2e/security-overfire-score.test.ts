import { describe, it, expect } from "vitest"
import {
  SECURITY_OVERFIRE_CASES,
  aggregate,
  applySecurityUsageGate,
  scoreCase,
  type SecurityScoredFinding,
} from "./security-overfire-corpus"

const safeRegex = () => SECURITY_OVERFIRE_CASES.find((c) => c.id === "safe-regexp-exec-detector")!
const realExec = () => SECURITY_OVERFIRE_CASES.find((c) => c.id === "real-child-process-exec")!
const realToolingExec = () => SECURITY_OVERFIRE_CASES.find((c) => c.id === "real-exec-in-security-tooling")!

describe("security overfire scorer", () => {
  it("counts a score>=4 security finding on a safe mention case as a false positive", () => {
    const findings: SecurityScoredFinding[] = [
      {
        path: "src/lib/ast-rules/scan-dynamic-html-sink.ts",
        line: 7,
        score: 5,
        category: "security",
        cweId: "CWE-78",
        headline: "Command injection via `exec`",
        body: "`re.exec(line)` executes user data in a shell.",
      },
    ]
    expect(scoreCase(safeRegex(), findings).falsePositive).toBe(true)
  })

  it("does not count low-score security nits or non-security findings as blocker false positives", () => {
    expect(
      scoreCase(safeRegex(), [{ path: safeRegex().path, line: 7, score: 3, category: "security" }]).falsePositive,
    ).toBe(false)
    expect(
      scoreCase(safeRegex(), [{ path: safeRegex().path, line: 7, score: 5, category: "logic" }]).falsePositive,
    ).toBe(false)
  })

  it("counts a score>=4 security finding near a real sink as recall", () => {
    const findings: SecurityScoredFinding[] = [
      {
        path: "src/jobs/convert.ts",
        line: 5,
        score: 4,
        category: "security",
        cweId: "CWE-78",
      },
    ]
    expect(scoreCase(realExec(), findings).caught).toBe(true)
  })

  it("does not credit duplicate basenames from different parent directories", () => {
    const findings: SecurityScoredFinding[] = [
      {
        path: "tests/fixtures/convert.ts",
        line: 5,
        score: 4,
        category: "security",
        cweId: "CWE-78",
      },
    ]
    expect(scoreCase(realExec(), findings).caught).toBe(false)
  })

  it("applies the usage gate to remove RegExp.exec mention FPs from the inline metric", () => {
    const findings: SecurityScoredFinding[] = [
      {
        path: safeRegex().path,
        line: 7,
        score: 5,
        category: "security",
        cweId: "CWE-78",
        headline: "Command injection via `exec`",
        body: "`re.exec(line)` is a command injection sink.",
      },
    ]
    expect(scoreCase(safeRegex(), findings).falsePositive).toBe(true)
    const postGate = applySecurityUsageGate(safeRegex(), findings)
    expect(postGate).toEqual([])
    expect(scoreCase(safeRegex(), postGate).falsePositive).toBe(false)
  })

  it("keeps a real child_process.exec finding even on a security-tooling path", () => {
    const findings: SecurityScoredFinding[] = [
      {
        path: realToolingExec().path,
        line: 5,
        score: 5,
        category: "security",
        cweId: "CWE-78",
        headline: "Command injection through child_process.exec",
        body: "`exec` comes from `node:child_process` and interpolates `req.query.script`.",
      },
    ]
    expect(applySecurityUsageGate(realToolingExec(), findings)).toHaveLength(1)
    expect(scoreCase(realToolingExec(), findings).caught).toBe(true)
  })

  it("aggregates recall and false-positive rate", () => {
    const report = aggregate([
      scoreCase(realExec(), [{ path: realExec().path, line: 5, score: 4, category: "security", cweId: "CWE-78" }]),
      scoreCase(safeRegex(), [{ path: safeRegex().path, line: 7, score: 5, category: "security", cweId: "CWE-78" }]),
    ])
    expect(report.recall).toBe(1)
    expect(report.fpRate).toBe(1)
  })
})
