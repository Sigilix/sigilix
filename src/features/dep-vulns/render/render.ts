// ARC-186: render dep-vuln findings as a structured fact block for
// the security specialist + synthesizer prompts. Empty input returns
// the empty string so callers can compose prompts with falsy
// short-circuits (consistent with ARC-187 secret-scan behavior).

import type { DepVulnFinding } from "@/src/features/dep-vulns/domain/finding"

/**
 * Render dep-vuln findings as a `[DEPENDENCY VULNERABILITIES — pre-LLM]`
 * block. Each finding is a structured stanza so the model treats the
 * output as authoritative facts (not prose to question).
 */
export function renderDepVulnFindingsForPrompt(findings: DepVulnFinding[]): string {
  if (findings.length === 0) return ""
  const lines: string[] = []
  lines.push("[DEPENDENCY VULNERABILITIES — pre-LLM]")
  lines.push(
    `${findings.length} ${findings.length === 1 ? "finding" : "findings"} surfaced by the bundled advisory DB. These are deterministic; do NOT question them.`,
  )
  lines.push("")
  for (const f of findings) {
    lines.push(`- package: ${f.package_name}@${f.version}`)
    lines.push(`  source_path: ${f.source_path}`)
    lines.push(`  advisory_id: ${f.advisory_id} (source: ${f.advisory_source})`)
    lines.push(`  severity: ${f.severity}`)
    lines.push(`  summary: ${f.summary}`)
    lines.push(`  vulnerable_range: ${f.vulnerable_range}`)
    lines.push(`  patched_in: ${f.patched_in}`)
    if (f.fix_guidance) lines.push(`  fix_guidance: ${f.fix_guidance}`)
    lines.push(`  match_type: ${f.match_type}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}
