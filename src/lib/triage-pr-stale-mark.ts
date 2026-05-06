// ARC-184: stale-mark queue handler. Runs in parallel with the
// regular pr-review job on `synchronize` / `edited` webhooks. Reads
// the per-PR review manifest, computes current state (file list, base
// SHA, head SHA, prompt version), checks drift, and PATCHes the prior
// review or issue-comment body with a stale-notice block.
//
// No new model calls — pure GitHub-side metadata + non-destructive
// PATCH. Latency target: 1-3 s after webhook arrival, well before the
// new review (30-90 s) lands.
//
// Spec: docs/superpowers/specs/2026-05-06-arc-184-review-provenance-stale-markers-design.md
// Plan: docs/superpowers/plans/2026-05-06-arc-184-review-provenance.md

import { GitHubClient, GitHubHttpError } from "./github"
import { getInstallationToken } from "./github-app"
import {
  readReviewManifest,
  computeFileListHash,
  detectReviewStale,
  renderStaleBlock,
  applyStaleBlock,
  type ReviewManifestV1,
} from "./review-manifest"
import type { Env } from "../index"

export interface PrStaleMarkArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
  /** Snapshot of the manifest taken at webhook arrival; the consumer
   * also re-reads to detect concurrent overwrites. */
  manifestSnapshot: ReviewManifestV1
  newHeadSha: string
  newBaseSha: string
  /** Pinned at webhook time so a concurrent prompt deploy between
   * enqueue and consume doesn't smuggle a different value into
   * drift detection. */
  currentPromptVersion: string
}

const MAX_EMPTY_FILELIST_RETRIES = 3
const EMPTY_FILELIST_BACKOFF_MS = 1000

export async function handlePrStaleMark(args: PrStaleMarkArgs): Promise<void> {
  const {
    env, owner, repo, prNumber, installationId,
    manifestSnapshot, newHeadSha, newBaseSha, currentPromptVersion,
  } = args

  if (env.OPENCLAW_REVIEW_MANIFEST_ENABLED === "off") {
    console.log(JSON.stringify({ event: "review-stale-skipped-disabled", owner, repo, prNumber }))
    return
  }

  // Re-read the manifest. Between enqueue and consume the regular
  // pr-review handler may have just landed a fresh manifest for the
  // new head SHA — that's the up-to-date one and we MUST NOT mark it
  // stale.
  const result = await readReviewManifest(env, owner, repo, prNumber)
  if (result.kind === "missing") {
    console.log(JSON.stringify({ event: "review-manifest-missing", owner, repo, prNumber }))
    return
  }
  if (result.kind === "invalid") {
    console.log(JSON.stringify({
      event: "review-manifest-invalid",
      owner, repo, prNumber,
      reason: result.reason,
    }))
    return
  }
  const manifest = result.manifest
  if (manifest.reviewedAt > manifestSnapshot.reviewedAt) {
    console.log(JSON.stringify({ event: "review-stale-superseded", owner, repo, prNumber }))
    return
  }

  // Build a GitHub client. Token fetch is best-effort; on failure we
  // log and exit since no further work is possible.
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error(JSON.stringify({
      event: "review-stale-mark-failed",
      owner, repo, prNumber,
      err: "missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY",
    }))
    return
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  const client = new GitHubClient({ token })

  // Compute current state. The file-list endpoint can return an empty
  // page on the leading edge of a fresh push (eventual consistency);
  // retry up to MAX_EMPTY_FILELIST_RETRIES times before aborting.
  let files: Awaited<ReturnType<GitHubClient["listPullFilesForManifest"]>> | null = null
  for (let attempt = 1; attempt <= MAX_EMPTY_FILELIST_RETRIES; attempt += 1) {
    files = await client.listPullFilesForManifest(owner, repo, prNumber)
    if (files.entries.length > 0) break
    console.log(JSON.stringify({
      event: "review-stale-current-state-empty-retry",
      owner, repo, prNumber, attempt,
    }))
    if (attempt < MAX_EMPTY_FILELIST_RETRIES) {
      await new Promise((r) => setTimeout(r, EMPTY_FILELIST_BACKOFF_MS))
    }
  }
  if (!files || files.entries.length === 0) {
    console.error(JSON.stringify({
      event: "review-stale-mark-failed",
      owner, repo, prNumber,
      err: "empty-files-after-retry",
    }))
    return
  }
  const fileListHash = await computeFileListHash(files)

  const staleResult = detectReviewStale(manifest, {
    headSha: newHeadSha,
    baseSha: newBaseSha,
    fileListHash,
    promptVersion: currentPromptVersion,
  })
  if (!staleResult.stale) {
    console.log(JSON.stringify({ event: "review-stale-not-detected", owner, repo, prNumber }))
    return
  }
  console.log(JSON.stringify({
    event: "review-stale-detected",
    owner, repo, prNumber,
    reasons: staleResult.reasons,
    manifestHeadSha: manifest.headSha,
    currentHeadSha: newHeadSha,
    manifestBaseSha: manifest.baseSha,
    currentBaseSha: newBaseSha,
    manifestPromptVersion: manifest.promptVersion,
    currentPromptVersion,
  }))

  // Fetch the prior body, locate / replace the stale block, PATCH.
  const target = manifest.target
  const block = renderStaleBlock(manifest, {
    headSha: newHeadSha,
    baseSha: newBaseSha,
    fileListHash,
    promptVersion: currentPromptVersion,
  })

  try {
    if (target.kind === "review") {
      const review = await client.getReview(owner, repo, prNumber, target.reviewId)
      if (review === null) {
        console.log(JSON.stringify({
          event: "review-stale-target-missing",
          owner, repo, prNumber,
          target: { kind: "review", id: target.reviewId },
        }))
        return
      }
      const newBody = applyStaleBlock(review.body, block)
      await client.updateReviewBody(owner, repo, prNumber, target.reviewId, newBody)
      console.log(JSON.stringify({
        event: "review-stale-marked",
        owner, repo, prNumber,
        target: { kind: "review", id: target.reviewId },
        reasons: staleResult.reasons,
      }))
    } else {
      const comment = await client.getIssueComment(owner, repo, target.commentId)
      if (comment === null) {
        console.log(JSON.stringify({
          event: "review-stale-target-missing",
          owner, repo, prNumber,
          target: { kind: "issue-comment", id: target.commentId },
        }))
        return
      }
      const newBody = applyStaleBlock(comment.body, block)
      await client.updateIssueComment(owner, repo, target.commentId, newBody)
      console.log(JSON.stringify({
        event: "review-stale-marked",
        owner, repo, prNumber,
        target: { kind: "issue-comment", id: target.commentId },
        reasons: staleResult.reasons,
      }))
    }
  } catch (err) {
    const status = err instanceof GitHubHttpError ? err.status : undefined
    console.error(JSON.stringify({
      event: "review-stale-mark-failed",
      owner, repo, prNumber,
      target: target.kind === "review"
        ? { kind: "review", id: target.reviewId }
        : { kind: "issue-comment", id: target.commentId },
      err: err instanceof Error ? err.message : String(err),
      ...(status !== undefined ? { status } : {}),
    }))
    // 5xx → bubble for queue retry. Anything else (4xx, including
    // 403 permission gap) → swallow; retry won't help.
    if (status !== undefined && status >= 500) throw err
  }
}
