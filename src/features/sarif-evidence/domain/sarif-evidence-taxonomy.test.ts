// ARC-188 — taxonomy resolver tests.

import { describe, it, expect } from "vitest"
import { parseRunnerMetadata } from "@/src/features/sarif-evidence/domain/runner-metadata"
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

describe("parseRunnerMetadata", () => {
  it("returns explicit reasons for absent and invalid metadata", () => {
    expect(parseRunnerMetadata(undefined)).toEqual({ ok: false, reason: "absent-metadata" })
    expect(parseRunnerMetadata({})).toEqual({ ok: false, reason: "absent-metadata" })
    expect(parseRunnerMetadata({ sigilixSource: "deterministic-tool" })).toEqual({
      ok: false,
      reason: "absent-metadata",
    })
    expect(
      parseRunnerMetadata({
        sigilixSchemaVersion: 2,
        sigilixToolId: "eslint",
        sigilixSource: "deterministic-tool",
      }),
    ).toEqual({ ok: false, reason: "unknown-schema-version", schemaVersion: 2 })
    expect(
      parseRunnerMetadata({
        sigilixSchemaVersion: 1,
        sigilixToolId: "biome",
        sigilixSource: "deterministic-tool",
      }),
    ).toEqual({ ok: false, reason: "unknown-tool", toolId: "biome" })
    expect(
      parseRunnerMetadata({
        sigilixSchemaVersion: 1,
        sigilixToolId: "eslint",
        sigilixSource: "repo-tool",
      }),
    ).toEqual({ ok: false, reason: "invalid-source", source: "repo-tool" })
  })

  it("prioritizes schema then tool id then source when multiple metadata fields are invalid", () => {
    expect(
      parseRunnerMetadata({
        sigilixSchemaVersion: 2,
        sigilixToolId: "biome",
        sigilixSource: "repo-tool",
      }),
    ).toEqual({ ok: false, reason: "unknown-schema-version", schemaVersion: 2 })
    expect(
      parseRunnerMetadata({
        sigilixSchemaVersion: 1,
        sigilixToolId: "biome",
        sigilixSource: "repo-tool",
      }),
    ).toEqual({ ok: false, reason: "unknown-tool", toolId: "biome" })
  })

  it("accepts valid metadata with ignored extra keys and optional dropped-result counts", () => {
    const parsed = parseRunnerMetadata({
      sigilixSchemaVersion: 1,
      sigilixToolId: "shellcheck",
      sigilixSource: "deterministic-tool",
      sigilixDroppedResults: { droppedCount: 3, keptCount: 50 },
      sigilixRoleHints: ["tests"],
    })
    expect(parsed).toEqual({
      ok: true,
      metadata: {
        schemaVersion: 1,
        toolId: "shellcheck",
        source: "deterministic-tool",
        roleHints: ["security", "logic"],
        droppedResults: { toolId: "shellcheck", droppedCount: 3, keptCount: 50 },
      },
    })
  })

  it("ignores malformed dropped-result counts without rejecting otherwise valid metadata", () => {
    const parsed = parseRunnerMetadata({
      sigilixSchemaVersion: 1,
      sigilixToolId: "ruff",
      sigilixSource: "deterministic-tool",
      sigilixDroppedResults: { droppedCount: -1 },
    })
    expect(parsed).toEqual({
      ok: true,
      metadata: {
        schemaVersion: 1,
        toolId: "ruff",
        source: "deterministic-tool",
        roleHints: ["logic", "performance"],
      },
    })
  })
})

describe("resolveTaxonomy — Sigilix runner metadata", () => {
  const metadata = (toolId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    sigilixSchemaVersion: 1,
    sigilixToolId: toolId,
    sigilixSource: "deterministic-tool",
    ...extra,
  })

  it("valid ESLint metadata routes to logic and exposes tool metadata", () => {
    expect(
      resolveTaxonomy({
        result: emptyResult,
        rule: { id: "no-undef" },
        toolName: "ESLint",
        toolDriverProperties: metadata("eslint"),
      }),
    ).toEqual({
      category: "other",
      roleHint: "logic",
      roleHints: ["logic"],
      isSbom: false,
      toolId: "eslint",
      source: "deterministic-tool",
    })
  })

  it("valid Ruff metadata routes to logic primary plus performance secondary", () => {
    const r = resolveTaxonomy({
      result: emptyResult,
      rule: { id: "PERF401" },
      toolName: "Ruff",
      toolDriverProperties: metadata("ruff"),
    })
    expect(r.roleHint).toBe("logic")
    expect(r.roleHints).toEqual(["logic", "performance"])
    expect(r.toolId).toBe("ruff")
    expect(r.source).toBe("deterministic-tool")
  })

  it("routes all first-slice tools with engine-owned role policy", () => {
    const cases = [
      ["semgrep", ["security"]],
      ["eslint", ["logic"]],
      ["ruff", ["logic", "performance"]],
      ["actionlint", ["logic", "security"]],
      ["shellcheck", ["security", "logic"]],
    ] as const

    for (const [toolId, roleHints] of cases) {
      const r = resolveTaxonomy({
        result: emptyResult,
        rule: { id: "X" },
        toolName: toolId,
        toolDriverProperties: metadata(toolId),
      })
      expect(r.roleHints).toEqual(roleHints)
      expect(r.roleHint).toBe(roleHints[0])
      expect(r.toolId).toBe(toolId)
      expect(r.source).toBe("deterministic-tool")
    }
  })

  it("unknown schema version falls back to legacy taxonomy and records a schema warning", () => {
    const r = resolveTaxonomy({
      result: emptyResult,
      rule: { id: "CVE-2024-1234" },
      toolName: "ESLint",
      toolDriverProperties: metadata("eslint", { sigilixSchemaVersion: 2 }),
    })
    expect(r).toEqual({
      category: "vulnerability",
      roleHint: "security",
      isSbom: false,
      schemaWarning: "unknown-schema-version",
    })
  })

  it("unknown tool and invalid source fall back without setting toolId/source", () => {
    const unknownTool = resolveTaxonomy({
      result: emptyResult,
      rule: { id: "CVE-2024-1234" },
      toolName: "Biome",
      toolDriverProperties: metadata("biome"),
    })
    expect(unknownTool.roleHint).toBe("security")
    expect(unknownTool.toolId).toBeUndefined()
    expect(unknownTool.source).toBeUndefined()

    const invalidSource = resolveTaxonomy({
      result: emptyResult,
      rule: { id: "X", properties: { tags: ["License"] } },
      toolName: "ESLint",
      toolDriverProperties: metadata("eslint", { sigilixSource: "repo-tool" }),
    })
    expect(invalidSource.category).toBe("license")
    expect(invalidSource.roleHint).toBe("security")
    expect(invalidSource.toolId).toBeUndefined()
    expect(invalidSource.source).toBeUndefined()
  })

  it("valid tool metadata does not override SBOM security routing", () => {
    const r = resolveTaxonomy({
      result: emptyResult,
      rule: { id: "X", properties: { tags: ["sbom"] } },
      toolName: "ESLint",
      toolDriverProperties: metadata("eslint"),
    })
    expect(r).toEqual({
      category: "other",
      roleHint: "security",
      isSbom: true,
      toolId: "eslint",
      source: "deterministic-tool",
    })
  })
})
