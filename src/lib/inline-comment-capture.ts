// SIG-473 (inline pill VERIFIED) — map a PR's posted inline comments back to the
// finding fingerprints they carry, so the review manifest can record each
// finding's `inlineCommentId`. `submitReview` returns only the review id (not
// per-comment ids), so we list the comments back and re-associate them by the
// hidden `<!-- sigilix:fingerprint:<64hex> -->` marker each comment embeds.
//
// Pure (no IO) — exported for tests.

import { parseFindingFingerprint } from "@/src/lib/pr-finding-markers"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { ReviewManifestFinding } from "@/src/lib/review-manifest"

/**
 * Build fingerprint → comment-id from a list of posted comments. For each
 * comment, parse its embedded finding fingerprint; map it to the comment id.
 * First write wins (a fingerprint should be unique per review, but if a copied
 * marker produced two comments we keep the earliest so the mapping is stable).
 * Comments with no/garbage fingerprint are skipped.
 */
export function buildFingerprintToCommentId(
  comments: ReadonlyArray<{ id: number; body: string }>,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const c of comments) {
    const fp = parseFindingFingerprint(c.body)
    if (!fp) continue
    if (!map.has(fp)) map.set(fp, c.id)
  }
  return map
}

/**
 * SIG-473: after a posted review, list the PR's inline comments and stamp each
 * manifest finding with the `inlineCommentId` of the comment carrying its
 * `contentFingerprint`. Mutates `findings` in place (sets `inlineCommentId` when
 * a match is found; leaves it absent otherwise). Best-effort: any failure is
 * surfaced to the caller (which logs + swallows) so it never fails the review.
 * Keeps publish.ts thin (one awaited call inside its own try/catch).
 */
export async function captureInlineCommentIds(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  findings: ReviewManifestFinding[],
): Promise<void> {
  const comments = await client.listPullRequestReviewComments(owner, repo, prNumber)
  const map = buildFingerprintToCommentId(comments)
  for (const f of findings) {
    if (typeof f.contentFingerprint !== "string") continue
    const id = map.get(f.contentFingerprint)
    if (typeof id === "number") f.inlineCommentId = id
  }
}
