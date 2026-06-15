import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/src/shared/adapters/model"
import type { RepoIndexManifestV1, ReadResult as ManifestReadResult } from "@/src/lib/repo-index-manifest"
import { graphIndexEnabled } from "@/src/lib/graph-flags"
import type { IndexTarget } from "@/src/lib/index-branch"
import { readActiveRunId, shouldFinalize, writeActiveRun } from "@/src/lib/repo-index-active-run"
import { debugActiveGraphVersion } from "@/src/lib/repo-graph-client"
import { deleteLexicalIds } from "@/src/lib/lexical-index"
import { processSlice } from "@/src/lib/indexer-slice"
import { persistManifest } from "@/src/lib/indexer-persist"
import {
  type IndexableFile,
  chunkId,
  isPotentiallyIndexablePath,
  walkIndexableFiles,
} from "@/src/lib/indexer-internals"
import { readRepoIndexVectors, writeRepoIndexVectors, type RepoIndexVectorsV1 } from "@/src/lib/repo-index-vectors"
import { chunkFile, type Chunk } from "@/src/lib/chunk-core"
import { chunkFileAst, jsTsExtOf } from "@/src/lib/ast-chunker"
import { classifyRuleFilePath } from "@/src/lib/scoped-rules"
import { mapWithConcurrency } from "@/src/shared/util/bounded-concurrency"

const MAX_INCREMENTAL_CHANGED_PATHS = 200
const VECTORIZE_DELETE_BATCH = 100
const REUSE_PROBE_CONCURRENCY = 8

// SIG-422: change-triggered re-index reasons eligible for the incremental
// path. `merged-pr` (enqueued on every PR merge for the default branch) and
// `pull-request` arrive with no push `changedPaths`/`before`, so they recover
// the delta via the Compare API below. `install` / `install-repos-added` /
// `manual` are bootstrap / operator intent and stay on the full-tree path.
const INCREMENTAL_REASONS: ReadonlySet<IndexRepoMessage["reason"]> = new Set(["push", "merged-pr", "pull-request"])

// GitHub's Compare API returns the changed-file array only on the
// comparison's first page and caps it at 300 entries for the whole
// comparison. A length at the cap is treated as possibly-truncated, so the
// recovery falls back to full rather than risk an incomplete delta.
const COMPARE_FILES_PAGE_CAP = 300

// A no-paging compare (what `compareCommits` issues) returns at most the
// first 250 commits, and the changed-file array reflects only those commits.
// A comparison larger than this can therefore omit files changed in later
// commits, so recovery falls back to full above the cap (or when the count
// is unknown).
const COMPARE_COMMITS_NO_PAGING_CAP = 250

type IndexRepoMessage = Extract<JobMessage, { type: "index-repo" }>

interface IncrementalArgs {
  job: IndexRepoMessage
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  githubRepoId: number | undefined
  installationId: number
  target: IndexTarget
  headSha: string
  treeSha: string
  runId: string
  astChunking: boolean
  existingManifest: ManifestReadResult
  chunkerVersion: number
}

export async function maybeHandleIncrementalPushIndex(args: IncrementalArgs): Promise<boolean> {
  // SIG-422: bootstrap / operator-intent reasons (install, manual, …) and
  // bootstrap shards stay on the full-tree path.
  if (!INCREMENTAL_REASONS.has(args.job.reason) || args.job.shard !== undefined) {
    logIncrementalSkipped(args, "not-incremental-reason")
    return false
  }
  if (args.existingManifest.kind !== "ok") {
    logIncrementalSkipped(args, "no-prior-manifest")
    return false
  }

  const prior = args.existingManifest.manifest
  if (!canIncrementFromManifest(prior, args.owner, args.chunkerVersion)) {
    logIncrementalSkipped(args, "version-mismatch")
    return false
  }

  // SIG-422: source the changed set from the cheap push payload when it's
  // present AND the push chain is intact; otherwise recover it via the
  // Compare API (merged-pr / pull-request, or a chain-drifted push). A null
  // result means a recall-unsafe delta — fall back to the full-tree path.
  const changed = await resolveIncrementalChanged(args, prior)
  if (changed === null) return false

  if (changedIncludesScopedRules(changed)) {
    console.log(
      JSON.stringify({
        event: "index-incremental-fallback-scoped-rules-changed",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
      }),
    )
    return false
  }

  const vectorsRead = await readRepoIndexVectors(args.env, args.owner, args.target.stateRepo)
  if (vectorsRead.kind !== "ok" || !canIncrementFromVectors(vectorsRead.vectors, args.owner, args.target.stateRepo)) {
    logIncrementalSkipped(args, "vectors-not-ok")
    return false
  }

  const graphRunId = await preservedGraphRunId(args, prior)
  if (graphRunId === null) {
    logIncrementalSkipped(args, "graph-version-mismatch")
    return false
  }

  if (!changedTouchesPotentialIndex(changed)) {
    return await handleNoopIncremental(args, prior, vectorsRead.vectors, graphRunId, changed)
  }

  const tree = await args.client.getRepoTree(args.owner, args.repo, args.treeSha)
  if (!tree || tree.truncated) return false

  const indexableFiles = walkIndexableFiles(tree.tree)
  const indexableByPath = new Map(indexableFiles.map((file) => [file.path, file]))
  const filesToProcess = selectFilesToProcess(changed.upsert, indexableByPath)
  const pathsToDelete = unique([...changed.upsert, ...changed.remove])
  const idsToReplace = idsForPaths(vectorsRead.vectors, pathsToDelete)

  await writeActiveRun(args.env, args.owner, args.target.stateRepo, args.runId)

  const activeBeforeProcess = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeProcess, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-superseded-process",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
      }),
    )
    return true
  }

  const reuse = await splitReusedFiles({
    args,
    files: filesToProcess,
    existingByPath: vectorsRead.vectors.byPath,
  })
  const activeAfterReuse = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeAfterReuse, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-superseded-reuse",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
      }),
    )
    return true
  }

  const { idsByPath } = await processSlice({
    client: args.client,
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    stateRepo: args.target.stateRepo,
    namespace: args.target.namespace,
    headSha: args.headSha,
    runId: args.runId,
    files: reuse.filesToEmbed,
    astChunking: args.astChunking,
  })
  const mergedIdsByPath = { ...reuse.reusedIdsByPath, ...idsByPath }

  const newIds = idsFromByPath(mergedIdsByPath)
  const activeBeforeDelete = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeDelete, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-superseded-delete",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
      }),
    )
    return true
  }

  const missingEmbeddedPaths = filesToProcess
    .filter((file) => mergedIdsByPath[file.path] === undefined)
    .map((file) => file.path)
  if (missingEmbeddedPaths.length > 0) {
    await bestEffortDeleteNewIds(args.env, newIds)
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-partial-embed",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        missing_paths: missingEmbeddedPaths,
      }),
    )
    return false
  }

  const idsToKeep = new Set(newIds)
  const idsToDelete = idsToReplace.filter((id) => !idsToKeep.has(id))
  const vectorsResult = await writeIncrementalVectorIds({
    env: args.env,
    owner: args.owner,
    stateRepo: args.target.stateRepo,
    githubRepoId: args.githubRepoId,
    runId: args.runId,
    existing: vectorsRead.vectors,
    pathsToDelete,
    idsByPath: mergedIdsByPath,
  })
  if (!vectorsResult.proceed) {
    return true
  }
  const activeBeforeManifest = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeManifest, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-skip-superseded-manifest",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        active_run_id: activeBeforeManifest,
      }),
    )
    return true
  }

  await persistManifest({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    githubRepoId: args.githubRepoId,
    stateRepo: args.target.stateRepo,
    namespace: args.target.namespace,
    branch: args.target.isDefault ? null : args.target.branch,
    defaultBranch: args.target.defaultBranch,
    headSha: args.headSha,
    runId: args.runId,
    graphRunId: graphRunId ?? undefined,
    fileCount: indexableFiles.length,
    chunkCount: vectorsResult.chunkCount,
    shardCount: 1,
    chunkerVersion: args.chunkerVersion,
  })
  const activeAfterManifest = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeAfterManifest, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-manifest-superseded-after-write",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        active_run_id: activeAfterManifest,
      }),
    )
    throw new Error(`repo-index-manifest superseded after incremental write for ${args.target.stateRepo}`)
  }
  const oldIdsToDelete = await unreferencedOldIds(args.env, args.owner, args.target.stateRepo, idsToDelete)
  const activeBeforeOldCleanup = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeOldCleanup, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-old-id-cleanup-superseded",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        active_run_id: activeBeforeOldCleanup,
        cleanup_ids: oldIdsToDelete.length,
      }),
    )
    throw new Error(`repo-index old-id cleanup superseded after incremental write for ${args.target.stateRepo}`)
  }
  await bestEffortDeleteOldIds(args.env, oldIdsToDelete)

  console.log(
    JSON.stringify({
      event: "index-incremental-completed",
      owner: args.owner,
      repo: args.repo,
      branch: args.target.isDefault ? null : args.target.branch,
      run_id: args.runId,
      changed_upsert_paths: changed.upsert.length,
      changed_remove_paths: changed.remove.length,
      embedded_files: reuse.filesToEmbed.length,
      reused_files: reuse.reusedFiles,
      deleted_vector_ids: oldIdsToDelete.length,
    }),
  )
  return true
}

async function handleNoopIncremental(
  args: IncrementalArgs,
  prior: RepoIndexManifestV1,
  existingVectors: RepoIndexVectorsV1,
  graphRunId: string | undefined,
  changed: { upsert: string[]; remove: string[] },
): Promise<boolean> {
  await writeActiveRun(args.env, args.owner, args.target.stateRepo, args.runId)
  const idsToReplace = idsForPaths(existingVectors, changed.remove)
  const vectorsResult = await writeIncrementalVectorIds({
    env: args.env,
    owner: args.owner,
    stateRepo: args.target.stateRepo,
    githubRepoId: args.githubRepoId,
    runId: args.runId,
    existing: existingVectors,
    pathsToDelete: changed.remove,
    idsByPath: {},
  })
  if (!vectorsResult.proceed) return true

  const activeBeforeManifest = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeManifest, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-noop-skip-superseded-manifest",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        active_run_id: activeBeforeManifest,
      }),
    )
    return true
  }

  await persistManifest({
    env: args.env,
    owner: args.owner,
    repo: args.repo,
    githubRepoId: args.githubRepoId,
    stateRepo: args.target.stateRepo,
    namespace: args.target.namespace,
    branch: args.target.isDefault ? null : args.target.branch,
    defaultBranch: args.target.defaultBranch,
    headSha: args.headSha,
    runId: args.runId,
    graphRunId: graphRunId ?? undefined,
    fileCount: prior.fileCount,
    chunkCount: vectorsResult.chunkCount,
    shardCount: 1,
    chunkerVersion: args.chunkerVersion,
  })
  const activeAfterManifest = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeAfterManifest, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-noop-manifest-superseded-after-write",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        active_run_id: activeAfterManifest,
      }),
    )
    throw new Error(`repo-index-manifest superseded after noop incremental write for ${args.target.stateRepo}`)
  }
  const oldIdsToDelete = await unreferencedOldIds(args.env, args.owner, args.target.stateRepo, idsToReplace)
  const activeBeforeOldCleanup = await readActiveRunId(args.env, args.owner, args.target.stateRepo)
  if (!shouldFinalize(activeBeforeOldCleanup, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-noop-old-id-cleanup-superseded",
        owner: args.owner,
        repo: args.repo,
        branch: args.target.isDefault ? null : args.target.branch,
        run_id: args.runId,
        active_run_id: activeBeforeOldCleanup,
        cleanup_ids: oldIdsToDelete.length,
      }),
    )
    throw new Error(`repo-index noop old-id cleanup superseded after incremental write for ${args.target.stateRepo}`)
  }
  await bestEffortDeleteOldIds(args.env, oldIdsToDelete)

  console.log(
    JSON.stringify({
      event: "index-incremental-noop-completed",
      owner: args.owner,
      repo: args.repo,
      branch: args.target.isDefault ? null : args.target.branch,
      run_id: args.runId,
      changed_upsert_paths: changed.upsert.length,
      changed_remove_paths: changed.remove.length,
      deleted_vector_ids: oldIdsToDelete.length,
    }),
  )
  return true
}

type ChangedSet = { upsert: string[]; remove: string[] }

/**
 * SIG-422: resolve the changed-file delta for an incremental re-index.
 *
 * Two sources, one downstream flow:
 *   - Cheap push fast-path: when the job carries a usable `changedPaths`
 *     payload AND the push chain is intact (`prior.headSha === job.before`)
 *     AND the resolved head is the pushed commit, trust it directly. The
 *     head-pinning (`resolveIndexHead`) normally makes `headSha === job.after`,
 *     so this holds and the `before → after` delta is applied at `after`.
 *   - Compare-recovery: otherwise (merged-pr / pull-request, which carry
 *     neither; a push whose chain drifted off the manifest head; a push whose
 *     `changedPaths` was dropped as too-large/truncated; OR a pinned push that
 *     fell back to the LIVE tip on a `getCommit` 404 so `headSha !== job.after`
 *     — applying the `before → after` delta at a different head would miss the
 *     `after → tip` commits) recover the delta from the GitHub Compare API
 *     between the manifest head and the resolved head.
 *
 * Returns the changed set, or null to signal a recall-unsafe situation the
 * caller must answer with a full-tree re-index.
 */
async function resolveIncrementalChanged(
  args: IncrementalArgs,
  prior: RepoIndexManifestV1,
): Promise<ChangedSet | null> {
  const pushChanged = normalizeChangedPaths(args.job.changedPaths)
  // The head-match guard rejects the fast-path only when `after` is present
  // but the resolved head drifted off it (the `getCommit`-404 live-tip
  // fallback) — legacy push messages without `after` keep the pre-SIG-422
  // behavior and trust the chain-intact delta as before.
  const headMatchesPushed = args.job.after === undefined || args.headSha === args.job.after
  if (pushChanged !== null && prior.headSha === args.job.before && headMatchesPushed) {
    return pushChanged
  }
  return await recoverChangedViaCompare(args, prior)
}

/**
 * SIG-422: recover the changed set via the Compare API when the push
 * fast-path can't supply it. Recall-safety is absolute — every branch that
 * can't prove a complete forward delta returns null (full fallback):
 *   - status must be `ahead` or `identical` (base is an ancestor of head);
 *     `diverged` / `behind` / unknown / a failed call mean a rewrite or
 *     force-push where a delta would be unsafe.
 *   - an unknown per-file status, a file array at the 300-entry page cap
 *     (possibly truncated), or a mapped change count over the cap all force
 *     a full fallback.
 * An empty net delta is NOT a fallback: the caller's noop path advances the
 * manifest head to re-establish the push chain for the next push.
 */
async function recoverChangedViaCompare(args: IncrementalArgs, prior: RepoIndexManifestV1): Promise<ChangedSet | null> {
  const trigger = compareTrigger(args.job)

  let compare: Awaited<ReturnType<GitHubClient["compareCommits"]>>
  try {
    compare = await args.client.compareCommits(args.owner, args.repo, prior.headSha, args.headSha)
  } catch (err) {
    return logCompareFallbackFull(args, prior, trigger, "compare-failed", {
      err: err instanceof Error ? err.message : String(err),
    })
  }
  if (compare === null) {
    return logCompareFallbackFull(args, prior, trigger, "compare-failed", {})
  }
  if (compare.status !== "ahead" && compare.status !== "identical") {
    return logCompareFallbackFull(args, prior, trigger, "diverged", { compare_status: compare.status })
  }
  // A comparison spanning more than the no-paging commit cap (or one whose
  // commit count we couldn't read) can omit files changed in the dropped
  // commits, so the `files` delta may be incomplete — fall back to full.
  if (compare.totalCommits === null || compare.totalCommits > COMPARE_COMMITS_NO_PAGING_CAP) {
    return logCompareFallbackFull(args, prior, trigger, "too-many-commits", { total_commits: compare.totalCommits })
  }
  if (compare.files.length >= COMPARE_FILES_PAGE_CAP) {
    return logCompareFallbackFull(args, prior, trigger, "too-many", { file_count: compare.files.length })
  }

  const mapped = mapCompareFiles(compare.files)
  if (mapped === null) {
    return logCompareFallbackFull(args, prior, trigger, "unknown-status", {})
  }
  const changed = normalizeChangeSet(mapped.upsert, mapped.remove)
  if (changed === null) {
    return logCompareFallbackFull(args, prior, trigger, "too-many", {
      file_count: mapped.upsert.length + mapped.remove.length,
    })
  }

  console.log(
    JSON.stringify({
      event: "index-incremental-compare-recovered",
      owner: args.owner,
      repo: args.repo,
      branch: args.target.isDefault ? null : args.target.branch,
      base: prior.headSha,
      head: args.headSha,
      file_count: changed.upsert.length + changed.remove.length,
      trigger,
    }),
  )
  return changed
}

type CompareTrigger = "merged-pr" | "pull-request" | "push-drift" | "large-push" | "unknown"

/**
 * SIG-422: which change-trigger routed this job to compare-recovery — so a
 * recovered/fallback log shows the cause:
 *   - push, no `changedPaths` (dropped as too-large/truncated) → `large-push`
 *   - push, `changedPaths` present but chain drifted / head off `after`
 *     → `push-drift`
 *   - `pull-request` re-index (no push payload) → `pull-request`
 *   - `merged-pr` re-index (no push payload) → `merged-pr`
 *
 * Only the three `INCREMENTAL_REASONS` reach here. Each is matched explicitly
 * so a future reason added to that set surfaces as an `unknown` label in
 * telemetry rather than being silently mislabeled `merged-pr`.
 */
function compareTrigger(job: IndexRepoMessage): CompareTrigger {
  switch (job.reason) {
    case "push":
      return job.changedPaths === undefined ? "large-push" : "push-drift"
    case "pull-request":
      return "pull-request"
    case "merged-pr":
      return "merged-pr"
    default:
      return "unknown"
  }
}

/**
 * SIG-422: map a Compare API `files[]` array into upsert/remove path sets.
 * Returns null on ANY unrecognized file status — conservative, so a file is
 * never left stale because we didn't understand its change type.
 */
function mapCompareFiles(
  files: ReadonlyArray<{ status: string; filename: string; previous_filename: string | null }>,
): { upsert: string[]; remove: string[] } | null {
  const upsert: string[] = []
  const remove: string[] = []
  for (const file of files) {
    switch (file.status) {
      case "added":
      case "modified":
      case "changed":
      case "copied":
        upsert.push(file.filename)
        break
      case "removed":
        remove.push(file.filename)
        break
      case "renamed":
        if (file.previous_filename !== null) remove.push(file.previous_filename)
        upsert.push(file.filename)
        break
      case "unchanged":
        break
      default:
        return null
    }
  }
  return { upsert, remove }
}

function logCompareFallbackFull(
  args: IncrementalArgs,
  prior: RepoIndexManifestV1,
  trigger: CompareTrigger,
  // The fallback CAUSE (why the compare delta was rejected). Kept distinct
  // from `trigger` (which change-event routed the job to compare) so the log
  // carries both axes — e.g. a `merged-pr` (trigger) that fell back because
  // the comparison `diverged` (reason).
  reason: "diverged" | "too-many" | "too-many-commits" | "unknown-status" | "compare-failed",
  extra: Record<string, unknown>,
): null {
  console.warn(
    JSON.stringify({
      event: "index-incremental-compare-fallback-full",
      owner: args.owner,
      repo: args.repo,
      branch: args.target.isDefault ? null : args.target.branch,
      base: prior.headSha,
      head: args.headSha,
      trigger,
      reason,
      ...extra,
    }),
  )
  return null
}

function logIncrementalSkipped(
  args: IncrementalArgs,
  reason:
    | "not-incremental-reason"
    | "no-prior-manifest"
    | "version-mismatch"
    | "vectors-not-ok"
    | "graph-version-mismatch",
): void {
  console.log(
    JSON.stringify({
      event: "index-incremental-skipped",
      owner: args.owner,
      repo: args.repo,
      branch: args.target.isDefault ? null : args.target.branch,
      reason,
    }),
  )
}

function canIncrementFromManifest(manifest: RepoIndexManifestV1, owner: string, chunkerVersion: number): boolean {
  return (
    manifest.owner === owner &&
    manifest.modelId === EMBEDDING_MODEL &&
    manifest.embeddingDim === EMBEDDING_DIMENSIONS &&
    manifest.chunkerVersion === chunkerVersion
  )
}

function canIncrementFromVectors(vectors: RepoIndexVectorsV1, owner: string, stateRepo: string): boolean {
  return vectors.owner === owner && vectors.repo === stateRepo.toLowerCase()
}

async function preservedGraphRunId(
  args: IncrementalArgs,
  prior: RepoIndexManifestV1,
): Promise<string | null | undefined> {
  if (!args.target.isDefault || !graphIndexEnabled(args.env)) return undefined
  const expected = prior.graphRunId ?? prior.runId
  let active: string | null = null
  try {
    active = await debugActiveGraphVersion(args.env, args.owner, args.repo)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-graph-version-read-failed",
        owner: args.owner,
        repo: args.repo,
        run_id: args.runId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
  return active === expected ? active : null
}

function changedIncludesScopedRules(changed: { upsert: string[]; remove: string[] }): boolean {
  return [...changed.upsert, ...changed.remove].some((path) => classifyRuleFilePath(path) !== null)
}

function changedTouchesPotentialIndex(changed: { upsert: string[]; remove: string[] }): boolean {
  return [...changed.upsert, ...changed.remove].some(isPotentiallyIndexablePath)
}

interface SplitReusedFilesArgs {
  args: IncrementalArgs
  files: readonly IndexableFile[]
  existingByPath: Readonly<Record<string, string[]>>
}

async function splitReusedFiles(input: SplitReusedFilesArgs): Promise<{
  filesToEmbed: IndexableFile[]
  reusedIdsByPath: Record<string, string[]>
  reusedFiles: number
}> {
  const filesToEmbed: IndexableFile[] = []
  const reusedIdsByPath: Record<string, string[]> = {}
  let reusedFiles = 0
  const results = await mapWithConcurrency(input.files, REUSE_PROBE_CONCURRENCY, async (file) => {
    const existingIds = input.existingByPath[file.path]
    if (existingIds === undefined || existingIds.length === 0) {
      return { file, reuseIds: null }
    }
    const currentIds = await currentChunkIds(input.args, file)
    if (currentIds !== null && sameIds(existingIds, currentIds)) {
      return { file, reuseIds: [...existingIds] }
    }
    return { file, reuseIds: null }
  })
  // mapWithConcurrency preserves input order; a rejected probe falls back to
  // embedding the file at the same index so index freshness wins over reuse.
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const file = input.files[i]!
    if (result?.status !== "fulfilled") {
      filesToEmbed.push(file)
      continue
    }
    if (result.value.reuseIds !== null) {
      reusedIdsByPath[result.value.file.path] = result.value.reuseIds
      reusedFiles += 1
    } else {
      filesToEmbed.push(file)
    }
  }
  if (reusedFiles > 0) {
    console.log(
      JSON.stringify({
        event: "index-incremental-content-reused",
        owner: input.args.owner,
        repo: input.args.repo,
        branch: input.args.target.isDefault ? null : input.args.target.branch,
        run_id: input.args.runId,
        reused_files: reusedFiles,
        embed_files: filesToEmbed.length,
      }),
    )
  }
  return { filesToEmbed, reusedIdsByPath, reusedFiles }
}

async function currentChunkIds(args: IncrementalArgs, file: IndexableFile): Promise<string[] | null> {
  let content: string | null = null
  try {
    content = await args.client.getFileContent(args.owner, args.repo, file.path, args.headSha)
  } catch {
    return null
  }
  if (content === null) return null
  const chunks = chunksForFile(file.path, content, args.astChunking)
  const ids: string[] = []
  for (const chunk of chunks) {
    ids.push(await chunkId(args.target.namespace, chunk))
  }
  return ids
}

function chunksForFile(path: string, content: string, astChunking: boolean): Chunk[] {
  const ext = astChunking ? jsTsExtOf(path) : null
  if (ext === null) return chunkFile(path, content)
  return chunkFileAst(path, content, ext) ?? chunkFile(path, content)
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function normalizeChangedPaths(value: IndexRepoMessage["changedPaths"]): ChangedSet | null {
  if (value === undefined) return null
  const changed = normalizeChangeSet(value.upsert, value.remove)
  // The push fast-path treats an empty changed set as "nothing to do" and
  // declines incremental entirely (the freshness check already covered the
  // no-op). The compare path keeps an empty set so its noop branch can
  // advance the manifest head and re-establish the push chain.
  if (changed === null || changed.upsert.length + changed.remove.length === 0) return null
  return changed
}

/**
 * SIG-422: shared upsert/remove normalization — clean (drop empty / NUL),
 * dedupe, drop any path that is both upserted and removed in favor of the
 * upsert, sort for stable ordering, and enforce the incremental size cap.
 * Returns null only when the deduped count exceeds the cap (too large to be
 * cheaper incremental); an empty set is returned as-is for callers that
 * need to distinguish it.
 */
function normalizeChangeSet(upsertPaths: ReadonlyArray<string>, removePaths: ReadonlyArray<string>): ChangedSet | null {
  const upsert = new Set(cleanPaths(upsertPaths))
  const remove = new Set(cleanPaths(removePaths))
  for (const path of upsert) remove.delete(path)
  if (upsert.size + remove.size > MAX_INCREMENTAL_CHANGED_PATHS) return null
  return { upsert: [...upsert].sort(), remove: [...remove].sort() }
}

function cleanPaths(paths: ReadonlyArray<string>): string[] {
  return paths.filter((path) => path.length > 0 && !path.includes("\0"))
}

function selectFilesToProcess(
  paths: readonly string[],
  indexableByPath: ReadonlyMap<string, IndexableFile>,
): IndexableFile[] {
  const files: IndexableFile[] = []
  for (const path of paths) {
    const file = indexableByPath.get(path)
    if (file) files.push(file)
  }
  return files
}

function idsForPaths(vectors: RepoIndexVectorsV1, paths: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const path of paths) {
    for (const id of vectors.byPath[path] ?? []) ids.add(id)
  }
  return [...ids]
}

function idsFromByPath(byPath: Record<string, string[]>): string[] {
  const ids = new Set<string>()
  for (const pathIds of Object.values(byPath)) {
    for (const id of pathIds) ids.add(id)
  }
  return [...ids]
}

interface WriteIncrementalVectorIdsArgs {
  env: Env
  owner: string
  stateRepo: string
  githubRepoId: number | undefined
  runId: string
  existing: RepoIndexVectorsV1
  pathsToDelete: readonly string[]
  idsByPath: Record<string, string[]>
}

async function writeIncrementalVectorIds(
  args: WriteIncrementalVectorIdsArgs,
): Promise<{ proceed: true; chunkCount: number } | { proceed: false }> {
  const byPath: Record<string, string[]> = {}
  for (const [path, ids] of Object.entries(args.existing.byPath)) {
    byPath[path] = [...ids]
  }
  for (const path of args.pathsToDelete) {
    delete byPath[path]
  }
  for (const [path, ids] of Object.entries(args.idsByPath)) {
    const clean = unique(ids.filter((id) => id.length > 0))
    if (clean.length > 0) byPath[path] = clean
  }

  const vectors: RepoIndexVectorsV1 = {
    v: 1,
    owner: args.owner,
    repo: args.stateRepo.toLowerCase(),
    runId: args.runId,
    byPath,
  }
  const repoId = effectiveGithubRepoId(args.githubRepoId, args.existing.githubRepoId)
  if (repoId !== undefined) vectors.githubRepoId = repoId

  const activeRunId = await readActiveRunId(args.env, args.owner, args.stateRepo)
  if (!shouldFinalize(activeRunId, args.runId)) {
    console.warn(
      JSON.stringify({
        event: "repo-index-vectors-incremental-stale-skip",
        owner: args.owner,
        repo: args.stateRepo,
        run_id: args.runId,
        active_run_id: activeRunId,
      }),
    )
    return { proceed: false }
  }

  const ok = await writeRepoIndexVectors(args.env, vectors)
  if (!ok) throw new Error(`repo-index-vectors incremental write failed for ${args.stateRepo}`)
  return { proceed: true, chunkCount: idsFromByPath(byPath).length }
}

function effectiveGithubRepoId(incoming: number | undefined, existing: number | undefined): number | undefined {
  if (typeof incoming === "number" && Number.isInteger(incoming) && incoming > 0) return incoming
  if (typeof existing === "number" && Number.isInteger(existing) && existing > 0) return existing
  return undefined
}

async function deleteVectorIds(env: Env, ids: readonly string[]): Promise<void> {
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += VECTORIZE_DELETE_BATCH) {
    batches.push(ids.slice(i, i + VECTORIZE_DELETE_BATCH))
  }
  const results = await Promise.allSettled(batches.map((batch) => env.OPENCLAW_CODE_INDEX.deleteByIds(batch)))
  const rejected = results.filter((result) => result.status === "rejected")
  if (rejected.length > 0) throw new Error(`${rejected.length} vector delete batches failed`)
}

async function deleteLexicalRows(
  env: Env,
  ids: readonly string[],
  reason: "new-id-cleanup" | "old-id-cleanup",
): Promise<void> {
  if (env.OPENCLAW_LEXICAL_INDEX == null) {
    console.warn(
      JSON.stringify({
        event: "index-incremental-lexical-cleanup-skipped",
        reason,
        count: ids.length,
      }),
    )
    return
  }
  await deleteLexicalIds(env.OPENCLAW_LEXICAL_INDEX, ids)
}

async function bestEffortDeleteNewIds(env: Env, ids: readonly string[]): Promise<void> {
  await bestEffortDeleteIds(env, ids, "index-incremental-new-id-cleanup-failed", "new-id-cleanup")
}

async function bestEffortDeleteOldIds(env: Env, ids: readonly string[]): Promise<void> {
  await bestEffortDeleteIds(env, ids, "index-incremental-old-id-cleanup-failed", "old-id-cleanup")
}

async function unreferencedOldIds(
  env: Env,
  owner: string,
  stateRepo: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  const current = await readRepoIndexVectors(env, owner, stateRepo)
  if (current.kind !== "ok") {
    console.warn(
      JSON.stringify({
        event: "index-incremental-old-id-cleanup-skipped",
        owner,
        repo: stateRepo,
        reason: current.kind,
      }),
    )
    return []
  }
  const referenced = new Set(idsFromByPath(current.vectors.byPath))
  return ids.filter((id) => !referenced.has(id))
}

async function bestEffortDeleteIds(
  env: Env,
  ids: readonly string[],
  event: "index-incremental-new-id-cleanup-failed" | "index-incremental-old-id-cleanup-failed",
  lexicalReason: "new-id-cleanup" | "old-id-cleanup",
): Promise<void> {
  if (ids.length === 0) return
  const errors: string[] = []
  try {
    await deleteVectorIds(env, ids)
  } catch (err) {
    errors.push(`vector: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    await deleteLexicalRows(env, ids, lexicalReason)
  } catch (err) {
    errors.push(`lexical: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (errors.length > 0) {
    console.warn(
      JSON.stringify({
        event,
        count: ids.length,
        errors,
      }),
    )
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
