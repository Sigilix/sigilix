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

import { GitHubClient } from "./github"
import { getInstallationToken } from "./github-app"
import type { Env } from "../index"

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
 *  `github.ts` keeps the wide union for forward compatibility. */
export type SigilixCheckConclusion = "neutral" | "failure" | "skipped"

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

interface CompleteArgs {
  handle: InProgressCheckRun | null
  conclusion: SigilixCheckConclusion
}

/**
 * Transition the check run from `in_progress` to `completed` with
 * the given conclusion. No-op when handle is null (creation failed
 * or was skipped). Output copy is derived from the conclusion so
 * the customer-visible title/summary stays consistent.
 */
export async function completeCheckRun(args: CompleteArgs): Promise<void> {
  const { handle, conclusion } = args
  if (handle === null) return
  const output = renderOutputForConclusion(conclusion)
  try {
    await handle.client.updateCheckRun(handle.owner, handle.repo, handle.id, {
      status: "completed",
      conclusion,
      completedAt: new Date().toISOString(),
      output,
    })
    console.log(JSON.stringify({
      event: "pr-review-check-run-completed",
      owner: handle.owner, repo: handle.repo,
      check_run_id: handle.id, conclusion,
    }))
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-complete-failed",
      owner: handle.owner, repo: handle.repo,
      check_run_id: handle.id, conclusion,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
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

function renderOutputForConclusion(conclusion: SigilixCheckConclusion): { title: string; summary: string } {
  switch (conclusion) {
    case "neutral":
      return {
        title: "Review posted",
        summary: "Sigilix posted a review on this PR. Open the conversation tab to view inline findings.",
      }
    case "skipped":
      return {
        title: "Review skipped (stale head)",
        summary: "A newer commit was pushed before this review finished. Sigilix will re-review the latest head automatically.",
      }
    case "failure":
      return {
        title: "Review failed",
        summary: "Sigilix encountered an error while reviewing this PR. Re-trigger with `/sigilix review` or contact support.",
      }
  }
}
