// ARC-235 — async indexer Cloudflare Queue consumer.
//
// Handles `index-repo` messages enqueued by ARC-234's webhook producer
// (and, later, by ARC-237 push-driven re-index). Walks the default-
// branch tree via GitHub Trees + Contents APIs using the installation
// token, chunks files into 30-line overlapping windows (matching the
// CLI script at scripts/index-repo.mjs), embeds via the Workers AI
// binding, and upserts to OPENCLAW_CODE_INDEX under `namespace = <repo>`
// lowercased (matches the existing retrieval contract — see Codex v1
// BLOCKING note in .claude/handoff/arc-234-235-codex-verdict.md).
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

import type { Env, JobMessage } from "../index"
import { GitHubClient, GitHubHttpError } from "./github"
import { getInstallationToken } from "./github-app"
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
} from "./repo-index-vectors"
import { enqueueWarmupRerunsForIndex } from "./warmup"

// ---------------------------------------------------------------------
// Constants (ported from scripts/index-repo.mjs — keep aligned)
// ---------------------------------------------------------------------

/**
 * Chunker config version. Bump when CHUNK_LINES / CHUNK_OVERLAP /
 * MAX_CHUNK_CHARS / chunk algorithm changes. The manifest's
 * chunkerVersion field invalidates a stale index when this rotates.
 */
export const CHUNKER_VERSION = 1
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
const CHUNK_LINES = 30
const CHUNK_OVERLAP = 10
const MAX_CHUNK_CHARS = 1_800
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

export interface Chunk {
  path: string
  lineStart: number
  lineEnd: number
  content: string
}

/**
 * Filter raw GitHub tree entries down to indexable blob files.
 * Mirrors the SKIP_DIRS / INDEXED_EXTENSIONS / MAX_FILE_BYTES logic
 * in scripts/index-repo.mjs:78-114 (the local walker uses fs.stat to
 * filter dirs + extension match; the Worker version filters the
 * already-flattened recursive tree response).
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
 * Split file content into overlapping line windows. Algorithm exactly
 * matches scripts/index-repo.mjs:116-141 — 30-line windows with 10-line
 * overlap, skip empty windows and over-MAX_CHUNK_CHARS windows, stop
 * at end of file.
 */
export function chunkFile(path: string, content: string): Chunk[] {
  const lines = content.split("\n")
  if (lines.length === 0) return []
  const chunks: Chunk[] = []
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length)
    const slice = lines.slice(start, end).join("\n")
    if (slice.trim().length === 0) {
      if (end === lines.length) break
      continue
    }
    if (slice.length > MAX_CHUNK_CHARS) {
      if (end === lines.length) break
      continue
    }
    chunks.push({
      path,
      lineStart: start + 1,
      lineEnd: end,
      content: slice,
    })
    if (end === lines.length) break
  }
  return chunks
}

/**
 * Content-addressed chunk id. SHA-256 over namespace + path + line
 * range + content, then hex-truncated to 48 chars (Vectorize id limit
 * is 64). Stable across re-runs at the same content → upsert
 * idempotency.
 */
export async function chunkId(namespace: string, chunk: Chunk): Promise<string> {
  const raw = `${namespace}\0${chunk.path}\0${chunk.lineStart}\0${chunk.lineEnd}\0${chunk.content}`
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
  const namespace = repo.toLowerCase()

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
  const branch = await client.getBranch(owner, repo, repoMeta.default_branch)
  if (!branch) {
    console.log(JSON.stringify({
      event: "index-job-skip-branch-not-found",
      owner, repo, installation_id: installationId, default_branch: repoMeta.default_branch,
    }))
    return
  }
  const { headSha, treeSha } = branch

  const runId = await computeRunId({
    owner,
    repo,
    headSha,
    modelId: EMBEDDING_MODEL,
    chunkerVersion: CHUNKER_VERSION,
  })

  // Freshness check — Codex v1 MAJOR. Skip when (owner, headSha,
  // modelId, chunkerVersion, embeddingDim) all match the prior run.
  const existing = await readRepoIndexManifest(env, repo)
  if (existing.kind === "ok") {
    const fresh = isManifestFresh({
      manifest: existing.manifest,
      currentHeadSha: headSha,
      currentOwner: owner,
      currentModelId: EMBEDDING_MODEL,
      currentEmbeddingDim: EMBEDDING_DIMENSIONS,
      currentChunkerVersion: CHUNKER_VERSION,
    })
    if (fresh) {
      console.log(JSON.stringify({
        event: "index-job-skip-fresh",
        owner, repo, head_sha: headSha, run_id: runId,
      }))
      return
    }
  } else if (existing.kind === "invalid") {
    console.warn(JSON.stringify({
      event: "repo-index-manifest-invalid",
      owner, repo, reason: existing.reason,
    }))
    // Fall through to re-index.
  }

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
    owner, repo, run_id: runId,
    total_entries: tree.tree.length,
    indexable_files: indexableFiles.length,
  }))

  const totalFiles = indexableFiles.length
  if (totalFiles === 0) {
    // Empty repo (or all-filtered). Write a manifest so we don't
    // re-walk on every webhook for this SHA.
    await persistManifest({
      env, owner, repo, namespace, headSha, runId,
      fileCount: 0, chunkCount: 0, shardCount: 1,
    })
    console.log(JSON.stringify({
      event: "index-job-completed",
      owner, repo, run_id: runId,
      file_count: 0, chunk_count: 0, shard_count: 1,
    }))
    return
  }

  const sliceHi = Math.min(totalFiles, MAX_FILES_PER_JOB)
  const sliceFiles = indexableFiles.slice(0, sliceHi)
  const { chunkCount, idsByPath } = await processSlice({
    client, env, owner, repo, namespace,
    headSha, files: sliceFiles,
  })

  // ARC-238 Codex v1 B3 + code-reviewer MED-2: vectors-record write
  // is NOT best-effort, and a `stale-skip` outcome MUST stop the
  // chain. If proceed=false, the caller doesn't write the manifest
  // and doesn't enqueue the next shard — the authoritative run
  // already on disk owns those writes.
  const vectorsResult = await persistVectorIds({
    env, owner, repo, runId, idsByPathSlice: idsByPath,
    isBootstrap: true,
  })
  if (!vectorsResult.proceed) {
    console.warn(JSON.stringify({
      event: "index-job-skip-stale-bootstrap",
      owner, repo, run_id: runId,
    }))
    return
  }

  if (totalFiles > MAX_FILES_PER_JOB) {
    // Hand off to the next continuation shard. Final shard will write
    // the manifest with cumulative totals; this bootstrap doesn't.
    await enqueueNextShard(env, {
      owner, repo, installationId, reason,
      lo: MAX_FILES_PER_JOB,
      hi: Math.min(MAX_FILES_PER_JOB * 2, totalFiles),
      headSha, treeSha,
      totalFiles,
      filesDone: sliceHi,
      chunksDone: chunkCount,
      runId,
    })
    return
  }

  // Single-shard run — write manifest now.
  await persistManifest({
    env, owner, repo, namespace, headSha, runId,
    fileCount: sliceHi, chunkCount, shardCount: 1,
  })
  console.log(JSON.stringify({
    event: "index-job-completed",
    owner, repo, run_id: runId,
    file_count: sliceHi, chunk_count: chunkCount, shard_count: 1,
  }))
  // ARC-236: fan out reruns for PRs that warmed up. Best-effort —
  // failure to enqueue doesn't fail the index job (the indexing
  // itself succeeded; reruns are a customer-UX upgrade).
  await enqueueWarmupRerunsForIndex({
    env, client, owner, repo, installationId,
  })
}

async function handleShardJob(
  job: IndexRepoMessage,
  shard: NonNullable<IndexRepoMessage["shard"]>,
  env: Env,
): Promise<void> {
  const { owner, repo, installationId, reason } = job
  const namespace = repo.toLowerCase()

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
    repo,
    headSha: shard.headSha,
    modelId: EMBEDDING_MODEL,
    chunkerVersion: CHUNKER_VERSION,
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

  const sliceFiles = indexableFiles.slice(shard.lo, shard.hi)
  const { chunkCount: sliceChunkCount, idsByPath } = await processSlice({
    client, env, owner, repo, namespace,
    headSha: shard.headSha, files: sliceFiles,
  })

  // ARC-238 Codex v1 B3 + code-reviewer MED-2: vectors-record write
  // can return proceed=false on stale-skip. In that case we abort
  // the chain — neither writing the manifest (would overwrite the
  // authoritative one with stale runId + counts) nor enqueueing the
  // next shard.
  const vectorsResult = await persistVectorIds({
    env, owner, repo,
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
    await persistManifest({
      env, owner, repo, namespace,
      headSha: shard.headSha, runId: shard.runId,
      fileCount: cumulativeFiles,
      chunkCount: cumulativeChunks,
      shardCount,
    })
    console.log(JSON.stringify({
      event: "index-job-completed",
      owner, repo, run_id: shard.runId,
      file_count: cumulativeFiles,
      chunk_count: cumulativeChunks,
      shard_count: shardCount,
    }))
    // ARC-236: fan out reruns on the final-shard path too. Multi-
    // shard repos benefit from the same warmup-rerun UX.
    await enqueueWarmupRerunsForIndex({
      env, client, owner, repo, installationId,
    })
    return
  }

  await enqueueNextShard(env, {
    owner, repo, installationId, reason,
    lo: shard.hi,
    hi: Math.min(shard.hi + MAX_FILES_PER_JOB, shard.totalFiles),
    headSha: shard.headSha,
    treeSha: shard.treeSha,
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
  repo: string
  namespace: string
  headSha: string
  files: ReadonlyArray<IndexableFile>
}

export interface ProcessSliceResult {
  /** Total chunks upserted across the slice. */
  chunkCount: number
  /** Path → ordered chunk ids accumulated for this slice. Used by
   *  ARC-238's uninstall delete to call `deleteByIds` later. */
  idsByPath: Record<string, string[]>
}

async function processSlice(args: ProcessSliceArgs): Promise<ProcessSliceResult> {
  const { client, env, owner, repo, namespace, headSha, files } = args
  let chunkBuffer: Chunk[] = []
  const vectorBuffer: VectorizeRecord[] = []
  let totalChunks = 0
  const idsByPath: Record<string, string[]> = {}

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

    const fileChunks = chunkFile(file.path, content)
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
        await env.OPENCLAW_CODE_INDEX.upsert(upBatch)
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
    await env.OPENCLAW_CODE_INDEX.upsert(upBatch)
  }

  return { chunkCount: totalChunks, idsByPath }
}

interface VectorizeRecord {
  id: string
  values: number[]
  namespace: string
  metadata: Record<string, string | number>
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
  installationId: number
  reason: IndexRepoMessage["reason"]
  lo: number
  hi: number
  headSha: string
  treeSha: string
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
    installationId: args.installationId,
    reason: args.reason,
    shard: {
      lo: args.lo,
      hi: args.hi,
      headSha: args.headSha,
      treeSha: args.treeSha,
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
  repo: string
  namespace: string
  headSha: string
  runId: string
  fileCount: number
  chunkCount: number
  shardCount: number
}

async function persistManifest(args: PersistManifestArgs): Promise<void> {
  const manifest: RepoIndexManifestV1 = {
    v: 1,
    repo: args.namespace,
    owner: args.owner,
    headSha: args.headSha,
    runId: args.runId,
    fileCount: args.fileCount,
    chunkCount: args.chunkCount,
    shardCount: args.shardCount,
    indexedAt: new Date().toISOString(),
    modelId: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIMENSIONS,
    chunkerVersion: CHUNKER_VERSION,
    windowLines: CHUNK_LINES,
    overlapLines: CHUNK_OVERLAP,
  }
  const ok = await writeRepoIndexManifest(args.env, manifest)
  if (!ok) {
    console.error(JSON.stringify({
      event: "repo-index-manifest-write-failed",
      owner: args.owner, repo: args.repo, run_id: args.runId,
    }))
  }
}

interface PersistVectorIdsArgs {
  env: Env
  owner: string
  repo: string
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
  const { env, owner, repo, runId, idsByPathSlice, isBootstrap } = args
  const existing = await readRepoIndexVectors(env, repo)
  const manifestRead = await readRepoIndexManifest(env, repo)
  const currentManifestRunId =
    manifestRead.kind === "ok" ? manifestRead.manifest.runId : null

  const outcome = computeMerge({
    existing,
    owner,
    repo,
    runId,
    idsByPathSlice,
    currentManifestRunId,
  })

  if (outcome.action === "stale-skip") {
    // Different run is the current one. Refuse to write — don't
    // corrupt the live vectors record with stale slice data — and
    // signal the caller to skip the manifest/next-shard write.
    console.warn(JSON.stringify({
      event: "repo-index-vectors-stale-skip",
      owner, repo, run_id: runId, existing_run_id: outcome.existingRunId,
      current_manifest_run_id: currentManifestRunId,
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
