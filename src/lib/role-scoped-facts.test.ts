// SIG-108: role-scoped fact routing — pins the "no cross-domain leak"
// acceptance criterion that the orchestrator (too large to exercise in
// isolation) relies on. Flagged for coverage by the Sigilix bot review.

import { describe, it, expect } from "vitest"
import { buildFactsByRole } from "@/src/lib/role-scoped-facts"
import type { AstFinding } from "@/src/features/ast-rules/domain/types"
import type { SarifFinding } from "@/src/features/sarif-evidence"

function ast(overrides: Partial<AstFinding> = {}): AstFinding {
  return {
    ruleId: "rule-x",
    severity: "error",
    roleHint: "security",
    path: "src/x.ts",
    line: 1,
    message: "msg",
    evidence: "ev",
    astFindingId: "ast-x",
    ...overrides,
  } as AstFinding
}

function sarif(overrides: Partial<SarifFinding> = {}): SarifFinding {
  return {
    ruleId: "sarif-rule",
    severity: "warning",
    roleHint: "security",
    category: "vulnerability",
    path: "src/x.ts",
    line: 1,
    message: "sarif msg",
    toolName: "Tool",
    ...overrides,
  }
}

const baseInputs = {
  secretScanBlock: "[SECRET SCAN] leaked key",
  depVulnBlock: "[DEP VULN] CVE-1",
  sarifFindings: [sarif({ ruleId: "security-sarif", roleHint: "security", toolName: "Semgrep" })],
  deterministicBlock: "[DETERMINISTIC] regex hit",
  docsCoverageBlock: "[DOCS COVERAGE] missing doc",
  coverageGapBlock: "[COVERAGE GAPS] uncovered lines",
  securityManifestBlock: "[SECURITY EVIDENCE MANIFEST] - id: secret:a:b:1",
  perfBudgetBlock: "[PERF BUDGETS] declared hot path touched",
  astFindings: [] as AstFinding[],
}

describe("buildFactsByRole — no cross-domain leak", () => {
  it("routes security facts (secret/dep-vuln/sarif/manifest) ONLY to the security role", () => {
    const f = buildFactsByRole(baseInputs)
    for (const sec of ["[SECRET SCAN]", "[DEP VULN]", "security-sarif", "[SECURITY EVIDENCE MANIFEST]"]) {
      expect(f.security).toContain(sec)
      expect(f.logic).not.toContain(sec)
      expect(f.performance).not.toContain(sec)
      expect(f.tests).not.toContain(sec)
    }
  })

  it("routes the deterministic-checks block ONLY to logic", () => {
    const f = buildFactsByRole(baseInputs)
    expect(f.logic).toContain("[DETERMINISTIC]")
    expect(f.security).not.toContain("[DETERMINISTIC]")
    expect(f.performance).not.toContain("[DETERMINISTIC]")
    expect(f.tests).not.toContain("[DETERMINISTIC]")
  })

  it("routes docs-coverage ONLY to tests", () => {
    const f = buildFactsByRole(baseInputs)
    expect(f.tests).toContain("[DOCS COVERAGE]")
    expect(f.security).not.toContain("[DOCS COVERAGE]")
    expect(f.logic).not.toContain("[DOCS COVERAGE]")
    expect(f.performance).not.toContain("[DOCS COVERAGE]")
  })

  it("routes the coverage-gap block ONLY to tests", () => {
    const f = buildFactsByRole(baseInputs)
    expect(f.tests).toContain("[COVERAGE GAPS]")
    expect(f.security).not.toContain("[COVERAGE GAPS]")
    expect(f.logic).not.toContain("[COVERAGE GAPS]")
    expect(f.performance).not.toContain("[COVERAGE GAPS]")
  })

  it("routes the perf-budgets block ONLY to performance", () => {
    const f = buildFactsByRole(baseInputs)
    expect(f.performance).toContain("[PERF BUDGETS]")
    expect(f.security).not.toContain("[PERF BUDGETS]")
    expect(f.logic).not.toContain("[PERF BUDGETS]")
    expect(f.tests).not.toContain("[PERF BUDGETS]")
  })

  it("splits AST findings by roleHint into the matching role", () => {
    const f = buildFactsByRole({
      ...baseInputs,
      astFindings: [
        ast({ ruleId: "sec-rule", roleHint: "security" }),
        ast({ ruleId: "logic-rule", roleHint: "logic" }),
        ast({ ruleId: "perf-rule", roleHint: "performance" }),
      ],
    })
    expect(f.security).toContain("sec-rule")
    expect(f.security).not.toContain("logic-rule")
    expect(f.logic).toContain("logic-rule")
    expect(f.logic).not.toContain("sec-rule")
    expect(f.performance).toContain("perf-rule")
    expect(f.performance).not.toContain("logic-rule")
    // AST findings never spill into the tests role.
    expect(f.tests).not.toContain("sec-rule")
    expect(f.tests).not.toContain("logic-rule")
    expect(f.tests).not.toContain("perf-rule")
  })

  it("routes legacy security-only SARIF only to security", () => {
    const f = buildFactsByRole({
      ...baseInputs,
      sarifFindings: [sarif({ ruleId: "legacy-security", roleHint: "security", toolName: "Semgrep" })],
    })
    expect(f.security).toContain("legacy-security")
    expect(f.logic).not.toContain("legacy-security")
    expect(f.performance).not.toContain("legacy-security")
    expect(f.tests).not.toContain("legacy-security")
  })

  it("routes ESLint logic SARIF to logic and not security/performance/tests", () => {
    const f = buildFactsByRole({
      ...baseInputs,
      sarifFindings: [
        sarif({
          ruleId: "eslint-logic",
          roleHint: "logic",
          roleHints: ["logic"],
          toolId: "eslint",
          source: "deterministic-tool",
          toolName: "ESLint",
        }),
      ],
    })
    expect(f.logic).toContain("eslint-logic")
    expect(f.security).not.toContain("eslint-logic")
    expect(f.performance).not.toContain("eslint-logic")
    expect(f.tests).not.toContain("eslint-logic")
  })

  it("routes Ruff logic+performance SARIF to logic and performance, not security/tests", () => {
    const f = buildFactsByRole({
      ...baseInputs,
      sarifFindings: [
        sarif({
          ruleId: "ruff-dual",
          roleHint: "logic",
          roleHints: ["logic", "performance"],
          toolId: "ruff",
          source: "deterministic-tool",
          toolName: "Ruff",
        }),
      ],
    })
    expect(f.logic).toContain("ruff-dual")
    expect(f.performance).toContain("ruff-dual")
    expect(f.security).not.toContain("ruff-dual")
    expect(f.tests).not.toContain("ruff-dual")
  })

  it("routes Actionlint logic+security SARIF to logic and security", () => {
    const f = buildFactsByRole({
      ...baseInputs,
      sarifFindings: [
        sarif({
          ruleId: "actionlint-dual",
          roleHint: "logic",
          roleHints: ["logic", "security"],
          toolId: "actionlint",
          source: "deterministic-tool",
          toolName: "Actionlint",
        }),
      ],
    })
    expect(f.logic).toContain("actionlint-dual")
    expect(f.security).toContain("actionlint-dual")
    expect(f.performance).not.toContain("actionlint-dual")
    expect(f.tests).not.toContain("actionlint-dual")
  })

  it("keeps the security manifest block security-only", () => {
    const f = buildFactsByRole({
      ...baseInputs,
      secretScanBlock: "",
      depVulnBlock: "",
      deterministicBlock: "",
      docsCoverageBlock: "",
      coverageGapBlock: "",
      perfBudgetBlock: "",
      sarifFindings: [sarif({ ruleId: "logic-only", roleHint: "logic", roleHints: ["logic"], toolName: "ESLint" })],
    })
    expect(f.security).toContain("[SECURITY EVIDENCE MANIFEST]")
    expect(f.logic).toContain("logic-only")
    expect(f.logic).not.toContain("[SECURITY EVIDENCE MANIFEST]")
    expect(f.performance).not.toContain("[SECURITY EVIDENCE MANIFEST]")
    expect(f.tests).not.toContain("[SECURITY EVIDENCE MANIFEST]")
  })

  it("yields an empty block for a role with no facts (omit-when-empty)", () => {
    const f = buildFactsByRole({
      secretScanBlock: "",
      depVulnBlock: "",
      deterministicBlock: "",
      docsCoverageBlock: "",
      coverageGapBlock: "",
      securityManifestBlock: "",
      perfBudgetBlock: "",
      astFindings: [],
      sarifFindings: [],
    })
    expect(f.security).toBe("")
    expect(f.logic).toBe("")
    expect(f.performance).toBe("")
    expect(f.tests).toBe("")
  })
})
