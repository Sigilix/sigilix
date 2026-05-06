// ARC-194: incremental review on synchronize.
//
// Currently every push to a PR re-reviews the entire diff. CodeRabbit
// stores the last-reviewed commit SHA in the sticky comment marker,
// fetches `lastReviewedSha...currentHeadSha` on synchronize, and
// reviews only the new commits. Saves model spend ~50% on
// iteration-heavy PRs.
//
// v1 takes a simpler shape: store last-reviewed SHA in KV
// (`OPENCLAW_STATE`), keyed by `{owner, repo, prNumber}`. On entry,
// the orchestrator looks up the previous SHA. If it exists AND
// differs from the current head, fetch the compare diff and use that
// instead of the full PR diff. After a successful review (regardless
// of mode), the new head SHA gets written.
//
// Fail-safe contract: if the compare fetch fails, the diff is empty,
// or the compare diff is suspiciously larger than the full diff
// (force-push to unrelated commit), fall back to the full diff. We
// never review LESS than the full PR by accident.
//
// Telemetry: `incrementalReview: { previousSha, mode: "incremental"|"full"|"first-review", reason? }`

import type { Env } from "../index"

const KV_KEY_PREFIX = "pr-last-reviewed:"
const TTL_SECONDS = 30 * 24 * 60 * 60  // 30 days, matches telemetry TTL

export interface LastReviewedRecord {
  reviewedSha: string
  reviewedAt: number  // ms since epoch
}

/**
 * Build the KV key for a PR's last-reviewed SHA. Centralized so the
 * read/write paths can't drift in format.
 */
function kvKey(owner: string, repo: string, prNumber: number): string {
  return `${KV_KEY_PREFIX}${owner}/${repo}#${prNumber}`
}

/**
 * Read the last-reviewed SHA for a PR. Returns `null` when no record
 * exists (first review for this PR), the record is malformed, or KV
 * read fails. Never throws — callers fall back to full diff on null.
 */
export async function readLastReviewedSha(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<LastReviewedRecord | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(kvKey(owner, repo, prNumber))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.reviewedSha !== "string" || obj.reviewedSha.length === 0) return null
    if (typeof obj.reviewedAt !== "number") return null
    return { reviewedSha: obj.reviewedSha, reviewedAt: obj.reviewedAt }
  } catch {
    return null
  }
}

/**
 * Persist the head SHA we just reviewed. Best-effort — KV write
 * failures fall through silently rather than failing the review run.
 */
export async function writeLastReviewedSha(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  reviewedSha: string,
): Promise<void> {
  const record: LastReviewedRecord = {
    reviewedSha,
    reviewedAt: Date.now(),
  }
  try {
    await env.OPENCLAW_STATE.put(
      kvKey(owner, repo, prNumber),
      JSON.stringify(record),
      { expirationTtl: TTL_SECONDS },
    )
  } catch {
    // Swallow — incremental review is an optimization, not a
    // correctness requirement. Next push will fall back to full diff
    // and we re-establish the marker on the following review.
  }
}

/**
 * Decide whether incremental diff is safe. Pure function — caller
 * provides the diff strings. Picks the incremental diff when it
 * meets these conditions:
 *   - Different from headSha (otherwise incremental diff would be
 *     empty or stale)
 *   - Compare diff is non-empty (prevents bizarre case where the
 *     compare endpoint returns nothing)
 *   - Compare diff is reasonably smaller than the full diff (cap at
 *     0.9× to detect the force-push-to-unrelated-commit case where
 *     the compare diff is BIGGER than the full diff)
 *
 * Otherwise falls back to full.
 */
export type DiffMode = "incremental" | "full" | "first-review"

export interface DiffSelection {
  diff: string
  mode: DiffMode
  previousSha?: string
  reason?: string
}

export function selectDiff(args: {
  fullDiff: string
  compareDiff: string | null
  previousSha: string | null
  currentHeadSha: string
}): DiffSelection {
  const { fullDiff, compareDiff, previousSha, currentHeadSha } = args
  if (previousSha === null) {
    return { diff: fullDiff, mode: "first-review" }
  }
  const sel: DiffSelection = { diff: fullDiff, mode: "full", previousSha }
  if (previousSha === currentHeadSha) {
    sel.reason = "same_sha"
    return sel
  }
  if (compareDiff === null) {
    sel.reason = "compare_fetch_failed"
    return sel
  }
  if (compareDiff.length === 0) {
    sel.reason = "compare_empty"
    return sel
  }
  // Sanity check: incremental should be SMALLER than full. If GitHub
  // returned a compare bigger than the full diff, something weird
  // happened (e.g., previousSha is on a branch that diverged hard
  // from the PR's current base). Fall back to full diff.
  if (compareDiff.length > fullDiff.length * 0.9) {
    sel.reason = "compare_not_smaller"
    return sel
  }
  return { diff: compareDiff, mode: "incremental", previousSha }
}
