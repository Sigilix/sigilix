// Canonical GitLab repository-context HTTP surface. The browser receives only
// the exact ACTIVE D1 authority set for the signed-in stable user and can submit
// a full replacement by immutable numeric project id. Scope, issuer-qualified
// external ids, and current project names are always server-derived.

import {
  readGitLabRepositoryAuthority,
  readRepositoryContext,
  replaceRepositoryContext,
  validateNumericRepositoryContextInput,
  type GitLabRepositoryAuthorityRepository,
  type RepositoryContextSnapshot,
} from "@/src/features/repository-context"
import { requireSession } from "@/src/lib/auth-middleware"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { hasHighConfidenceSecretText } from "@/src/lib/secret-scan"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const PROVIDER = "gitlab" as const
const MAX_BODY_BYTES = 64 * 1024

interface PublicGitLabRepositoryContext {
  provider: typeof PROVIDER
  scopeId: string
  revision: number
  authorityRevision: number
  repositories: Array<{ repositoryId: number; fullName: string; context: string }>
  relationships: Array<{ fromRepositoryId: number; toRepositoryId: number; label: string }>
  conventions: string
  availableRepositories: Array<{ repositoryId: number; fullName: string }>
}

type AuthorizedScope = {
  scopeId: string
  db: D1Database
  authorityRevision: number
  repositories: GitLabRepositoryAuthorityRepository[]
}

export async function handleGetGitLabRepositoryContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!repositoryContextEnabled(env)) return json({ error: "not_found" }, 404)
  const authorized = await authorizeScope(request, env, ctx)
  if (!authorized.ok) return authorized.response
  const stored = await readRepositoryContext(authorized.value.db, PROVIDER, authorized.value.scopeId)
  if (stored.status === "unavailable") return unavailable("gitlab-repository-context-read-unavailable")
  const confirmedAuthority = await readGitLabRepositoryAuthority(authorized.value.db, authorized.value.scopeId)
  if (confirmedAuthority.status === "unavailable") {
    return unavailable("gitlab-repository-context-authority-confirm-unavailable")
  }
  const confirmedRevision = confirmedAuthority.status === "ok" ? confirmedAuthority.revision : 0
  const confirmedRepositories = confirmedAuthority.status === "ok" ? confirmedAuthority.repositories : []
  if (
    confirmedRevision !== authorized.value.authorityRevision ||
    !sameAuthorityRepositories(confirmedRepositories, authorized.value.repositories)
  ) {
    return json({ error: "repository_scope_changed" }, 409)
  }
  return json(
    publicSnapshot(
      stored.status === "ok" ? stored.snapshot : null,
      authorized.value.scopeId,
      confirmedRevision,
      confirmedRepositories,
    ),
    200,
  )
}

export async function handlePutGitLabRepositoryContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!repositoryContextEnabled(env)) return json({ error: "not_found" }, 404)

  // Authentication precedes request-shape checks so an unauthenticated caller
  // cannot probe this private governance surface.
  const authorized = await authorizeScope(request, env, ctx)
  if (!authorized.ok) return authorized.response
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const rawBody = await readBodyCapped(request, MAX_BODY_BYTES)
  if (rawBody === null) return json({ error: "payload_too_large" }, 413)
  let raw: unknown
  try {
    raw = JSON.parse(rawBody) as unknown
  } catch {
    return json({ error: "invalid_repository_context", reason: "invalid_json" }, 400)
  }
  const parsed = validateGitLabInput(raw)
  if (!parsed.ok) return json({ error: "invalid_repository_context", reason: parsed.reason }, 400)

  const authorityBySourceId = uniqueAuthorityBySourceId(authorized.value.repositories)
  if (!authorityBySourceId) return unavailable("gitlab-repository-context-ambiguous-authority")
  if (parsed.value.repositories.length !== authorityBySourceId.size) {
    return json({ error: "repository_scope_changed" }, 409)
  }

  const repositories = []
  for (const repository of parsed.value.repositories) {
    const authority = authorityBySourceId.get(repository.externalId)
    if (!authority) return json({ error: "repository_scope_changed" }, 409)
    repositories.push({
      externalId: authority.externalId,
      fullName: authority.fullName,
      context: repository.context,
      position: repository.position,
    })
  }
  const relationships = []
  for (const relationship of parsed.value.relationships) {
    const from = authorityBySourceId.get(relationship.fromExternalId)
    const to = authorityBySourceId.get(relationship.toExternalId)
    if (!from || !to) return json({ error: "repository_scope_changed" }, 409)
    relationships.push({
      fromExternalId: from.externalId,
      toExternalId: to.externalId,
      label: relationship.label,
      normalizedLabel: relationship.normalizedLabel,
      position: relationship.position,
    })
  }

  const written = await replaceRepositoryContext(authorized.value.db, {
    provider: PROVIDER,
    scopeId: authorized.value.scopeId,
    expectedRevision: parsed.value.expectedRevision,
    repositories,
    relationships,
    conventions: parsed.value.conventions,
    nowIso: new Date().toISOString(),
    updatedBy: `gitlab:${authorized.value.scopeId}`,
    authorityGuard: {
      revision: parsed.value.authorityRevision,
      externalIds: authorized.value.repositories.map((repository) => repository.externalId),
    },
  })
  if (written.status === "unavailable") return unavailable("gitlab-repository-context-write-unavailable")
  if (written.status === "scope_changed") return json({ error: "repository_scope_changed" }, 409)
  if (written.status === "conflict") {
    return json({ error: "revision_conflict", currentRevision: written.currentRevision }, 409)
  }

  console.log(
    JSON.stringify({
      event: "repository-context-replaced",
      provider: PROVIDER,
      scopeId: authorized.value.scopeId,
      revision: written.snapshot.revision,
      authorityRevision: authorized.value.authorityRevision,
      repositoryCount: written.snapshot.repositories.length,
      relationshipCount: written.snapshot.relationships.length,
    }),
  )
  return json(
    publicSnapshot(
      written.snapshot,
      authorized.value.scopeId,
      authorized.value.authorityRevision,
      authorized.value.repositories,
    ),
    200,
  )
}

async function authorizeScope(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<{ ok: true; value: AuthorizedScope } | { ok: false; response: Response }> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  const scopeId = authed.record.userId
  if (!scopeId) return { ok: false, response: json({ error: "session_reauthenticate" }, 409) }
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return { ok: false, response: unavailable("gitlab-repository-context-db-missing") }
  const authority = await readGitLabRepositoryAuthority(db, scopeId)
  if (authority.status === "unavailable") {
    return { ok: false, response: unavailable("gitlab-repository-context-authority-unavailable") }
  }
  return {
    ok: true,
    value: {
      scopeId,
      db,
      authorityRevision: authority.status === "ok" ? authority.revision : 0,
      repositories: authority.status === "ok" ? authority.repositories : [],
    },
  }
}

function validateGitLabInput(raw: unknown):
  | {
      ok: true
      value: {
        expectedRevision: number
        authorityRevision: number
        repositories: Array<{ externalId: string; context: string; position: number }>
        relationships: Array<{
          fromExternalId: string
          toExternalId: string
          label: string
          normalizedLabel: string
          position: number
        }>
        conventions: string
      }
    }
  | { ok: false; reason: string } {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["revision", "authorityRevision", "repositories", "relationships", "conventions"])
  ) {
    return { ok: false, reason: "invalid_shape" }
  }
  if (
    !Number.isSafeInteger(raw.authorityRevision) ||
    Number(raw.authorityRevision) < 0 ||
    Number(raw.authorityRevision) >= Number.MAX_SAFE_INTEGER
  ) {
    return { ok: false, reason: "invalid_revision" }
  }
  const validated = validateNumericRepositoryContextInput(
    {
      revision: raw.revision,
      repositories: raw.repositories,
      relationships: raw.relationships,
      conventions: raw.conventions,
    },
    hasHighConfidenceSecretText,
  )
  return validated.ok
    ? { ok: true, value: { ...validated.value, authorityRevision: Number(raw.authorityRevision) } }
    : validated
}

function publicSnapshot(
  snapshot: RepositoryContextSnapshot | null,
  scopeId: string,
  authorityRevision: number,
  authorityRepositories: GitLabRepositoryAuthorityRepository[],
): PublicGitLabRepositoryContext {
  const contextByExternalId = new Map(
    (snapshot?.repositories ?? []).map((repository) => [repository.externalId, repository]),
  )
  const authorityByExternalId = new Map(authorityRepositories.map((repository) => [repository.externalId, repository]))
  const repositories = [...authorityRepositories]
    .sort(
      (left, right) => left.sourceId - right.sourceId || compareCodepoints(left.instanceOrigin, right.instanceOrigin),
    )
    .map((repository) => ({
      repositoryId: repository.sourceId,
      fullName: repository.fullName,
      context: contextByExternalId.get(repository.externalId)?.context ?? "",
    }))
  const relationships = (snapshot?.relationships ?? []).flatMap((relationship) => {
    const from = authorityByExternalId.get(relationship.fromExternalId)
    const to = authorityByExternalId.get(relationship.toExternalId)
    return from && to
      ? [{ fromRepositoryId: from.sourceId, toRepositoryId: to.sourceId, label: relationship.label }]
      : []
  })
  return {
    provider: PROVIDER,
    scopeId,
    revision: snapshot?.revision ?? 0,
    authorityRevision,
    repositories,
    relationships,
    conventions: snapshot?.conventions ?? "",
    availableRepositories: repositories.map(({ repositoryId, fullName }) => ({ repositoryId, fullName })),
  }
}

function uniqueAuthorityBySourceId(
  repositories: GitLabRepositoryAuthorityRepository[],
): Map<string, GitLabRepositoryAuthorityRepository> | null {
  const bySourceId = new Map<string, GitLabRepositoryAuthorityRepository>()
  for (const repository of repositories) {
    const key = String(repository.sourceId)
    if (bySourceId.has(key)) return null
    bySourceId.set(key, repository)
  }
  return bySourceId
}

function sameAuthorityRepositories(
  left: GitLabRepositoryAuthorityRepository[],
  right: GitLabRepositoryAuthorityRepository[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (repository, index) =>
        repository.externalId === right[index]?.externalId &&
        repository.instanceOrigin === right[index]?.instanceOrigin &&
        repository.sourceId === right[index]?.sourceId &&
        repository.fullName === right[index]?.fullName,
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function repositoryContextEnabled(env: Env): boolean {
  return env.OPENCLAW_REPOSITORY_CONTEXT_API === "on"
}

function unavailable(event: string): Response {
  console.warn(JSON.stringify({ event, provider: PROVIDER }))
  return json({ error: "repository_context_unavailable" }, 503)
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}
