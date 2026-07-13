export type OrgWorkspaceRole = "admin" | "member"

export interface OrgWorkspaceAccess {
  installationId: number
  githubUserId: string
  role: OrgWorkspaceRole
  createdAt: string
  updatedAt: string
  updatedBy: string
  revokedAt: string | null
}

export interface OrgWorkspaceMutationArgs {
  installationId: number
  githubUserId: string
  nowIso: string
  updatedBy: string
}

export type BootstrapFirstOrgAdminResult = "bootstrapped" | "not_bootstrapped"

export type AddOrgWorkspaceMemberResult = OrgWorkspaceAccess

export type SetOrgWorkspaceRoleResult =
  | { status: "updated"; access: OrgWorkspaceAccess }
  | { status: "not_found" }
  | { status: "last_admin" }

export type RemoveOrgWorkspaceAccessResult = { status: "removed" } | { status: "not_found" } | { status: "last_admin" }

export type RecoverOrgWorkspaceAdminResult = OrgWorkspaceAccess

export function isOrgWorkspaceRole(value: unknown): value is OrgWorkspaceRole {
  return value === "admin" || value === "member"
}

/** Canonical positive-decimal GitHub account id safe to store in D1 TEXT. */
export function isOrgWorkspaceGithubUserId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false
  const numeric = Number(value)
  // The round trip rejects values outside JavaScript's exact integer range.
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}
