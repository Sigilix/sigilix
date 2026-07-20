// Canonical per-installation repository-context HTTP surface.
//
// GET/PUT /v1/org/:installationId/repository-context and the explicit legacy
// onboarding import are dark unless the rollout flag is on. Every route requires an exact-installation
// Sigilix admin and a complete GitHub App-installation repository snapshot
// before repository-context D1 is touched. Repository names and scope are always derived from
// that live snapshot; callers may submit only immutable numeric repository ids
// plus bounded user-authored context.

import {
  readRepositoryContext,
  replaceRepositoryContext,
  validateGitHubRepositoryContextInput,
  type RepositoryContextSnapshot,
} from "@/src/features/repository-context"
import { listGithubAppInstallationRepos } from "@/src/lib/github-user-repo-scope"
import { requireOrgAccess } from "@/src/lib/org-access"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { hasHighConfidenceSecretText } from "@/src/lib/secret-scan"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { importOnboardingRepositoryContext } from "@/src/lib/onboarding-repository-context-import"

const MAX_BODY_BYTES = 64 * 1024
const MAX_IMPORT_BODY_BYTES = 1_024
const IMPORT_CONFIRMATION = "migrate-from-onboarding-kv"
const PROVIDER = "github" as const

interface AvailableRepository {
  repositoryId: number
  fullName: string
}

interface PublicRepositoryContext {
  provider: typeof PROVIDER
  scopeId: string
  revision: number
  repositories: Array<{
    repositoryId: number
    fullName: string
    context: string
    available: boolean
  }>
  relationships: Array<{
    fromRepositoryId: number
    toRepositoryId: number
    label: string
  }>
  conventions: string
  availableRepositories: AvailableRepository[]
}

type AuthorizedScope = Extract<Awaited<ReturnType<typeof requireOrgAccess>>, { ok: true }> & {
  db: D1Database
  availableRepositories: AvailableRepository[]
}

type ScopeResult = { ok: true; value: AuthorizedScope } | { ok: false; response: Response }

/** GET the current canonical snapshot plus the exact current GitHub repo set. */
export async function handleGetRepositoryContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!repositoryContextEnabled(env)) return json({ error: "not_found" }, 404)

  const scope = await authorizeAndResolveScope(request, env, ctx, installationId)
  if (!scope.ok) return scope.response

  const stored = await readRepositoryContext(scope.value.db, PROVIDER, String(installationId))
  if (stored.status === "unavailable") {
    emitUnavailable("repository-context-read-unavailable", installationId)
    return json({ error: "repository_context_unavailable" }, 503)
  }
  return json(
    publicSnapshot(stored.status === "ok" ? stored.snapshot : null, installationId, scope.value.availableRepositories),
    200,
  )
}

/** PUT one exact-revision replacement after reconciling every id to live GitHub. */
export async function handlePutRepositoryContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!repositoryContextEnabled(env)) return json({ error: "not_found" }, 404)

  // Auth precedes content/body checks so a non-admin cannot use request-shape
  // differences to probe this governance surface. No body or repository-context D1 read occurs.
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "admin" })
  if (!access.ok) return privateResponse(access.response)
  if (!hasJsonContentType(request)) {
    return json({ error: "content-type must be application/json" }, 415)
  }

  const scope = await resolveLiveScopeAndDb(env, access)
  if (!scope.ok) return scope.response

  const rawBody = await readBodyCapped(request, MAX_BODY_BYTES)
  if (rawBody === null) return json({ error: "payload_too_large" }, 413)
  let raw: unknown
  try {
    raw = JSON.parse(rawBody) as unknown
  } catch {
    return json({ error: "invalid_repository_context", reason: "invalid_json" }, 400)
  }
  const validated = validateGitHubRepositoryContextInput(raw, hasHighConfidenceSecretText)
  if (!validated.ok) {
    return json({ error: "invalid_repository_context", reason: validated.reason }, 400)
  }

  const liveById = new Map(
    scope.value.availableRepositories.map((repository) => [String(repository.repositoryId), repository]),
  )
  const repositories = []
  for (const repository of validated.value.repositories) {
    const live = liveById.get(repository.externalId)
    if (!live) return json({ error: "repository_scope_changed" }, 409)
    repositories.push({
      externalId: repository.externalId,
      fullName: live.fullName,
      context: repository.context,
      position: repository.position,
    })
  }

  const written = await replaceRepositoryContext(scope.value.db, {
    provider: PROVIDER,
    scopeId: String(installationId),
    expectedRevision: validated.value.expectedRevision,
    repositories,
    relationships: validated.value.relationships,
    conventions: validated.value.conventions,
    nowIso: new Date().toISOString(),
    updatedBy: `github:${access.githubUserId}`,
  })
  if (written.status === "unavailable") {
    emitUnavailable("repository-context-write-unavailable", installationId)
    return json({ error: "repository_context_unavailable" }, 503)
  }
  if (written.status === "conflict") {
    return json({ error: "revision_conflict", currentRevision: written.currentRevision }, 409)
  }
  // GitHub writes do not currently pass a strong-authority guard, but keep the
  // shared store's fail-closed result exhaustive for future provider cutovers.
  if (written.status === "scope_changed") return json({ error: "repository_scope_changed" }, 409)

  console.log(
    JSON.stringify({
      event: "repository-context-replaced",
      provider: PROVIDER,
      scopeId: String(installationId),
      revision: written.snapshot.revision,
      repositoryCount: written.snapshot.repositories.length,
      relationshipCount: written.snapshot.relationships.length,
    }),
  )
  return json(publicSnapshot(written.snapshot, installationId, scope.value.availableRepositories), 200)
}

/** Explicitly import this admin's legacy signup answers into one exact installation. */
export async function handleImportOnboardingRepositoryContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!repositoryContextEnabled(env)) return json({ error: "not_found" }, 404)

  // Authorization and the JSON CSRF guard both precede body, KV, live-scope,
  // and repository-context reads. A non-admin cannot probe legacy payloads.
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "admin" })
  if (!access.ok) return privateResponse(access.response)
  if (!hasJsonContentType(request)) {
    return json({ error: "content-type must be application/json" }, 415)
  }

  const rawBody = await readBodyCapped(request, MAX_IMPORT_BODY_BYTES)
  if (rawBody === null) return json({ error: "payload_too_large" }, 413)
  let confirmation: unknown
  try {
    confirmation = JSON.parse(rawBody) as unknown
  } catch {
    return json({ error: "invalid_import_confirmation" }, 400)
  }
  if (!isImportConfirmation(confirmation)) {
    return json({ error: "invalid_import_confirmation" }, 400)
  }

  const scope = await resolveLiveScopeAndDb(env, access)
  if (!scope.ok) return scope.response
  const nowIso = new Date().toISOString()
  const imported = await importOnboardingRepositoryContext({
    db: scope.value.db,
    kv: env.OPENCLAW_STATE,
    githubUserId: access.githubUserId,
    installationId,
    availableRepositories: scope.value.availableRepositories,
    nowIso,
  })
  if (imported.status === "not_found") return json({ error: "legacy_context_not_found" }, 404)
  if (imported.status === "invalid") {
    return json({ error: "legacy_context_invalid", reason: imported.reason }, 422)
  }
  if (imported.status === "scope_changed") {
    return json(
      {
        error: "legacy_scope_changed",
        missingRepositoryCount: imported.missingRepositoryCount,
      },
      409,
    )
  }
  if (imported.status === "exists") {
    return json({ error: "repository_context_exists", currentRevision: imported.currentRevision }, 409)
  }
  if (imported.status === "unavailable") {
    const error = imported.stage === "kv" ? "legacy_context_unavailable" : "repository_context_unavailable"
    emitUnavailable(`repository-context-onboarding-import-${imported.stage}-unavailable`, installationId)
    return json({ error }, 503)
  }

  console.log(
    JSON.stringify({
      event: "repository-context-onboarding-imported",
      provider: PROVIDER,
      scopeId: String(installationId),
      githubUserId: access.githubUserId,
      importedAt: nowIso,
      revision: imported.snapshot.revision,
      repositoryCount: imported.snapshot.repositories.length,
      relationshipCount: imported.snapshot.relationships.length,
    }),
  )
  return json(
    {
      imported: true,
      repositoryCount: imported.snapshot.repositories.length,
      relationshipCount: imported.snapshot.relationships.length,
      snapshot: publicSnapshot(imported.snapshot, installationId, scope.value.availableRepositories),
    },
    200,
  )
}

async function authorizeAndResolveScope(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<ScopeResult> {
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "admin" })
  return access.ok ? resolveLiveScopeAndDb(env, access) : { ok: false, response: privateResponse(access.response) }
}

async function resolveLiveScopeAndDb(
  env: Env,
  access: Extract<Awaited<ReturnType<typeof requireOrgAccess>>, { ok: true }>,
): Promise<ScopeResult> {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_PRIVATE_KEY
  if (!env.OPENCLAW_STATE || !appId?.trim() || !privateKey?.trim()) {
    emitScopeUnavailable("repository-context-app-config-missing", access.installationId)
    return { ok: false, response: json({ error: "repository_scope_unavailable" }, 503) }
  }

  let installationToken: string
  try {
    installationToken = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId,
      privateKey,
      installationId: access.installationId,
    })
  } catch {
    emitScopeUnavailable("repository-context-installation-token-unavailable", access.installationId)
    return { ok: false, response: json({ error: "repository_scope_unavailable" }, 503) }
  }

  const listed = await listGithubAppInstallationRepos(installationToken, access.installationId)
  if (!listed.ok) {
    emitScopeUnavailable("repository-context-scope-unavailable", access.installationId, listed.reason)
    return { ok: false, response: json({ error: "repository_scope_unavailable" }, 503) }
  }
  const availableRepositories = listed.repos
    .map((repository) => ({
      repositoryId: repository.repoId,
      fullName: `${repository.owner}/${repository.repo}`,
    }))
    .sort((left, right) => left.repositoryId - right.repositoryId)

  // This check intentionally follows the complete exact GitHub lookup. A
  // missing/unmigrated DB cannot cause a partial repo list to be treated as an
  // authoritative selection snapshot.
  if (!env.SIGILIX_PLATFORM_DB) {
    emitUnavailable("repository-context-db-missing", access.installationId)
    return { ok: false, response: json({ error: "repository_context_unavailable" }, 503) }
  }
  return {
    ok: true,
    value: { ...access, db: env.SIGILIX_PLATFORM_DB, availableRepositories },
  }
}

function publicSnapshot(
  snapshot: RepositoryContextSnapshot | null,
  installationId: number,
  availableRepositories: AvailableRepository[],
): PublicRepositoryContext {
  const availableById = new Map(
    availableRepositories.map((repository) => [String(repository.repositoryId), repository]),
  )
  return {
    provider: PROVIDER,
    scopeId: snapshot?.scopeId ?? String(installationId),
    revision: snapshot?.revision ?? 0,
    repositories: (snapshot?.repositories ?? []).map((repository) => {
      const available = availableById.get(repository.externalId)
      return {
        repositoryId: Number(repository.externalId),
        fullName: available?.fullName ?? repository.fullName,
        context: repository.context,
        available: available !== undefined,
      }
    }),
    relationships: (snapshot?.relationships ?? []).map((relationship) => ({
      fromRepositoryId: Number(relationship.fromExternalId),
      toRepositoryId: Number(relationship.toExternalId),
      label: relationship.label,
    })),
    conventions: snapshot?.conventions ?? "",
    availableRepositories,
  }
}

function repositoryContextEnabled(env: Env): boolean {
  return env.OPENCLAW_REPOSITORY_CONTEXT_API === "on"
}

function isImportConfirmation(value: unknown): value is { confirm: typeof IMPORT_CONFIRMATION } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && record.confirm === IMPORT_CONFIRMATION
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "private, no-store")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

function emitUnavailable(event: string, installationId: number): void {
  console.error(
    JSON.stringify({
      event,
      provider: PROVIDER,
      scopeId: String(installationId),
    }),
  )
}

function emitScopeUnavailable(event: string, installationId: number, reason?: "lookup_failed" | "timeout"): void {
  console.warn(
    JSON.stringify({
      event,
      provider: PROVIDER,
      scopeId: String(installationId),
      ...(reason ? { reason } : {}),
    }),
  )
}
