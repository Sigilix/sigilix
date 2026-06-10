// SIG-89: skip pr-review dispatch when a `synchronize` push is a no-op
// merge from base (`Update branch` button, `git merge main` with no
// conflicts, rebase-on-main no-op force push, empty-commit push).
//
// Detection is by byte-identical comparison of the cumulative PR diff
// (PR.base..PR.head) against the diff hash stashed after the prior
// successful review. Same input to the ensemble => same review =>
// re-running is pure waste + timeline noise. Catches all four no-op
// cases uniformly (merge commit, rebase, force-push no-op, empty
// commit) where a merge-commit-shape heuristic would miss three of
// them.
//
// The prior review (APPROVE or REQUEST_CHANGES) stays as the
// authoritative one — same UX CodeRabbit demonstrates when GitHub's
// "Update branch" button fires a synchronize. The dismiss-prior-reviews
// path MUST NOT fire either, which is achieved by skipping the
// enqueuePrReviewJob call in the webhook entirely.
//
// pr-overview is intentionally unaffected: an "Update branch" push is
// still a meaningful timeline event worth a fresh sticky, and the
// overview is cheap.
//
// Telemetry: emits `pr-review-skipped-noop-merge` so we can count
// budget saved + correlate with customer "Update branch" usage.

import type { Env } from "@/src/shared/types/env"

const KV_KEY_PREFIX = "pr-review-diff-hash:"
const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days, mirrors pr-last-reviewed

export interface DiffHashRecord {
  /** sha256 hex of the cumulative PR diff that was last reviewed. */
  diffHash: string
  /** Head SHA at the time of the last review (telemetry only). */
  reviewedHeadSha: string
  /** ms since epoch. */
  hashedAt: number
}

function kvKey(owner: string, repo: string, prNumber: number): string {
  return `${KV_KEY_PREFIX}${owner}/${repo}#${prNumber}`
}

/**
 * Compute sha256 hex of a diff string. Pure + deterministic — identical
 * input always returns the same hex, regardless of which environment
 * computed it. Uses Web Crypto (available in Workers + Node 20+ + the
 * Vitest test runtime).
 */
export async function computeDiffHash(diff: string): Promise<string> {
  const bytes = new TextEncoder().encode(diff)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Read the diff hash stashed after the prior successful review.
 * Returns `null` for first-review (no record), malformed JSON, or
 * KV read failure. Callers treat null as "dispatch as today".
 */
export async function readPriorReviewDiffHash(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<DiffHashRecord | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(kvKey(owner, repo, prNumber))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.diffHash !== "string" || obj.diffHash.length === 0) return null
    if (typeof obj.reviewedHeadSha !== "string" || obj.reviewedHeadSha.length === 0) return null
    if (typeof obj.hashedAt !== "number" || !Number.isFinite(obj.hashedAt)) return null
    return {
      diffHash: obj.diffHash,
      reviewedHeadSha: obj.reviewedHeadSha,
      hashedAt: obj.hashedAt,
    }
  } catch {
    return null
  }
}

/**
 * Persist the diff hash after a confirmed GitHub review submit. Same
 * "swallow KV failures" semantics as `writeLastReviewedSha` — the
 * customer-facing review already shipped; a KV miss only means the
 * next push falls back to dispatch (correct + safe).
 */
export async function writePriorReviewDiffHash(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  diffHash: string,
  reviewedHeadSha: string,
): Promise<void> {
  const record: DiffHashRecord = {
    diffHash,
    reviewedHeadSha,
    hashedAt: Date.now(),
  }
  try {
    await env.OPENCLAW_STATE.put(
      kvKey(owner, repo, prNumber),
      JSON.stringify(record),
      { expirationTtl: TTL_SECONDS },
    )
  } catch {
    // Swallow — noop-merge detection is an optimization. Next push
    // falls back to dispatch + re-establishes the marker on the
    // following successful review.
  }
}

/**
 * Compute the hash of the just-reviewed diff and stash it for the
 * next synchronize webhook's noop-merge compare. Single entry point
 * called from every post-submit-success site in
 * `triage-pr-review-ensemble.ts` so the contract is directly testable
 * (the inline compute+write pair would only be exercised through the
 * full ensemble handler, which is too heavy to set up in tests).
 *
 * Catches all errors internally — same swallow-and-log semantics as
 * the underlying `writePriorReviewDiffHash`, so callers don't need
 * their own try/catch and a KV miss can't bubble out as `errored`.
 */
export async function recordReviewedDiffHash(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  fullPrDiff: string,
  reviewedHeadSha: string,
): Promise<void> {
  try {
    const diffHash = await computeDiffHash(fullPrDiff)
    await writePriorReviewDiffHash(env, owner, repo, prNumber, diffHash, reviewedHeadSha)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-diff-hash-record-failed",
      owner, repo, prNumber, reviewedHeadSha,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}
