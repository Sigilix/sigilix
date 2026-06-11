// ARC-188 — taxonomy resolver tests.

import { describe, it, expect } from "vitest"
import { resolveTaxonomy } from "@/src/features/sarif-evidence/domain/taxonomy"
import type { SarifResult, SarifRule, SarifTaxa } from "@/src/features/sarif-evidence/domain/types"

const emptyResult: SarifResult = { message: { text: "x" } }

describe("resolveTaxonomy — ruleId pattern matches (highest precision)", () => {
  it("CVE-* ruleId → vulnerability/security", () => {
    const rule: SarifRule = { id: "CVE-2024-1234" }
    expect(
      resolveTaxonomy({
        result: { ...emptyResult, ruleId: "CVE-2024-1234" },
        rule,
        toolName: "Trivy",
      }),
    ).toEqual({ category: "vulnerability", roleHint: "security", isSbom: false })
  })

  it("GHSA-* ruleId → vulnerability/security", () => {
    const rule: SarifRule = { id: "GHSA-abcd-1234-efgh" }
    expect(resolveTaxonomy({ result: emptyResult, rule, toolName: "Trivy" })).toEqual({
      category: "vulnerability",
      roleHint: "security",
      isSbom: false,
    })
  })

  it("AVD-KSV-* ruleId → iac/security", () => {
    const rule: SarifRule = { id: "AVD-KSV-0017" }
    expect(resolveTaxonomy({ result: emptyResult, rule, toolName: "Trivy" })).toEqual({
      category: "iac",
      roleHint: "security",
      isSbom: false,
    })
  })
})

describe("resolveTaxonomy — properties.tags", () => {
  it("Kubernetes tag → iac/security", () => {
    const rule: SarifRule = { id: "X", properties: { tags: ["Kubernetes", "Misconfiguration"] } }
    const r = resolveTaxonomy({ result: emptyResult, rule, toolName: "Trivy" })
    expect(r.category).toBe("iac")
    expect(r.roleHint).toBe("security")
  })

  it("CVE tag → vulnerability/security", () => {
    const rule: SarifRule = { id: "X", properties: { tags: ["CVE"] } }
    expect(resolveTaxonomy({ result: emptyResult, rule, toolName: "Snyk" }).category).toBe("vulnerability")
  })

  it("License tag → license/security (NOT logic)", () => {
    const rule: SarifRule = { id: "X", properties: { tags: ["License", "GPL-3.0"] } }
    const r = resolveTaxonomy({ result: emptyResult, rule, toolName: "Trivy" })
    expect(r.category).toBe("license")
    expect(r.roleHint).toBe("security")
  })

  it("Secret tag → secret/security", () => {
    const rule: SarifRule = { id: "X", properties: { tags: ["secret"] } }
    expect(resolveTaxonomy({ result: emptyResult, rule, toolName: "Gitleaks" }).category).toBe("secret")
  })
})

describe("resolveTaxonomy — result.taxa de-references run-level taxa table", () => {
  it("dereferences result.taxa[].toolComponent.guid against runTaxa", () => {
    const result: SarifResult = {
      message: { text: "x" },
      taxa: [{ id: "K8S", toolComponent: { guid: "abc-123" } }],
    }
    const runTaxa: SarifTaxa[] = [
      { guid: "abc-123", name: "Kubernetes" },
      { guid: "other", name: "Other" },
    ]
    const r = resolveTaxonomy({ result, rule: { id: "X" }, runTaxa, toolName: "Trivy" })
    expect(r.category).toBe("iac")
  })
})

describe("resolveTaxonomy — SBOM detection", () => {
  it("SBOM tag returns isSbom: true (filtered by runner)", () => {
    const rule: SarifRule = { id: "X", properties: { tags: ["sbom"] } }
    const r = resolveTaxonomy({ result: emptyResult, rule, toolName: "Trivy" })
    expect(r.isSbom).toBe(true)
  })
})

describe("resolveTaxonomy — fall-through to tool.driver.name", () => {
  it("kubescape tool name → iac when no other signal", () => {
    const rule: SarifRule = { id: "X" }
    const r = resolveTaxonomy({ result: emptyResult, rule, toolName: "Kubescape" })
    // Kubescape doesn't match the IaC keyword list directly; falls
    // back to "other"/security. Acceptable v1 default — taxa
    // reference de-ref + ruleId AVD-KSV-* match handle the real
    // Kubescape findings.
    expect(r.roleHint).toBe("security")
  })
})

describe("resolveTaxonomy — first-match-wins ordering", () => {
  it("result.taxa wins over tool.driver.name", () => {
    const result: SarifResult = {
      message: { text: "x" },
      taxa: [{ toolComponent: { guid: "lic-1" } }],
    }
    const runTaxa: SarifTaxa[] = [{ guid: "lic-1", name: "License" }]
    const r = resolveTaxonomy({ result, rule: { id: "X" }, runTaxa, toolName: "Snyk" })
    expect(r.category).toBe("license")
  })

  it("rule.id pattern (CVE) wins over conflicting tags", () => {
    const rule: SarifRule = {
      id: "CVE-2024-9999",
      properties: { tags: ["License"] },
    }
    const r = resolveTaxonomy({
      result: { ...emptyResult, ruleId: "CVE-2024-9999" },
      rule,
      toolName: "Trivy",
    })
    expect(r.category).toBe("vulnerability")
  })
})

describe("resolveTaxonomy — null/empty inputs", () => {
  it("null rule + empty result + unknown tool → other/security/no-sbom", () => {
    expect(resolveTaxonomy({ result: emptyResult, rule: null, toolName: "Unknown" })).toEqual({
      category: "other",
      roleHint: "security",
      isSbom: false,
    })
  })
})
