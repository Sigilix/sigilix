// SIG-171: deterministic SARIF findings can post directly as GitHub Checks
// annotations, independent of whether the LLM review emits a matching finding.

import { describe, expect, it } from "vitest"
import { buildSarifCheckAnnotations } from "../src/lib/sarif-evidence/annotations"
import type { SarifFinding } from "../src/lib/sarif-evidence/types"

const F = (overrides: Partial<SarifFinding> = {}): SarifFinding => ({
  ruleId: "R1",
  severity: "warning",
  roleHint: "security",
  category: "vulnerability",
  path: "src/app.ts",
  line: 10,
  message: "scanner finding",
  toolName: "Semgrep",
  ...overrides,
})

describe("buildSarifCheckAnnotations", () => {
  it("maps SARIF severities to GitHub annotation levels", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ ruleId: "error", severity: "error", line: 1 }),
      F({ ruleId: "warning", severity: "warning", line: 2 }),
      F({ ruleId: "info", severity: "info", line: 3 }),
    ])

    expect(annotations.map((a) => [a.title, a.annotation_level])).toEqual([
      ["[SARIF error] Semgrep: error", "failure"],
      ["[SARIF warning] Semgrep: warning", "warning"],
      ["[SARIF info] Semgrep: info", "notice"],
    ])
  })

  it("sorts highest severity first, then path, line, and rule", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ ruleId: "z", severity: "warning", path: "z.ts", line: 2 }),
      F({ ruleId: "a", severity: "warning", path: "a.ts", line: 2 }),
      F({ ruleId: "b", severity: "warning", path: "a.ts", line: 1 }),
      F({ ruleId: "err", severity: "error", path: "m.ts", line: 99 }),
    ])

    expect(annotations.map((a) => `${a.path}:${a.start_line}:${a.title}`)).toEqual([
      "m.ts:99:[SARIF error] Semgrep: err",
      "a.ts:1:[SARIF warning] Semgrep: b",
      "a.ts:2:[SARIF warning] Semgrep: a",
      "z.ts:2:[SARIF warning] Semgrep: z",
    ])
  })

  it("drops path-only findings because GitHub Checks annotations need a line", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ ruleId: "path-only", line: undefined }),
      F({ ruleId: "line-zero", line: 0 }),
      F({ ruleId: "line-one", line: 1 }),
    ])

    expect(annotations).toHaveLength(1)
    expect(annotations[0]?.title).toBe("[SARIF warning] Semgrep: line-one")
  })

  it("includes scanner metadata and evidence in the annotation message", () => {
    const annotations = buildSarifCheckAnnotations([
      F({
        ruleId: "CWE-22",
        ruleName: "Path traversal",
        toolName: "Trivy",
        severity: "error",
        category: "iac",
        evidence: "privileged: true",
        ruleHelpText: "Containers should not run as privileged.",
      }),
    ])

    expect(annotations[0]?.title).toBe("[SARIF error] Trivy: Path traversal")
    expect(annotations[0]?.message).toContain("Rule: Path traversal (CWE-22)")
    expect(annotations[0]?.message).toContain("Tool: Trivy")
    expect(annotations[0]?.message).toContain("SARIF severity: error")
    expect(annotations[0]?.message).toContain("Category: iac")
    expect(annotations[0]?.message).toContain("Evidence: privileged: true")
    expect(annotations[0]?.message).toContain("Containers should not run as privileged.")
  })

  it("truncates long titles to GitHub's title budget", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ ruleName: "x".repeat(500) }),
    ])

    expect(annotations[0]?.title).toHaveLength(240)
    expect(annotations[0]?.title.endsWith("...")).toBe(true)
  })
})
