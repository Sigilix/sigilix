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

import { chunkFile, type Chunk } from "./indexer"
import type { RetrievedChunk } from "./retrieval"

/**
 * Merge main-index chunks with branch (PR-head) chunks. A path present in
 * the branch set is treated as authoritative: ALL main chunks for that
 * path are dropped (they reflect stale `main` content) and the branch
 * chunks take their place. Branch-only paths are appended. The result is
 * re-ranked by score descending (Vectorize and our in-memory scores are
 * both cosine, so they are directly comparable).
 */
export function mergeBranchAware(
  mainChunks: readonly RetrievedChunk[],
  branchChunks: readonly RetrievedChunk[],
): RetrievedChunk[] {
  if (branchChunks.length === 0) return [...mainChunks]
  const branchPaths = new Set(branchChunks.map((c) => c.path))
  const keptMain = mainChunks.filter((c) => !branchPaths.has(c.path))
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
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
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
    const vn = norm(bvi.vector)
    if (vn === 0) continue
    const score = dot(queryVector, bvi.vector) / (qn * vn)
    scored.push({ ...bvi.chunk, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, topK))
}
