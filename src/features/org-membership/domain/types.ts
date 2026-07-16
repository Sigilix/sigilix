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

/**
 * Canonical immutable-ID set from one complete exact-installation App roster
 * fetch. The snapshot is complete only as of that fetch; GitHub and D1 do not
 * share a transaction.
 */
export interface CompleteInstallationRosterSnapshot {
  readonly memberIds: readonly string[]
  readonly sqlTokenSet: string
}

const MAX_INSTALLATION_ROSTER_MEMBERS = 5_000

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

/**
 * Canonical positive-decimal GitHub account id safe to store in D1 TEXT. The
 * numeric-only grammar also makes `|` an impossible member of the SQL token
 * delimiter format.
 */
export function isOrgWorkspaceGithubUserId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false
  const numeric = Number(value)
  // The round trip rejects values outside JavaScript's exact integer range.
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

/** Canonicalize already-enumerated App-roster identities; completeness is checked by the caller. */
export function canonicalizeInstallationRosterMemberIds(
  values: readonly unknown[],
): CompleteInstallationRosterSnapshot | null {
  const unique = new Set<string>()
  for (const value of values) {
    if (!isOrgWorkspaceGithubUserId(value)) return null
    unique.add(value)
    if (unique.size > MAX_INSTALLATION_ROSTER_MEMBERS) return null
  }
  const memberIds = [...unique].sort(
    (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0),
  )
  return Object.freeze({
    memberIds: Object.freeze(memberIds),
    sqlTokenSet: memberIds.length === 0 ? "" : `|${memberIds.join("|")}|`,
  })
}

/** Recompute the canonical representation at persistence boundaries. */
export function isCompleteInstallationRosterSnapshot(value: unknown): value is CompleteInstallationRosterSnapshot {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<CompleteInstallationRosterSnapshot>
  if (!Array.isArray(candidate.memberIds) || typeof candidate.sqlTokenSet !== "string") return false
  const canonical = canonicalizeInstallationRosterMemberIds(candidate.memberIds)
  return (
    canonical !== null &&
    canonical.sqlTokenSet === candidate.sqlTokenSet &&
    canonical.memberIds.length === candidate.memberIds.length &&
    canonical.memberIds.every((memberId, index) => memberId === candidate.memberIds![index])
  )
}
