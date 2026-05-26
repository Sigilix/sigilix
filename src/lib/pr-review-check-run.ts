// ARC-258 — customer-visible "Sigilix · In progress" check
// run lifecycle. Lives at the dispatcher level (called from
// `dispatchJob`'s `pr-review` case) because the ensemble-post path
// can fall back to Phase 3 on quorum/synth/internal errors, and the
// final conclusion depends on which handler ultimately posted. A
// single dispatcher-level owner avoids the "ensemble marks
// `failure`, then Phase 3 posts a successful review" contradiction
// the first PR #80 attempt produced.
//
// All operations are best-effort: a 403 from a missing `checks:
// write` permission, or a 5xx from GitHub, must NOT fail the
// underlying review pipeline. The check is an indicator ON TOP OF
// the real review — the review must always go through.

import { GitHubClient, type CheckRunAnnotation } from "./github"
import { getInstallationToken } from "./github-app"
import type { Env } from "../index"

// SIG-216 (founder sign-off 2026-05-25): Sigilix follows Greptile's
// pattern of NOT posting Check annotations. GitHub renders the
// annotation `message` field as PLAIN TEXT, so our markdown-formatted
// finding bodies (with <details>, **bold**, badge <img> tags) dump
// literally with raw HTML visible. Findings live in the PR review
// thread instead; the Check run is advisory-only and links back.

/** Name used for the Check Run — renders in the PR's Checks tab.
 *  Kept short ("Sigilix") since the row already carries the
 *  in_progress/completed status; "Sigilix Review" was redundant.
 *  Single string lets future code look up the in-progress check
 *  by name+head_sha if needed. */
export const CHECK_RUN_NAME = "Sigilix"

/** Names that have ever been used for the in-progress check, current
 *  + historical. Used at create time to find and cancel stale
 *  in-progress checks left over from rename deploys or queue
 *  retries — see `cancelStaleInProgressChecks`. */
const KNOWN_CHECK_NAMES: ReadonlySet<string> = new Set([
  CHECK_RUN_NAME,
  "Sigilix Review", // legacy (commit 4 of PR #80, briefly deployed before rename)
])

/** Conclusion subset Sigilix actually emits. Narrower than GitHub's
 *  full set so call sites can't accidentally pass `cancelled` or
 *  `timed_out` (which we don't use). The REST primitive in
 *  `github.ts` keeps the wide union for forward compatibility.
 *
 *  SIG-216 follow-up (founder feedback on PR #176, 2026-05-25): the
 *  Check run signals EXECUTION HEALTH ("did the bot run?"), not
 *  findings count. Industry advisory-bot convention (CodeRabbit,
 *  Greptile) is `success` regardless of findings; review state lives
 *  in the GitHub native review object (APPROVE / COMMENT /
 *  REQUEST_CHANGES). Mapping in `completeCheckRun`:
 *    - `success` → wire `success` (green check, bot ran cleanly)
 *    - `failure` → wire `neutral` (bot errored, ambiguous; reserve
 *      wire `failure` for future opt-in P0 gates)
 *    - `skipped` → wire `neutral` (bot couldn't review — legit
 *      ambiguous state, e.g. stale head). */
export type SigilixCheckConclusion = "success" | "failure" | "skipped"

interface InProgressCheckRun {
  id: number
  client: GitHubClient
  owner: string
  repo: string
}

interface CreateArgs {
  env: Env
  owner: string
  repo: string
  headSha: string
  installationId: number
}

/**
 * Create an `in_progress` check run on the PR's head commit and
 * return a handle the dispatcher can later complete. Returns `null`
 * if the App is missing credentials, if creation 403s (missing
 * `checks: write`), or if any other error fires — the caller treats
 * a null handle as "no check to update."
 */
export async function startInProgressCheckRun(args: CreateArgs): Promise<InProgressCheckRun | null> {
  const { env, owner, repo, headSha, installationId } = args

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-skip-missing-creds",
      owner, repo, head_sha: headSha, installation_id: installationId,
    }))
    return null
  }

  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })

    // Cancel stale Sigilix-named in-progress checks before creating
    // the new one. Two scenarios this handles:
    //   1. Rename-deploy switchovers (founder caught this on PR #80
    //      — "Sigilix Review" check from the prior deploy stayed
    //      in-progress alongside the new "Sigilix" check).
    //   2. Queue retries that re-enter dispatchJob for the same
    //      (PR, headSha) — first run's check is still in_progress
    //      when the retry tries to create another.
    // Best-effort: a failure here logs + continues to the create.
    await cancelStaleInProgressChecks({ client, owner, repo, headSha })

    const created = await client.createCheckRun(owner, repo, {
      name: CHECK_RUN_NAME,
      headSha,
      status: "in_progress",
      startedAt: new Date().toISOString(),
      output: {
        title: "Reviewing this PR…",
        summary: "Sigilix is analyzing the changes. The full review will post as a PR comment when ready.",
      },
    })
    console.log(JSON.stringify({
      event: "pr-review-check-run-created",
      owner, repo, head_sha: headSha, installation_id: installationId,
      check_run_id: created.id,
    }))
    return { id: created.id, client, owner, repo }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-create-failed",
      owner, repo, head_sha: headSha, installation_id: installationId,
      err: err instanceof Error ? err.message : String(err),
    }))
    return null
  }
}

/**
 * ARC-276: payload threaded from the dispatcher's posted-path so the
 * Check Run title can render the customer-visible verdict (Approved
 * vs N findings). Only meaningful when `conclusion === "success"`
 * and a review was actually posted.
 *
 * ARC-279: `surface` is set to `"comment"` when the ensemble had to
 * route through the synth-body-as-PR-comment fallback (the formal
 * review submit was silently rejected by GitHub). The dispatcher
 * maps that to a `failure` conclusion + a "see PR comment" title
 * so the customer knows the normal review pipeline didn't run even
 * though they have a comment to read.
 *
 * ARC-280 follow-up: `surface === "skip-notice"` is set when the
 * ensemble couldn't generate a verdict (router_no_specialists /
 * specialists_all_failed / synth retry exhausted / internal_error)
 * and posted a minimal "Sigilix couldn't review" comment. The
 * dispatcher maps `errored + surface=skip-notice` to `failure`
 * with a distinct "Couldn't review — see PR comment" title so the
 * customer knows the review didn't run AND can find the explanation
 * comment.
 */
export interface ReviewCheckMeta {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  findingsCount: number
  surface?: "review" | "comment" | "skip-notice"
  /**
   * @deprecated SIG-216 — `completeCheckRun` no longer posts these.
   * GitHub renders the annotation `message` field as plain text,
   * which butchers our markdown finding bodies. The field stays on
   * the interface for back-compat with the producer in
   * `triage-pr-review-ensemble.ts`; the consumer drops it. Remove
   * once the producer stops threading it.
   */
  checkAnnotations?: CheckRunAnnotation[]
  /**
   * SIG-216: PR number used to build the `[View review]` link in
   * the Check run summary. Optional so legacy callers without the
   * PR number in scope still get a sensible (link-less) summary.
   */
  prNumber?: number
}

interface CompleteArgs {
  handle: InProgressCheckRun | null
  conclusion: SigilixCheckConclusion
  /** ARC-276: optional; populated by the dispatcher on posted runs. */
  reviewMeta?: ReviewCheckMeta
}

/**
 * Transition the check run from `in_progress` to `completed` with
 * the given conclusion. No-op when handle is null (creation failed
 * or was skipped). Output copy is derived from the conclusion +
 * (when present) the review verdict, so the customer-visible
 * title differentiates "Approved — no issues found" from "3
 * findings posted" rather than a generic "Review posted."
 */
export async function completeCheckRun(args: CompleteArgs): Promise<void> {
  const { handle, conclusion, reviewMeta } = args
  if (handle === null) return
  const output = renderOutputForConclusion(conclusion, reviewMeta, {
    owner: handle.owner,
    repo: handle.repo,
  })
  // SIG-216 follow-up (founder feedback on PR #176, 2026-05-25):
  // Kimi K2.6 (UI design authority) confirmed industry convention —
  // the Check run signals EXECUTION HEALTH, not findings count.
  // CodeRabbit + Greptile both emit `success` regardless of findings;
  // review state lives in the GitHub native review object
  // (APPROVE / COMMENT / REQUEST_CHANGES). Reserve `neutral` for
  // skips/errors (ambiguous "did the bot run?" state). Reserve wire
  // `failure` for future opt-in P0 gates.
  const wireConclusion: "success" | "neutral" =
    conclusion === "success" ? "success"
    : conclusion === "failure" ? "neutral"  // errored — ambiguous, not failing the check
    : "neutral"                              // skipped — legit ambiguous
  try {
    await handle.client.updateCheckRun(handle.owner, handle.repo, handle.id, {
      status: "completed",
      conclusion: wireConclusion,
      completedAt: new Date().toISOString(),
      output,
    })
    console.log(JSON.stringify({
      event: "pr-review-check-run-completed",
      owner: handle.owner, repo: handle.repo,
      check_run_id: handle.id, conclusion: wireConclusion,
      internal_conclusion: conclusion,
    }))
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-complete-failed",
      owner: handle.owner, repo: handle.repo,
      check_run_id: handle.id, conclusion: wireConclusion,
      internal_conclusion: conclusion,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }

  // SIG-216: Check annotations are NOT posted. GitHub renders the
  // annotation `message` field as plain text, so our markdown
  // finding bodies (with <details>, **bold**, badge <img> tags)
  // dump literally with raw HTML visible. Findings live in the PR
  // review thread; the Check summary links there. The annotation
  // batching loop that previously ran here was removed for SIG-216.
}

/**
 * ARC-258: cancel any Sigilix-named in-progress check runs on this
 * head_sha BEFORE creating a new one. Idempotent — safe to call on
 * every dispatcher entry; returns 0-cancellation early if no stale
 * checks are found. Best-effort throughout: list/PATCH failures
 * log + return without touching the underlying review pipeline.
 *
 * GitHub's Check Runs API does NOT dedupe by name — each
 * `POST /check-runs` creates a new row. Without this cleanup, every
 * queue retry + every name-rename deploy + every concurrent
 * dispatcher run would stack another in-progress row on the PR.
 */
async function cancelStaleInProgressChecks(args: {
  client: GitHubClient
  owner: string
  repo: string
  headSha: string
}): Promise<void> {
  const { client, owner, repo, headSha } = args
  let existing: Array<{ id: number; name: string; status: string }>
  try {
    existing = await client.listCheckRunsForRef(owner, repo, headSha)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-list-failed",
      owner, repo, head_sha: headSha,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }
  const stale = existing.filter((r) =>
    KNOWN_CHECK_NAMES.has(r.name) && (r.status === "in_progress" || r.status === "queued"),
  )
  if (stale.length === 0) return
  for (const run of stale) {
    try {
      await client.updateCheckRun(owner, repo, run.id, {
        status: "completed",
        conclusion: "cancelled",
        completedAt: new Date().toISOString(),
        output: {
          title: "Cancelled (superseded)",
          summary: "A newer Sigilix review run started for this commit and replaced this check.",
        },
      })
      console.log(JSON.stringify({
        event: "pr-review-check-run-cancelled-stale",
        owner, repo, head_sha: headSha,
        check_run_id: run.id, name: run.name,
      }))
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-review-check-run-cancel-stale-failed",
        owner, repo, head_sha: headSha,
        check_run_id: run.id, name: run.name,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
}

/**
 * Exported for direct unit tests of the title/summary mapping.
 * The dispatcher calls `completeCheckRun` which wraps this, but the
 * pure mapping is the contract that ARC-276 codifies.
 *
 * SIG-216: the success-path summary is now the Greptile-direction
 * one-liner "N suggestion(s) · [View review](pr-url)". The PR URL
 * is built from `repoCoords` + `reviewMeta.prNumber`; legacy
 * callers without those fields get a link-less variant. The verbose
 * "open the conversation tab and check annotations" copy was
 * removed — annotations are no longer posted.
 */
export function renderOutputForConclusion(
  conclusion: SigilixCheckConclusion,
  reviewMeta?: ReviewCheckMeta,
  repoCoords?: { owner: string; repo: string },
): { title: string; summary: string } {
  const prReviewUrl = buildPrReviewUrl(repoCoords, reviewMeta?.prNumber)
  switch (conclusion) {
    case "success":
      // ARC-276 + SIG-216: when the dispatcher threads `reviewMeta`,
      // the Check Run title reflects the verdict directly. The
      // summary collapses to a single line pointing at the PR
      // conversation tab.
      if (reviewMeta) {
        if (reviewMeta.event === "APPROVE") {
          return {
            title: "Approved — no issues found",
            summary: buildApprovedSummary(prReviewUrl),
          }
        }
        const n = reviewMeta.findingsCount
        const noun = n === 1 ? "finding" : "findings"
        const title = reviewMeta.event === "COMMENT"
          ? `${n} non-blocking ${noun} posted`
          : `${n} ${noun} — changes requested`
        return {
          title,
          summary: buildFindingsSummary(n, prReviewUrl),
        }
      }
      return {
        title: "Review posted",
        summary: buildLegacyPostedSummary(prReviewUrl),
      }
    case "skipped":
      return {
        title: "Review skipped (stale head)",
        summary: "A newer commit was pushed before this review finished. Sigilix will re-review the latest head automatically.",
      }
    case "failure":
      // ARC-279: the dispatcher maps `surface === "comment"` to
      // `failure` so the customer sees that the normal review
      // pipeline didn't run — but the comment fallback DID post
      // synth's body. Title points them at the PR comment so they
      // don't think the bot was entirely silent.
      if (reviewMeta?.surface === "comment") {
        return {
          title: "Couldn't post review — see PR comment",
          summary: "GitHub silently rejected Sigilix's formal review submit. Sigilix posted the review content as a regular PR comment instead so the signal isn't lost. Re-run `/sigilix review` to try the formal review again.",
        }
      }
      // ARC-280 follow-up: `surface === "skip-notice"` means the
      // ensemble couldn't even generate a verdict (no specialist
      // ran or synth fully failed after retry) and posted a
      // minimal "couldn't review" comment instead. Different
      // title so log analysis can distinguish.
      if (reviewMeta?.surface === "skip-notice") {
        return {
          title: "Couldn't review — see PR comment",
          summary: "Sigilix couldn't generate a review for this PR (specialists failed, synth couldn't run, or an internal error fired). A short PR comment explains which path bailed. Re-run `/sigilix review` to try again.",
        }
      }
      return {
        title: "Review failed",
        summary: "Sigilix encountered an error while reviewing this PR. Re-trigger with `/sigilix review` or contact support.",
      }
  }
}

/**
 * SIG-216: build the canonical GitHub PR URL used in the Check run
 * summary's `[View review]` link. Returns `null` when owner/repo or
 * PR number are missing (legacy callers) so the caller can render a
 * link-less fallback.
 */
function buildPrReviewUrl(
  repoCoords: { owner: string; repo: string } | undefined,
  prNumber: number | undefined,
): string | null {
  if (!repoCoords || typeof prNumber !== "number" || !Number.isFinite(prNumber)) {
    return null
  }
  return `https://github.com/${repoCoords.owner}/${repoCoords.repo}/pull/${prNumber}`
}

/**
 * SIG-216: Greptile-direction one-liner for the approve-only path.
 * "Sigilix approved · [View PR](url)" when we can link, plain text
 * otherwise.
 */
function buildApprovedSummary(prReviewUrl: string | null): string {
  return prReviewUrl
    ? `Sigilix approved · [View PR](${prReviewUrl})`
    : "Sigilix approved"
}

/**
 * SIG-216: Greptile-direction one-liner for the findings-posted
 * path. "N suggestion(s) · [View review](url)" when we can link,
 * plain text otherwise.
 */
function buildFindingsSummary(findingsCount: number, prReviewUrl: string | null): string {
  const noun = findingsCount === 1 ? "suggestion" : "suggestions"
  const head = `${findingsCount} ${noun}`
  return prReviewUrl ? `${head} · [View review](${prReviewUrl})` : head
}

/**
 * SIG-216: legacy "we don't know the verdict" path (no reviewMeta).
 * Avoids fabricating a misleading "0 suggestions" line; instead
 * emits a neutral pointer at the PR.
 */
function buildLegacyPostedSummary(prReviewUrl: string | null): string {
  return prReviewUrl
    ? `Sigilix posted a review · [View review](${prReviewUrl})`
    : "Sigilix posted a review"
}
