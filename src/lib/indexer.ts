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

import type { Env } from "../shared/types/env"
import type { JobMessage } from "../shared/types/job"
import { GitHubClient, GitHubHttpError } from "../shared/adapters/github"
import { getInstallationToken } from "../shared/adapters/github/github-app"
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedTexts,
} from "./embeddings"
import {
  isManifestFresh,
  readRepoIndexManifest,
  writeRepoIndexManifest,
  type RepoIndexManifestV1,
} from "./repo-index-manifest"
import { isRepoSensitive } from "./repo-policy"
import {
  computeMerge,
  readRepoIndexVectors,
  writeRepoIndexVectors,
  appendVectorCoverage,
} from "./repo-index-vectors"
import { writeActiveRun, readActiveRunId, shouldFinalize } from "./repo-index-active-run"
import { upsertLexicalChunks, type LexicalChunk } from "./lexical-index"
import { enqueueWarmupRerunsForIndex } from "./warmup"
import { extractFileGraph } from "./graph-extract"
import { writeFileGraph, commitGraph, debugActiveGraphVersion } from "./repo-graph-client"
import { graphIndexEnabled } from "./graph-flags"
import {
  type Chunk,
  CHUNK_LINES,
  CHUNK_OVERLAP,
  chunkFile,
} from "./chunk-core"
import { chunkFileAst, jsTsExtOf } from "./ast-chunker"
import { resolveIndexTarget, isBranchStateRepo } from "./index-branch"
import { walkScopedRuleFiles } from "./scoped-rules"
import { writeScopedRulesManifest } from "./scoped-rules-kv"

// SIG-131: re-export the chunking primitives so existing consumers that
// import them from "./indexer" (branch-retrieval.ts, tests/indexer-pure)
// keep working unchanged after the move to chunk-core.ts.
export { chunkFile, splitOversizedWindow } from "./chunk-core"
export type { Chunk } from "./chunk-core"

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

/**
 * Chunker config version. Bump when CHUNK_LINES / CHUNK_OVERLAP /
 * MAX_CHUNK_CHARS / chunk algorithm changes. The manifest's
 * chunkerVersion field invalidates a stale index when this rotates.
 *
 * v2 (SIG-133): split-not-drop. Over-cap windows are now split into
 * consecutive sub-chunks instead of being silently dropped, and the
 * cap was lowered to a token-safe 1400 chars. The bump forces a
 * re-index so previously-dropped dense regions get indexed.
 */
export const CHUNKER_VERSION = 2

/** SIG-131: chunker config version folded with the AST-chunking flag.
 *  off → 2 (line-window), on → 3 (AST). Flipping the flag changes the
 *  effective version → runId/manifest/freshness shift → repos re-index. */
export function effectiveChunkerVersion(astChunkingOn: boolean): number {
  return astChunkingOn ? 3 : CHUNKER_VERSION
}

/** Read the AST-chunking flag from env (case-insensitive "on"). */
export function astChunkingEnabled(env: Env): boolean {
  return (env.OPENCLAW_AST_CHUNKING ?? "").trim().toLowerCase() === "on"
}

export const MAX_FILES_PER_JOB = 1000

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "dist",
  "build",
  "coverage",
  "target",
  ".openclaw",
  ".claude",
  ".turbo",
  ".cache",
  "out",
])

const INDEXED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".jsx",
  ".rs",
  ".sql",
  ".md",
  ".py",
  ".go",
  ".toml",
])

const MAX_FILE_BYTES = 200 * 1024
const EMBED_BATCH = 16
const UPSERT_BATCH = 100

// ---------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------

export interface TreeEntry {
  path?: string | undefined
  type?: string | undefined
  size?: number | undefined
}

export interface IndexableFile {
  path: string
  size: number
}

/**
 * Filter raw GitHub tree entries down to indexable blob files.
 * Applies the Worker indexer's SKIP_DIRS / INDEXED_EXTENSIONS /
 * MAX_FILE_BYTES policy to the already-flattened recursive tree
 * response.
 */
export function walkIndexableFiles(entries: ReadonlyArray<TreeEntry>): IndexableFile[] {
  const out: IndexableFile[] = []
  for (const entry of entries) {
    if (entry.type !== "blob") continue
    if (typeof entry.path !== "string") continue
    const path = entry.path
    if (path.length === 0) continue
    if (pathHitsSkipDir(path)) continue
    const dot = path.lastIndexOf(".")
    if (dot < 0) continue
    const lastSlash = path.lastIndexOf("/")
    if (dot < lastSlash) continue
    const ext = path.slice(dot)
    if (!INDEXED_EXTENSIONS.has(ext)) continue
    const size = typeof entry.size === "number" ? entry.size : 0
    if (size > MAX_FILE_BYTES) continue
    out.push({ path, size })
  }
  return out
}

/**
 * True if any segment of `path` matches a SKIP_DIRS entry. Mirrors
 * the CLI's directory-walk skip but operates on the flattened path.
 * Also excludes paths whose first segment is a dotfile dir other than
 * `.github` — same as the CLI's `entry.name.startsWith(".") && entry.name !== ".github"`.
 */
function pathHitsSkipDir(path: string): boolean {
  const segments = path.split("/")
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (!seg) continue
    if (SKIP_DIRS.has(seg)) return true
    if (seg.startsWith(".") && seg !== ".github") return true
  }
  return false
}

/**
 * Content-addressed chunk id. SHA-256 over namespace + path + line
 * range + content, then hex-truncated to 48 chars (Vectorize id limit
 * is 64). Stable across re-runs at the same content → upsert
 * idempotency.
 */
export async function chunkId(namespace: string, chunk: Chunk): Promise<string> {
  // SIG-133: fold the hard-split fragment index into the identity when set,
  // so byte-identical slices of one repeating over-cap line get distinct ids.
  // Normal chunks (fragmentIndex undefined) stay purely content-addressed.
  const frag = chunk.fragmentIndex === undefined ? "" : `\0frag${chunk.fragmentIndex}`
  const raw = `${namespace}\0${chunk.path}\0${chunk.lineStart}\0${chunk.lineEnd}\0${chunk.content}${frag}`
  return sha256HexPrefix(raw, 48)
}

async function sha256HexPrefix(input: string, length: number): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return hex.slice(0, length)
}

/**
 * Stable per-run id. Deterministic from (owner, repo, headSha,
 * modelId, chunkerVersion). Used for shard chain tagging + telemetry
 * correlation; mismatch between the shard's incoming runId and the
 * current-config recomputation signals a config drift (Kimi v2 d.1)
 * and the consumer refuses to continue the chain.
 */
export async function computeRunId(args: {
  owner: string
  repo: string
  headSha: string
  modelId: string
  chunkerVersion: number
}): Promise<string> {
  return sha256HexPrefix(
    `${args.owner}\0${args.repo}\0${args.headSha}\0${args.modelId}\0${args.chunkerVersion}`,
    16,
  )
}

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
export function shouldCommitGraph(args: {
  activeRunId: string | null
  runId: string
}): boolean {
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

/** SIG-136: true iff this run still owns the lease (or it's absent) and may
 *  proceed to persist a manifest / enqueue the next shard. */
async function leaseAllows(env: Env, owner: string, repo: string, runId: string): Promise<boolean> {
  return shouldFinalize(await readActiveRunId(env, owner, repo), runId)
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
    console.log(JSON.stringify({
      event: "index-job-skip-sensitive-consumer",
      owner, repo, installation_id: installationId, reason,
    }))
    return
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("indexer: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }

  const client = await buildClient(env, installationId)

  const repoMeta = await client.getRepository(owner, repo)
  if (!repoMeta) {
    console.log(JSON.stringify({
      event: "index-job-skip-repo-not-found",
      owner, repo, installation_id: installationId, reason,
    }))
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
    console.log(JSON.stringify({
      event: "index-job-skip-branch-not-found",
      owner, repo, installation_id: installationId,
      branch: target.branch,
      default_branch: repoMeta.default_branch,
    }))
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
      if (!target.isDefault || await freshManifestHasActiveGraph({ env, owner, repo, runId })) {
        console.log(JSON.stringify({
          event: "index-job-skip-fresh",
          owner, repo, branch: target.isDefault ? null : target.branch,
          head_sha: headSha, run_id: runId,
        }))
        return
      }
    }
  } else if (existing.kind === "invalid") {
    console.warn(JSON.stringify({
      event: "repo-index-manifest-invalid",
      owner, repo, branch: target.isDefault ? null : target.branch,
      state_repo: stateRepo, reason: existing.reason,
    }))
    // Fall through to re-index.
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
    console.log(JSON.stringify({
      event: "index-job-skip-tree-not-found",
      owner, repo, tree_sha: treeSha,
    }))
    return
  }
  if (tree.truncated) {
    console.warn(JSON.stringify({
      event: "index-tree-truncated",
      owner, repo, head_sha: headSha, total_entries: tree.tree.length,
    }))
    // Codex v2 BLOCKING: do NOT write a manifest. Customer retrieval
    // stays empty until a partial-indexing fallback ships.
    return
  }

  const indexableFiles = walkIndexableFiles(tree.tree)
  console.log(JSON.stringify({
    event: "index-tree-walked",
    owner, repo, branch: target.isDefault ? null : target.branch,
    run_id: runId,
    total_entries: tree.tree.length,
    indexable_files: indexableFiles.length,
  }))

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
        env, client, owner, repo, headSha, runId, stateRepo,
        treeEntries: tree.tree,
      })
    } catch (err) {
      console.warn(JSON.stringify({
        event: "scoped-rules-manifest-write-failed",
        owner, repo, run_id: runId,
        err: err instanceof Error ? err.message : String(err),
      }))
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
      console.warn(JSON.stringify({
        event: "index-job-skip-superseded-finalize",
        owner, repo, branch: target.isDefault ? null : target.branch,
        run_id: runId, site: "bootstrap-empty-manifest",
      }))
      return
    }
    await persistManifest({
      env, owner, repo, githubRepoId, stateRepo, namespace, headSha, runId,
      branch: target.isDefault ? null : target.branch,
      defaultBranch: target.defaultBranch,
      fileCount: 0, chunkCount: 0, shardCount: 1,
      chunkerVersion: effectiveChunkerVersion(astOn),
    })
    console.log(JSON.stringify({
      event: "index-job-completed",
      owner, repo, branch: target.isDefault ? null : target.branch,
      run_id: runId,
      file_count: 0, chunk_count: 0, shard_count: 1,
    }))
    // SIG-138: commit an empty graph version to GC any stale graph left
    // from a previously-indexed repo that is now empty. Best-effort —
    // never fails the index job.
    if (target.isDefault && graphIndexEnabled(env) && shouldCommitGraph({ activeRunId, runId })) {
      try {
        await commitGraph(env, owner, repo, runId)
      } catch (err) {
        console.warn(JSON.stringify({
          event: "graph-commit-failed",
          owner, repo, run_id: runId,
          err: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    return
  }

  const sliceHi = Math.min(totalFiles, MAX_FILES_PER_JOB)
  const sliceFiles = indexableFiles.slice(0, sliceHi)
  const { chunkCount, idsByPath } = await processSlice({
    client, env, owner, repo, stateRepo, namespace,
    headSha, runId, files: sliceFiles, astChunking: astOn,
  })

  // ARC-238 Codex v1 B3 + code-reviewer MED-2: vectors-record write
  // is NOT best-effort, and a `stale-skip` outcome MUST stop the
  // chain. If proceed=false, the caller doesn't write the manifest
  // and doesn't enqueue the next shard — the authoritative run
  // already on disk owns those writes.
  // SIG-136: the run lease was claimed early (right after the freshness
  // gate, before processSlice) so a stale run can't clobber it late.
  const vectorsResult = await persistVectorIds({
    env, owner, repo: stateRepo, githubRepoId, runId, idsByPathSlice: idsByPath,
    isBootstrap: true,
  })
  if (!vectorsResult.proceed) {
    console.warn(JSON.stringify({
      event: "index-job-skip-stale-bootstrap",
      owner, repo, branch: target.isDefault ? null : target.branch,
      run_id: runId,
    }))
    return
  }

  if (totalFiles > MAX_FILES_PER_JOB) {
    // Hand off to the next continuation shard. Final shard will write
    // the manifest with cumulative totals; this bootstrap doesn't.
    if (!(await leaseAllows(env, owner, stateRepo, runId))) {
      console.warn(JSON.stringify({
        event: "index-job-skip-superseded-finalize",
        site: "bootstrap-enqueue",
        owner, repo, branch: target.isDefault ? null : target.branch,
        run_id: runId,
      }))
      return
    }
    await enqueueNextShard(env, {
      owner, repo, githubRepoId, installationId, reason,
      ...(target.isDefault ? {} : { branch: target.branch }),
      lo: MAX_FILES_PER_JOB,
      hi: Math.min(MAX_FILES_PER_JOB * 2, totalFiles),
      headSha, treeSha,
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
    console.warn(JSON.stringify({
      event: "index-job-skip-superseded-finalize",
      site: "bootstrap-manifest",
      owner, repo, branch: target.isDefault ? null : target.branch,
      run_id: runId,
    }))
    return
  }
  await persistManifest({
    env, owner, repo, githubRepoId, stateRepo, namespace, headSha, runId,
    branch: target.isDefault ? null : target.branch,
    defaultBranch: target.defaultBranch,
    fileCount: sliceHi, chunkCount, shardCount: 1,
    chunkerVersion: effectiveChunkerVersion(astOn),
  })
  console.log(JSON.stringify({
    event: "index-job-completed",
    owner, repo, branch: target.isDefault ? null : target.branch,
    run_id: runId,
    file_count: sliceHi, chunk_count: chunkCount, shard_count: 1,
  }))
  // SIG-138: commit the graph version after a successful manifest write,
  // lease-gated. Best-effort — never fails the index job.
  if (target.isDefault && graphIndexEnabled(env) && shouldCommitGraph({ activeRunId, runId })) {
    try {
      await commitGraph(env, owner, repo, runId)
    } catch (err) {
      console.warn(JSON.stringify({
        event: "graph-commit-failed",
        owner, repo, run_id: runId,
        err: err instanceof Error ? err.message : String(err),
      }))
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
    if (target.isDefault) await enqueueWarmupRerunsForIndex({
      env, client, owner, repo, installationId, runId,
    })
  } catch (err) {
    console.warn(JSON.stringify({
      event: "warmup-rerun-fanout-failed",
      owner, repo, run_id: runId,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

async function freshManifestHasActiveGraph(args: {
  env: Env
  owner: string
  repo: string
  runId: string
}): Promise<boolean> {
  const { env, owner, repo, runId } = args
  if (!graphIndexEnabled(env)) return true

  let activeGraphVersion: string | null = null
  try {
    activeGraphVersion = await debugActiveGraphVersion(env, owner, repo)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "graph-active-version-read-failed",
      owner, repo, run_id: runId,
      err: err instanceof Error ? err.message : String(err),
    }))
    return true
  }

  if (activeGraphVersion === runId) return true

  console.warn(JSON.stringify({
    event: "index-job-fresh-manifest-graph-missing",
    owner, repo, run_id: runId,
    active_graph_version: activeGraphVersion,
  }))
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
    console.warn(JSON.stringify({
      event: "index-shard-default-branch-missing",
      owner, repo, run_id: shard.runId,
      shard_lo: shard.lo,
      shard_hi: shard.hi,
      note: "legacy shard missing defaultBranch; using sentinel",
    }))
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
    console.log(JSON.stringify({
      event: "index-job-skip-sensitive-consumer",
      owner, repo, installation_id: installationId, reason,
      run_id: shard.runId,
    }))
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
    console.warn(JSON.stringify({
      event: "index-shard-config-drift",
      owner, repo, expected_run_id: shard.runId, current_run_id: currentRunId,
    }))
    return
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("indexer: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const client = await buildClient(env, installationId)

  const tree = await client.getRepoTree(owner, repo, shard.treeSha)
  if (!tree) {
    console.warn(JSON.stringify({
      event: "index-shard-tree-not-found",
      owner, repo, tree_sha: shard.treeSha, run_id: shard.runId,
    }))
    return
  }
  if (tree.truncated) {
    console.warn(JSON.stringify({
      event: "index-tree-truncated",
      owner, repo, head_sha: shard.headSha, total_entries: tree.tree.length,
      run_id: shard.runId,
    }))
    return
  }
  const indexableFiles = walkIndexableFiles(tree.tree)
  if (indexableFiles.length !== shard.totalFiles) {
    // Tree composition drifted under us (the underlying tree SHA
    // hasn't changed but the filter result differs — shouldn't
    // normally happen since the tree SHA pins both). Refuse to write
    // the manifest; the next push-driven re-index will repair.
    console.warn(JSON.stringify({
      event: "index-shard-tree-drift",
      owner, repo, run_id: shard.runId,
      expected: shard.totalFiles, current: indexableFiles.length,
    }))
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
    console.warn(JSON.stringify({
      event: "index-job-skip-superseded-shard",
      owner, repo, run_id: shard.runId, lo: shard.lo, hi: shard.hi,
    }))
    return
  }
  // The check above and this refresh are NOT atomic, but that's safe: the
  // authoritative gate is persistVectorIds' own lease read + computeMerge
  // (a newer run that claims in this window stale-skips us at persist time).
  await writeActiveRun(env, owner, stateRepo, shard.runId)

  const sliceFiles = indexableFiles.slice(shard.lo, shard.hi)
  const { chunkCount: sliceChunkCount, idsByPath } = await processSlice({
    client, env, owner, repo, stateRepo, namespace,
    headSha: shard.headSha, runId: shard.runId, files: sliceFiles, astChunking: astOn,
  })

  const vectorsResult = await persistVectorIds({
    env, owner, repo: stateRepo, githubRepoId,
    runId: shard.runId,
    idsByPathSlice: idsByPath,
    isBootstrap: false,
  })
  if (!vectorsResult.proceed) {
    console.warn(JSON.stringify({
      event: "index-job-skip-stale-shard",
      owner, repo, run_id: shard.runId, lo: shard.lo, hi: shard.hi,
    }))
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
      console.warn(JSON.stringify({
        event: "index-job-skip-superseded-finalize",
        site: "shard-manifest",
        owner, repo, run_id: shard.runId,
      }))
      return
    }
    await persistManifest({
      env, owner, repo, githubRepoId, stateRepo, namespace,
      branch: target.isDefault ? null : target.branch,
      defaultBranch: target.defaultBranch,
      headSha: shard.headSha, runId: shard.runId,
      fileCount: cumulativeFiles,
      chunkCount: cumulativeChunks,
      shardCount,
      chunkerVersion: effectiveChunkerVersion(astOn),
    })
    console.log(JSON.stringify({
      event: "index-job-completed",
      owner, repo, run_id: shard.runId,
      file_count: cumulativeFiles,
      chunk_count: cumulativeChunks,
      shard_count: shardCount,
    }))
    // SIG-138: commit the graph version after a successful manifest write,
    // lease-gated. Best-effort — never fails the index job.
    if (target.isDefault && graphIndexEnabled(env) && shouldCommitGraph({ activeRunId, runId: shard.runId })) {
      try {
        await commitGraph(env, owner, repo, shard.runId)
      } catch (err) {
        console.warn(JSON.stringify({
          event: "graph-commit-failed",
          owner, repo, run_id: shard.runId,
          err: err instanceof Error ? err.message : String(err),
        }))
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
      if (target.isDefault) await enqueueWarmupRerunsForIndex({
        env, client, owner, repo, installationId, runId: shard.runId,
      })
    } catch (err) {
      console.warn(JSON.stringify({
        event: "warmup-rerun-fanout-failed",
        owner, repo, run_id: shard.runId,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
    return
  }

  if (!(await leaseAllows(env, owner, stateRepo, shard.runId))) {
    console.warn(JSON.stringify({
      event: "index-job-skip-superseded-finalize",
      site: "shard-enqueue",
      owner, repo, run_id: shard.runId,
    }))
    return
  }
  await enqueueNextShard(env, {
    owner, repo, githubRepoId, installationId, reason,
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
// Streaming pipeline
// ---------------------------------------------------------------------

interface ProcessSliceArgs {
  client: GitHubClient
  env: Env
  owner: string
  /** Actual GitHub repo name for file fetches. */
  repo: string
  /** KV/vector/lease identity; branch indexes differ from repo. */
  stateRepo: string
  namespace: string
  headSha: string
  runId: string
  files: ReadonlyArray<IndexableFile>
  astChunking: boolean
}

export interface ProcessSliceResult {
  /** Total chunks upserted across the slice. */
  chunkCount: number
  /** Path → ordered chunk ids accumulated for this slice. Used by
   *  ARC-238's uninstall delete to call `deleteByIds` later. */
  idsByPath: Record<string, string[]>
}

/** SIG-137: group an upsert batch's chunk ids by source path for the
 *  delete-coverage ledger write that precedes each Vectorize upsert. */
function coverageByPath(records: VectorizeRecord[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of records) {
    const path = typeof r.metadata.path === "string" ? r.metadata.path : ""
    if (path.length === 0) continue
    ;(out[path] ??= []).push(r.id)
  }
  return out
}

async function processSlice(args: ProcessSliceArgs): Promise<ProcessSliceResult> {
  const { client, env, owner, repo, stateRepo, namespace, headSha, runId, files } = args
  let chunkBuffer: Chunk[] = []
  const vectorBuffer: VectorizeRecord[] = []
  let totalChunks = 0
  const idsByPath: Record<string, string[]> = {}
  let astChunkFiles = 0
  let lineChunkFiles = 0
  let parseFallbackFiles = 0

  for (const file of files) {
    let content: string | null = null
    try {
      content = await client.getFileContent(owner, repo, file.path, headSha)
    } catch (err) {
      // Non-404 errors (rate limits, transient) re-throw so the queue
      // retries the slice. 404 returns null below.
      if (err instanceof GitHubHttpError && err.status !== 404 && err.status !== 403) {
        throw err
      }
      console.warn(JSON.stringify({
        event: "index-file-fetch-failed",
        owner, repo, path: file.path,
        err: err instanceof Error ? err.message : String(err),
      }))
      continue
    }
    if (content === null) continue

    // SIG-138: graph write is best-effort and additive — any error here
    // logs + continues; the embedding/upsert pipeline is unaffected.
    if (!isBranchStateRepo(stateRepo) && graphIndexEnabled(env)) {
      try {
        const fg = extractFileGraph(file.path, content)
        await writeFileGraph(env, owner, repo, {
          runId, headSha, path: file.path,
          symbols: fg.symbols,
          fileEdgesRaw: fg.fileEdgesRaw,
          callEdges: fg.callEdges.map((c) => ({
            sourcePath: c.sourcePath,
            calleeName: c.calleeName,
            callKind: c.callKind,
            startLine: c.startLine,
            startCol: c.startCol,
          })),
        })
      } catch (err) {
        console.warn(JSON.stringify({
          event: "graph-write-failed",
          owner, repo, path: file.path, run_id: runId,
          err: err instanceof Error ? err.message : String(err),
        }))
      }
    }

    // SIG-131: AST-aware chunking with line-window fallback.
    const ext = args.astChunking ? jsTsExtOf(file.path) : null
    let fileChunks: Chunk[]
    if (ext !== null) {
      const astChunks = chunkFileAst(file.path, content, ext)
      if (astChunks !== null) {
        fileChunks = astChunks
        astChunkFiles += 1
      } else {
        fileChunks = chunkFile(file.path, content) // parse failed → line-window
        parseFallbackFiles += 1
      }
    } else {
      fileChunks = chunkFile(file.path, content) // AST off or non-JS/TS
      lineChunkFiles += 1
    }
    chunkBuffer.push(...fileChunks)

    while (chunkBuffer.length >= EMBED_BATCH) {
      const batch = chunkBuffer.splice(0, EMBED_BATCH)
      const upserts = await embedBatch(env, batch, namespace)
      for (const record of upserts) {
        const path = typeof record.metadata.path === "string" ? record.metadata.path : ""
        if (path.length === 0) continue
        ;(idsByPath[path] ??= []).push(record.id)
      }
      vectorBuffer.push(...upserts)
      totalChunks += batch.length
      // Flush upsert batches as they fill.
      while (vectorBuffer.length >= UPSERT_BATCH) {
        const upBatch = vectorBuffer.splice(0, UPSERT_BATCH)
        // SIG-137: record ids in the delete-coverage ledger BEFORE upserting,
        // so a crash or mid-slice supersede can't leave a Vectorize entry that
        // isn't in the id-list (which would escape the GDPR uninstall delete).
        await appendVectorCoverage(env, owner, stateRepo, runId, coverageByPath(upBatch))
        await env.OPENCLAW_CODE_INDEX.upsert(upBatch)
        await dualWriteLexical(env, upBatch) // SIG-45 — soft lexical mirror
      }
    }
  }

  // Drain remaining chunks.
  if (chunkBuffer.length > 0) {
    const upserts = await embedBatch(env, chunkBuffer, namespace)
    for (const record of upserts) {
      const path = typeof record.metadata.path === "string" ? record.metadata.path : ""
      if (path.length === 0) continue
      ;(idsByPath[path] ??= []).push(record.id)
    }
    vectorBuffer.push(...upserts)
    totalChunks += chunkBuffer.length
    chunkBuffer = []
  }
  // Drain remaining vectors.
  while (vectorBuffer.length > 0) {
    const upBatch = vectorBuffer.splice(0, UPSERT_BATCH)
    // SIG-137: coverage-before-upsert (see flush loop above).
    await appendVectorCoverage(env, owner, stateRepo, runId, coverageByPath(upBatch))
    await env.OPENCLAW_CODE_INDEX.upsert(upBatch)
    await dualWriteLexical(env, upBatch) // SIG-45 — soft lexical mirror
  }

  console.log(JSON.stringify({
    event: "index-chunking",
    owner: args.owner, repo: args.repo,
    ast_on: args.astChunking,
    ast_chunk_files: astChunkFiles,
    line_chunk_files: lineChunkFiles,
    parse_fallback_files: parseFallbackFiles,
  }))

  return { chunkCount: totalChunks, idsByPath }
}

interface VectorizeRecord {
  id: string
  values: number[]
  namespace: string
  metadata: Record<string, string | number>
}

/**
 * SIG-45: dual-write the just-upserted batch to the D1 FTS5 lexical mirror.
 * Gated only on the binding being present (NOT the read flag) so the lexical
 * index can be populated ahead of flipping OPENCLAW_RETRIEVAL_HYBRID on for
 * the A/B — you can't measure hybrid retrieval on an empty lexical corpus.
 *
 * Soft by design: `upsertLexicalChunks` swallows + logs its own failures and
 * we don't await-throw here. The Vectorize upsert and its delete-coverage
 * ledger (written BEFORE the upsert) remain the load-bearing GDPR path; a
 * lexical-mirror hiccup must never abort indexing or strand a vector that
 * escapes the uninstall delete.
 */
async function dualWriteLexical(
  env: Env,
  records: ReadonlyArray<VectorizeRecord>,
): Promise<void> {
  const db = env.OPENCLAW_LEXICAL_INDEX
  if (db == null || records.length === 0) return
  const chunks: LexicalChunk[] = []
  for (const r of records) {
    const path = typeof r.metadata.path === "string" ? r.metadata.path : ""
    const content = typeof r.metadata.content === "string" ? r.metadata.content : ""
    if (path.length === 0 || content.length === 0) continue
    chunks.push({
      id: r.id,
      namespace: r.namespace,
      path,
      lineStart: typeof r.metadata.lineStart === "number" ? r.metadata.lineStart : 0,
      lineEnd: typeof r.metadata.lineEnd === "number" ? r.metadata.lineEnd : 0,
      content,
    })
  }
  await upsertLexicalChunks(db, chunks)
}

/**
 * SIG-218 defense: Vectorize hard-caps namespace + id at 64 bytes; the
 * bounded-length encodeBranchName fix keeps `namespace` well under that
 * for every legitimate path, but log + skip if anything constructs a
 * long namespace via another code path. 60 leaves a safety margin.
 */
export function shouldSkipForLength(id: string, namespace: string): boolean {
  return namespace.length > 60 || id.length > 60
}

async function embedBatch(
  env: Env,
  chunks: ReadonlyArray<Chunk>,
  namespace: string,
): Promise<VectorizeRecord[]> {
  const vectors = await embedTexts(env.AI, chunks.map((c) => c.content))
  const out: VectorizeRecord[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const vec = vectors[i]!
    const id = await chunkId(namespace, chunk)
    if (shouldSkipForLength(id, namespace)) {
      console.error(JSON.stringify({
        event: "vector-upsert-length-exceeded",
        namespaceLength: namespace.length,
        idLength: id.length,
        namespaceSample: namespace.slice(0, 32),
        idSample: id.slice(0, 16),
        path: chunk.path,
      }))
      continue
    }
    out.push({
      id,
      values: vec,
      namespace,
      metadata: {
        repo: namespace,
        path: chunk.path,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        content: chunk.content,
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------
// Continuation enqueue + manifest write
// ---------------------------------------------------------------------

interface EnqueueNextShardArgs {
  owner: string
  repo: string
  /**
   * SIG-243 Phase 1: parent run's immutable GitHub repo ID. Forwarded
   * onto every shard continuation so the manifest write at the end of
   * the chain stamps the field correctly. Optional during the
   * transition — undefined for legacy bootstrap runs that predate
   * Phase 1.
   */
  githubRepoId: number | undefined
  installationId: number
  reason: IndexRepoMessage["reason"]
  branch?: string
  lo: number
  hi: number
  headSha: string
  treeSha: string
  defaultBranch: string
  totalFiles: number
  filesDone: number
  chunksDone: number
  runId: string
}

async function enqueueNextShard(env: Env, args: EnqueueNextShardArgs): Promise<void> {
  await env.OPENCLAW_JOBS.send({
    type: "index-repo",
    owner: args.owner,
    repo: args.repo,
    // SIG-243 Phase 1: forward the parent run's GitHub repo ID onto
    // every shard. Conditional spread keeps the queue message tight
    // under exactOptionalPropertyTypes. Positive-integer guard matches
    // every other producer site.
    ...(typeof args.githubRepoId === "number" && Number.isInteger(args.githubRepoId) && args.githubRepoId > 0
      ? { githubRepoId: args.githubRepoId }
      : {}),
    installationId: args.installationId,
    reason: args.reason,
    ...(args.branch ? { branch: args.branch } : {}),
    shard: {
      lo: args.lo,
      hi: args.hi,
      headSha: args.headSha,
      treeSha: args.treeSha,
      defaultBranch: args.defaultBranch,
      totalFiles: args.totalFiles,
      filesDone: args.filesDone,
      chunksDone: args.chunksDone,
      runId: args.runId,
    },
  })
  console.log(JSON.stringify({
    event: "index-shard-enqueued",
    owner: args.owner, repo: args.repo,
    installation_id: args.installationId,
    run_id: args.runId,
    lo: args.lo, hi: args.hi, total_files: args.totalFiles,
  }))
}

interface PersistManifestArgs {
  env: Env
  owner: string
  /** Actual GitHub repo name. */
  repo: string
  /**
   * SIG-243 Phase 1: immutable GitHub repository ID, captured at the
   * webhook entry point and threaded through the queue message + the
   * indexer pipeline. Optional during Phases 1 and 2 — legacy queue
   * messages predating Phase 1 omit the field, and bootstrap / install
   * / reconciliation paths that haven't been wired yet pass it as
   * undefined. The manifest persists it when present so Phase 3's
   * backfill knows which records still need the lookup. Phase 4
   * promotes it to the canonical KV key.
   */
  githubRepoId: number | undefined
  /** State repo used for KV manifests/vectors. Branch indexes use repo/__branch__/... */
  stateRepo: string
  namespace: string
  branch: string | null
  defaultBranch: string
  headSha: string
  runId: string
  fileCount: number
  chunkCount: number
  shardCount: number
  chunkerVersion: number
}

async function persistManifest(args: PersistManifestArgs): Promise<void> {
  const manifest: RepoIndexManifestV1 = {
    v: 1,
    // SIG-35: default-branch manifests keep the historical bare repo
    // value. Branch manifests store a branch-state repo such as
    // `sigilix/__branch__/h646576`, which keeps branch KV/vector state
    // isolated and prevents `listIndexedRepos` from advertising it as
    // another default repo.
    repo: args.stateRepo.toLowerCase(),
    owner: args.owner,
    actualRepo: args.repo.toLowerCase(),
    defaultBranch: args.defaultBranch,
    namespace: args.namespace,
    headSha: args.headSha,
    runId: args.runId,
    fileCount: args.fileCount,
    chunkCount: args.chunkCount,
    shardCount: args.shardCount,
    indexedAt: new Date().toISOString(),
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: args.chunkerVersion,
    windowLines: CHUNK_LINES,
    overlapLines: CHUNK_OVERLAP,
  }
  if (args.branch !== null) {
    manifest.branch = args.branch
  }
  // SIG-243 Phase 1: persist the immutable repo ID when the queue
  // message carried it. Conditional spread keeps the manifest shape
  // tight under exactOptionalPropertyTypes. Positive-integer guard
  // matches the type-guard in repo-index-manifest.ts.
  if (
    typeof args.githubRepoId === "number" &&
    Number.isInteger(args.githubRepoId) &&
    args.githubRepoId > 0
  ) {
    manifest.githubRepoId = args.githubRepoId
  }
  try {
    await writeRepoIndexManifest(args.env, manifest)
  } catch (err) {
    // SIG-156 PR3: log + propagate. The throw aborts the consumer and
    // the queue retries — bootstrap is idempotent (freshness-skips on
    // the next attempt if data already landed; otherwise re-runs the
    // slice with content-addressed vector ids).
    console.error(JSON.stringify({
      event: "repo-index-manifest-write-failed",
      owner: args.owner, repo: args.repo, run_id: args.runId,
      error: err instanceof Error ? err.message : String(err),
    }))
    throw err
  }
}

interface PersistVectorIdsArgs {
  env: Env
  owner: string
  repo: string
  /**
   * SIG-243 Phase 2b: immutable GitHub repo ID from the queue
   * message. Forwarded into the merge so the resulting vectors
   * record carries the field and `writeRepoIndexVectors` dual-writes
   * to `repo-vectors:{id}`. Optional during the Phase 1+2
   * transition — undefined on legacy in-flight shard runs.
   */
  githubRepoId: number | undefined
  runId: string
  idsByPathSlice: Record<string, string[]>
  /**
   * Continuation-shard vs. bootstrap. code-reviewer MED-1: an
   * `invalid-overwrite` outcome on a continuation shard would silently
   * lose prior shards' ids → Vectorize orphans. Throwing here makes
   * the queue retry the shard; if the corruption persists, the queue
   * drops the message after `max_retries` and the operator sees a
   * loud failure. Acceptable trade vs. silent retention.
   */
  isBootstrap: boolean
}

/**
 * ARC-238 Codex v1 B3: run-aware merge + non-best-effort write of the
 * `repo-index-vectors:<repo>` record. Called by every shard BEFORE
 * the manifest write so a write failure prevents the manifest from
 * marking the repo "indexed" while uninstall has no ids to enumerate.
 *
 * code-reviewer MED-2: return a discriminator so callers can guard
 * the manifest-write + next-shard-enqueue on a clean `proceed`. A
 * `stale-skip` result MUST NOT proceed to a manifest write that would
 * overwrite the currently-authoritative manifest with a stale runId.
 *
 * Reads the prior manifest's runId (if any) to disambiguate the
 * run-aware merge decision: a shard whose runId differs from the
 * current manifest's runId is treated as stale and refuses to write.
 *
 * Throws on KV-write failure so the queue retries the shard. Re-runs
 * are idempotent (content-addressed chunk ids).
 */
async function persistVectorIds(args: PersistVectorIdsArgs): Promise<{ proceed: boolean }> {
  const { env, owner, repo, githubRepoId, runId, idsByPathSlice, isBootstrap } = args
  const existing = await readRepoIndexVectors(env, owner, repo)
  const activeRunId = await readActiveRunId(env, owner, repo)

  const outcome = computeMerge({
    existing,
    owner,
    repo,
    githubRepoId,
    runId,
    idsByPathSlice,
    activeRunId,
  })

  if (outcome.action === "stale-skip") {
    // Different run is the current one. Refuse to write — don't
    // corrupt the live vectors record with stale slice data — and
    // signal the caller to skip the manifest/next-shard write.
    console.warn(JSON.stringify({
      event: "repo-index-vectors-stale-skip",
      owner, repo, run_id: runId, existing_run_id: outcome.existingRunId,
      active_run_id: activeRunId,
    }))
    return { proceed: false }
  }

  // code-reviewer MED-1: on a continuation shard, `invalid-overwrite`
  // means we're about to clobber a corrupt record with ONLY this
  // slice's ids — the earlier shards' ids would be lost from the
  // vectors record while their vectors persist in Vectorize. Refuse +
  // throw so the queue retries; if the corruption persists, the
  // operator sees the drop instead of silent leak.
  if (outcome.action === "invalid-overwrite" && !isBootstrap) {
    console.error(JSON.stringify({
      event: "repo-index-vectors-invalid-mid-chain",
      owner, repo, run_id: runId,
      note: "refusing to clobber corrupt record with partial slice; queue retry",
    }))
    throw new Error(`repo-index-vectors corrupt mid-chain for ${repo}`)
  }

  const ok = await writeRepoIndexVectors(env, outcome.vectors)
  if (!ok) {
    console.error(JSON.stringify({
      event: "repo-index-vectors-write-failed",
      owner, repo, run_id: runId, action: outcome.action,
    }))
    throw new Error(`repo-index-vectors write failed for ${repo}`)
  }
  console.log(JSON.stringify({
    event: "repo-index-vectors-write-ok",
    owner, repo, run_id: runId, action: outcome.action,
    path_count: Object.keys(outcome.vectors.byPath).length,
  }))
  return { proceed: true }
}

// ---------------------------------------------------------------------
// SIG-172: scoped-rules manifest discovery + persistence
// ---------------------------------------------------------------------

interface PersistScopedRulesArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  /** Run id from the bootstrap context — gated by `leaseAllows`
   *  before the KV write so an older run can't clobber a newer one. */
  runId: string
  /** Branch-scoped repo key for the lease check — matches what
   *  `writeActiveRun` keyed on (i.e. `target.stateRepo`). */
  stateRepo: string
  headSha: string
  treeEntries: ReadonlyArray<TreeEntry>
}

/**
 * Enumerate SIGILIX.md + .sigilix/rules/*.md at any depth from the
 * already-fetched repo tree, fetch their content via the same
 * installation token used for indexing, and persist the manifest to
 * KV under `repo-index-rules:<owner>/<repo>`.
 *
 * Best-effort per file fetch: a single failed file is dropped + logged
 * rather than failing the whole manifest. The KV write itself does
 * throw on failure so the caller's try/catch records it as a non-
 * fatal indexer event.
 *
 * Empty rule set still writes the manifest — gives the orchestrator a
 * clean "no rules configured" signal vs. "indexer hasn't run yet"
 * (KV-missing).
 *
 * SIG-172 M2 (fix-up): the KV write is gated by the active-run lease
 * (same `shouldFinalize(activeRunId, runId)` check the manifest +
 * vectors writes use). The fetch loop still runs — small in absolute
 * cost, and the lease may flip between fetch and write — but the
 * write itself is suppressed when this run has been superseded. An
 * older overlapping run completing its rule walk after a newer run
 * had already finalised its scoped-rules manifest would otherwise
 * overwrite the newer rules with stale content.
 */
async function persistScopedRulesManifest(args: PersistScopedRulesArgs): Promise<void> {
  const { env, client, owner, repo, runId, stateRepo, headSha, treeEntries } = args
  const ruleFiles = walkScopedRuleFiles(treeEntries)
  const entries: Array<{ path: string; content: string }> = []
  for (const file of ruleFiles) {
    let content: string | null = null
    try {
      content = await client.getFileContent(owner, repo, file.path, headSha)
    } catch (err) {
      console.warn(JSON.stringify({
        event: "scoped-rules-file-fetch-failed",
        owner, repo, path: file.path,
        err: err instanceof Error ? err.message : String(err),
      }))
      continue
    }
    if (content === null) continue
    entries.push({ path: file.path, content })
  }
  // SIG-172 M2 (fix-up): lease check immediately before the write so
  // a slow rule-file walk can't outlive its run-id ownership.
  if (!(await leaseAllows(env, owner, stateRepo, runId))) {
    console.warn(JSON.stringify({
      event: "scoped-rules-manifest-skip-superseded",
      owner, repo, run_id: runId,
      file_count: entries.length,
    }))
    return
  }
  const manifest = await writeScopedRulesManifest(env, owner, repo, entries)
  console.log(JSON.stringify({
    event: "scoped-rules-manifest-written",
    owner, repo,
    head_sha: headSha,
    file_count: entries.length,
    per_directory_rules: manifest.perDirectoryRules.length,
    glob_rules: manifest.globRules.length,
  }))
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
