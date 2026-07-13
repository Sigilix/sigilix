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
