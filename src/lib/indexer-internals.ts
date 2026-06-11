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
import type { Chunk } from "@/src/lib/chunk-core"
import { readActiveRunId, shouldFinalize } from "@/src/lib/repo-index-active-run"

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

// Constants consumed by the slice pipeline leaf (indexer-slice.ts).
export { EMBED_BATCH, UPSERT_BATCH }
