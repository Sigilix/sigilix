import type { RoleHint } from "./types"

interface RoleScopedSarifFinding {
  roleHint: RoleHint
  roleHints?: readonly RoleHint[]
}

export function rolesForSarifFinding(finding: RoleScopedSarifFinding): readonly RoleHint[] {
  return finding.roleHints?.length ? finding.roleHints : [finding.roleHint]
}

export function sarifFindingHasRole(finding: RoleScopedSarifFinding, role: RoleHint): boolean {
  return rolesForSarifFinding(finding).includes(role)
}
