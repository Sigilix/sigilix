// ARC-188 — SARIF render tests.

import { describe, it, expect } from "vitest"
import {
  renderSarifFindingsForPrompt,
  renderSarifFindingsAsJsonForSynth,
} from "@/src/features/sarif-evidence/render/render"
import type { SarifFinding, SbomSummary } from "@/src/features/sarif-evidence/domain/types"

const TRIAGE_NOTE =
  "Deterministic tool output is evidence, not a final verdict; inspect/refute against visible code, and refute only with proof, before emitting."

const F = (overrides: { [K in keyof SarifFinding]?: SarifFinding[K] | undefined } = {}): SarifFinding => {
  const base: Record<string, unknown> = {
    ruleId: "X",
    severity: "warning",
    roleHint: "security",
    category: "vulnerability",
    path: "src/a.ts",
    line: 1,
    message: "default",
    toolName: "Trivy",
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key]
    else base[key] = value
  }
  return base as unknown as SarifFinding
}

describe("renderSarifFindingsForPrompt", () => {
  it("empty findings → empty string", () => {
    expect(renderSarifFindingsForPrompt([])).toBe("")
  })

  it("emits canonical header + finding stanza", () => {
    const out = renderSarifFindingsForPrompt([F({ ruleId: "R1", message: "msg" })])
    expect(out).toContain("[SARIF EVIDENCE — pre-LLM]")
    expect(out).toContain(`1 finding surfaced from SARIF. ${TRIAGE_NOTE}`)
    expect(out).not.toContain("not shown or inspected")
    expect(out).toContain("rule_id: R1")
    expect(out).toContain("severity: warning")
    expect(out).toContain("category: vulnerability")
    expect(out).toContain("role_hint: security")
    expect(out).toContain("tool: Trivy")
    expect(out).toContain("path: src/a.ts:1")
    expect(out).toContain("message: msg")
  })

  it("sorts severity desc, then path asc", () => {
    const findings = [
      F({ ruleId: "low", severity: "info", path: "z.ts" }),
      F({ ruleId: "high", severity: "error", path: "b.ts" }),
      F({ ruleId: "warn", severity: "warning", path: "a.ts" }),
    ]
    const out = renderSarifFindingsForPrompt(findings)
    const highIdx = out.indexOf("rule_id: high")
    const warnIdx = out.indexOf("rule_id: warn")
    const lowIdx = out.indexOf("rule_id: low")
    expect(highIdx).toBeLessThan(warnIdx)
    expect(warnIdx).toBeLessThan(lowIdx)
  })

  it("per-file render cap kicks in at 11+ findings on same path", () => {
    const findings = Array.from({ length: 15 }, (_, i) => F({ ruleId: `R-${i}`, path: "src/a.ts" }))
    const out = renderSarifFindingsForPrompt(findings)
    // Only first 10 rule_ids appear in the prompt
    let count = 0
    for (let i = 0; i < 15; i++) {
      if (out.includes(`rule_id: R-${i}`)) count++
    }
    expect(count).toBe(10)
    expect(out).toContain("dropped by per-file render cap")
    expect(out).toContain("not shown or inspected")
    expect(out).toContain(
      `10 findings surfaced from SARIF (5 additional dropped by per-file render cap; not shown or inspected). ${TRIAGE_NOTE}`,
    )
  })

  it("does NOT cap per-file when paths differ", () => {
    const findings = Array.from({ length: 12 }, (_, i) => F({ ruleId: `R-${i}`, path: `src/file-${i}.ts` }))
    const out = renderSarifFindingsForPrompt(findings)
    // All 12 emitted (one per unique path, all under cap)
    let count = 0
    for (let i = 0; i < 12; i++) {
      if (out.includes(`rule_id: R-${i}`)) count++
    }
    expect(count).toBe(12)
  })

  it("omits line suffix when line is undefined (path-only IaC findings)", () => {
    const out = renderSarifFindingsForPrompt([F({ ruleId: "Y", line: undefined, path: "k8s/dep.yaml" })])
    expect(out).toMatch(/path: k8s\/dep\.yaml$/m)
    expect(out).not.toContain("k8s/dep.yaml:")
  })

  it("emits evidence when present", () => {
    const out = renderSarifFindingsForPrompt([F({ evidence: "snippet" })])
    expect(out).toContain("evidence: snippet")
  })

  it("renders compact deterministic source/tool labels when metadata is present", () => {
    const out = renderSarifFindingsForPrompt([
      F({ toolName: "ESLint", toolId: "eslint", source: "deterministic-tool" }),
    ])
    expect(out).toContain("source: deterministic-tool/eslint")
  })

  it("frames deterministic tool output as candidate evidence, not an unquestionable verdict", () => {
    const out = renderSarifFindingsForPrompt([
      F({ toolName: "PHPStan", toolId: "phpstan", source: "deterministic-tool", ruleId: "phpstan/type-error" }),
    ])
    expect(out).toContain("Deterministic tool output is evidence, not a final verdict")
    expect(out).toContain("inspect/refute against visible code")
    expect(out).toContain("refute only with proof")
    expect(out).not.toContain("do NOT question them")
  })

  it("renders compact dropped-result summaries when metadata is present", () => {
    const out = renderSarifFindingsForPrompt([
      F({ toolId: "eslint", droppedResults: { toolId: "eslint", droppedCount: 4, keptCount: 9 } }),
    ])
    expect(out).toContain("dropped_results: 4 dropped, 9 kept")
    expect(out.match(/dropped_results:/g)).toHaveLength(1)
  })

  it("keeps dropped-result summaries visible when the carrier finding is capped out", () => {
    const cappedFindings = Array.from({ length: 10 }, (_, i) =>
      F({ ruleId: `kept-${i}`, severity: "error", path: "src/a.ts" }),
    )
    const carrier = F({
      ruleId: "carrier",
      severity: "info",
      path: "src/a.ts",
      toolId: "eslint",
      droppedResults: { toolId: "eslint", droppedCount: 42, keptCount: 11 },
    })

    const out = renderSarifFindingsForPrompt([...cappedFindings, carrier])

    expect(out).not.toContain("rule_id: carrier")
    expect(out).toContain("dropped_results: eslint: 42 dropped, 11 kept")
  })

  it("omits evidence line when absent", () => {
    const out = renderSarifFindingsForPrompt([F({ evidence: undefined })])
    expect(out).not.toContain("evidence:")
  })

  it("does NOT contain SBOM block (synth-only contract — Kimi MINOR #5)", () => {
    const out = renderSarifFindingsForPrompt([F()])
    expect(out).not.toContain("[SBOM SUMMARY")
    expect(out).not.toContain("Total packages")
  })
})

describe("renderSarifFindingsAsJsonForSynth", () => {
  const emptySbom: SbomSummary = {
    text: "",
    present: false,
    packageCount: 0,
    directDepCount: 0,
    licenseCounts: {},
  }
  const presentSbom: SbomSummary = {
    text: "[SBOM SUMMARY — pre-LLM]\nTotal packages: 5",
    present: true,
    packageCount: 5,
    directDepCount: 2,
    licenseCounts: { MIT: 3, "Apache-2.0": 2 },
  }

  it("returns empty when both findings + sbom are empty", () => {
    expect(renderSarifFindingsAsJsonForSynth([], emptySbom)).toBe("")
    expect(renderSarifFindingsAsJsonForSynth([])).toBe("")
  })

  it("returns valid JSON parseable to {sarif_findings: [...]}", () => {
    const out = renderSarifFindingsAsJsonForSynth([F({ ruleId: "Z", message: "m" })])
    const parsed = JSON.parse(out) as { sarif_findings: Array<Record<string, unknown>> }
    expect(parsed.sarif_findings.length).toBe(1)
    expect(parsed.sarif_findings[0]!.rule_id).toBe("Z")
  })

  it("preserves structured fields including tool + category + role_hint", () => {
    const out = renderSarifFindingsAsJsonForSynth([F({ ruleId: "X", category: "license", roleHint: "security" })])
    const parsed = JSON.parse(out) as { sarif_findings: Array<Record<string, unknown>> }
    expect(parsed.sarif_findings[0]!.category).toBe("license")
    expect(parsed.sarif_findings[0]!.role_hint).toBe("security")
    expect(parsed.sarif_findings[0]!.tool).toBe("Trivy")
  })

  it("preserves deterministic metadata and dropped-result summaries in structured output", () => {
    const out = renderSarifFindingsAsJsonForSynth([
      F({
        toolName: "ESLint",
        toolId: "eslint",
        source: "deterministic-tool",
        droppedResults: { toolId: "eslint", droppedCount: 2 },
      }),
    ])
    const parsed = JSON.parse(out) as { sarif_findings: Array<Record<string, unknown>> }
    expect(parsed.sarif_findings[0]!.source).toBe("deterministic-tool")
    expect(parsed.sarif_findings[0]!.tool_id).toBe("eslint")
    expect(parsed.sarif_findings[0]!.dropped_results).toEqual({ tool_id: "eslint", dropped_count: 2 })
  })

  it("appends SBOM summary AFTER the JSON block when present", () => {
    const out = renderSarifFindingsAsJsonForSynth([F()], presentSbom)
    expect(out).toContain("[SBOM SUMMARY — pre-LLM]")
    const jsonEnd = out.indexOf("}\n\n[SBOM")
    expect(jsonEnd).toBeGreaterThan(0)
  })

  it("emits SBOM-only output when findings empty but SBOM present", () => {
    const out = renderSarifFindingsAsJsonForSynth([], presentSbom)
    expect(out).toContain("[SBOM SUMMARY")
    expect(out).not.toContain("sarif_findings")
  })
})
