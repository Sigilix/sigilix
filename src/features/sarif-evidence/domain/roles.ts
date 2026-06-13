import type { RoleHint } from "./types"

interface RoleScopedSarifFinding {
  roleHint: RoleHint
  roleHints?: readonly RoleHint[] | undefined
}

/**
 * Returns the role set for a SARIF finding; an empty roleHints array is treated
 * as absent so the primary roleHint remains the fallback routing contract.
 */
export function rolesForSarifFinding(finding: RoleScopedSarifFinding): readonly RoleHint[] {
  return finding.roleHints?.length ? finding.roleHints : [finding.roleHint]
}

export function sarifFindingHasRole(finding: RoleScopedSarifFinding, role: RoleHint): boolean {
  return rolesForSarifFinding(finding).includes(role)
}
