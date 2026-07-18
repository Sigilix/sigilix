// ARC-235 — async indexer Cloudflare Queue consumer.
// Resolves immutable identity, walks a pinned tree, embeds one bounded slice,
// and publishes or queues one retry-idempotent continuation.

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/src/shared/adapters/model"
import { isManifestFresh, readRepoIndexManifest } from "./repo-index-manifest"
import { isRepoSensitive } from "./repo-policy"
import { writeActiveRun, readActiveRunId, shouldFinalize } from "./repo-index-active-run"
import { enqueueWarmupRerunsForIndex } from "./warmup"
import { commitGraph, debugActiveGraphVersion } from "./repo-graph-client"
import { graphIndexEnabled } from "./graph-flags"
import { resolveIndexTarget } from "./index-branch"
import {
  activeIndexAllowsFreshSkip,
  activeIndexModeForBootstrap,
  activeIndexModeForContinuation,
  activeIndexRunAlreadyPublished,
  readActiveIndexProgress,
  repoActiveIndexChunkCount,
  resolveLiveGithubRepoId,
  stageActiveIndexSlice,
  type StageActiveIndexResult,
} from "./indexer-active-index"
import {
  MAX_FILES_PER_JOB,
  INDEX_JOB_PROCESSING_BUDGET_MS,
  effectiveChunkerVersion,
  astChunkingEnabled,
  computeRunId,
  walkIndexableFiles,
  leaseAllows,
  resolveIndexHead,
} from "@/src/lib/indexer-internals"
import { processSlice } from "@/src/lib/indexer-slice"
import { CITATION_CHUNK_VERSION } from "@/src/lib/chunk-core"
import { maybeHandleIncrementalPushIndex } from "@/src/lib/indexer-incremental"
import {
  enqueueNextShard,
  persistManifest,
  persistVectorIds,
  persistScopedRulesManifest,
} from "@/src/lib/indexer-persist"

export { chunkFile, splitOversizedWindow } from "./chunk-core"
export type { Chunk } from "./chunk-core"

export {
  CHUNKER_VERSION,
  MAX_FILES_PER_JOB,
  INDEX_JOB_PROCESSING_BUDGET_MS,
  effectiveChunkerVersion,
  astChunkingEnabled,
  computeRunId,
  walkIndexableFiles,
  isPotentiallyIndexablePath,
  chunkId,
  shouldSkipForLength,
} from "@/src/lib/indexer-internals"
export type { TreeEntry, IndexableFile } from "@/src/lib/indexer-internals"
export type { ProcessSliceResult } from "@/src/lib/indexer-slice"

export { graphIndexEnabled } from "./graph-flags"

/** True when this run still owns finalization and may commit its graph. */
export function shouldCommitGraph(args: { activeRunId: string | null; runId: string }): boolean {
  return shouldFinalize(args.activeRunId, args.runId)
}

// ---------------------------------------------------------------------
// Consumer entry point
// ---------------------------------------------------------------------

type IndexRepoMessage = Extract<JobMessage, { type: "index-repo" }>

interface ConsumerArgs {
  job: IndexRepoMessage
  env: Env
}

export async function handleIndexRepoJob(args: ConsumerArgs): Promise<void> {
  const deadlineMs = Date.now() + INDEX_JOB_PROCESSING_BUDGET_MS
  if (args.job.shard !== undefined) {
    return handleShardJob(args.job, args.job.shard, args.env, deadlineMs)
  }
  return handleBootstrapJob(args.job, args.env, deadlineMs)
}

async function handleBootstrapJob(job: IndexRepoMessage, env: Env, deadlineMs: number): Promise<void> {
  const { owner, repo, installationId, reason } = job
  const astOn = astChunkingEnabled(env)

  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(
      JSON.stringify({
        event: "index-job-skip-sensitive-consumer",
        owner,
        repo,
        installation_id: installationId,
        reason,
      }),
    )
    return
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("indexer: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }

  const client = await buildClient(env, installationId)

  const repoMeta = await client.getRepository(owner, repo)
  if (!repoMeta) {
    console.log(
      JSON.stringify({
        event: "index-job-skip-repo-not-found",
        owner,
        repo,
        installation_id: installationId,
        reason,
      }),
    )
    return
  }
  const githubRepoId = resolveLiveGithubRepoId({
    liveGithubRepoId: repoMeta.id,
    queuedGithubRepoId: job.githubRepoId,
  })
  const target = await resolveIndexTarget({
    owner,
    repo,
    defaultBranch: repoMeta.default_branch,
    ...(job.branch ? { branch: job.branch } : {}),
  })
  const namespace = target.namespace
  const stateRepo = target.stateRepo
  const activeIndexMode = activeIndexModeForBootstrap(env, target.isDefault)

  // SIG-422: read the prior manifest BEFORE resolving the head. The PUSH
  // pin (below) is only safe to apply when this run's push chain is intact
  // (`prior.headSha === job.before`) — i.e. `job.after` is the immediate
  // next commit, so the manifest can only advance, never regress. The read
  // is otherwise unchanged (the freshness check + incremental path reuse it).
  const existing = await readRepoIndexManifest(env, owner, stateRepo)
  if (existing.kind === "ok") {
    resolveLiveGithubRepoId({
      liveGithubRepoId: githubRepoId,
      queuedGithubRepoId: job.githubRepoId,
      priorManifest: existing.manifest,
    })
  }
  const priorHeadSha = existing.kind === "ok" ? existing.manifest.headSha : undefined
  const head = await resolveIndexHead({ client, owner, repo, target, job, priorHeadSha })
  if (!head) {
    console.log(
      JSON.stringify({
        event: "index-job-skip-branch-not-found",
        owner,
        repo,
        installation_id: installationId,
        branch: target.branch,
        default_branch: repoMeta.default_branch,
      }),
    )
    return
  }
  const { headSha, treeSha } = head

  const runId = await computeRunId({
    owner,
    repo: stateRepo,
    headSha,
    modelId: EMBEDDING_MODEL,
    chunkerVersion: effectiveChunkerVersion(astOn),
  })

  // Freshness check — Codex v1 MAJOR. Skip when (owner, headSha,
  // modelId, chunkerVersion, embeddingDim) all match the prior run.
  if (existing.kind === "ok") {
    const fresh = isManifestFresh({
      manifest: existing.manifest,
      currentHeadSha: headSha,
      currentOwner: owner,
      currentModelId: EMBEDDING_MODEL,
      currentEmbeddingDim: EMBEDDING_DIMENSIONS,
      currentChunkerVersion: effectiveChunkerVersion(astOn),
      currentCitationChunkVersion: CITATION_CHUNK_VERSION,
    })
    if (
      fresh &&
      (await activeIndexAllowsFreshSkip({
        env,
        mode: activeIndexMode,
        isDefaultBranch: target.isDefault,
        githubRepoId,
        manifest: existing.manifest,
      }))
    ) {
      if (
        !target.isDefault ||
        (await freshManifestHasActiveGraph({ env, owner, repo, runId, graphRunId: existing.manifest.graphRunId }))
      ) {
        console.log(
          JSON.stringify({
            event: "index-job-skip-fresh",
            owner,
            repo,
            branch: target.isDefault ? null : target.branch,
            head_sha: headSha,
            run_id: runId,
          }),
        )
        return
      }
    }
  } else if (existing.kind === "invalid") {
    console.warn(
      JSON.stringify({
        event: "repo-index-manifest-invalid",
        owner,
        repo,
        branch: target.isDefault ? null : target.branch,
        state_repo: stateRepo,
        reason: existing.reason,
      }),
    )
    // Fall through to re-index.
  }

  if (
    await maybeHandleIncrementalPushIndex({
      job,
      env,
      client,
      owner,
      repo,
      githubRepoId,
      installationId,
      target,
      headSha,
      treeSha,
      runId,
      activeIndexMode,
      astChunking: astOn,
      existingManifest: existing,
      chunkerVersion: effectiveChunkerVersion(astOn),
    })
  ) {
    return
  }

  // SIG-136: claim the run lease as the FIRST side-effecting write after
  // Claim before slow work so an older run cannot overwrite a newer lease late.
  await writeActiveRun(env, owner, stateRepo, runId)

  const tree = await client.getRepoTree(owner, repo, treeSha)
  if (!tree) {
    console.log(
      JSON.stringify({
        event: "index-job-skip-tree-not-found",
        owner,
        repo,
        tree_sha: treeSha,
      }),
    )
    return
  }
  if (tree.truncated) {
    console.warn(
      JSON.stringify({
        event: "index-tree-truncated",
        owner,
        repo,
        head_sha: headSha,
        total_entries: tree.tree.length,
      }),
    )
    // Codex v2 BLOCKING: do NOT write a manifest. Customer retrieval
    // stays empty until a partial-indexing fallback ships.
    return
  }

  const indexableFiles = walkIndexableFiles(tree.tree)
  console.log(
    JSON.stringify({
      event: "index-tree-walked",
      owner,
      repo,
      branch: target.isDefault ? null : target.branch,
      run_id: runId,
      total_entries: tree.tree.length,
      indexable_files: indexableFiles.length,
    }),
  )

  // Default-branch scoped rules are additive, best-effort, and lease-gated.
  if (target.isDefault) {
    try {
      await persistScopedRulesManifest({
        env,
        client,
        owner,
        repo,
        headSha,
        runId,
        stateRepo,
        treeEntries: tree.tree,
      })
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "scoped-rules-manifest-write-failed",
          owner,
          repo,
          run_id: runId,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  const totalFiles = indexableFiles.length
  if (totalFiles === 0) {
    // Empty repo (or all-filtered). Write a manifest so we don't
    // re-walk on every webhook for this SHA.
    // SIG-138: read activeRunId explicitly so we can reuse it for the graph
    // commit check below without a second KV read (don't re-read KV).
    const activeRunId = await readActiveRunId(env, owner, stateRepo)
    if (!shouldFinalize(activeRunId, runId)) {
      console.warn(
        JSON.stringify({
          event: "index-job-skip-superseded-finalize",
          owner,
          repo,
          branch: target.isDefault ? null : target.branch,
          run_id: runId,
          site: "bootstrap-empty-manifest",
        }),
      )
      return
    }
    const activeSlice = await stageActiveIndexSlice({
      env,
      mode: activeIndexMode,
      isDefaultBranch: target.isDefault,
      githubRepoId,
      installationId,
      runId,
      totalFiles: 0,
      lo: 0,
      hi: 0,
      idsByPath: {},
      finalize: true,
    })
    await persistManifest({
      env,
      owner,
      repo,
      githubRepoId,
      stateRepo,
      namespace,
      headSha,
      runId,
      branch: target.isDefault ? null : target.branch,
      defaultBranch: target.defaultBranch,
      fileCount: 0,
      chunkCount: 0,
      shardCount: 1,
      chunkerVersion: effectiveChunkerVersion(astOn),
      ...(activeSlice.activeIndex ? { activeIndex: activeSlice.activeIndex } : {}),
      roleClassify: { client, treeEntries: tree.tree },
    })
    console.log(
      JSON.stringify({
        event: "index-job-completed",
        owner,
        repo,
        branch: target.isDefault ? null : target.branch,
        run_id: runId,
        file_count: 0,
        chunk_count: 0,
        shard_count: 1,
      }),
    )
    // SIG-138: commit an empty graph version to GC any stale graph left
    // from a previously-indexed repo that is now empty. Best-effort —
    // never fails the index job.
    if (target.isDefault && graphIndexEnabled(env) && shouldCommitGraph({ activeRunId, runId })) {
      try {
        await commitGraph(env, owner, repo, runId)
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "graph-commit-failed",
            owner,
            repo,
            run_id: runId,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
    return
  }

  let activeSlice: StageActiveIndexResult
  let chunkCount = 0
  let sliceHi = 0
  const resumed = await readActiveIndexProgress({
    env,
    mode: activeIndexMode,
    isDefaultBranch: target.isDefault,
    githubRepoId,
    installationId,
    runId,
    totalFiles,
  })
  if (resumed?.completedThrough) {
    activeSlice = resumed
    chunkCount = resumed.chunkCount ?? 0
    sliceHi = resumed.completedThrough
  } else {
    const sliceFiles = indexableFiles.slice(0, Math.min(totalFiles, MAX_FILES_PER_JOB))
    const processed = await processSlice({
      client,
      env,
      owner,
      repo,
      stateRepo,
      namespace,
      headSha,
      runId,
      files: sliceFiles,
      astChunking: astOn,
      deadlineMs,
    })
    if (processed.processedFileCount <= 0) throw new Error("indexer slice made no progress")
    chunkCount = processed.chunkCount
    const vectorsResult = await persistVectorIds({
      env,
      owner,
      repo: stateRepo,
      githubRepoId,
      runId,
      idsByPathSlice: processed.idsByPath,
      isBootstrap: true,
    })
    if (!vectorsResult.proceed) return
    activeSlice = await stageActiveIndexSlice({
      env,
      mode: activeIndexMode,
      isDefaultBranch: target.isDefault,
      githubRepoId,
      installationId,
      runId,
      totalFiles,
      lo: 0,
      hi: processed.processedFileCount,
      idsByPath: processed.idsByPath,
      finalize: processed.processedFileCount >= totalFiles,
    })
    chunkCount = activeSlice.chunkCount ?? chunkCount
    sliceHi = activeSlice.completedThrough ?? processed.processedFileCount
  }
  if (activeSlice.runSealed && activeSlice.activeIndex === undefined) return

  if (sliceHi < totalFiles) {
    // Hand off to the next continuation shard. Final shard will write
    // the manifest with cumulative totals; this bootstrap doesn't.
    if (!(await leaseAllows(env, owner, stateRepo, runId))) {
      console.warn(
        JSON.stringify({
          event: "index-job-skip-superseded-finalize",
          site: "bootstrap-enqueue",
          owner,
          repo,
          branch: target.isDefault ? null : target.branch,
          run_id: runId,
        }),
      )
      return
    }
    await enqueueNextShard(env, {
      owner,
      repo,
      githubRepoId,
      installationId,
      reason,
      activeIndexMode,
      ...(activeSlice.bookmark ? { activeIndexBookmark: activeSlice.bookmark } : {}),
      ...(target.isDefault ? {} : { branch: target.branch }),
      lo: sliceHi,
      hi: Math.min(sliceHi + MAX_FILES_PER_JOB, totalFiles),
      headSha,
      treeSha,
      defaultBranch: target.defaultBranch,
      totalFiles,
      filesDone: sliceHi,
      chunksDone: chunkCount,
      shardsDone: activeSlice.shardCount ?? 1,
      runId,
    })
    return
  }

  // Single-shard run — write manifest now.
  // SIG-138: read activeRunId explicitly so we can reuse it for the graph
  // commit check below without a second KV read (don't re-read KV).
  const activeRunId = await readActiveRunId(env, owner, stateRepo)
  if (!shouldFinalize(activeRunId, runId)) {
    console.warn(
      JSON.stringify({
        event: "index-job-skip-superseded-finalize",
        site: "bootstrap-manifest",
        owner,
        repo,
        branch: target.isDefault ? null : target.branch,
        run_id: runId,
      }),
    )
    return
  }
  const publishedChunkCount = activeSlice.activeIndex ? repoActiveIndexChunkCount(activeSlice.activeIndex) : chunkCount
  await persistManifest({
    env,
    owner,
    repo,
    githubRepoId,
    stateRepo,
    namespace,
    headSha,
    runId,
    branch: target.isDefault ? null : target.branch,
    defaultBranch: target.defaultBranch,
    fileCount: sliceHi,
    chunkCount: publishedChunkCount,
    shardCount: activeSlice.shardCount ?? 1,
    chunkerVersion: effectiveChunkerVersion(astOn),
    ...(activeSlice.activeIndex ? { activeIndex: activeSlice.activeIndex } : {}),
    roleClassify: { client, treeEntries: tree.tree },
  })
  console.log(
    JSON.stringify({
      event: "index-job-completed",
      owner,
      repo,
      branch: target.isDefault ? null : target.branch,
      run_id: runId,
      file_count: sliceHi,
      chunk_count: publishedChunkCount,
      shard_count: activeSlice.shardCount ?? 1,
    }),
  )
  // SIG-138: commit the graph version after a successful manifest write,
  // lease-gated. Best-effort — never fails the index job.
  if (target.isDefault && graphIndexEnabled(env) && shouldCommitGraph({ activeRunId, runId })) {
    try {
      await commitGraph(env, owner, repo, runId)
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "graph-commit-failed",
          owner,
          repo,
          run_id: runId,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
  // Warmup reruns are deduped and best-effort after the index is durable.
  try {
    if (target.isDefault)
      await enqueueWarmupRerunsForIndex({
        env,
        client,
        owner,
        repo,
        installationId,
        runId,
      })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "warmup-rerun-fanout-failed",
        owner,
        repo,
        run_id: runId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

async function freshManifestHasActiveGraph(args: {
  env: Env
  owner: string
  repo: string
  runId: string
  graphRunId?: string | undefined
}): Promise<boolean> {
  const { env, owner, repo, runId, graphRunId } = args
  if (!graphIndexEnabled(env)) return true

  let activeGraphVersion: string | null = null
  try {
    activeGraphVersion = await debugActiveGraphVersion(env, owner, repo)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "graph-active-version-read-failed",
        owner,
        repo,
        run_id: runId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return true
  }

  if (activeGraphVersion === runId || (graphRunId !== undefined && activeGraphVersion === graphRunId)) return true

  console.warn(
    JSON.stringify({
      event: "index-job-fresh-manifest-graph-missing",
      owner,
      repo,
      run_id: runId,
      active_graph_version: activeGraphVersion,
    }),
  )
  return false
}

async function handleShardJob(
  job: IndexRepoMessage,
  shard: NonNullable<IndexRepoMessage["shard"]>,
  env: Env,
  deadlineMs: number,
): Promise<void> {
  const { owner, repo, installationId, reason } = job
  const resolvedDefaultBranch = shard.defaultBranch ?? job.branch ?? null
  if (resolvedDefaultBranch === null) {
    console.warn(
      JSON.stringify({
        event: "index-shard-default-branch-missing",
        owner,
        repo,
        run_id: shard.runId,
        shard_lo: shard.lo,
        shard_hi: shard.hi,
        note: "legacy shard missing defaultBranch; using sentinel",
      }),
    )
  }
  const target = await resolveIndexTarget({
    owner,
    repo,
    defaultBranch: resolvedDefaultBranch ?? "__default_unknown__",
    ...(job.branch ? { branch: job.branch } : {}),
  })
  const stateRepo = target.stateRepo
  const namespace = target.namespace
  const astOn = astChunkingEnabled(env)
  const activeIndexMode = activeIndexModeForContinuation(job.activeIndexMode, target.isDefault)
  const completedShardCount =
    typeof shard.shardsDone === "number" && Number.isSafeInteger(shard.shardsDone) && shard.shardsDone >= 1
      ? shard.shardsDone
      : Math.max(1, Math.ceil(shard.lo / MAX_FILES_PER_JOB))

  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(
      JSON.stringify({
        event: "index-job-skip-sensitive-consumer",
        owner,
        repo,
        installation_id: installationId,
        reason,
        run_id: shard.runId,
      }),
    )
    return
  }

  // Abort a continuation if embedding or chunking config drifted.
  const currentRunId = await computeRunId({
    owner,
    repo: stateRepo,
    headSha: shard.headSha,
    modelId: EMBEDDING_MODEL,
    chunkerVersion: effectiveChunkerVersion(astOn),
  })
  if (currentRunId !== shard.runId) {
    console.warn(
      JSON.stringify({
        event: "index-shard-config-drift",
        owner,
        repo,
        expected_run_id: shard.runId,
        current_run_id: currentRunId,
      }),
    )
    return
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("indexer: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const client = await buildClient(env, installationId)
  const repoMeta = await client.getRepository(owner, repo)
  if (!repoMeta) {
    console.warn(
      JSON.stringify({
        event: "index-shard-repo-not-found",
        owner,
        repo,
        run_id: shard.runId,
      }),
    )
    return
  }
  const githubRepoId = resolveLiveGithubRepoId({
    liveGithubRepoId: repoMeta.id,
    queuedGithubRepoId: job.githubRepoId,
  })
  if (
    await activeIndexRunAlreadyPublished({
      env,
      mode: activeIndexMode,
      owner,
      stateRepo,
      isDefaultBranch: target.isDefault,
      githubRepoId,
      runId: shard.runId,
    })
  ) {
    return
  }

  const tree = await client.getRepoTree(owner, repo, shard.treeSha)
  if (!tree) {
    console.warn(
      JSON.stringify({
        event: "index-shard-tree-not-found",
        owner,
        repo,
        tree_sha: shard.treeSha,
        run_id: shard.runId,
      }),
    )
    return
  }
  if (tree.truncated) {
    console.warn(
      JSON.stringify({
        event: "index-tree-truncated",
        owner,
        repo,
        head_sha: shard.headSha,
        total_entries: tree.tree.length,
        run_id: shard.runId,
      }),
    )
    return
  }
  const indexableFiles = walkIndexableFiles(tree.tree)
  if (indexableFiles.length !== shard.totalFiles) {
    // Refuse a filtered-tree mismatch; a later full run repairs it.
    console.warn(
      JSON.stringify({
        event: "index-shard-tree-drift",
        owner,
        repo,
        run_id: shard.runId,
        expected: shard.totalFiles,
        current: indexableFiles.length,
      }),
    )
    return
  }

  // Validate the lease before embedding; persistVectorIds rechecks after it.
  if (!(await leaseAllows(env, owner, stateRepo, shard.runId))) {
    console.warn(
      JSON.stringify({
        event: "index-job-skip-superseded-shard",
        owner,
        repo,
        run_id: shard.runId,
        lo: shard.lo,
        hi: shard.hi,
      }),
    )
    return
  }
  await writeActiveRun(env, owner, stateRepo, shard.runId)

  let activeSlice: StageActiveIndexResult
  let actualHi = shard.lo
  let sliceChunkCount = 0
  const resumed = await readActiveIndexProgress({
    env,
    mode: activeIndexMode,
    isDefaultBranch: target.isDefault,
    githubRepoId,
    installationId,
    runId: shard.runId,
    totalFiles: shard.totalFiles,
  })
  if (resumed && resumed.completedThrough !== undefined && resumed.completedThrough > shard.lo) {
    activeSlice = resumed
    actualHi = resumed.completedThrough
  } else {
    if (resumed?.completedThrough !== undefined && resumed.completedThrough < shard.lo) {
      throw new Error("repo active index continuation is ahead of the durable high-water")
    }
    const processed = await processSlice({
      client,
      env,
      owner,
      repo,
      stateRepo,
      namespace,
      headSha: shard.headSha,
      runId: shard.runId,
      files: indexableFiles.slice(shard.lo, shard.hi),
      astChunking: astOn,
      deadlineMs,
    })
    if (processed.processedFileCount <= 0) throw new Error("indexer slice made no progress")
    sliceChunkCount = processed.chunkCount
    const vectorsResult = await persistVectorIds({
      env,
      owner,
      repo: stateRepo,
      githubRepoId,
      runId: shard.runId,
      idsByPathSlice: processed.idsByPath,
      isBootstrap: false,
    })
    if (!vectorsResult.proceed) return
    activeSlice = await stageActiveIndexSlice({
      env,
      mode: activeIndexMode,
      isDefaultBranch: target.isDefault,
      githubRepoId,
      installationId,
      runId: shard.runId,
      totalFiles: shard.totalFiles,
      lo: shard.lo,
      hi: shard.lo + processed.processedFileCount,
      idsByPath: processed.idsByPath,
      ...(job.activeIndexBookmark ? { bookmark: job.activeIndexBookmark } : {}),
      finalize: shard.lo + processed.processedFileCount >= shard.totalFiles,
    })
    actualHi = activeSlice.completedThrough ?? shard.lo + processed.processedFileCount
  }
  if (activeSlice.runSealed && activeSlice.activeIndex === undefined) return

  const cumulativeFiles = actualHi
  const cumulativeChunks = activeSlice.chunkCount ?? shard.chunksDone + sliceChunkCount
  const currentShardCount = activeSlice.shardCount ?? completedShardCount + 1

  if (actualHi >= shard.totalFiles) {
    const activeRunId = await readActiveRunId(env, owner, stateRepo)
    if (!shouldFinalize(activeRunId, shard.runId)) {
      console.warn(
        JSON.stringify({
          event: "index-job-skip-superseded-finalize",
          site: "shard-manifest",
          owner,
          repo,
          run_id: shard.runId,
        }),
      )
      return
    }
    const publishedChunkCount = activeSlice.activeIndex
      ? repoActiveIndexChunkCount(activeSlice.activeIndex)
      : cumulativeChunks
    await persistManifest({
      env,
      owner,
      repo,
      githubRepoId,
      stateRepo,
      namespace,
      branch: target.isDefault ? null : target.branch,
      defaultBranch: target.defaultBranch,
      headSha: shard.headSha,
      runId: shard.runId,
      fileCount: cumulativeFiles,
      chunkCount: publishedChunkCount,
      shardCount: currentShardCount,
      chunkerVersion: effectiveChunkerVersion(astOn),
      ...(activeSlice.activeIndex ? { activeIndex: activeSlice.activeIndex } : {}),
      roleClassify: { client, treeEntries: tree.tree },
    })
    console.log(
      JSON.stringify({
        event: "index-job-completed",
        owner,
        repo,
        run_id: shard.runId,
        file_count: cumulativeFiles,
        chunk_count: publishedChunkCount,
        shard_count: currentShardCount,
      }),
    )
    // SIG-138: commit the graph version after a successful manifest write,
    // lease-gated. Best-effort — never fails the index job.
    if (target.isDefault && graphIndexEnabled(env) && shouldCommitGraph({ activeRunId, runId: shard.runId })) {
      try {
        await commitGraph(env, owner, repo, shard.runId)
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "graph-commit-failed",
            owner,
            repo,
            run_id: shard.runId,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
    // Same deduped, best-effort warmup fanout as the single-shard path.
    try {
      if (target.isDefault)
        await enqueueWarmupRerunsForIndex({
          env,
          client,
          owner,
          repo,
          installationId,
          runId: shard.runId,
        })
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "warmup-rerun-fanout-failed",
          owner,
          repo,
          run_id: shard.runId,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    return
  }

  if (!(await leaseAllows(env, owner, stateRepo, shard.runId))) {
    console.warn(
      JSON.stringify({
        event: "index-job-skip-superseded-finalize",
        site: "shard-enqueue",
        owner,
        repo,
        run_id: shard.runId,
      }),
    )
    return
  }
  await enqueueNextShard(env, {
    owner,
    repo,
    githubRepoId,
    installationId,
    reason,
    activeIndexMode,
    ...(activeSlice.bookmark ? { activeIndexBookmark: activeSlice.bookmark } : {}),
    ...(target.isDefault ? {} : { branch: target.branch }),
    lo: actualHi,
    hi: Math.min(actualHi + MAX_FILES_PER_JOB, shard.totalFiles),
    headSha: shard.headSha,
    treeSha: shard.treeSha,
    defaultBranch: target.defaultBranch,
    totalFiles: shard.totalFiles,
    filesDone: cumulativeFiles,
    chunksDone: cumulativeChunks,
    shardsDone: currentShardCount,
    runId: shard.runId,
  })
}

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("indexer: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}
