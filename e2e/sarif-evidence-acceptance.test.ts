// ARC-188 — fixture-locked acceptance tests (Codex MAJOR #6).
//
// Per Linear AC: 1 IaC + 1 dep/license + 1 Rego metadata fixture.
// These wire the full parse → normalize → taxonomy → diff-filter →
// render pipeline against real SARIF shapes so a regression in any
// piece of the chain shows up here.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runSarifEvidence, type ResolvedSarifConfig } from "@/src/features/sarif-evidence/app/runner"
import { sarifFindingHasRole } from "@/src/features/sarif-evidence"
import { buildFactsByRole } from "@/src/lib/role-scoped-facts"
import { buildSecurityFactManifest } from "@/src/lib/security-evidence-manifest"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const FIXTURE_DIR = join(__dirname, "fixtures", "sarif")
const fixture = (name: string): string => readFileSync(join(FIXTURE_DIR, name), "utf8")

const CTX = { owner: "o", repo: "r", prNumber: 1, headSha: "h".repeat(40) }
const fakeEnv = {} as unknown as Env
const fakeClient = (raw: string): GitHubClient => ({ getFileContent: async () => raw }) as unknown as GitHubClient

const DEFAULT_CONFIG: ResolvedSarifConfig = {
  enabled: true,
  path: ".sigilix/trivy.sarif.json",
  severityThreshold: "warning",
  disabledRules: [],
  disabledCategories: [],
}

const diffFor = (path: string, line: number): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line},0 +${line},1 @@\n+touched\n`

const runnerMetadata = (toolId: string): Record<string, unknown> => ({
  sigilixSchemaVersion: 1,
  sigilixToolId: toolId,
  sigilixSource: "deterministic-tool",
})

describe("ARC-188 acceptance — Trivy IaC fixture", () => {
  it("renders a K8s privileged-container finding correctly", async () => {
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(fixture("trivy-iac.sarif.json")),
      ...CTX,
      diff: diffFor("k8s/deployment.yaml", 14),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(1)
    const f = r.findings[0]!
    expect(f.ruleId).toBe("AVD-KSV-0017")
    expect(f.category).toBe("iac")
    expect(f.roleHint).toBe("security")
    expect(f.severity).toBe("error")
    expect(f.toolName).toBe("Trivy")
    expect(f.path).toBe("k8s/deployment.yaml")
    expect(f.line).toBe(14)
    expect(f.evidence).toContain("privileged: true")
  })
})

describe("SIG-107 acceptance — runner SARIF role-scoped facts", () => {
  it("renders multi-role tool evidence as in-lane for each receiving specialist", async () => {
    const report = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Ruff", properties: runnerMetadata("ruff") } },
          results: [
            {
              ruleId: "PERF401",
              level: "warning",
              message: { text: "Use a list comprehension" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "src/app.py" }, region: { startLine: 4 } } }],
            },
          ],
        },
        {
          tool: { driver: { name: "actionlint", properties: runnerMetadata("actionlint") } },
          results: [
            {
              ruleId: "actionlint/expression",
              level: "warning",
              message: { text: "Dangerous expression in workflow" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: ".github/workflows/ci.yml" },
                    region: { startLine: 8 },
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(report),
      ...CTX,
      diff: diffFor("src/app.py", 4) + diffFor(".github/workflows/ci.yml", 8),
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    const ruffFinding = r.findings.find((f) => f.ruleId === "PERF401")
    const actionlintFinding = r.findings.find((f) => f.ruleId === "actionlint/expression")
    expect(ruffFinding?.roleHint).toBe("logic")
    expect(ruffFinding?.roleHints).toEqual(["logic", "performance"])
    expect(actionlintFinding?.roleHint).toBe("logic")
    expect(actionlintFinding?.roleHints).toEqual(["logic", "security"])

    const facts = buildFactsByRole({
      secretScanBlock: "",
      depVulnBlock: "",
      sarifFindings: r.findings,
      deterministicBlock: "",
      docsCoverageBlock: "",
      coverageGapBlock: "",
      securityManifestBlock: "",
      perfBudgetBlock: "",
      astFindings: [],
    })

    expect(facts.performance).toContain("PERF401")
    expect(facts.performance).toContain("role_hint: performance")
    expect(facts.performance).not.toContain("role_hint: logic")
    expect(facts.performance).not.toContain("role_hints")
    expect(facts.logic).toContain("PERF401")
    expect(facts.logic).toContain("role_hint: logic")

    expect(facts.security).toContain("actionlint/expression")
    expect(facts.security).toContain("role_hint: security")
    expect(facts.security).not.toContain("role_hints")
    expect(facts.logic).toContain("actionlint/expression")
    expect(facts.logic).toContain("role_hint: logic")
    expect(facts.logic).not.toContain("role_hints")
    expect(ruffFinding?.roleHint).toBe("logic")
    expect(ruffFinding?.roleHints).toEqual(["logic", "performance"])
    expect(actionlintFinding?.roleHint).toBe("logic")
    expect(actionlintFinding?.roleHints).toEqual(["logic", "security"])

    const securityManifest = await buildSecurityFactManifest({
      secretHits: [],
      depVulnFindings: [],
      sarifFindings: r.findings.filter((f) => sarifFindingHasRole(f, "security")),
      astSecurityFindings: [],
    })
    expect(securityManifest.render()).toContain("sarif:actionlint/expression:")
    expect(securityManifest.render()).toContain("actionlint/actionlint/expression")
  })
})

describe("ARC-188 acceptance — dep + license fixture", () => {
  it("CVE → vulnerability/security; license → license/security (NOT logic)", async () => {
    const diff = diffFor("package.json", 12) + diffFor("package.json", 18)
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(fixture("dep-and-license.sarif.json")),
      ...CTX,
      diff,
      config: DEFAULT_CONFIG,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(2)

    const cve = r.findings.find((f) => f.ruleId === "CVE-2024-1234")
    expect(cve).toBeDefined()
    expect(cve?.category).toBe("vulnerability")
    expect(cve?.roleHint).toBe("security")
    expect(cve?.severity).toBe("error")

    const lic = r.findings.find((f) => f.ruleId === "TRIVY-LIC-001")
    expect(lic).toBeDefined()
    expect(lic?.category).toBe("license")
    expect(lic?.roleHint).toBe("security") // NOT logic
    expect(lic?.severity).toBe("warning")
  })
})

describe("ARC-188 acceptance — Kubescape Rego metadata fixture", () => {
  it("resolves taxonomy via run-level taxa table + raw toolName", async () => {
    const NOW = new Date("2026-05-06T16:30:00Z").getTime()
    const r = await runSarifEvidence({
      env: fakeEnv,
      client: fakeClient(fixture("kubescape-rego-meta.sarif.json")),
      ...CTX,
      diff: diffFor("k8s/pod.yaml", 7),
      config: DEFAULT_CONFIG,
      now: () => NOW,
    })
    expect(r.skipped).toBe(false)
    if (r.skipped) return
    expect(r.findings.length).toBe(1)
    const f = r.findings[0]!
    expect(f.ruleId).toBe("C-0001")
    expect(f.toolName).toBe("Kubescape")
    // Taxonomy resolved via result.taxa[].toolComponent.guid →
    // run.taxonomies[].taxa[]; "Kubernetes Network" name routes to iac
    expect(f.category).toBe("iac")
    expect(f.roleHint).toBe("security")
    // Fixture's invocations.endTimeUtc is 30 min before NOW — fresh,
    // no stale-report telemetry expected.
    expect(r.telemetry.staleReport).toBeUndefined()
  })
})
