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
