// ARC-286 — pre-submit "is PR still open" guard. Extracted from the
// inline block in `handlePrReviewEnsemble` per Sigilix's PR #97
// round-2 pushback: testing the guard's three branches (open / merged
// / API-error) takes ~3 unit tests with 1-2 mocks, not 20-mock
// orchestrator integration tests. The orchestrator just calls this
// helper and decides what to do when `shouldSkip: true`.
//
// SIG-88 (2026-05-18): added `submitMergedOnApprove` below — when the
// guard fires (pre-fanout OR pre-submit), the orchestrator now submits
// a marker-only APPROVE via this helper instead of bailing to a
// skip-notice. Matches CodeRabbit's behavior: GitHub's native
// "approved these changes" one-liner stands in for a review on a PR
// that merged before the ensemble could decide. The helper lives next
// to `checkIsPrMerged` so the two pieces of the merged-mid-review
// story stay co-located + unit-testable.

import { renderApproveBody } from "./triage-pr-review"
import type { SubmitReviewBody } from "../shared/types/github"

/** Just the slice of `GitHubClient` this helper needs. Defined locally
 *  so tests can stub a 1-method object rather than constructing the
 *  full client. */
export interface MergeGuardClient {
  getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ merged_at?: string | null }>
}

export type MergeGuardResult =
  | { shouldSkip: false }
  | { shouldSkip: true; mergedAtMs: number }

/**
 * Fetches the PR's current state. Returns `shouldSkip: true` with the
 * merge timestamp when the PR is already merged; `shouldSkip: false`
 * otherwise.
 *
 * **Best-effort.** Transient GitHub failures (5xx, rate limits,
 * network blips) log warn and return `shouldSkip: false` so the
 * caller proceeds with submit. Sigilix PR #97 Critical catch: the
 * caller's risk on a discarded synth review (minutes of work lost)
 * exceeds the risk on a duplicate-review-against-merged-PR (the
 * ARC-286 quirks we wanted to prevent). Warn-and-proceed is the
 * right semantics for a best-effort guard.
 *
 * Pure-side-effect-free except for the one warn log on the error
 * path. Exported for unit tests.
 */
export async function checkIsPrMerged(args: {
  client: MergeGuardClient
  owner: string
  repo: string
  prNumber: number
  /** Stamped on the warn log for correlation. */
  headSha: string
}): Promise<MergeGuardResult> {
  try {
    const meta = await args.client.getPullRequest(args.owner, args.repo, args.prNumber)
    if (meta.merged_at !== null && meta.merged_at !== undefined) {
      return { shouldSkip: true, mergedAtMs: new Date(meta.merged_at).getTime() }
    }
    return { shouldSkip: false }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-merged-guard-failed",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      err: err instanceof Error ? err.message : String(err),
    }))
    return { shouldSkip: false }
  }
}

// ─── SIG-88: merged-mid-review → APPROVE short-circuit ─────────────────

/** Slice of `GitHubClient.submitReview` the helper needs. Defined
 *  locally so tests stub a 1-method object instead of the full client. */
export interface MergeApproveSubmitClient {
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody,
  ): Promise<{ id: number; state: string }>
}

/** Which call site fired the short-circuit. Drives the `stage` field on
 *  the `pr-review-approved-on-merge` telemetry event so post-hoc analysis
 *  can split "merged before we even started" from "merged while we were
 *  computing". */
export type MergedOnApproveStage = "pre-fanout" | "pre-submit"

export type SubmitMergedOnApproveResult =
  | { ok: true; reviewId: number; state: string }
  | { ok: false; error: string }

/**
 * SIG-88: submit a marker-only APPROVE event when the PR was merged
 * mid-review. Matches CodeRabbit's posture — GitHub's native "approved
 * these changes" timeline line carries the signal without competing
 * with the merge or posting REQUEST_CHANGES on already-merged code.
 *
 * Body: `renderApproveBody({ verdict: { findings: [] } })` — post-ARC-293
 * + SIG-87 the APPROVE renderer returns marker-only (just
 * `<!-- sigilix:pr-review -->\n`). We pass an empty-findings synthetic
 * verdict because the renderer's shape requires one; the verdict
 * content is intentionally never read on this path.
 *
 * Telemetry: emits `pr-review-approved-on-merge` with `stage`,
 * `merged_at_ms`, `merged_during_review_ms`, and the truncated headSha
 * so it's correlatable with the surrounding ensemble events. This
 * event distinguishes the short-circuit APPROVE from an ensemble-
 * decided APPROVE (which doesn't emit it).
 *
 * Errors: the submit can fail (GitHub API blip, auth issue, etc.). On
 * failure we log + return `{ ok: false, error }` so the caller can
 * finalize as `errored`. On success we return `{ ok: true, reviewId }`
 * so the caller can finalize as `posted` with the appropriate
 * `reviewMeta`.
 *
 * Pure-ish: one network call (`submitReview`) + one log line. No KV
 * writes; the caller's `finalize` still owns the telemetry-write +
 * daily-budget increment.
 *
 * Exported for unit tests.
 */
export async function submitMergedOnApprove(args: {
  client: MergeApproveSubmitClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** Pre-fanout or pre-submit short-circuit — stamped on telemetry. */
  stage: MergedOnApproveStage
  /** Epoch ms when the merge happened (from `merged_at` parsing). */
  mergedAtMs: number
  /** Epoch ms when this ensemble run started — drives the
   *  `merged_during_review_ms` field on telemetry. */
  startMs: number
}): Promise<SubmitMergedOnApproveResult> {
  // Synthetic empty-findings verdict. The renderer reads `findings`
  // (length === 0 → APPROVE marker-only) and nothing else from the
  // verdict object on this path. `summary`/`confidence`/etc. live
  // only in the REQUEST_CHANGES renderer.
  const body = renderApproveBody({
    verdict: {
      summary: "",
      confidence: 5,
      confidenceReason: "",
      findings: [],
    },
  })
  const submission: SubmitReviewBody = {
    event: "APPROVE",
    body,
    commit_id: args.headSha,
    // No `comments` — the marker-only body is the entire review.
  }
  try {
    const submitted = await args.client.submitReview(
      args.owner, args.repo, args.prNumber, submission,
    )
    // CR PR #104 Minor catch: clamp at 0 — on `pre-fanout` runs the merge
    // can have happened BEFORE this ensemble started (webhook queued during
    // a long delay), so `mergedAtMs - startMs` would otherwise report a
    // negative duration on telemetry. `pre-submit` always positive in
    // practice (merge happened during fan-out → after startMs), but the
    // clamp is cheap and keeps the field's semantic ("how long into the
    // review did the merge land") honest across both stages.
    console.log(JSON.stringify({
      event: "pr-review-approved-on-merge",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      stage: args.stage,
      merged_at_ms: args.mergedAtMs,
      merged_during_review_ms: Math.max(0, args.mergedAtMs - args.startMs),
      review_elapsed_ms: Date.now() - args.startMs,
      review_id: submitted.id,
    }))
    return { ok: true, reviewId: submitted.id, state: submitted.state }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(JSON.stringify({
      event: "pr-review-approved-on-merge-failed",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      stage: args.stage,
      err: msg,
    }))
    return { ok: false, error: msg }
  }
}
