// ARC-181 — prompt rendering tests.

import { describe, it, expect } from "vitest"
import {
  renderAstFindingsForPrompt,
  renderAstFindingsAsJsonForSynth,
} from "@/src/features/ast-rules/render/render"
import type { AstFinding } from "@/src/features/ast-rules/domain/types"

const F1: AstFinding = {
  ruleId: "no-eval-call",
  severity: "error",
  roleHint: "security",
  path: "src/auth.ts",
  line: 42,
  column: 14,
  message: "Direct eval() call",
  evidence: `eval("payload")`,
  astFindingId: "ast/no-eval-call/abcdefa/42",
}

const F2: AstFinding = {
  ruleId: "no-throw-literal",
  severity: "warning",
  roleHint: "logic",
  path: "src/util.ts",
  line: 7,
  column: 2,
  message: "throw of literal value",
  evidence: `throw "boom"`,
  astFindingId: "ast/no-throw-literal/1234567/7",
}

describe("renderAstFindingsForPrompt", () => {
  it("returns empty string for empty findings", () => {
    expect(renderAstFindingsForPrompt([])).toBe("")
  })

  it("emits the canonical header for non-empty input", () => {
    const out = renderAstFindingsForPrompt([F1])
    expect(out).toContain("[AST RULE FINDINGS — pre-LLM]")
  })

  it("emits 'finding' (singular) for one finding", () => {
    const out = renderAstFindingsForPrompt([F1])
    expect(out).toMatch(/1 finding /)
  })

  it("emits 'findings' (plural) for multiple", () => {
    const out = renderAstFindingsForPrompt([F1, F2])
    expect(out).toMatch(/2 findings /)
  })

  it("includes every required field in each stanza", () => {
    const out = renderAstFindingsForPrompt([F1])
    expect(out).toContain("rule_id: no-eval-call")
    expect(out).toContain("severity: error")
    expect(out).toContain("role_hint: security")
    expect(out).toContain("path: src/auth.ts:42")
    expect(out).toContain("message: Direct eval() call")
    expect(out).toContain(`evidence: eval("payload")`)
    expect(out).toContain("ast_finding_id: ast/no-eval-call/abcdefa/42")
  })

  it("locks the literal severity strings (drift guard)", () => {
    const out = renderAstFindingsForPrompt([F1, F2])
    expect(out).toMatch(/severity: error/)
    expect(out).toMatch(/severity: warning/)
  })
})

describe("renderAstFindingsAsJsonForSynth", () => {
  it("returns empty string for empty findings", () => {
    expect(renderAstFindingsAsJsonForSynth([])).toBe("")
  })

  it("returns valid JSON parseable to { ast_findings: [...] }", () => {
    const out = renderAstFindingsAsJsonForSynth([F1])
    const parsed = JSON.parse(out) as { ast_findings: unknown[] }
    expect(Array.isArray(parsed.ast_findings)).toBe(true)
    expect(parsed.ast_findings.length).toBe(1)
  })

  it("preserves astFindingId, ruleId, path, line, severity, role_hint", () => {
    const out = renderAstFindingsAsJsonForSynth([F1])
    const parsed = JSON.parse(out) as { ast_findings: Array<Record<string, unknown>> }
    const item = parsed.ast_findings[0]!
    expect(item.id).toBe(F1.astFindingId)
    expect(item.rule_id).toBe(F1.ruleId)
    expect(item.path).toBe(F1.path)
    expect(item.line).toBe(F1.line)
    expect(item.severity).toBe(F1.severity)
    expect(item.role_hint).toBe(F1.roleHint)
  })

  it("renders multiple findings in array order", () => {
    const out = renderAstFindingsAsJsonForSynth([F1, F2])
    const parsed = JSON.parse(out) as { ast_findings: Array<{ id: string }> }
    expect(parsed.ast_findings[0]?.id).toBe(F1.astFindingId)
    expect(parsed.ast_findings[1]?.id).toBe(F2.astFindingId)
  })
})
