// ARC-238 — uninstall / repos-removed delete fan-out.
//
// Two webhook events trigger this module:
//   - `installation.deleted`             — full uninstall; sweep every repo
//                                          this installation indexed.
//   - `installation_repositories.removed`— delta; specific repos removed
//                                          from the installation.
//
// Both call `deleteRepoIndex(owner, repo, reason)` per affected
// (owner, repo) tuple. SIG-35 branch-scoped index records are deleted
// as additional repo-state tuples such as `repo/__branch__/h646576`. That worker:
//   1. Reads `repo-index-vectors:<owner>/<repo>` (the KV id-list from
//      ARC-235's indexer extension in PR 3 commit 2), probing the legacy
//      bare `repo-index-vectors:<repo>` key too (SIG-132). Codex v1:
//      gate destructive ops on `vectors.owner === owner` — a same-named
//      repo under a different owner doesn't get its data deleted by
//      mistake.
//   2. Batches `deleteByIds` against Vectorize, dedup'd, ≤100 per call
//      (Vectorize caps deleteByIds at 100 ids — error 40007 above that).
//      (Vectorize delete is by id and namespace-independent, so legacy
//      vectors records purge their embeddings just the same.)
//   3. Deletes the `repo-index-vectors:*` KV record at the EXACT key it
//      was found under (new or legacy shape).
//   4. Deletes the `repo-index-manifest:*` KV record at the EXACT key it
//      was found under — also gated on the manifest's owner matching the
//      removal context.
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

import type { Env } from "@/src/shared/types/env"
import {
  parseRepoIndexManifest,
  repoIndexManifestKey,
  REPO_INDEX_MANIFEST_PREFIX,
  repoTenantKey,
  indexNamespace,
} from "./repo-index-manifest"
import {
  flattenIds,
  repoVectorsTenantKey,
} from "./repo-index-vectors"
import { activeRunKey } from "./repo-index-active-run"
import { deleteLexicalNamespace } from "./lexical-index"
import { deleteGraph } from "./repo-graph-client"
import { deleteScopedRulesManifest } from "./scoped-rules-kv"
// SIG-376 (Tier-1 1/8): the per-(owner, repo) state-resolution + legacy-
// orphan-purge IO cluster — plus the public result/arg types and the
// Vectorize batch constant they share with the core — were lifted into a
// leaf module so this file stays under the 1,000-line budget. The types
// are re-exported below so every importer of `@/lib/index-delete` is
// unchanged.
import {
  VECTORIZE_DELETE_BATCH,
  resolveManifest,
  resolveVectors,
  purgeLegacyVectorsOrphan,
} from "./index-delete-resolve"
import type {
  DeleteReason,
  DeleteResult,
  DeleteRepoIndexArgs,
} from "./index-delete-resolve"

export type { DeleteReason, DeleteResult, DeleteRepoIndexArgs }

const KV_LIST_PAGE_LIMIT = 1000

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
    reviewMemoryKeys: 0,
    lexicalRows: 0,
    errors: [],
  }

  console.log(JSON.stringify({
    event: "index-delete-started",
    owner, repo, reason,
  }))

  // Cross-tenant guard. SIG-132 made `<owner>/<repo>` the namespace, so
  // newly-indexed repos no longer collide. But the cross-tenant guard is
  // kept for two reasons: (1) orphaned PRE-MIGRATION records still live
  // under the bare `<repo>` key shape and CAN collide; (2) defense in
  // depth. EVERY destructive op on the repo-only state must check that
  // the stored owner matches `owner`. The owner-qualified
  // `pr-review-manifest:<owner>/<repo>#*` and `pr-review:<owner>/<repo>#*`
  // keys ARE safe to delete without this gate (their KEY is disambiguated).
  //
  // Sigilix HIGH + CR Critical #1 on PR #77: the previous structure had
  // two separate ownership checks (manifest then vectors-record) that
  // didn't compose — if manifest was missing/invalid OR the two records
  // disagreed, the KV-delete arms still fired and clobbered another
  // tenant's data. Consolidated below into one `safeToTouchRepoOnlyState`
  // gate that requires every record we CAN read to agree on `owner`.
  //
  // SIG-132: probe BOTH the new `<owner>/<repo>` key and the legacy bare
  // `<repo>` key so orphaned pre-migration records remain discoverable
  // and deletable. We delete the ACTUAL key the record was found under
  // (`manifestKeyName` / `vectorsKeyName`), never a reconstructed one,
  // so an old-shape orphan isn't stranded by writing to the new shape.
  const {
    read: manifestRead,
    keyName: manifestKeyName,
    extraOwnerSafeKey: manifestLegacyOrphanKey,
  } = await resolveManifest(env, owner, repo)
  const {
    read: vectorsRead,
    keyName: vectorsKeyName,
    extraOwnerSafeKey: vectorsLegacyOrphanKey,
  } = await resolveVectors(env, owner, repo)
  const manifestOwnerMismatch =
    manifestRead.kind === "ok" && manifestRead.manifest.owner !== owner
  const vectorsOwnerMismatch =
    vectorsRead.kind === "ok" && vectorsRead.vectors.owner !== owner
  const safeToTouchRepoOnlyState = !manifestOwnerMismatch && !vectorsOwnerMismatch

  // SIG-247 Phase 1 PR B: extract the immutable repo.id for review-
  // memory cleanup. The legacy `review-memory:<owner>/<repo>:*`
  // prefix is owner-qualified (safe to delete unguarded by the cross-
  // tenant probe). But the new `review-memory:repo:<id>:*` prefix is
  // keyed by the IMMUTABLE id — if we sourced the id from a manifest
  // whose owner doesn't match the delete target, OR from a branch-
  // scoped delete (where the writer never populated repo-id tenant
  // keys), we could clobber an unrelated tenant's repo-id data.
  //
  // CR Critical (PR #206): gate the repo-id extraction on BOTH owner-
  // safety AND default-branch-scope, mirroring the tenant-key writer
  // contract at `repo-index-manifest.ts:280-298`. The branch-scope
  // check mirrors the existing `isBranchScopedState` derivation at
  // line 436-438 below.
  const isBranchScopedStateForReviewMemory =
    (manifestRead.kind === "ok" && manifestRead.manifest.branch !== undefined) ||
    (vectorsRead.kind === "ok" && vectorsRead.vectors.repo.includes("/__branch__/"))
  const reviewMemoryRepoId =
    !safeToTouchRepoOnlyState || isBranchScopedStateForReviewMemory
      ? undefined
      : (manifestRead.kind === "ok" &&
        typeof manifestRead.manifest.githubRepoId === "number" &&
        Number.isInteger(manifestRead.manifest.githubRepoId) &&
        manifestRead.manifest.githubRepoId > 0
          ? manifestRead.manifest.githubRepoId
          : undefined) ??
        (vectorsRead.kind === "ok" &&
        typeof vectorsRead.vectors.githubRepoId === "number" &&
        Number.isInteger(vectorsRead.vectors.githubRepoId) &&
        vectorsRead.vectors.githubRepoId > 0
          ? vectorsRead.vectors.githubRepoId
          : undefined)

  if (!safeToTouchRepoOnlyState) {
    console.warn(JSON.stringify({
      event: "index-delete-owner-mismatch-skip-repo-only",
      owner, repo, reason,
      manifest_owner:
        manifestRead.kind === "ok" ? manifestRead.manifest.owner : null,
      vectors_owner:
        vectorsRead.kind === "ok" ? vectorsRead.vectors.owner : null,
    }))
  }

  if (safeToTouchRepoOnlyState) {
    // Step 1: Vectorize vectors via deleteByIds. Track failure
    // separately so the KV deletes below can be gated on success —
    // CR Critical #2 on PR #77: a partial Vectorize delete that
    // proceeds to wipe the KV id-list + manifest leaves orphaned
    // embeddings unrecoverable on redelivery.
    let vectorizeDeleteFailed = false
    if (vectorsRead.kind === "ok") {
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
          vectorizeDeleteFailed = true
          console.error(JSON.stringify({
            event: "index-delete-vectorize-batch-failed",
            owner, repo, batch_start: i, batch_size: batch.length,
            err: message,
          }))
        }
      }
    } else if (vectorsRead.kind === "invalid") {
      console.warn(JSON.stringify({
        event: "index-delete-vectors-kv-invalid",
        owner, repo, reason, kv_reason: vectorsRead.reason,
      }))
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

    // Steps 2 + 3: KV deletes for repo-index-vectors:* and
    // repo-index-manifest:*. CR Critical #2 fix: keep the id list +
    // manifest until ALL Vectorize batches succeed. A redelivery on
    // partial failure must find the id list intact so it can retry
    // the leaked batches. Idempotency holds because deleteByIds is
    // idempotent.
    if (vectorizeDeleteFailed) {
      console.warn(JSON.stringify({
        event: "index-delete-kv-cleanup-deferred-pending-vectorize-retry",
        owner, repo, reason,
      }))
    } else {
      if ((vectorsRead.kind === "ok" || vectorsRead.kind === "invalid") && vectorsKeyName) {
        try {
          // SIG-132: delete the exact key the record was found under
          // (new `<owner>/<repo>` OR legacy bare `<repo>`).
          await env.OPENCLAW_STATE.delete(vectorsKeyName)
          result.vectorsKvDeleted = true
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors.push(`kv.delete(repo-index-vectors): ${message}`)
          console.error(JSON.stringify({
            event: "index-delete-kv-vectors-failed",
            owner, repo, key: vectorsKeyName, err: message,
          }))
        }
      }
      if (manifestKeyName) {
        try {
          // SIG-132: delete the exact key the manifest was found under.
          await env.OPENCLAW_STATE.delete(manifestKeyName)
          result.manifestDeleted = true
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors.push(`kv.delete(repo-index-manifest): ${message}`)
          console.error(JSON.stringify({
            event: "index-delete-kv-manifest-failed",
            owner, repo, key: manifestKeyName, err: message,
          }))
        }
      }

      // SIG-243 Phase 2b: delete the new tenant-scoped KV records too
      // (`repo-tenant:{id}` for the manifest, `repo-vectors:{id}` for
      // the chunk-id ledger). Reads the immutable `githubRepoId` from
      // EITHER the manifest or the vectors record — both carry the
      // same value once Phase 1+2 has stamped them. Best-effort +
      // idempotent (missing key = no-op). Skipped for pre-Phase-2
      // legacy records that lack the field (those have no new-key
      // counterpart to clean up).
      //
      // CR PR #203 — gate on DEFAULT-BRANCH state, mirroring the
      // writer's contract. The tenant keys are only populated for
      // default-branch records (`writeRepoIndexManifest`'s
      // `manifest.branch === undefined` gate + `writeRepoIndexVectors`'s
      // `!repo.includes("/__branch__/")` gate). A branch-scoped
      // delete (e.g. `pr-branch-closed`) MUST NOT touch the tenant
      // keys — the writer never populated them for that branch state,
      // and the tenant keys hold the canonical default-branch record
      // which a branch delete must never wipe.
      const isBranchScopedState =
        (manifestRead.kind === "ok" && manifestRead.manifest.branch !== undefined) ||
        (vectorsRead.kind === "ok" && vectorsRead.vectors.repo.includes("/__branch__/"))
      const tenantRepoId = isBranchScopedState
        ? null
        : (manifestRead.kind === "ok" && typeof manifestRead.manifest.githubRepoId === "number"
            ? manifestRead.manifest.githubRepoId
            : null) ??
          (vectorsRead.kind === "ok" && typeof vectorsRead.vectors.githubRepoId === "number"
            ? vectorsRead.vectors.githubRepoId
            : null)
      if (typeof tenantRepoId === "number" && Number.isInteger(tenantRepoId) && tenantRepoId > 0) {
        const newManifestKey = repoTenantKey(tenantRepoId)
        const newVectorsKey = repoVectorsTenantKey(tenantRepoId)
        try {
          await env.OPENCLAW_STATE.delete(newManifestKey)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors.push(`kv.delete(repo-tenant): ${message}`)
          console.error(JSON.stringify({
            event: "index-delete-kv-tenant-manifest-failed",
            owner, repo, key: newManifestKey, err: message,
          }))
        }
        try {
          await env.OPENCLAW_STATE.delete(newVectorsKey)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors.push(`kv.delete(repo-vectors): ${message}`)
          console.error(JSON.stringify({
            event: "index-delete-kv-tenant-vectors-failed",
            owner, repo, key: newVectorsKey, err: message,
          }))
        }
      }

      // SIG-136: drop the per-repo indexer run LEASE so nothing is
      // stranded (GDPR completeness). The key is owner-qualified via
      // `indexNamespace` and brand new (no legacy bare-repo shape), so
      // it's safe under the same owner gate as the records above. Best-
      // effort + idempotent (missing key = no-op).
      try {
        await env.OPENCLAW_STATE.delete(activeRunKey(owner, repo))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push(`kv.delete(repo-index-active-run): ${message}`)
        console.error(JSON.stringify({
          event: "index-delete-kv-active-run-failed",
          owner, repo, key: activeRunKey(owner, repo), err: message,
        }))
      }

      // SIG-132: purge any leftover same-owner LEGACY KV keys that
      // coexist with the new-shape records (already verified owner-safe
      // by the probe). VERY narrow case (a repo indexed both pre- AND
      // post-migration — effectively impossible given the indexer was
      // enabled minutes before the migration). The legacy VECTORS
      // record's ids are content-addressed under the old namespace and
      // differ from the new record's; deleteByIds them too so their
      // embeddings don't leak.
      if (vectorsLegacyOrphanKey) {
        await purgeLegacyVectorsOrphan(env, vectorsLegacyOrphanKey, owner, repo, result)
      }
      if (manifestLegacyOrphanKey) {
        try {
          await env.OPENCLAW_STATE.delete(manifestLegacyOrphanKey)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors.push(`kv.delete(legacy-manifest-orphan): ${message}`)
          console.error(JSON.stringify({
            event: "index-delete-kv-legacy-manifest-orphan-failed",
            owner, repo, key: manifestLegacyOrphanKey, err: message,
          }))
        }
      }
    }

  }

  // SIG-138 T8: wipe the repo's DO-backed code graph (SQLite). The
  // graph is keyed by indexNamespace(owner, repo) — deleting it ONLY
  // ever touches the requested tenant's DO, never another owner's data.
  // The owner guard above exists to protect SHARED KV/vector records
  // that might belong to a different owner; it must NOT gate the graph
  // delete. Graph deletion is GDPR/SOC 2 compliance and runs for the
  // requested owner/repo regardless of safeToTouchRepoOnlyState.
  //
  // Best-effort: a graph failure logs (with owner/repo for the audit
  // trail) but does NOT abort the rest of the delete; redelivery is
  // idempotent (deleteRepoGraph wipes all rows, so re-calling is safe).
  try {
    await deleteGraph(env, owner, repo)
    console.log(JSON.stringify({
      event: "index-delete-graph-deleted",
      owner, repo,
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    result.errors.push(`graph.delete(repo-graph): ${message}`)
    console.error(JSON.stringify({
      event: "index-delete-graph-failed",
      owner, repo, err: message,
    }))
  }

  // SIG-45: purge the repo's lexical (D1 FTS5) rows. Keyed by
  // indexNamespace(owner, repo) — only ever touches the requested tenant's
  // rows (the namespace embeds the owner), so like the graph delete above it
  // runs UNGUARDED by safeToTouchRepoOnlyState: this is GDPR/SOC 2 cleanup.
  // Best-effort + idempotent (a missing binding / already-empty namespace =
  // 0 rows). deleteLexicalNamespace swallows + logs its own errors, but we
  // still surface a thrown failure so a partial delete is visible.
  if (env.OPENCLAW_LEXICAL_INDEX != null) {
    try {
      result.lexicalRows += await deleteLexicalNamespace(
        env.OPENCLAW_LEXICAL_INDEX,
        indexNamespace(owner, repo),
      )
      console.log(JSON.stringify({
        event: "index-delete-lexical-deleted",
        owner, repo, rows: result.lexicalRows,
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`lexical.delete(namespace): ${message}`)
      console.error(JSON.stringify({
        event: "index-delete-lexical-failed",
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

  // SIG-247 Phase 1 PR B: drop review-memory state on repo delete /
  // uninstall. Both prefixes:
  //   - `review-memory:<owner>/<repo>:` — legacy keyspace (Phase 5
  //     will delete the writers, but cleanup on delete is GDPR/SOC 2
  //     compliance independent of the migration timeline)
  //   - `review-memory:repo:<id>:` — new keyspace; deleted when we
  //     have a verified positive `tenantRepoId` (sourced from the
  //     manifest read above, mirroring the pattern at line 439-449)
  //
  // Both deletions are best-effort + idempotent (missing key = no-op).
  // The legacy prefix is owner-qualified — safe to delete unguarded
  // by the cross-tenant probe that protects shared repo-only state.
  result.reviewMemoryKeys += await deleteKvPrefix(
    env,
    `review-memory:${owner}/${repo}:`,
    result.errors,
    "review-memory-legacy",
  )
  if (typeof reviewMemoryRepoId === "number" && reviewMemoryRepoId > 0) {
    result.reviewMemoryKeys += await deleteKvPrefix(
      env,
      `review-memory:repo:${reviewMemoryRepoId}:`,
      result.errors,
      "review-memory-repo-id",
    )
  }

  // SIG-172: drop the per-repo scoped-rules manifest
  // (`repo-index-rules:<owner>/<repo>`). Owner-qualified key with no
  // legacy bare-repo shape — runs UNGUARDED alongside the other
  // owner-qualified deletes above (and the graph delete) so it
  // can't be stranded by an owner-mismatch on the repo-only state.
  // Best-effort + idempotent (missing key = no-op).
  try {
    await deleteScopedRulesManifest(env, owner, repo)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    result.errors.push(`kv.delete(repo-index-rules): ${message}`)
    console.error(JSON.stringify({
      event: "index-delete-kv-scoped-rules-failed",
      owner, repo, err: message,
    }))
  }

  if (result.errors.length > 0) {
    result.status = "partial"
  } else if (!safeToTouchRepoOnlyState) {
    result.status = "owner-mismatch-skip"
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
    review_memory_keys: result.reviewMemoryKeys,
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

async function listBranchStateReposForRepo(args: {
  env: Env
  owner: string
  repo: string
}): Promise<{ repos: string[]; errors: string[] }> {
  const { env, owner, repo } = args
  const repos = new Set<string>()
  const errors: string[] = []
  const branchRepoPrefix = `${repo.toLowerCase()}/__branch__/`
  const keyPrefix = `${repoIndexManifestKey(owner, repo)}/__branch__/`
  let cursor: string | undefined
  for (;;) {
    let page: { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    try {
      page = await env.OPENCLAW_STATE.list({
        prefix: keyPrefix,
        limit: KV_LIST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }) as { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`kv.list(repo-index-branch-manifest): ${message}`)
      console.error(JSON.stringify({
        event: "index-delete-branch-manifest-list-failed",
        owner, repo, err: message,
      }))
      break
    }
    for (const key of page.keys) {
      let raw: string | null
      try {
        raw = await env.OPENCLAW_STATE.get(key.name)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`kv.get(branch-manifest:${key.name}): ${message}`)
        console.error(JSON.stringify({
          event: "index-delete-branch-manifest-get-failed",
          owner, repo, key: key.name, err: message,
        }))
        continue
      }
      if (raw === null) continue
      const manifest = parseRepoIndexManifest(raw)
      if (
        manifest.kind === "ok" &&
        manifest.manifest.owner === owner &&
        manifest.manifest.repo.startsWith(branchRepoPrefix)
      ) {
        repos.add(manifest.manifest.repo)
      }
    }
    if (page.list_complete) break
    if (!page.cursor) {
      errors.push("kv.list(repo-index-branch-manifest): missing cursor on incomplete page")
      break
    }
    cursor = page.cursor
  }
  return { repos: Array.from(repos).sort(), errors }
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
    const branchState = await listBranchStateReposForRepo({
      env,
      owner: parsed.owner,
      repo: parsed.repo,
    })
    if (branchState.errors.length > 0) anyError = true
    const stateRepos = [parsed.repo, ...branchState.repos]
    for (const repo of stateRepos) {
      const r = await deleteRepoIndex({
        env, owner: parsed.owner, repo,
        reason: "install-repos-removed",
      })
      results.push(r)
      if (r.status === "partial") anyError = true
    }
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
 *      from prior incomplete uninstalls, pre-PR3 indexes, OR — SIG-132 —
 *      orphaned pre-migration records still under the bare `<repo>` key
 *      shape). The match is on the manifest BODY's owner, not the key
 *      shape, so both new `<owner>/<repo>` and old `<repo>` keys match.
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
      // SIG-132: the key suffix is `<owner>/<repo>` for new records and a
      // bare `<repo>` for orphaned pre-migration records. Don't derive
      // owner/repo from the KEY SHAPE (it's ambiguous, and a repo name
      // can itself contain no slash but an owner can't be inferred from
      // an old bare key). Instead read the manifest BODY — it stores both
      // `owner` and `repo` — and match on `manifest.owner === ownerLogin`.
      // This makes BOTH new and orphaned-old records discoverable, which
      // is the GDPR-critical requirement (no customer data stranded).
      const suffix = key.name.slice(REPO_INDEX_MANIFEST_PREFIX.length)
      if (suffix.length === 0) continue
      const raw = await env.OPENCLAW_STATE.get(key.name)
      if (raw === null) continue
      const manifest = parseRepoIndexManifest(raw)
      if (manifest.kind === "ok" && manifest.manifest.owner === ownerLogin) {
        const bareRepo = manifest.manifest.repo
        if (!reposToDelete.has(bareRepo)) {
          // Use the manifest's own owner so deleteRepoIndex reconstructs
          // the right keys + probes both shapes.
          reposToDelete.set(bareRepo, manifest.manifest.owner)
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
