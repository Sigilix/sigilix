import {
  readGitLabRepositoryAuthority,
  readRepositoryContext,
  replaceRepositoryContext,
} from "@/src/features/repository-context"

/**
 * Remove stale context rows after strong authority changes. This is deliberately
 * best effort: the HTTP read path independently filters to ACTIVE authority, so
 * a conflict or transient D1 failure cannot expose a disconnected repository.
 */
export async function reconcileGitLabRepositoryContextAfterAuthorityChange(
  db: D1Database,
  scopeId: string,
): Promise<"updated" | "noop" | "unavailable"> {
  const [authority, stored] = await Promise.all([
    readGitLabRepositoryAuthority(db, scopeId),
    readRepositoryContext(db, "gitlab", scopeId),
  ])
  if (authority.status === "unavailable" || stored.status === "unavailable") return "unavailable"
  if (authority.status !== "ok" || stored.status !== "ok") return "noop"

  const storedByExternalId = new Map(
    stored.snapshot.repositories.map((repository) => [repository.externalId, repository]),
  )
  const activeExternalIds = new Set(authority.repositories.map((repository) => repository.externalId))
  const repositories = authority.repositories.map((repository, position) => ({
    externalId: repository.externalId,
    fullName: repository.fullName,
    context: storedByExternalId.get(repository.externalId)?.context ?? "",
    position,
  }))
  const relationships = stored.snapshot.relationships.filter(
    (relationship) =>
      activeExternalIds.has(relationship.fromExternalId) && activeExternalIds.has(relationship.toExternalId),
  )
  if (
    repositories.length === stored.snapshot.repositories.length &&
    relationships.length === stored.snapshot.relationships.length &&
    repositories.every(
      (repository, index) =>
        repository.externalId === stored.snapshot.repositories[index]?.externalId &&
        repository.fullName === stored.snapshot.repositories[index]?.fullName,
    )
  ) {
    return "noop"
  }

  const result = await replaceRepositoryContext(db, {
    provider: "gitlab",
    scopeId,
    expectedRevision: stored.snapshot.revision,
    repositories,
    relationships,
    conventions: stored.snapshot.conventions,
    nowIso: new Date().toISOString(),
    updatedBy: "system:gitlab-authority-change",
    authorityGuard: {
      revision: authority.revision,
      externalIds: authority.repositories.map((repository) => repository.externalId),
    },
  })
  if (result.status === "updated") return "updated"
  if (result.status === "unavailable") return "unavailable"
  return "noop"
}
