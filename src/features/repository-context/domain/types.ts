export type RepositoryContextProvider = "github" | "gitlab"
export type RepositoryContextAction = "replaced" | "purged"

export interface RepositoryContextRepository {
  externalId: string
  fullName: string
  context: string
  position: number
}

export interface RepositoryContextRelationship {
  fromExternalId: string
  toExternalId: string
  label: string
  normalizedLabel: string
  position: number
}

export interface RepositoryContextSnapshot {
  provider: RepositoryContextProvider
  scopeId: string
  revision: number
  repositories: RepositoryContextRepository[]
  relationships: RepositoryContextRelationship[]
  conventions: string
  snapshotSha256: string
  createdAt: string
  updatedAt: string
  updatedBy: string
  deletedAt: string | null
}

export interface ReplaceRepositoryContextArgs {
  provider: RepositoryContextProvider
  scopeId: string
  expectedRevision: number
  repositories: RepositoryContextRepository[]
  relationships: RepositoryContextRelationship[]
  conventions: string
  nowIso: string
  updatedBy: string
}

export interface PurgeRepositoryContextArgs {
  provider: RepositoryContextProvider
  scopeId: string
  expectedRevision: number
  nowIso: string
  updatedBy: string
}

export type RepositoryContextReadResult =
  | { status: "ok"; snapshot: RepositoryContextSnapshot }
  | { status: "not_found" }
  | { status: "unavailable" }

export type RepositoryContextWriteResult =
  | { status: "updated"; snapshot: RepositoryContextSnapshot }
  | { status: "conflict"; currentRevision: number }
  | { status: "unavailable" }
