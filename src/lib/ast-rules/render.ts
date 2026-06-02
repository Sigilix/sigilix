// ARC-181: prompt rendering for AST findings.
//
// Two surfaces:
//
//   - `renderAstFindingsForPrompt(findings)` — human-readable
//     `[AST RULE FINDINGS — pre-LLM]` block injected alongside
//     ARC-186/ARC-187/ARC-193 facts. Mirrors their omit-when-empty
//     contract.
//
//   - `renderAstFindingsAsJsonForSynth(findings)` — machine-readable
//     JSON block the synth model uses for structured (path, line,
//     role_hint) supersession matching (spec §5.5). Embedded in the
//     synth prompt as a fenced code block.

import type { AstFinding } from "./types"

// CR catch on PR #67: prompt-block fields are line-delimited; an
// `evidence` or `message` value containing a literal newline would
// split the field across multiple lines and break deterministic
// parsing. Collapse all whitespace runs (including newlines) to a
// single space.
function normalizePromptScalar(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

export function renderAstFindingsForPrompt(findings: readonly AstFinding[]): string {
  if (findings.length === 0) return ""
  const lines: string[] = []
  lines.push("[AST RULE FINDINGS — pre-LLM]")
  lines.push(
    `${findings.length} ${findings.length === 1 ? "finding" : "findings"} surfaced by the AST rule pack. These are deterministic; do NOT question them.`,
  )
  lines.push("")
  for (const f of findings) {
    lines.push(`- rule_id: ${f.ruleId}`)
    lines.push(`  severity: ${f.severity}`)
    lines.push(`  role_hint: ${f.roleHint}`)
    lines.push(`  path: ${f.path}:${f.line}`)
    lines.push(`  message: ${normalizePromptScalar(f.message)}`)
    lines.push(`  evidence: ${normalizePromptScalar(f.evidence)}`)
    lines.push(`  ast_finding_id: ${f.astFindingId}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function renderAstFindingsAsJsonForSynth(findings: readonly AstFinding[]): string {
  if (findings.length === 0) return ""
  const payload = {
    ast_findings: findings.map((f) => ({
      id: f.astFindingId,
      rule_id: f.ruleId,
      path: f.path,
      line: f.line,
      severity: f.severity,
      role_hint: f.roleHint,
      message: f.message,
      evidence: f.evidence,
      // SIG-309 PR2: high-confidence FP-safe security sink the synth should
      // emit even with no matching specialist finding (see the synth block).
      ...(f.emitWhenUnmatched ? { deterministic_emit: true } : {}),
    })),
  }
  return JSON.stringify(payload, null, 2)
}
