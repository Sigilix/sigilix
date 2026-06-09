// ARC-194: incremental review on synchronize — last-reviewed SHA
// tracking (KV-backed) + the diff-selection helper that historically
// chose between full + incremental compare diffs.
//
// SIG-10 (2026-05-18): the incremental compare-diff path is disabled.
// The diff fed to specialists + synth is now always the cumulative
// full PR diff (PR.base.sha..headSha). The push-delta variant
// produced a false-positive class on multi-commit PRs where the
// prompt context (PR body, file lists, retrieval) describes the
// cumulative state but the diff only showed the latest push, so
// specialists flagged references to symbols introduced in an earlier
// commit as "undefined" / missing. See `selectDiff` below for the
// full rationale.
//
// The KV last-reviewed marker still gets read + written for
// telemetry (so we can correlate runs across pushes) and for the
// review-overview "first run vs subsequent run" rendering — only the
// diff-selection step changed.
//
// Telemetry: `incrementalReview: { previousSha, mode: "full"|"first-review", reason? }`
// (`mode: "incremental"` is no longer emitted but is preserved on the
// `DiffMode` union in case the incremental path is re-introduced
// behind a guard later.)

import type { Env } from "../shared/types/env"

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
 * Return the diff text to feed to specialists + synth.
 *
 * SIG-10 (2026-05-18): always returns the cumulative full PR diff
 * (PR.base.sha..headSha). Previously this picked the incremental
 * `previousSha..headSha` compare diff when one was available — a
 * model-spend savings on iteration-heavy PRs — but that produced a
 * false-positive class on multi-commit PRs: the prompt context
 * (PR title/body, file listing, retrieval) describes the cumulative
 * state of the whole PR, while the incremental diff only covers the
 * push delta. Specialists then flagged references to symbols that
 * exist in an earlier commit but aren't in the latest-commit diff
 * (e.g. "undefined export" findings on symbols introduced in commit
 * 1 of an N-commit PR).
 *
 * The per-push dispatch trigger is unchanged; only the diff CONTENT
 * is forced cumulative. `mode` / `previousSha` / `reason` remain
 * populated for telemetry observability so operators can correlate
 * "we knew about a prior review" with the diff we actually shipped.
 *
 * The `compareDiff` argument is retained for telemetry shape (and
 * future re-introduction behind a guard); its content is no longer
 * consumed.
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
  const { fullDiff, previousSha } = args
  if (previousSha === null) {
    return { diff: fullDiff, mode: "first-review" }
  }
  // SIG-10: always cumulative. Mode is reported as `full` (we have a
  // prior-review record but deliberately did NOT take the incremental
  // path) with reason `cumulative_diff_required` so logs make the
  // intentional choice obvious vs. the legacy "tried but bailed"
  // reasons (`same_sha`, `compare_fetch_failed`, etc.).
  return {
    diff: fullDiff,
    mode: "full",
    previousSha,
    reason: "cumulative_diff_required",
  }
}
