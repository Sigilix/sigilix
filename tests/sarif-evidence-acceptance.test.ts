// ARC-188 — fixture-locked acceptance tests (Codex MAJOR #6).
//
// Per Linear AC: 1 IaC + 1 dep/license + 1 Rego metadata fixture.
// These wire the full parse → normalize → taxonomy → diff-filter →
// render pipeline against real SARIF shapes so a regression in any
// piece of the chain shows up here.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runSarifEvidence, type ResolvedSarifConfig } from "../src/lib/sarif-evidence/runner"
import type { GitHubClient } from "../src/shared/adapters/github"
import type { Env } from "../src/shared/types/env"

const FIXTURE_DIR = join(__dirname, "fixtures", "sarif")
const fixture = (name: string): string =>
  readFileSync(join(FIXTURE_DIR, name), "utf8")

const CTX = { owner: "o", repo: "r", prNumber: 1, headSha: "h".repeat(40) }
const fakeEnv = {} as unknown as Env
const fakeClient = (raw: string): GitHubClient =>
  ({ getFileContent: async () => raw } as unknown as GitHubClient)

const DEFAULT_CONFIG: ResolvedSarifConfig = {
  enabled: true,
  path: ".sigilix/trivy.sarif.json",
  severityThreshold: "warning",
  disabledRules: [],
  disabledCategories: [],
}

const diffFor = (path: string, line: number): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line},0 +${line},1 @@\n+touched\n`

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
    const f = r.findings[0]
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
    const f = r.findings[0]
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
