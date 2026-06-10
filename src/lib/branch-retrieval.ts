// SIG-129: branch-aware retrieval. The codebase index covers only the
// default branch, so a PR's new/changed code is invisible to retrieval —
// causing branch-only false negatives and "symbol doesn't exist"
// hallucinations. The PR-review ensemble already holds the changed-file
// HEAD content in `astFilesByPath`; this module makes that content
// retrievable in-memory and merges it into each retrieval pass with HEAD
// content winning on path collision.
//
// Model: branch state = main index (unchanged files) ∪ changed-file head
// content (overrides). No new GitHub fetches, no Vectorize writes.

import { embedTexts } from "@/src/shared/adapters/model"
import { chunkFile, type Chunk } from "./indexer"
import type { RetrievedChunk } from "./retrieval"

interface AiBinding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][]; shape?: number[] }>
}

/**
 * Merge main-index chunks with branch (PR-head) chunks. Every changed file
 * is stale on `main`, so ALL main chunks whose path is in `changedPaths` are
 * dropped (the tombstone) — even if no branch chunk for that path surfaced in
 * the retrieved top-K. Showing stale `main` content for a changed file is
 * worse than omitting it (it causes "symbol doesn't exist" hallucinations).
 * Surviving main chunks + the branch chunks are re-ranked by score descending
 * (both are cosine scores, directly comparable).
 */
export function mergeBranchAware(
  mainChunks: readonly RetrievedChunk[],
  branchChunks: readonly RetrievedChunk[],
  changedPaths: ReadonlySet<string>,
): RetrievedChunk[] {
  const keptMain = mainChunks.filter((c) => !changedPaths.has(c.path))
  return [...keptMain, ...branchChunks].sort((a, b) => b.score - a.score)
}

// Bounds the embed payload + cosine cost on large/stacked PRs. ~400
// chunks ≈ a few hundred KB of source — comfortably within one batched
// embed budget. Chunks beyond the cap are dropped (best-effort: the model
// still has the diff itself).
export const MAX_BRANCH_CHUNKS = 400

/**
 * Chunk the changed-file HEAD content with the indexer's own `chunkFile`
 * (same CHUNKER_VERSION windowing) so branch chunks are shaped exactly
 * like the indexed ones. Capped at MAX_BRANCH_CHUNKS.
 */
export function buildBranchChunks(filesByPath: ReadonlyMap<string, string>): Chunk[] {
  const out: Chunk[] = []
  for (const [path, content] of filesByPath) {
    if (out.length >= MAX_BRANCH_CHUNKS) break
    for (const c of chunkFile(path, content)) {
      out.push(c)
      if (out.length >= MAX_BRANCH_CHUNKS) break
    }
  }
  return out
}

/** A branch chunk paired with its embedding vector (cached for the review). */
export interface BranchVector {
  chunk: { path: string; lineStart: number; lineEnd: number; content: string }
  vector: number[]
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0
  // i < min(a.length, b.length) keeps both indices in bounds, so the `!`
  // is safe under noUncheckedIndexedAccess.
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a))
}

/**
 * In-memory cosine retrieval over the cached branch vectors. Scores are
 * cosine similarity in [-1, 1] — the same metric Vectorize returns — so
 * callers may merge + re-rank against main-index chunks directly. Returns
 * top-K as RetrievedChunk[]. Empty when the set is empty or the query has
 * zero norm.
 */
export function retrieveBranchChunks(
  queryVector: readonly number[],
  branchVectors: readonly BranchVector[],
  topK: number,
): RetrievedChunk[] {
  if (branchVectors.length === 0) return []
  const qn = norm(queryVector)
  if (qn === 0) return []
  const scored: RetrievedChunk[] = []
  for (const bvi of branchVectors) {
    // Defensive: a dimension mismatch would make cosine (dot over min-length,
    // norms over full length) meaningless. In practice all vectors are
    // EMBEDDING_DIMENSIONS-wide, so this only fires on a model/version skew.
    if (bvi.vector.length !== queryVector.length) continue
    const vn = norm(bvi.vector)
    if (vn === 0) continue
    const score = dot(queryVector, bvi.vector) / (qn * vn)
    // A non-finite score (NaN/Infinity from a corrupt vector) would make the
    // sort comparator undefined and let a bad chunk land anywhere in top-K.
    if (!Number.isFinite(score)) continue
    scored.push({ ...bvi.chunk, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, topK))
}

/** Gate: flag is "on" (case-insensitive) and there is changed JS/TS content. */
export function shouldRunBranchAwareRetrieval(
  flag: string | undefined,
  filesByPath: ReadonlyMap<string, string>,
): boolean {
  return (flag ?? "").trim().toLowerCase() === "on" && filesByPath.size > 0
}

/** Shadow telemetry event for the SIG-86 bake-off. Pure builder so the
 *  emitted shape is unit-pinned (a dropped/renamed field breaks the test,
 *  not a downstream log pipeline). headSha is truncated to 7 at emit time. */
export interface BranchRetrievalEventInput {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  branchChunkCount: number
  embedElapsedMs: number
  headOverride: { preflight: number; perf: number; symbol: number }
}

export function buildBranchRetrievalEvent(e: BranchRetrievalEventInput): Record<string, unknown> {
  return {
    event: "pr-review-branch-retrieval",
    owner: e.owner,
    repo: e.repo,
    prNumber: e.prNumber,
    headSha: e.headSha.slice(0, 7),
    branch_chunk_count: e.branchChunkCount,
    embed_elapsed_ms: e.embedElapsedMs,
    head_override_preflight: e.headOverride.preflight,
    head_override_perf: e.headOverride.perf,
    head_override_symbol: e.headOverride.symbol,
  }
}

/**
 * Build + embed the branch retrieval set ONCE per review. Best-effort:
 * any failure (embed error, empty input) yields [] so the caller silently
 * falls back to main-only retrieval. One batched `embedTexts` call.
 */
export async function prepareBranchSet(
  ai: AiBinding,
  filesByPath: ReadonlyMap<string, string>,
): Promise<BranchVector[]> {
  const chunks = buildBranchChunks(filesByPath)
  if (chunks.length === 0) return []
  try {
    const vectors = await embedTexts(ai, chunks.map((c) => c.content))
    if (vectors.length !== chunks.length) return []
    // The length check above guarantees vectors[i] exists for every chunk
    // index, so the `!` is safe under noUncheckedIndexedAccess.
    return chunks.map((chunk, i) => ({
      chunk: { path: chunk.path, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, content: chunk.content },
      vector: vectors[i]!,
    }))
  } catch {
    return []
  }
}
