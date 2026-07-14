import {
  purgeRepositoryContext,
  readRepositoryContext,
  replaceRepositoryContext,
} from "@/src/features/repository-context"
import { handleInstallationDeleted, handleInstallReposRemoved, type InstallRepoEntry } from "@/src/lib/index-delete"
import type { Env } from "@/src/shared/types/env"

const PROVIDER = "github"
const UNINSTALL_ACTOR_PREFIX = "github-webhook:installation.deleted"
const REPOSITORIES_REMOVED_ACTOR_PREFIX = "github-webhook:installation_repositories.removed"
const MAX_DELIVERY_ID_CHARS = 128

export type GitHubRepositoryContextUninstallResult =
  | { status: "ok"; changed: boolean; revision: number }
  | { status: "retryable_failure" }

export interface TombstoneGitHubRepositoryContextOnUninstallArgs {
  db: D1Database
  installationId: number
  deliveryId: string | null
  nowIso: string
}

export async function tombstoneGitHubRepositoryContextOnUninstall(
  args: TombstoneGitHubRepositoryContextOnUninstallArgs,
): Promise<GitHubRepositoryContextUninstallResult> {
  if (!Number.isSafeInteger(args.installationId) || args.installationId <= 0) {
    emitFailure("repository-context-uninstall-invalid-scope", String(args.installationId), null)
    return { status: "retryable_failure" }
  }
  const scopeId = String(args.installationId)
  const deliveryKey = await deliveryFingerprint(args.deliveryId)
  const before = await readRepositoryContext(args.db, PROVIDER, scopeId)
  if (before.status === "unavailable") {
    emitFailure("repository-context-uninstall-read-unavailable", scopeId, deliveryKey)
    return { status: "retryable_failure" }
  }
  if (before.status === "ok" && before.snapshot.deletedAt !== null) {
    emitSatisfied(scopeId, before.snapshot.revision, deliveryKey)
    return { status: "ok", changed: false, revision: before.snapshot.revision }
  }

  const expectedRevision = before.status === "not_found" ? 0 : before.snapshot.revision
  const written = await purgeRepositoryContext(args.db, {
    provider: PROVIDER,
    scopeId,
    expectedRevision,
    nowIso: args.nowIso,
    updatedBy: actor(UNINSTALL_ACTOR_PREFIX, deliveryKey),
  })
  if (written.status === "updated") {
    console.log(
      JSON.stringify({
        event: "repository-context-uninstall-tombstoned",
        provider: PROVIDER,
        scope_id: scopeId,
        revision: written.snapshot.revision,
        delivery_key: deliveryKey,
      }),
    )
    return { status: "ok", changed: true, revision: written.snapshot.revision }
  }
  if (written.status === "unavailable") {
    emitFailure("repository-context-uninstall-write-unavailable", scopeId, deliveryKey)
    return { status: "retryable_failure" }
  }

  const afterConflict = await readRepositoryContext(args.db, PROVIDER, scopeId)
  if (afterConflict.status === "ok" && afterConflict.snapshot.deletedAt !== null) {
    emitSatisfied(scopeId, afterConflict.snapshot.revision, deliveryKey)
    return { status: "ok", changed: false, revision: afterConflict.snapshot.revision }
  }
  emitFailure("repository-context-uninstall-conflict", scopeId, deliveryKey)
  return { status: "retryable_failure" }
}

export interface GitHubRepositoryRemovedEntry extends InstallRepoEntry {
  id?: number | undefined
}

export type GitHubRepositoryContextRemovalResult =
  | { status: "ok"; changed: boolean; revision: number | null; removedCount: number }
  | { status: "retryable_failure" }

export interface ReconcileGitHubRepositoryContextOnRepositoriesRemovedArgs {
  db: D1Database
  installationId: number
  repositories: ReadonlyArray<GitHubRepositoryRemovedEntry>
  deliveryId: string | null
  nowIso: string
}

export async function reconcileGitHubRepositoryContextOnRepositoriesRemoved(
  args: ReconcileGitHubRepositoryContextOnRepositoriesRemovedArgs,
): Promise<GitHubRepositoryContextRemovalResult> {
  if (!Number.isSafeInteger(args.installationId) || args.installationId <= 0) {
    emitFailure("repository-context-repositories-removed-invalid-scope", String(args.installationId), null)
    return { status: "retryable_failure" }
  }
  if (args.repositories.length === 0) {
    return { status: "ok", changed: false, revision: null, removedCount: 0 }
  }

  const scopeId = String(args.installationId)
  const deliveryKey = await deliveryFingerprint(args.deliveryId)
  const updatedBy = actor(REPOSITORIES_REMOVED_ACTOR_PREFIX, deliveryKey)
  const classified = classifyRepositoryRemovals(args.repositories)
  if (classified.invalidEntryCount > 0) {
    emitRemovalFailure("repository-context-repositories-removed-invalid-id", scopeId, deliveryKey, classified)
  }

  const before = await readRepositoryContext(args.db, PROVIDER, scopeId)
  if (before.status === "unavailable") {
    emitRemovalFailure("repository-context-repositories-removed-read-unavailable", scopeId, deliveryKey, classified)
    return { status: "retryable_failure" }
  }
  if (before.status === "ok" && before.snapshot.deletedAt !== null) {
    return finishRepositoryRemoval({
      changed: false,
      revision: before.snapshot.revision,
      removedCount: 0,
      scopeId,
      deliveryKey,
      classified,
    })
  }

  const snapshot = before.status === "ok" ? before.snapshot : null
  const repositories = (snapshot?.repositories ?? []).filter(
    (repository) => !classified.externalIds.has(repository.externalId),
  )
  const relationships = (snapshot?.relationships ?? []).filter(
    (relationship) =>
      !classified.externalIds.has(relationship.fromExternalId) &&
      !classified.externalIds.has(relationship.toExternalId),
  )
  const removedCount = (snapshot?.repositories.length ?? 0) - repositories.length
  const exactDeliveryAlreadyApplied =
    deliveryKey !== null &&
    snapshot?.updatedBy === updatedBy &&
    removedRepositoriesAbsent(snapshot.repositories, classified.externalIds)
  if (exactDeliveryAlreadyApplied) {
    return finishRepositoryRemoval({
      changed: false,
      revision: snapshot.revision,
      removedCount: 0,
      scopeId,
      deliveryKey,
      classified,
    })
  }

  // SECURITY: `github` is the composite identity boundary with the exact
  // installation scope. Do not parameterize this webhook mutation by provider.
  const written = await replaceRepositoryContext(args.db, {
    provider: PROVIDER,
    scopeId,
    expectedRevision: snapshot?.revision ?? 0,
    repositories,
    relationships,
    conventions: snapshot?.conventions ?? "",
    nowIso: args.nowIso,
    updatedBy,
  })
  if (written.status === "updated") {
    return finishRepositoryRemoval({
      changed: true,
      revision: written.snapshot.revision,
      removedCount,
      scopeId,
      deliveryKey,
      classified,
    })
  }
  if (written.status === "unavailable") {
    emitRemovalFailure("repository-context-repositories-removed-write-unavailable", scopeId, deliveryKey, classified)
    return { status: "retryable_failure" }
  }

  const afterConflict = await readRepositoryContext(args.db, PROVIDER, scopeId)
  if (
    afterConflict.status === "ok" &&
    (afterConflict.snapshot.deletedAt !== null ||
      removedRepositoriesAbsent(afterConflict.snapshot.repositories, classified.externalIds))
  ) {
    return finishRepositoryRemoval({
      changed: false,
      revision: afterConflict.snapshot.revision,
      removedCount: 0,
      scopeId,
      deliveryKey,
      classified,
    })
  }
  emitRemovalFailure("repository-context-repositories-removed-conflict", scopeId, deliveryKey, classified)
  return { status: "retryable_failure" }
}

export interface HandleGitHubRepositoriesRemovedLifecycleArgs {
  env: Env
  installationId: number
  repositories: ReadonlyArray<GitHubRepositoryRemovedEntry>
  deliveryId: string | null
  nowIso: string
}

export async function handleGitHubRepositoriesRemovedLifecycle(
  args: HandleGitHubRepositoriesRemovedLifecycleArgs,
): Promise<Response> {
  let contextResult: GitHubRepositoryContextRemovalResult = {
    status: "ok",
    changed: false,
    revision: null,
    removedCount: 0,
  }
  if (args.repositories.length > 0) {
    if (!args.env.SIGILIX_PLATFORM_DB) {
      emitFailure("repository-context-repositories-removed-db-missing", String(args.installationId), null)
      contextResult = { status: "retryable_failure" }
    } else {
      try {
        contextResult = await reconcileGitHubRepositoryContextOnRepositoriesRemoved({
          db: args.env.SIGILIX_PLATFORM_DB,
          installationId: args.installationId,
          repositories: args.repositories,
          deliveryId: args.deliveryId,
          nowIso: args.nowIso,
        })
      } catch (error) {
        emitLifecycleThrow("repository-context-repositories-removed-threw", args.installationId, error)
        contextResult = { status: "retryable_failure" }
      }
    }
  }

  try {
    const { results, anyError } = await handleInstallReposRemoved({
      env: args.env,
      installationId: args.installationId,
      repositories: args.repositories,
    })
    if (anyError || contextResult.status === "retryable_failure") {
      console.error(
        JSON.stringify({
          event: "index-delete-fanout-partial",
          installation_id: args.installationId,
          reason: "install-repos-removed",
          count: results.length,
          repository_context_retryable: contextResult.status === "retryable_failure",
        }),
      )
      return new Response("delete fanout partial\n", { status: 503 })
    }
    return new Response("repos-removed deleted\n", { status: 202 })
  } catch (error) {
    emitLifecycleThrow("index-delete-fanout-threw", args.installationId, error)
    return new Response("delete fanout threw\n", { status: 503 })
  }
}

export interface HandleGitHubInstallationDeletedLifecycleArgs {
  env: Env
  installationId: number
  ownerLogin: string | undefined
  repositoriesFromPayload?: ReadonlyArray<InstallRepoEntry>
  deliveryId: string | null
  nowIso: string
}

export async function handleGitHubInstallationDeletedLifecycle(
  args: HandleGitHubInstallationDeletedLifecycleArgs,
): Promise<Response> {
  if (!args.env.SIGILIX_PLATFORM_DB) {
    emitFailure("repository-context-uninstall-db-missing", String(args.installationId), null)
  }
  const contextResult = args.env.SIGILIX_PLATFORM_DB
    ? await tombstoneGitHubRepositoryContextOnUninstall({
        db: args.env.SIGILIX_PLATFORM_DB,
        installationId: args.installationId,
        deliveryId: args.deliveryId,
        nowIso: args.nowIso,
      })
    : ({ status: "retryable_failure" } as const)

  // The D1 tombstone and legacy KV/vector cleanup are independent, idempotent retention
  // arms. Let the index arm make progress even when D1 is unavailable, but keep the
  // combined webhook response retryable until both arms have settled.
  if (typeof args.ownerLogin !== "string" || args.ownerLogin.length === 0) {
    console.error(
      JSON.stringify({
        event: "index-delete-missing-account-login",
        installation_id: args.installationId,
      }),
    )
    // GitHub cannot repair an omitted account.login on redelivery. Preserve the established
    // terminal response only after the installation-id-scoped context cleanup has succeeded.
    return contextResult.status === "ok"
      ? new Response("missing account.login\n", { status: 200 })
      : new Response("delete fanout partial\n", { status: 503 })
  }

  try {
    const { results, anyError } = await handleInstallationDeleted({
      env: args.env,
      installationId: args.installationId,
      ownerLogin: args.ownerLogin,
      ...(args.repositoriesFromPayload ? { repositoriesFromPayload: args.repositoriesFromPayload } : {}),
    })
    if (anyError || contextResult.status === "retryable_failure") {
      console.error(
        JSON.stringify({
          event: "index-delete-fanout-partial",
          installation_id: args.installationId,
          reason: "install-deleted",
          count: results.length,
          repository_context_retryable: contextResult.status === "retryable_failure",
        }),
      )
      return new Response("delete fanout partial\n", { status: 503 })
    }
    return new Response("installation deleted\n", { status: 202 })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "index-delete-fanout-threw",
        installation_id: args.installationId,
        reason: "install-deleted",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return new Response("delete fanout threw\n", { status: 503 })
  }
}

async function deliveryFingerprint(deliveryId: string | null): Promise<string | null> {
  // Hash only GitHub-sized identifiers; never copy an untrusted or oversized header into
  // immutable audit metadata.
  if (!deliveryId || deliveryId.length > MAX_DELIVERY_ID_CHARS) return null
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deliveryId))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function actor(prefix: string, deliveryKey: string | null): string {
  return deliveryKey ? `${prefix}:${deliveryKey}` : prefix
}

interface ClassifiedRepositoryRemovals {
  externalIds: ReadonlySet<string>
  invalidEntryCount: number
}

function classifyRepositoryRemovals(
  repositories: ReadonlyArray<GitHubRepositoryRemovedEntry>,
): ClassifiedRepositoryRemovals {
  const externalIds = new Set<string>()
  let invalidEntryCount = 0
  for (const repository of repositories) {
    if (Number.isSafeInteger(repository?.id) && (repository.id ?? 0) > 0) {
      externalIds.add(String(repository.id))
    } else {
      invalidEntryCount += 1
    }
  }
  return { externalIds, invalidEntryCount }
}

function removedRepositoriesAbsent(
  repositories: ReadonlyArray<{ externalId: string }>,
  removedExternalIds: ReadonlySet<string>,
): boolean {
  return repositories.every((repository) => !removedExternalIds.has(repository.externalId))
}

function finishRepositoryRemoval(args: {
  changed: boolean
  revision: number
  removedCount: number
  scopeId: string
  deliveryKey: string | null
  classified: ClassifiedRepositoryRemovals
}): GitHubRepositoryContextRemovalResult {
  console.log(
    JSON.stringify({
      event: args.changed
        ? "repository-context-repositories-removed-reconciled"
        : "repository-context-repositories-removed-postcondition-satisfied",
      provider: PROVIDER,
      scope_id: args.scopeId,
      revision: args.revision,
      removed_id_count: args.classified.externalIds.size,
      removed_context_count: args.removedCount,
      invalid_entry_count: args.classified.invalidEntryCount,
      delivery_key: args.deliveryKey,
    }),
  )
  return args.classified.invalidEntryCount > 0
    ? { status: "retryable_failure" }
    : { status: "ok", changed: args.changed, revision: args.revision, removedCount: args.removedCount }
}

function emitRemovalFailure(
  event: string,
  scopeId: string,
  deliveryKey: string | null,
  classified: ClassifiedRepositoryRemovals,
): void {
  console.error(
    JSON.stringify({
      event,
      provider: PROVIDER,
      scope_id: scopeId,
      removed_id_count: classified.externalIds.size,
      invalid_entry_count: classified.invalidEntryCount,
      delivery_key: deliveryKey,
    }),
  )
}

function emitLifecycleThrow(event: string, installationId: number, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      installation_id: installationId,
      reason: "install-repos-removed",
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}

function emitSatisfied(scopeId: string, revision: number, deliveryKey: string | null): void {
  console.log(
    JSON.stringify({
      event: "repository-context-uninstall-postcondition-satisfied",
      provider: PROVIDER,
      scope_id: scopeId,
      revision,
      delivery_key: deliveryKey,
    }),
  )
}

function emitFailure(event: string, scopeId: string, deliveryKey: string | null): void {
  console.error(
    JSON.stringify({
      event,
      provider: PROVIDER,
      scope_id: scopeId,
      delivery_key: deliveryKey,
    }),
  )
}
