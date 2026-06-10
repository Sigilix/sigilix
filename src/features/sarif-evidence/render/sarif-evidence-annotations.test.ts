// SIG-171: deterministic SARIF findings can post directly as GitHub Checks
// annotations, independent of whether the LLM review emits a matching finding.

import { describe, expect, it } from "vitest"
import { buildSarifCheckAnnotations } from "@/src/features/sarif-evidence/render/annotations"
import type { SarifFinding } from "@/src/features/sarif-evidence/domain/types"

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
  it("returns no annotations for empty SARIF findings", () => {
    expect(buildSarifCheckAnnotations([])).toEqual([])
  })

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

  it("uses host-stable codepoint sorting for paths and rules", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ ruleId: "b", path: "src/a.ts", line: 1 }),
      F({ ruleId: "A", path: "src/a.ts", line: 1 }),
      F({ ruleId: "a", path: "Src/a.ts", line: 1 }),
    ])

    expect(annotations.map((a) => `${a.path}:${a.title}`)).toEqual([
      "Src/a.ts:[SARIF warning] Semgrep: a",
      "src/a.ts:[SARIF warning] Semgrep: A",
      "src/a.ts:[SARIF warning] Semgrep: b",
    ])
  })

  it("falls back to ruleId when ruleName is blank", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ ruleId: "no-eval", ruleName: "   " }),
    ])

    expect(annotations[0]?.title).toBe("[SARIF warning] Semgrep: no-eval")
    expect(annotations[0]?.message).toContain("Rule: no-eval")
    expect(annotations[0]?.message).not.toContain("unknown-rule")
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
    expect(annotations[0]?.message).toContain("Evidence omitted from public check annotation.")
    expect(annotations[0]?.message).not.toContain("privileged: true")
    expect(annotations[0]?.message).toContain("Rule help text omitted from public check annotation.")
    expect(annotations[0]?.message).not.toContain("Containers should not run as privileged.")
  })

  it("omits raw evidence and redacts secret-like public text", () => {
    const token = `sk-${"a".repeat(48)}`
    const annotations = buildSarifCheckAnnotations([
      F({
        message: `Do not expose ${token}`,
        evidence: `OPENAI_API_KEY=${token}`,
        ruleHelpText: `Example token ${token}`,
      }),
    ])

    expect(annotations[0]?.message).toContain("Evidence omitted from public check annotation.")
    expect(annotations[0]?.message).toContain("[REDACTED]")
    expect(annotations[0]?.message).not.toContain(token)
    expect(annotations[0]?.message).not.toContain("OPENAI_API_KEY=")
  })

  it("redacts long bearer tokens without redacting short placeholders", () => {
    const bearer = `Bearer ${"a".repeat(24)}`
    const annotations = buildSarifCheckAnnotations([
      F({ ruleId: "long-bearer", message: `Header ${bearer}` }),
      F({ ruleId: "short-bearer", message: "Use Bearer example in docs", line: 11 }),
    ])

    expect(annotations[0]?.message).toContain("Header [REDACTED]")
    expect(annotations[0]?.message).not.toContain(bearer)
    expect(annotations[1]?.message).toContain("Use Bearer example in docs")
  })

  it("redacts bearer tokens with base64 padding", () => {
    const bearer = `Bearer ${"a".repeat(22)}==`
    const annotations = buildSarifCheckAnnotations([
      F({ message: `Header ${bearer}` }),
    ])

    expect(annotations[0]?.message).toContain("Header [REDACTED]")
    expect(annotations[0]?.message).not.toContain(bearer)
  })

  it("redacts JWT-like tokens in public messages", () => {
    const jwt = `eyJ${"a".repeat(16)}.eyJ${"b".repeat(16)}.${"c".repeat(32)}`
    const annotations = buildSarifCheckAnnotations([
      F({ message: `OIDC token ${jwt}` }),
    ])

    expect(annotations[0]?.message).toContain("OIDC token [REDACTED]")
    expect(annotations[0]?.message).not.toContain(jwt)
  })

  it("truncates long titles to GitHub's title budget", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ ruleName: "x".repeat(500) }),
    ])

    expect(annotations[0]?.title).toHaveLength(240)
    expect(annotations[0]?.title.endsWith("...")).toBe(true)
  })

  it("truncates long messages to GitHub's annotation text budget", () => {
    const annotations = buildSarifCheckAnnotations([
      F({ message: "x".repeat(70000) }),
    ])

    expect(annotations[0]?.message).toHaveLength(60000)
    expect(annotations[0]?.message.endsWith("...")).toBe(true)
  })
})
