// SIG-376 (SIG-318 Tier-1 7/8): the pure foundation lifted out of
// `indexer.ts` so that file stays under the 1,000-line budget. These
// constants, identity helpers, and tree-walk filters have no environment
// or network dependencies (modulo the typed `Env` accessor for the
// AST-chunking flag), so they relocate verbatim — bodies are byte-identical
// to their prior in-file definitions; only the surrounding `export`
// keywords + the import paths differ.
//
// This leaf also OWNS `leaseAllows` (a private helper used by BOTH the
// consumer handlers staying in core AND `persistScopedRulesManifest` in the
// persist leaf). Moving the shared symbol INTO this leaf breaks the
// would-be `indexer-persist → indexer (core)` cycle — mirroring the
// triage-pr-overview marker-ownership pattern. `leaseAllows` was private, so
// the core re-exports nothing for it; both core and the persist leaf import
// it from here. It only calls the external `readActiveRunId` /
// `shouldFinalize`, so it stays cycle-free here.
//
// Leaf module: imports the `Env` + `Chunk` types and the
// `repo-index-active-run` accessors. It does NOT value-import the core
// `indexer.ts`.

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { IndexTarget } from "@/src/lib/index-branch"
import type { Chunk } from "@/src/lib/chunk-core"
import { readActiveRunId, shouldFinalize } from "@/src/lib/repo-index-active-run"

type IndexRepoMessage = Extract<JobMessage, { type: "index-repo" }>

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

/**
 * Whether the index job should classify + stamp the repo's role
 * (`OPENCLAW_REPO_ROLE_CLASSIFY`, case-insensitive "on"). Default OFF: only
 * "on" enables, so no extra package.json fetch happens otherwise. Purely
 * additive metadata — nothing reads the role yet.
 */
export function repoRoleClassifyEnabled(env: Pick<Env, "OPENCLAW_REPO_ROLE_CLASSIFY">): boolean {
  return (env.OPENCLAW_REPO_ROLE_CLASSIFY ?? "").trim().toLowerCase() === "on"
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

const INDEXED_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx", ".rs", ".sql", ".md", ".py", ".go", ".toml"])

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
    if (!isPotentiallyIndexablePath(path)) continue
    const size = typeof entry.size === "number" ? entry.size : 0
    if (size > MAX_FILE_BYTES) continue
    out.push({ path, size })
  }
  return out
}

/**
 * Path-only indexability predicate. Unlike walkIndexableFiles, this
 * intentionally cannot apply the size cap because push changed-path payloads
 * do not include blob sizes. Used only for safe "definitely cannot affect the
 * vector index" fast paths.
 */
export function isPotentiallyIndexablePath(path: string): boolean {
  if (path.length === 0) return false
  if (pathHitsSkipDir(path)) return false
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  const lastSlash = path.lastIndexOf("/")
  if (dot < lastSlash) return false
  return INDEXED_EXTENSIONS.has(path.slice(dot))
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
  return sha256HexPrefix(`${args.owner}\0${args.repo}\0${args.headSha}\0${args.modelId}\0${args.chunkerVersion}`, 16)
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

/** SIG-136: true iff this run still owns the lease (or it's absent) and may
 *  proceed to persist a manifest / enqueue the next shard. */
export async function leaseAllows(env: Env, owner: string, repo: string, runId: string): Promise<boolean> {
  return shouldFinalize(await readActiveRunId(env, owner, repo), runId)
}

/**
 * SIG-422: resolve the commit + tree SHA to index this run at.
 *
 * PUSH path, push chain INTACT (`priorHeadSha === job.before`): pin to the
 * exact pushed commit (`job.after`) via `getCommit` instead of re-reading the
 * live branch tip. Pinning makes `manifest.headSha` equal the pushed commit,
 * so the NEXT push's `before` matches it and the cheap push fast-path chain
 * stays intact (fewer Compare-API recoveries). When the chain is intact,
 * `after` is the IMMEDIATE next commit after the manifest head, so the manifest
 * can only advance (A→B), never regress.
 *
 * The chain-intact gate is the recall-safety guard: a backlogged / out-of-order
 * push (manifest already AHEAD of this job's `before`) is NOT pinned — pinning
 * it to its older `after` would let the full-fallback regress the manifest to
 * that older tree. Instead it falls through to the live branch tip, where the
 * freshness check skips it (manifest already at the live tip) or compare-
 * recovery (#550) computes a safe forward delta — no regression either way.
 *
 * Non-push reasons (`merged-pr` / `pull-request` / `install` / `manual`) carry
 * no `after` and keep resolving the live branch tip — compare-recovery handles
 * their delta. A `getCommit` 404 (commit GC'd after a force-push) also falls
 * back to the live tip; the fast-path's `headSha === job.after` check (in
 * `resolveIncrementalChanged`) then forces a safe compare since the live tip is
 * no longer the pinned `after`.
 */
export async function resolveIndexHead(args: {
  client: GitHubClient
  owner: string
  repo: string
  target: IndexTarget
  job: IndexRepoMessage
  priorHeadSha: string | undefined
}): Promise<{ headSha: string; treeSha: string } | null> {
  const { client, owner, repo, target, job, priorHeadSha } = args
  const chainIntact =
    typeof job.before === "string" && job.before.length > 0 && priorHeadSha !== undefined && priorHeadSha === job.before
  if (job.reason === "push" && chainIntact && typeof job.after === "string" && job.after.length > 0) {
    const pinned = await client.getCommit(owner, repo, job.after)
    if (pinned) return pinned
    console.warn(
      JSON.stringify({
        event: "index-pin-after-miss-fallback-live",
        owner,
        repo,
        branch: target.isDefault ? null : target.branch,
        after: job.after,
      }),
    )
  }
  return client.getBranch(owner, repo, target.branch)
}

// Constants consumed by the slice pipeline leaf (indexer-slice.ts).
export { EMBED_BATCH, UPSERT_BATCH }
