// ARC-238 — uninstall / repos-removed delete fan-out.
//
// Two webhook events trigger this module:
//   - `installation.deleted`             — full uninstall; sweep every repo
//                                          this installation indexed.
//   - `installation_repositories.removed`— delta; specific repos removed
//                                          from the installation.
//
// Both call `deleteRepoIndex(owner, repo, reason)` per affected
// (owner, repo) tuple. That worker:
//   1. Reads `repo-index-vectors:<repo>` (the KV id-list from ARC-235's
//      indexer extension in PR 3 commit 2). Codex v1: gate destructive
//      ops on `vectors.owner === owner` — a same-named repo under a
//      different owner doesn't get its data deleted by mistake.
//   2. Batches `deleteByIds` against Vectorize, dedup'd, ≤1000 per call.
//   3. Deletes `repo-index-vectors:<repo>` KV.
//   4. Deletes `repo-index-manifest:<repo>` KV — also gated on the
//      manifest's owner matching the removal context.
//   5. Lists + deletes `pr-review-manifest:<owner>/<repo>#*` (ARC-184
//      per-PR provenance) — these are owner-qualified so safe.
//   6. Lists + deletes `pr-review:<owner>/<repo>#*` dedupe locks.
//
// All steps are idempotent (missing keys = no-op, deleteByIds is
// idempotent). Webhook redelivery is safe.
//
// Codex v1 B5: the webhook handler MUST surface 5xx on partial-delete
// failure so GitHub redelivers; `DeleteResult.status === "partial"`
// drives the response.
//
// Codex v1 B6: this module DOES NOT gate on `OPENCLAW_INDEXER_ENABLED`.
// Uninstall delete is GDPR/SOC 2 retention compliance; turning off the
// indexer to save cost must not turn off deletion.

import type { Env } from "../index"
import {
  readRepoIndexManifest,
  repoIndexManifestKey,
} from "./repo-index-manifest"
import {
  deleteRepoIndexVectors,
  flattenIds,
  readRepoIndexVectors,
} from "./repo-index-vectors"

const VECTORIZE_DELETE_BATCH = 1000
const KV_LIST_PAGE_LIMIT = 1000

export type DeleteReason =
  | "install-deleted"
  | "install-repos-removed"

export interface DeleteResult {
  /** Summary status — drives the webhook HTTP response. */
  status: "complete" | "partial" | "owner-mismatch-skip" | "no-state"
  /** Vector ids actually deleted (0 if no vectors record or owner mismatch). */
  vectorIds: number
  /** Per-PR review manifests deleted. */
  prReviewManifests: number
  /** Per-(PR, headSha) dedupe locks deleted. */
  prReviewDedupeKeys: number
  /** Whether the repo-index-manifest:<repo> KV was deleted. */
  manifestDeleted: boolean
  /** Whether the repo-index-vectors:<repo> KV was deleted. */
  vectorsKvDeleted: boolean
  /** Non-fatal errors (per-step) that should make the webhook return 5xx. */
  errors: string[]
}

export interface DeleteRepoIndexArgs {
  env: Env
  owner: string
  repo: string
  reason: DeleteReason
}

/**
 * Delete every piece of state this PR owns for one (owner, repo)
 * tuple. Idempotent across re-delivery. Returns a structured result
 * the caller uses to decide between 202 / 503.
 */
export async function deleteRepoIndex(args: DeleteRepoIndexArgs): Promise<DeleteResult> {
  const { env, owner, repo, reason } = args
  const result: DeleteResult = {
    status: "complete",
    vectorIds: 0,
    prReviewManifests: 0,
    prReviewDedupeKeys: 0,
    manifestDeleted: false,
    vectorsKvDeleted: false,
    errors: [],
  }

  console.log(JSON.stringify({
    event: "index-delete-started",
    owner, repo, reason,
  }))

  // Cross-tenant guard. Two same-named repos under different owners
  // share the Vectorize namespace + repo-only KV records under the
  // existing retrieval contract. If the manifest's owner doesn't
  // match the removal context, ALL repo-only deletes are skipped to
  // avoid smashing someone else's vectors. The owner-qualified
  // `pr-review-manifest:<owner>/<repo>#*` and `pr-review:<owner>/<repo>#*`
  // keys ARE safe to delete because they're already disambiguated.
  let ownerMatchesForRepoOnly = true
  const manifestRead = await readRepoIndexManifest(env, repo)
  if (manifestRead.kind === "ok" && manifestRead.manifest.owner !== owner) {
    ownerMatchesForRepoOnly = false
    console.warn(JSON.stringify({
      event: "index-delete-owner-mismatch-skip-repo-only",
      owner, repo, reason,
      manifest_owner: manifestRead.manifest.owner,
    }))
  }

  if (ownerMatchesForRepoOnly) {
    // Step 1+3: Vectorize vectors + repo-index-vectors KV.
    const vectorsRead = await readRepoIndexVectors(env, repo)
    if (vectorsRead.kind === "ok") {
      if (vectorsRead.vectors.owner !== owner) {
        // Defensive: vectors record's owner mismatches even though
        // manifest matched (shouldn't happen, but the schema lets it).
        console.warn(JSON.stringify({
          event: "index-delete-owner-mismatch-skip-vectors",
          owner, repo, reason,
          vectors_owner: vectorsRead.vectors.owner,
        }))
      } else {
        const ids = flattenIds(vectorsRead.vectors)
        // Codex v1 N2: dedup before batched delete.
        const uniq = Array.from(new Set(ids))
        for (let i = 0; i < uniq.length; i += VECTORIZE_DELETE_BATCH) {
          const batch = uniq.slice(i, i + VECTORIZE_DELETE_BATCH)
          try {
            await env.OPENCLAW_CODE_INDEX.deleteByIds(batch)
            result.vectorIds += batch.length
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            result.errors.push(`vectorize.deleteByIds: ${message}`)
            console.error(JSON.stringify({
              event: "index-delete-vectorize-batch-failed",
              owner, repo, batch_start: i, batch_size: batch.length,
              err: message,
            }))
          }
        }
      }

      // Always delete the vectors KV record if it existed (and we
      // owned it). On a re-delivery, the second pass finds it
      // already missing and no-ops.
      try {
        await deleteRepoIndexVectors(env, repo)
        result.vectorsKvDeleted = true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push(`kv.delete(repo-index-vectors): ${message}`)
        console.error(JSON.stringify({
          event: "index-delete-kv-vectors-failed",
          owner, repo, err: message,
        }))
      }
    } else if (vectorsRead.kind === "invalid") {
      // Best-effort: log + delete the KV record (we can't enumerate
      // vectors but we can at least clean up the KV side).
      console.warn(JSON.stringify({
        event: "index-delete-vectors-kv-invalid",
        owner, repo, reason, kv_reason: vectorsRead.reason,
      }))
      try {
        await deleteRepoIndexVectors(env, repo)
        result.vectorsKvDeleted = true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push(`kv.delete(repo-index-vectors): ${message}`)
      }
    } else {
      // missing: pre-PR3 indexes have no vectors record. Vector data
      // leaks until natural re-index churn populates the record.
      // Documented limitation in the design v1.1 addendum.
      console.warn(JSON.stringify({
        event: "index-delete-no-vectors-record",
        owner, repo, reason,
        note: "pre-PR3 index — vector deletion not possible; KV cleanup proceeds",
      }))
    }

    // Step 4: manifest KV.
    try {
      await env.OPENCLAW_STATE.delete(repoIndexManifestKey(repo))
      result.manifestDeleted = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`kv.delete(repo-index-manifest): ${message}`)
      console.error(JSON.stringify({
        event: "index-delete-kv-manifest-failed",
        owner, repo, err: message,
      }))
    }
  }

  // Steps 5 + 6: owner-qualified KV prefixes. ALWAYS safe to delete
  // (these don't share the cross-tenant collision problem).
  result.prReviewManifests += await deleteKvPrefix(
    env,
    `pr-review-manifest:${owner}/${repo}#`,
    result.errors,
    "pr-review-manifest",
  )
  result.prReviewDedupeKeys += await deleteKvPrefix(
    env,
    `pr-review:${owner}/${repo}#`,
    result.errors,
    "pr-review-dedupe",
  )

  if (!ownerMatchesForRepoOnly) {
    result.status = "owner-mismatch-skip"
  } else if (result.errors.length > 0) {
    result.status = "partial"
  } else if (manifestRead.kind === "missing" && !result.vectorsKvDeleted) {
    // Nothing to delete at all — both repo-only records were absent.
    // The pr-review-manifest/dedupe keys may have been deleted but
    // those don't count as "state" for this status.
    result.status = "no-state"
  }

  console.log(JSON.stringify({
    event: "index-deleted",
    owner, repo, reason,
    status: result.status,
    vector_ids: result.vectorIds,
    pr_review_manifests: result.prReviewManifests,
    pr_review_dedupe_keys: result.prReviewDedupeKeys,
    manifest_deleted: result.manifestDeleted,
    vectors_kv_deleted: result.vectorsKvDeleted,
    error_count: result.errors.length,
  }))

  return result
}

/**
 * Codex v1 B4: KV `list({prefix})` is paginated with explicit
 * `list_complete`; don't stop on an empty page, keep going until the
 * boolean flips. Each page is up to KV_LIST_PAGE_LIMIT keys.
 *
 * Errors are captured in the caller's `errors[]` to drive the
 * webhook 503 on partial failure (Codex v1 B5).
 */
async function deleteKvPrefix(
  env: Env,
  prefix: string,
  errors: string[],
  label: string,
): Promise<number> {
  let deleted = 0
  let cursor: string | undefined
  for (;;) {
    let page: { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    try {
      page = await env.OPENCLAW_STATE.list({
        prefix,
        limit: KV_LIST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }) as { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`kv.list(${label}): ${message}`)
      console.error(JSON.stringify({
        event: "index-delete-kv-list-failed",
        label, prefix, err: message,
      }))
      return deleted
    }
    for (const key of page.keys) {
      try {
        await env.OPENCLAW_STATE.delete(key.name)
        deleted += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`kv.delete(${label}:${key.name}): ${message}`)
        console.error(JSON.stringify({
          event: "index-delete-kv-key-failed",
          label, key: key.name, err: message,
        }))
      }
    }
    if (page.list_complete) break
    if (!page.cursor) {
      // Defensive: list_complete false but no cursor returned. Avoid
      // an infinite loop; log and stop.
      console.error(JSON.stringify({
        event: "index-delete-kv-list-no-cursor",
        label, prefix,
      }))
      errors.push(`kv.list(${label}): missing cursor on incomplete page`)
      break
    }
    cursor = page.cursor
  }
  return deleted
}

// ---------------------------------------------------------------------
// Webhook entry points
// ---------------------------------------------------------------------

export interface InstallRepoEntry {
  full_name?: string | undefined
}

export interface HandleInstallReposRemovedArgs {
  env: Env
  installationId: number
  repositories: ReadonlyArray<InstallRepoEntry>
}

/**
 * `installation_repositories.removed` — payload carries
 * `repositories_removed[]` with `full_name` entries.
 */
export async function handleInstallReposRemoved(
  args: HandleInstallReposRemovedArgs,
): Promise<{ results: DeleteResult[]; anyError: boolean }> {
  const { env, installationId, repositories } = args
  const results: DeleteResult[] = []
  let anyError = false
  for (const entry of repositories) {
    const parsed = parseFullName(entry)
    if (!parsed) {
      console.warn(JSON.stringify({
        event: "index-delete-skip-invalid-payload",
        installation_id: installationId,
        full_name: typeof entry.full_name === "string" ? entry.full_name : null,
      }))
      continue
    }
    const r = await deleteRepoIndex({
      env, owner: parsed.owner, repo: parsed.repo,
      reason: "install-repos-removed",
    })
    results.push(r)
    if (r.status === "partial") anyError = true
  }
  return { results, anyError }
}

export interface HandleInstallationDeletedArgs {
  env: Env
  installationId: number
  /** `installation.account.login` from the payload. */
  ownerLogin: string
  /**
   * code-reviewer HIGH-1: GitHub DOES ship `repositories[]` on the
   * `installation.deleted` payload (the App's repo list at deletion
   * time). Prefer this as the primary discovery source — it's
   * authoritative and includes repos that may not have been
   * indexed (so any `pr-review-manifest:*` / `pr-review:*` keys
   * still get cleaned up even when indexing was disabled).
   * Falls back to KV scan when GitHub omits the field.
   */
  repositoriesFromPayload?: ReadonlyArray<InstallRepoEntry>
}

/**
 * `installation.deleted` — discover affected repos and fan out
 * deletion. Discovery order:
 *   1. `repositoriesFromPayload` if non-empty (authoritative).
 *   2. KV scan of `repo-index-manifest:` records, filtered by
 *      `manifest.owner === ownerLogin` (backup; useful for orphans
 *      from prior incomplete uninstalls or pre-PR3 indexes).
 *
 * Codex v1 sign-off Q1 confirmed walking our own KV as v1 shape;
 * code-reviewer HIGH-1 sharpened it: use the payload list when
 * present so we don't miss repos that were reviewed-but-not-indexed
 * (indexer flag was off or sensitive-skipped).
 */
export async function handleInstallationDeleted(
  args: HandleInstallationDeletedArgs,
): Promise<{ results: DeleteResult[]; anyError: boolean }> {
  const { env, installationId, ownerLogin, repositoriesFromPayload } = args
  const reposToDelete = new Map<string, string>() // repo → owner
  const errors: string[] = []

  // Discovery 1: payload's repositories[] (authoritative when present).
  if (repositoriesFromPayload && repositoriesFromPayload.length > 0) {
    for (const entry of repositoriesFromPayload) {
      const parsed = parseFullName(entry)
      if (!parsed) {
        console.warn(JSON.stringify({
          event: "index-delete-installation-skip-invalid-payload-entry",
          installation_id: installationId,
          full_name: typeof entry.full_name === "string" ? entry.full_name : null,
        }))
        continue
      }
      reposToDelete.set(parsed.repo, parsed.owner)
    }
  }

  // Discovery 2: KV scan of repo-index-manifest:. Always runs because
  // it catches orphans missed by the payload (e.g., prior incomplete
  // uninstall) AND fills in for the `repositoriesFromPayload`-absent
  // path. Repos discovered both ways converge to one delete call.
  let cursor: string | undefined
  for (;;) {
    let page: { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    try {
      page = await env.OPENCLAW_STATE.list({
        prefix: "repo-index-manifest:",
        limit: KV_LIST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }) as { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`kv.list(repo-index-manifest): ${message}`)
      console.error(JSON.stringify({
        event: "index-delete-installation-list-failed",
        installation_id: installationId, err: message,
      }))
      break
    }
    for (const key of page.keys) {
      const repo = key.name.slice("repo-index-manifest:".length)
      if (repo.length === 0) continue
      const manifest = await readRepoIndexManifest(env, repo)
      if (manifest.kind === "ok" && manifest.manifest.owner === ownerLogin) {
        if (!reposToDelete.has(repo)) {
          reposToDelete.set(repo, ownerLogin)
        }
      }
    }
    if (page.list_complete) break
    if (!page.cursor) {
      errors.push("kv.list(repo-index-manifest): missing cursor on incomplete page")
      break
    }
    cursor = page.cursor
  }

  console.log(JSON.stringify({
    event: "index-delete-installation-scan-done",
    installation_id: installationId,
    owner_login: ownerLogin,
    matching_repos: reposToDelete.size,
    discovery_payload_count: repositoriesFromPayload?.length ?? 0,
  }))

  const results: DeleteResult[] = []
  let anyError = errors.length > 0
  for (const [repo, owner] of reposToDelete.entries()) {
    const r = await deleteRepoIndex({
      env, owner, repo,
      reason: "install-deleted",
    })
    results.push(r)
    if (r.status === "partial") anyError = true
  }
  if (anyError && errors.length > 0) {
    console.error(JSON.stringify({
      event: "index-delete-installation-errors",
      installation_id: installationId,
      error_count: errors.length,
      errors: errors.slice(0, 5), // bound the log line
    }))
  }
  return { results, anyError }
}

function parseFullName(entry: InstallRepoEntry): { owner: string; repo: string } | null {
  if (typeof entry.full_name !== "string") return null
  const trimmed = entry.full_name.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return null
  if (trimmed.indexOf("/", slash + 1) !== -1) return null
  const owner = trimmed.slice(0, slash)
  const repo = trimmed.slice(slash + 1)
  if (owner.length === 0 || repo.length === 0) return null
  return { owner, repo }
}
