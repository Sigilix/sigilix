import { purgeRepositoryContext, readRepositoryContext } from "@/src/features/repository-context"
import { handleInstallationDeleted, type InstallRepoEntry } from "@/src/lib/index-delete"
import type { Env } from "@/src/shared/types/env"

const PROVIDER = "github"
const ACTOR_PREFIX = "github-webhook:installation.deleted"
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
    updatedBy: actor(deliveryKey),
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

function actor(deliveryKey: string | null): string {
  return deliveryKey ? `${ACTOR_PREFIX}:${deliveryKey}` : ACTOR_PREFIX
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
