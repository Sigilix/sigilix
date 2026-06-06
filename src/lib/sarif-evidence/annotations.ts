// SIG-171: first-class deterministic SARIF lane for GitHub Checks.
//
// The SARIF evidence runner already normalizes scanner output for prompts.
// This adapter turns the same normalized findings into Check annotations so
// deterministic diagnostics can surface even when the LLM review degrades.

import type { CheckRunAnnotation } from "../github"
import type { SarifFinding } from "./types"

const CHECK_ANNOTATION_TEXT_LIMIT = 60000
const CHECK_ANNOTATION_TITLE_LIMIT = 240

const SEVERITY_RANK: Record<SarifFinding["severity"], number> = {
  error: 2,
  warning: 1,
  info: 0,
}

function annotationLevelForSarifSeverity(
  severity: SarifFinding["severity"],
): CheckRunAnnotation["annotation_level"] {
  switch (severity) {
    case "error":
      return "failure"
    case "warning":
      return "warning"
    case "info":
      return "notice"
  }
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+$/gm, "").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`
}

function nonBlank(value: string | undefined, fallback: string): string {
  const clean = value?.trim()
  return clean && clean.length > 0 ? clean : fallback
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function ruleParts(finding: SarifFinding): { ruleId: string; ruleName?: string; label: string } {
  const ruleId = nonBlank(finding.ruleId, "unknown-rule")
  const ruleName = finding.ruleName?.trim()
  const cleanRuleName = ruleName && ruleName.length > 0 ? ruleName : undefined
  return {
    ruleId,
    ...(cleanRuleName !== undefined ? { ruleName: cleanRuleName } : {}),
    label: cleanRuleName ?? ruleId,
  }
}

function hasAnchorableLine(finding: SarifFinding): finding is SarifFinding & { line: number } {
  return (
    finding.path.trim().length > 0 &&
    typeof finding.line === "number" &&
    Number.isInteger(finding.line) &&
    finding.line >= 1
  )
}

function sortForChecks(findings: readonly (SarifFinding & { line: number })[]): Array<SarifFinding & { line: number }> {
  return [...findings].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (sevDiff !== 0) return sevDiff
    const pathDiff = compareText(a.path, b.path)
    if (pathDiff !== 0) return pathDiff
    const lineDiff = a.line - b.line
    if (lineDiff !== 0) return lineDiff
    return compareText(a.ruleId, b.ruleId)
  })
}

function messageForFinding(finding: SarifFinding): string {
  const { ruleId, ruleName } = ruleParts(finding)
  const toolName = nonBlank(finding.toolName, "unknown-tool")
  const lines = [
    finding.message,
    "",
    `Rule: ${ruleName ? `${ruleName} (${ruleId})` : ruleId}`,
    `Tool: ${toolName}`,
    `SARIF severity: ${finding.severity}`,
    `Category: ${finding.category}`,
  ]
  if (finding.evidence) {
    lines.push("", `Evidence: ${finding.evidence}`)
  }
  if (finding.ruleHelpText) {
    lines.push("", finding.ruleHelpText)
  }
  return truncate(lines.join("\n"), CHECK_ANNOTATION_TEXT_LIMIT)
}

export function buildSarifCheckAnnotations(findings: readonly SarifFinding[]): CheckRunAnnotation[] {
  return sortForChecks(findings.filter(hasAnchorableLine)).map((finding) => ({
    path: finding.path,
    start_line: finding.line,
    end_line: finding.line,
    annotation_level: annotationLevelForSarifSeverity(finding.severity),
    title: truncate(
      `[SARIF ${finding.severity}] ${nonBlank(finding.toolName, "unknown-tool")}: ${ruleParts(finding).label}`,
      CHECK_ANNOTATION_TITLE_LIMIT,
    ),
    message: messageForFinding(finding),
  }))
}
