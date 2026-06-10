// ARC-188: SARIF prompt rendering.
//
// Two surfaces (mirror of ARC-181):
//   - `renderSarifFindingsForPrompt(findings)` — human-readable
//     `[SARIF EVIDENCE — pre-LLM]` block. Per-file 10-render cap
//     (Codex MINOR #6 prompt-flooding guard). SBOM stays OUT of
//     this surface (Kimi MINOR #5).
//   - `renderSarifFindingsAsJsonForSynth(findings, sbomText?)` —
//     structured JSON for the synth prompt + appended SBOM summary
//     for Fix Plan ordering (spec §3.6a).

import type { SarifFinding, SbomSummary } from "@/src/features/sarif-evidence/domain/types"

const PER_FILE_RENDER_CAP = 10

const SEVERITY_RANK: Record<SarifFinding["severity"], number> = {
  error: 2,
  warning: 1,
  info: 0,
}

function sortBySeverityThenPath(findings: readonly SarifFinding[]): SarifFinding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (sevDiff !== 0) return sevDiff
    return a.path.localeCompare(b.path)
  })
}

function applyPerFileCap(findings: readonly SarifFinding[]): SarifFinding[] {
  const counts = new Map<string, number>()
  const out: SarifFinding[] = []
  for (const f of findings) {
    const c = counts.get(f.path) ?? 0
    if (c >= PER_FILE_RENDER_CAP) continue
    counts.set(f.path, c + 1)
    out.push(f)
  }
  return out
}

export function renderSarifFindingsForPrompt(findings: readonly SarifFinding[]): string {
  if (findings.length === 0) return ""
  const sorted = sortBySeverityThenPath(findings)
  const capped = applyPerFileCap(sorted)
  const lines: string[] = []
  lines.push("[SARIF EVIDENCE — pre-LLM]")
  const droppedByCap = sorted.length - capped.length
  const summary = droppedByCap > 0
    ? `${capped.length} ${capped.length === 1 ? "finding" : "findings"} surfaced from SARIF (${droppedByCap} additional dropped by per-file render cap). Deterministic — do NOT question them.`
    : `${capped.length} ${capped.length === 1 ? "finding" : "findings"} surfaced from SARIF. Deterministic — do NOT question them.`
  lines.push(summary)
  lines.push("")
  for (const f of capped) {
    lines.push(`- rule_id: ${f.ruleId}`)
    lines.push(`  severity: ${f.severity}`)
    lines.push(`  category: ${f.category}`)
    lines.push(`  role_hint: ${f.roleHint}`)
    lines.push(`  tool: ${f.toolName}`)
    lines.push(`  path: ${f.path}${typeof f.line === "number" ? `:${f.line}` : ""}`)
    lines.push(`  message: ${f.message}`)
    if (f.evidence) lines.push(`  evidence: ${f.evidence}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function renderSarifFindingsAsJsonForSynth(
  findings: readonly SarifFinding[],
  sbom?: SbomSummary,
): string {
  const sbomBlock = sbom?.present ? sbom.text : ""
  if (findings.length === 0 && sbomBlock.length === 0) return ""
  const payload: Record<string, unknown> = {}
  if (findings.length > 0) {
    payload.sarif_findings = findings.map((f) => {
      const out: Record<string, unknown> = {
        rule_id: f.ruleId,
        severity: f.severity,
        category: f.category,
        role_hint: f.roleHint,
        tool: f.toolName,
        path: f.path,
        message: f.message,
      }
      if (typeof f.line === "number") out.line = f.line
      if (f.evidence) out.evidence = f.evidence
      return out
    })
  }
  const json = JSON.stringify(payload, null, 2)
  if (sbomBlock.length === 0) return json
  return `${json}\n\n${sbomBlock}`
}
