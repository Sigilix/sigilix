// SIG-108: role-scoped fact routing — pins the "no cross-domain leak"
// acceptance criterion that the orchestrator (too large to exercise in
// isolation) relies on. Flagged for coverage by the Sigilix bot review.

import { describe, it, expect } from "vitest"
import { buildFactsByRole } from "../src/lib/role-scoped-facts"
import type { AstFinding } from "../src/lib/ast-rules/types"

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

const baseInputs = {
  secretScanBlock: "[SECRET SCAN] leaked key",
  depVulnBlock: "[DEP VULN] CVE-1",
  sarifBlock: "[SARIF] iac issue",
  deterministicBlock: "[DETERMINISTIC] regex hit",
  docsCoverageBlock: "[DOCS COVERAGE] missing doc",
  coverageGapBlock: "[COVERAGE GAPS] uncovered lines",
  securityManifestBlock: "[SECURITY EVIDENCE MANIFEST] - id: secret:a:b:1",
  astFindings: [] as AstFinding[],
}

describe("buildFactsByRole — no cross-domain leak", () => {
  it("routes security facts (secret/dep-vuln/sarif/manifest) ONLY to the security role", () => {
    const f = buildFactsByRole(baseInputs)
    for (const sec of ["[SECRET SCAN]", "[DEP VULN]", "[SARIF]", "[SECURITY EVIDENCE MANIFEST]"]) {
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

  it("yields an empty block for a role with no facts (omit-when-empty)", () => {
    const f = buildFactsByRole({
      secretScanBlock: "",
      depVulnBlock: "",
      sarifBlock: "",
      deterministicBlock: "",
      docsCoverageBlock: "",
      coverageGapBlock: "",
      securityManifestBlock: "",
      astFindings: [],
    })
    expect(f.security).toBe("")
    expect(f.logic).toBe("")
    expect(f.performance).toBe("")
    expect(f.tests).toBe("")
  })
})
