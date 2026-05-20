// SIG-108: role-scoped deterministic-fact routing.
//
// Each ensemble specialist sees ONLY its own domain's deterministic
// facts — the security specialist gets secret-scan / dep-vuln /
// AST-security / SARIF / the security evidence manifest; logic gets
// AST-correctness + regex deterministic-checks; performance gets
// AST-performance; tests gets docs-coverage. This eliminates the
// cross-domain leak where (e.g.) the logic specialist's prompt carried
// secret-scan output.
//
// The SIG-91 diff-classification block and the ARC-182 stack block are
// deliberately NOT routed here — they're shared diff topology / ambient
// context, not domain facts (per Codex sign-off), and the orchestrator
// passes them to every role.
//
// Extracted as a pure function so the "no cross-domain leak" contract is
// directly unit-testable (the orchestrator that calls it is too large to
// exercise in isolation).

import type { SpecialistRole } from "./ensemble-router"
import type { AstFinding } from "./ast-rules/types"
import { renderAstFindingsForPrompt } from "./ast-rules/render"

export interface RoleScopedFactInputs {
  /** ARC-187 secret-scan hits block (security). */
  secretScanBlock: string
  /** ARC-186 dependency-vulnerability block (security). */
  depVulnBlock: string
  /** ARC-188 SARIF evidence block (security). */
  sarifBlock: string
  /** ARC-193 regex deterministic-checks block (logic). */
  deterministicBlock: string
  /** ARC-272 docs-coverage block (tests). */
  docsCoverageBlock: string
  /** SIG-108 security evidence manifest render (security). */
  securityManifestBlock: string
  /** ARC-181 AST findings, split here by `roleHint`. */
  astFindings: readonly AstFinding[]
}

/**
 * Build the per-role deterministic-fact block map. Pure: no I/O, order-
 * stable. A role's block is the omit-empty join of its domain's facts;
 * an empty block means that role gets no `deterministicChecksBlock`.
 */
export function buildFactsByRole(inputs: RoleScopedFactInputs): Record<SpecialistRole, string> {
  const join = (blocks: string[]): string => blocks.filter((s) => s.length > 0).join("\n\n")
  const astBlock = (role: AstFinding["roleHint"]): string =>
    renderAstFindingsForPrompt(inputs.astFindings.filter((f) => f.roleHint === role))

  return {
    security: join([
      inputs.secretScanBlock,
      inputs.depVulnBlock,
      astBlock("security"),
      inputs.sarifBlock,
      inputs.securityManifestBlock,
    ]),
    logic: join([astBlock("logic"), inputs.deterministicBlock]),
    performance: join([astBlock("performance")]),
    tests: join([inputs.docsCoverageBlock]),
  }
}
