// ARC-235 — async indexer Cloudflare Queue consumer.
//
// Handles `index-repo` messages enqueued by ARC-234's webhook producer
// (and, later, by ARC-237/SIG-35 push-driven re-index). Walks the target
// branch tree via GitHub Trees + Contents APIs using the installation
// token, chunks files into 30-line overlapping windows, embeds via the
// Workers AI binding, and upserts to OPENCLAW_CODE_INDEX under
// `namespace = <owner>/<repo>` lowercased for default branches and an isolated
// `<owner>/<repo>/__branch__/<encodedBranch>` namespace for non-default
// branch indexes.
//
// State machine — bootstrap (message.shard is undefined):
//   1. Sensitive-repo gate (consumer-side defense-in-depth).
//   2. Resolve default branch → headSha + treeSha (Codex v2 B1: these
//      are DIFFERENT SHAs; the Trees endpoint takes a tree SHA).
//   3. Compute runId from (owner, repo, headSha, modelId, chunkerVersion).
//   4. Freshness check vs manifest. Same SHA + same config → skip.
//   5. Fetch the tree. Truncated → refuse + log + no manifest.
//   6. Filter to indexable files (extension + skip-dirs + size).
//   7. Process slice [0, MAX_FILES_PER_JOB) via the streaming pipeline.
//   8. If totalFiles > MAX_FILES_PER_JOB: enqueue the next shard.
//      Else: write the manifest.
//
// State machine — shard (message.shard is defined):
//   1. Sensitive-repo gate.
//   2. Config-drift check: recompute current runId; mismatch → refuse.
//   3. Fetch the tree at shard.treeSha. Truncated → refuse.
//   4. Drift check: indexableFiles.length === shard.totalFiles.
//   5. Process slice [shard.lo, shard.hi).
//   6. Accumulate filesDone/chunksDone. Final shard writes manifest.
//
// Streaming pipeline: two-buffer flush. Chunks accumulate to EMBED_BATCH
// before embedding; embedded vectors accumulate to UPSERT_BATCH before
// upsert. Memory stays bounded — Codex v2 MAJOR note on the 128 MB
// isolate limit; the v1 design's "buffer all chunks then all vectors"
// would have OOM'd on 10k+ chunk runs.
//
// Idempotency: chunk IDs are content-addressed (sha256 over namespace +
// path + lines + content, truncated to 48 chars). Re-running the same
// slice upserts to the same IDs — Vectorize replaces in place. Safe
// against queue retries + bootstrap-side double-fanout.

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
// SIG-376 (SIG-318 Tier-1 7/8): the pure foundation, the embed/upsert
// pipeline, and the persistence + enqueue cluster were lifted into sibling
// leaf modules. Core imports back the symbols its consumer handlers call,
// and re-exports the previously-public ones so importers + tests resolve
// them unchanged via "@/src/lib/indexer".
import {
  MAX_FILES_PER_JOB,
  effectiveChunkerVersion,
  astChunkingEnabled,
  computeRunId,
  walkIndexableFiles,
  leaseAllows,
} from "@/src/lib/indexer-internals"
import { processSlice } from "@/src/lib/indexer-slice"
import { maybeHandleIncrementalPushIndex } from "@/src/lib/indexer-incremental"
import {
  enqueueNextShard,
  persistManifest,
  persistVectorIds,
  persistScopedRulesManifest,
} from "@/src/lib/indexer-persist"

// SIG-131: re-export the chunking primitives so existing consumers that
// import them from "./indexer" (branch-retrieval.ts, tests/indexer-pure)
// keep working unchanged after the move to chunk-core.ts.
export { chunkFile, splitOversizedWindow } from "./chunk-core"
export type { Chunk } from "./chunk-core"

// SIG-376: re-export the previously-public symbols moved into the leaf
// modules so every importer + test that reads them from "@/src/lib/indexer"
// keeps resolving unchanged. Private moved symbols (`leaseAllows`,
// `processSlice`, the persist helpers, `sha256HexPrefix`, `pathHitsSkipDir`,
// the constants/types only used internally) are NOT re-exported.
export {
  CHUNKER_VERSION,
  MAX_FILES_PER_JOB,
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

/**
 * True iff this run should call commitGraphVersion after writing the
 * manifest. Requires `shouldFinalize(activeRunId, runId)` — this run
 * still holds the lease (or it's absent), mirroring persistManifest.
 *
 * SIG-156 PR3: the prior `manifestWritten` gate was removed alongside
 * the manifest-write hardening — persistManifest now throws on KV
 * failure, so callers reaching shouldCommitGraph have a written manifest
 * by construction.
 */
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
  if (args.job.shard !== undefined) {
    return handleShardJob(args.job, args.job.shard, args.env)
  }
  return handleBootstrapJob(args.job, args.env)
}

async function handleBootstrapJob(job: IndexRepoMessage, env: Env): Promise<void> {
  const { owner, repo, installationId, reason } = job
  // SIG-243 Phase 1: forward the immutable repo ID from the queue
  // message to persistManifest so the new manifest record carries
  // `githubRepoId`. Legacy in-flight messages (no field) flow through
  // as undefined; the field is omitted from the manifest in that case.
  const githubRepoId = job.githubRepoId
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
  const target = await resolveIndexTarget({
    owner,
    repo,
    defaultBranch: repoMeta.default_branch,
    ...(job.branch ? { branch: job.branch } : {}),
  })
  const namespace = target.namespace
  const stateRepo = target.stateRepo
  const branch = await client.getBranch(owner, repo, target.branch)
  if (!branch) {
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
  const { headSha, treeSha } = branch

  const runId = await computeRunId({
    owner,
    repo: stateRepo,
    headSha,
    modelId: EMBEDDING_MODEL,
    chunkerVersion: effectiveChunkerVersion(astOn),
  })

  // Freshness check — Codex v1 MAJOR. Skip when (owner, headSha,
  // modelId, chunkerVersion, embeddingDim) all match the prior run.
  const existing = await readRepoIndexManifest(env, owner, stateRepo)
  if (existing.kind === "ok") {
    const fresh = isManifestFresh({
      manifest: existing.manifest,
      currentHeadSha: headSha,
      currentOwner: owner,
      currentModelId: EMBEDDING_MODEL,
      currentEmbeddingDim: EMBEDDING_DIMENSIONS,
      currentChunkerVersion: effectiveChunkerVersion(astOn),
    })
    if (fresh) {
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
      astChunking: astOn,
      existingManifest: existing,
      chunkerVersion: effectiveChunkerVersion(astOn),
    })
  ) {
    return
  }

  // SIG-136: claim the run lease as the FIRST side-effecting write after
  // deciding to (re-)index, so claim-order reflects run START order. An
  // older run that started embedding earlier must not overwrite a newer
  // run's lease late (after its own slow processSlice) — claiming here,
  // before getTree / the empty-repo branch / processSlice, closes that
  // embedding-window clobber. Throws on KV failure → queue retries.
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

  // SIG-172: enumerate SIGILIX.md + .sigilix/rules/*.md at any depth
  // and persist the manifest separately from the vector index. Runs
  // only on the default-branch bootstrap (branch indexes share the
  // default branch's rules; the per-PR review path reads the
  // repo-level key). Best-effort — never fails the index job, because
  // vectors are the load-bearing artifact and scoped rules are
  // additive prompt context.
  //
  // SIG-172 M2 (fix-up): the rule-file walk + content fetches can take
  // seconds on a large repo. An older overlapping bootstrap that
  // started before a newer run (and thus lost the lease at writeActiveRun
  // above) could still reach the writeScopedRulesManifest call AFTER
  // the newer run had finalised its own scoped-rules manifest, and
  // clobber it with stale rules. Gate the WRITE behind the same lease
  // check that protects persistManifest / persistVectorIds. The walk +
  // fetches are still attempted (cheap to throw away), but the actual
  // KV write only happens if this run still holds the lease.
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

  const sliceHi = Math.min(totalFiles, MAX_FILES_PER_JOB)
  const sliceFiles = indexableFiles.slice(0, sliceHi)
  const { chunkCount, idsByPath } = await processSlice({
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
  })

  // ARC-238 Codex v1 B3 + code-reviewer MED-2: vectors-record write
  // is NOT best-effort, and a `stale-skip` outcome MUST stop the
  // chain. If proceed=false, the caller doesn't write the manifest
  // and doesn't enqueue the next shard — the authoritative run
  // already on disk owns those writes.
  // SIG-136: the run lease was claimed early (right after the freshness
  // gate, before processSlice) so a stale run can't clobber it late.
  const vectorsResult = await persistVectorIds({
    env,
    owner,
    repo: stateRepo,
    githubRepoId,
    runId,
    idsByPathSlice: idsByPath,
    isBootstrap: true,
  })
  if (!vectorsResult.proceed) {
    console.warn(
      JSON.stringify({
        event: "index-job-skip-stale-bootstrap",
        owner,
        repo,
        branch: target.isDefault ? null : target.branch,
        run_id: runId,
      }),
    )
    return
  }

  if (totalFiles > MAX_FILES_PER_JOB) {
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
      ...(target.isDefault ? {} : { branch: target.branch }),
      lo: MAX_FILES_PER_JOB,
      hi: Math.min(MAX_FILES_PER_JOB * 2, totalFiles),
      headSha,
      treeSha,
      defaultBranch: target.defaultBranch,
      totalFiles,
      filesDone: sliceHi,
      chunksDone: chunkCount,
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
    chunkCount,
    shardCount: 1,
    chunkerVersion: effectiveChunkerVersion(astOn),
  })
  console.log(
    JSON.stringify({
      event: "index-job-completed",
      owner,
      repo,
      branch: target.isDefault ? null : target.branch,
      run_id: runId,
      file_count: sliceHi,
      chunk_count: chunkCount,
      shard_count: 1,
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
  // ARC-236: fan out reruns for PRs that warmed up. Best-effort —
  // failure to enqueue doesn't fail the index job (the indexing
  // itself succeeded; reruns are a customer-UX upgrade).
  // M4 (CR PR #80): pass `runId` so the helper's KV breadcrumb
  // dedupes against queue-retry redelivery of this index-repo job.
  // CR phase-end catch on commit 4: wrap in try/catch — internal KV
  // calls are already best-effort, but a transport error from
  // listOpenPullRequests is caught + swallowed by the helper, yet
  // an unforeseen path could still throw. Belt-and-suspenders: any
  // throw here must NOT fail the index job (which already
  // succeeded) and trigger an indexer queue retry → full re-embed.
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
): Promise<void> {
  const { owner, repo, installationId, reason } = job
  // SIG-243 Phase 1: shard messages carry the parent run's
  // githubRepoId so the final manifest write at the end of the chain
  // stamps it correctly. Bootstrap (`handleBootstrapJob`) forwards
  // it into the first shard message via `enqueueShard` below.
  const githubRepoId = job.githubRepoId
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

  // Kimi v2 d.1: config-drift check. If `EMBEDDING_MODEL` or
  // `CHUNKER_VERSION` rotated between bootstrap and this shard, the
  // recomputed runId won't match. Abort the chain — next webhook (or
  // ARC-237 push re-index) starts fresh with the new config.
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
    // Tree composition drifted under us (the underlying tree SHA
    // hasn't changed but the filter result differs — shouldn't
    // normally happen since the tree SHA pins both). Refuse to write
    // the manifest; the next push-driven re-index will repair.
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

  // ARC-238 Codex v1 B3 + code-reviewer MED-2: vectors-record write
  // can return proceed=false on stale-skip. In that case we abort
  // the chain — neither writing the manifest (would overwrite the
  // authoritative one with stale runId + counts) nor enqueueing the
  // next shard.
  // SIG-136: a continuation shard proceeds only if it still owns the lease
  // (or it's absent); then refresh the TTL so a long chain keeps the lease.
  // Validate the lease BEFORE the slow embed/upsert work so a
  // superseded/redelivered shard doesn't write orphaned vectors to Vectorize
  // (vectors not recorded in the id-list pollute retrieval + escape the
  // GDPR uninstall delete). persistVectorIds re-checks at the end as backstop.
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
  // The check above and this refresh are NOT atomic, but that's safe: the
  // authoritative gate is persistVectorIds' own lease read + computeMerge
  // (a newer run that claims in this window stale-skips us at persist time).
  await writeActiveRun(env, owner, stateRepo, shard.runId)

  const sliceFiles = indexableFiles.slice(shard.lo, shard.hi)
  const { chunkCount: sliceChunkCount, idsByPath } = await processSlice({
    client,
    env,
    owner,
    repo,
    stateRepo,
    namespace,
    headSha: shard.headSha,
    runId: shard.runId,
    files: sliceFiles,
    astChunking: astOn,
  })

  const vectorsResult = await persistVectorIds({
    env,
    owner,
    repo: stateRepo,
    githubRepoId,
    runId: shard.runId,
    idsByPathSlice: idsByPath,
    isBootstrap: false,
  })
  if (!vectorsResult.proceed) {
    console.warn(
      JSON.stringify({
        event: "index-job-skip-stale-shard",
        owner,
        repo,
        run_id: shard.runId,
        lo: shard.lo,
        hi: shard.hi,
      }),
    )
    return
  }

  const cumulativeFiles = shard.filesDone + sliceFiles.length
  const cumulativeChunks = shard.chunksDone + sliceChunkCount

  if (shard.hi >= shard.totalFiles) {
    // Final shard — derive shardCount from the chain length.
    const shardCount = Math.ceil(shard.totalFiles / MAX_FILES_PER_JOB)
    // SIG-138: read activeRunId explicitly so we can reuse it for the graph
    // commit check below without a second KV read (don't re-read KV).
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
      chunkCount: cumulativeChunks,
      shardCount,
      chunkerVersion: effectiveChunkerVersion(astOn),
    })
    console.log(
      JSON.stringify({
        event: "index-job-completed",
        owner,
        repo,
        run_id: shard.runId,
        file_count: cumulativeFiles,
        chunk_count: cumulativeChunks,
        shard_count: shardCount,
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
    // ARC-236: fan out reruns on the final-shard path too. Multi-
    // shard repos benefit from the same warmup-rerun UX.
    // M4 (CR PR #80): same runId-keyed dedupe as the single-shard
    // path — guards against final-shard queue redelivery.
    // CR phase-end catch on commit 4: same belt-and-suspenders
    // try/catch as the bootstrap path. Best-effort applies here
    // too — multi-shard repos already paid the indexing cost.
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
    ...(target.isDefault ? {} : { branch: target.branch }),
    lo: shard.hi,
    hi: Math.min(shard.hi + MAX_FILES_PER_JOB, shard.totalFiles),
    headSha: shard.headSha,
    treeSha: shard.treeSha,
    defaultBranch: target.defaultBranch,
    totalFiles: shard.totalFiles,
    filesDone: cumulativeFiles,
    chunksDone: cumulativeChunks,
    runId: shard.runId,
  })
}

// ---------------------------------------------------------------------
// Auth helper (mirrors the pattern used elsewhere in src/lib/)
// ---------------------------------------------------------------------

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
