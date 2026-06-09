// ARC-258 follow-up — unified warmup + overview sticky.
//
// Historical context (ARC-236 + initial ARC-258 attempt):
// Sigilix used to post TWO separate sticky comments on PRs when the
// indexer hadn't yet produced a manifest:
//   1. `<!-- sigilix:warmup -->` standalone "warming up" sticky from
//      `postWarmupStickyIfUnindexed` (called at the head of every
//      `pr-review` dispatch).
//   2. `<!-- sigilix:pr-overview -->` overview sticky from
//      `handlePrOverview` (called on PR opened/synchronize).
//
// Founder caught the redundancy on PR #80: two stickies stacked at
// the top of every PR for new installs, and CodeRabbit (the
// inspiration) renders its equivalent as ONE comment that morphs
// through states. The current model:
//   * The pr-overview comment is the SOLE sticky.
//   * When `repo-index-manifest:<repo>` is absent, the overview body
//     gets a top "Sigilix is warming up its index for this repo"
//     callout block carrying `WARMUP_CALLOUT_MARKER`.
//   * When indexing completes (`enqueueWarmupRerunsForIndex` below),
//     we fan out BOTH a `pr-review-rerun` (so the customer gets a
//     codebase-aware review) AND a `pr-overview` refresh (so the
//     callout is dropped from the body).
//   * The legacy `<!-- sigilix:warmup -->` standalone sticky is
//     one-way migrated → deleted on the next overview render via
//     `deleteLegacyWarmupStickyIfPresent` in triage-pr-overview.ts.
//
// All operations remain best-effort: a KV/GitHub blip can't take
// down the review pipeline. Telemetry events flow regardless.

import type { Env } from "../shared/types/env"
import type { JobMessage } from "../shared/types/job"
import { GitHubClient } from "../shared/adapters/github"

/**
 * Marker for the LEGACY standalone warmup sticky. Kept exported so
 * the overview helper can find + delete any straggler on PRs that
 * pre-date the unification. Do NOT post new comments with this
 * marker — the overview comment now carries the warmup state.
 */
export const LEGACY_WARMUP_MARKER = "<!-- sigilix:warmup -->"

/**
 * Marker INSIDE the pr-overview body when the warmup callout block
 * is rendered. Used here at fan-out time to detect which open PRs
 * have an overview that still claims "warming up" and need their
 * rerun fired post-indexing. Overview helper emits this string into
 * the callout block when manifest is absent.
 */
export const WARMUP_CALLOUT_MARKER = "<!-- sigilix:warmup-callout -->"

// ---------------------------------------------------------------------
// Index-job-completed: fan out reruns for PRs that warmed up
// ---------------------------------------------------------------------

/**
 * After an `index-repo` job's final shard writes the manifest, scan
 * open PRs in the repo and enqueue:
 *
 *   - a `pr-review-rerun` for each PR whose overview body shows the
 *     warmup callout (or legacy standalone sticky — backward-compat
 *     during migration). The customer gets a fresh codebase-aware
 *     review automatically.
 *   - a `pr-overview` for the same PRs so the overview re-renders
 *     with `warmup === "none"` and the callout disappears.
 *
 * Called from `handleIndexRepoJob`'s success path with an
 * already-built client to avoid a second installation-token mint.
 *
 * Returns the enqueue count for telemetry. Best-effort throughout:
 * any failure logs + continues, never throws (indexer's queue
 * handler would otherwise retry the entire index job).
 */
export async function enqueueWarmupRerunsForIndex(args: {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  installationId: number
  /** Stable per-run id from the indexer (matches the manifest's
   *  runId). Used for the queue-retry dedupe breadcrumb so that a
   *  redelivered `index-repo` message can't fan out reruns twice. */
  runId: string
}): Promise<{ enqueued: number; scanned: number; skipped?: "already-fanned-out" }> {
  const { env, client, owner, repo, installationId, runId } = args

  // code-reviewer M4 catch on PR #80: the index-repo queue handler
  // retries on failure (max_retries=3). If `persistManifest` succeeded
  // but a transient error caused redelivery, this fan-out would run
  // a second time → every warmup PR would get a duplicate
  // `pr-review-rerun` queued → duplicate review on the same head.
  // KV breadcrumb keyed by `runId` makes the fan-out idempotent.
  const ranKey = `warmup-fanout-ran:${owner.toLowerCase()}/${repo.toLowerCase()}:${runId}`
  try {
    const already = await env.OPENCLAW_STATE.get(ranKey)
    if (already !== null) {
      console.log(JSON.stringify({
        event: "pr-review-warmup-rerun-fanout-already-ran",
        owner, repo, installation_id: installationId, run_id: runId,
      }))
      return { enqueued: 0, scanned: 0, skipped: "already-fanned-out" }
    }
  } catch (err) {
    // code-reviewer H1 catch on the M4 fix: indexer.ts treats this
    // helper as best-effort. A KV read failure here must NOT throw
    // up the stack (would fail the index-repo queue handler →
    // retry → re-embed the entire repo). Log + continue with the
    // fan-out; double-fanout on a transient KV blip is strictly
    // less bad than re-embedding 1k files.
    console.warn(JSON.stringify({
      event: "pr-review-warmup-rerun-fanout-dedupe-read-failed",
      owner, repo, installation_id: installationId, run_id: runId,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
  // Write the breadcrumb BEFORE the fan-out so a fail-mid-fanout
  // doesn't trigger a full re-fanout — the rerun handler is idempotent
  // on its own (content-addressed dedupe via the existing pr-review
  // path), and double-running a few enqueues on a retry is cheaper
  // than the full N-PR double-review. KV put failure is non-fatal
  // for the same reason as the read above.
  try {
    await env.OPENCLAW_STATE.put(ranKey, String(Date.now()), {
      expirationTtl: 7 * 24 * 60 * 60, // 7 days — long enough to outlive queue retry budgets
    })
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-warmup-rerun-fanout-dedupe-write-failed",
      owner, repo, installation_id: installationId, run_id: runId,
      err: err instanceof Error ? err.message : String(err),
    }))
  }

  let openPrs: Array<{ number: number; head: { sha: string } }>
  try {
    openPrs = await client.listOpenPullRequests(owner, repo)
  } catch (err) {
    console.error(JSON.stringify({
      event: "pr-review-warmup-rerun-list-failed",
      owner, repo, installation_id: installationId,
      err: err instanceof Error ? err.message : String(err),
    }))
    return { enqueued: 0, scanned: 0 }
  }

  let enqueued = 0
  for (const pr of openPrs) {
    if (typeof pr.number !== "number") continue
    let needsRerun = false
    try {
      needsRerun = await prHasWarmupState(client, owner, repo, pr.number)
    } catch (err) {
      // List-issue-comments failure for one PR shouldn't abort the
      // whole fan-out. Log + skip + continue.
      console.warn(JSON.stringify({
        event: "pr-review-warmup-rerun-check-failed",
        owner, repo, pr_number: pr.number,
        err: err instanceof Error ? err.message : String(err),
      }))
      continue
    }
    if (!needsRerun) continue

    // Enqueue both the rerun (refreshes the code review with
    // retrieval) AND the overview refresh (drops the warmup
    // callout from the unified sticky). Both are best-effort; one
    // failing doesn't block the other.
    const headSha = pr.head?.sha
    try {
      // code-reviewer M1 catch on PR #80: silent=true so the rerun
      // handler skips the slash-command ack comment. The customer
      // didn't type `/sigilix review` — these reruns are automatic
      // post-indexing and shouldn't generate unsolicited noise on
      // every open PR.
      const reviewMessage: JobMessage = {
        type: "pr-review-rerun",
        owner, repo, prNumber: pr.number, installationId,
        silent: true,
      }
      await env.OPENCLAW_JOBS.send(reviewMessage)
      enqueued += 1
      console.log(JSON.stringify({
        event: "pr-review-warmup-rerun-enqueued",
        owner, repo, pr_number: pr.number, installation_id: installationId,
      }))
    } catch (err) {
      console.error(JSON.stringify({
        event: "pr-review-warmup-rerun-enqueue-failed",
        owner, repo, pr_number: pr.number, installation_id: installationId,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
    // The overview refresh requires headSha; PRs without one are
    // skipped silently — they'd fail downstream anyway when the
    // overview handler couldn't compute its dedupe key.
    if (typeof headSha === "string" && headSha.length > 0) {
      try {
        const overviewMessage: JobMessage = {
          type: "pr-overview",
          owner, repo, prNumber: pr.number, headSha, installationId,
        }
        await env.OPENCLAW_JOBS.send(overviewMessage)
        console.log(JSON.stringify({
          event: "pr-overview-warmup-refresh-enqueued",
          owner, repo, pr_number: pr.number, installation_id: installationId,
          head_sha: headSha.slice(0, 7),
        }))
      } catch (err) {
        console.error(JSON.stringify({
          event: "pr-overview-warmup-refresh-enqueue-failed",
          owner, repo, pr_number: pr.number, installation_id: installationId,
          err: err instanceof Error ? err.message : String(err),
        }))
      }
    }
  }
  console.log(JSON.stringify({
    event: "pr-review-warmup-rerun-fanout-done",
    owner, repo, installation_id: installationId,
    scanned: openPrs.length, enqueued,
  }))
  return { enqueued, scanned: openPrs.length }
}

/**
 * True if any comment on this PR carries either the new warmup
 * callout marker (inside the overview body) or the legacy standalone
 * sticky marker (pre-unification PRs). Either signal means this PR
 * was opened against an un-indexed repo and should get the rerun
 * fan-out when indexing finishes.
 */
async function prHasWarmupState(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  const items = await client.listIssueComments(owner, repo, prNumber)
  return items.some(
    (c) => typeof c.body === "string" && (
      c.body.includes(WARMUP_CALLOUT_MARKER) || c.body.includes(LEGACY_WARMUP_MARKER)
    ),
  )
}
