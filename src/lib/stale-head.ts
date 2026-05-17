// ARC-250: surface stale-head drops as a user-visible signal.
//
// Three pr-review pipeline guards return silently when the PR head SHA
// moves between job-queue-time and job-process-time:
//   - `triage-pr-review.ts` Phase 3 guard
//   - `triage-pr-review-ensemble.ts` guard #1 (before fanout)
//   - `triage-pr-review-ensemble.ts` guard #2 (after model call,
//     before GitHub submit)
//
// Before this module, all three logged a one-line `console.log` at most.
// From the customer's view that's zero output: GitHub showed a webhook
// delivery, no review ever posted, no obvious cause. Tonight's rubberfit
// PR #237 merged with zero Sigilix reviews because every webhook hit the
// guard while the queue was backed up.
//
// This helper provides two things:
//   1. A structured `pr-review-stale-head` log event on every guard hit
//      so operators can tail logs to see what's going on.
//   2. A sticky comment on the PR (upsert-by-marker — Codex MAJOR on the
//      design review, agreed with by Kimi) so the customer learns the
//      head moved and can `/sigilix review` or push to retry.
//
// ARC-251 (the requeue half) extends this helper in a follow-up commit:
// it adds a depth-capped re-enqueue path so most stale-head cases
// auto-recover without ever reaching the sticky comment. Until that
// commit lands, every guard hit posts/updates the sticky.

import type { Env } from "../index"
import { GitHubClient } from "./github"
import { getInstallationToken } from "./github-app"

export const STALE_HEAD_MARKER = "<!-- sigilix:stale-head-skipped -->"

export type StaleHeadGuardSource =
  | "phase3"
  | "ensemble-before-fanout"
  | "ensemble-after-review"

export interface HandleStaleHeadArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
  /** SHA the job was queued against. */
  queuedHeadSha: string
  /** SHA we observed live on the PR when the guard fired. */
  currentHeadSha: string
  source: StaleHeadGuardSource
}

export type StaleHeadOutcome =
  | { posted: "created"; commentId: number }
  | { posted: "updated"; commentId: number }
  | { posted: "failed"; reason: string }

/**
 * Emit a structured stale-head telemetry event and upsert a sticky
 * comment so the customer knows the PR head moved during review.
 *
 * Caller responsibilities (not this helper's):
 *   - Returning the appropriate "stale_head" status to the dispatcher
 *     so the Phase 3 fallback short-circuits.
 *   - (ARC-251) Re-enqueuing against the current head when retry
 *     budget remains.
 *
 * Trade-off: if GitHub App credentials are missing, the helper still
 * emits structured telemetry but cannot post the sticky comment — the
 * customer sees nothing on the PR (same as the pre-ARC-250 silent
 * skip). Returning `{posted: "failed", reason}` rather than throwing
 * is deliberate: we don't want a misconfigured env to drop the queue
 * message and trigger Cloudflare Queue retries on every stale-head.
 */
export async function handleStaleHead(args: HandleStaleHeadArgs): Promise<StaleHeadOutcome> {
  const { env, owner, repo, prNumber, installationId, queuedHeadSha, currentHeadSha, source } = args

  console.log(JSON.stringify({
    event: "pr-review-stale-head",
    guard_source: source,
    owner,
    repo,
    pr_number: prNumber,
    installation_id: installationId,
    queued_head_sha: queuedHeadSha,
    current_head_sha: currentHeadSha,
  }))

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    // No creds = no comment. Telemetry already emitted above; treat as
    // a soft failure rather than throwing — the silent-skip we're
    // replacing was equally invisible, and we don't want a misconfigured
    // env to drop the queue message and trigger queue retries.
    const reason = "missing_github_app_credentials"
    console.error(JSON.stringify({
      event: "pr-review-stale-head-comment-failed",
      reason,
      owner, repo, pr_number: prNumber, installation_id: installationId, guard_source: source,
    }))
    return { posted: "failed", reason }
  }

  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    const body = renderStaleHeadComment({
      queuedHeadSha,
      currentHeadSha,
    })

    const existing = await findExistingStaleHeadComment(client, owner, repo, prNumber)
    if (existing !== null) {
      await client.updateIssueComment(owner, repo, existing, body)
      console.log(JSON.stringify({
        event: "pr-review-stale-head-comment-updated",
        owner, repo, pr_number: prNumber, installation_id: installationId, comment_id: existing, guard_source: source,
      }))
      return { posted: "updated", commentId: existing }
    }

    const created = await client.createIssueComment(owner, repo, prNumber, body)
    console.log(JSON.stringify({
      event: "pr-review-stale-head-comment-created",
      owner, repo, pr_number: prNumber, installation_id: installationId, comment_id: created.id, guard_source: source,
    }))
    return { posted: "created", commentId: created.id }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      event: "pr-review-stale-head-comment-failed",
      reason,
      owner, repo, pr_number: prNumber, installation_id: installationId, guard_source: source,
    }))
    return { posted: "failed", reason }
  }
}

export function renderStaleHeadComment(args: {
  queuedHeadSha: string
  currentHeadSha: string
}): string {
  const queued = args.queuedHeadSha.slice(0, 7)
  const current = args.currentHeadSha.slice(0, 7)
  return [
    STALE_HEAD_MARKER,
    "",
    "**Sigilix skipped this review** — the PR head moved while the job was processing.",
    "",
    `Queued head: \`${queued}\` · Current head: \`${current}\``,
    "",
    "Push another commit or comment `/sigilix review` to request a fresh review against the current head.",
  ].join("\n")
}

async function findExistingStaleHeadComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const items = await client.listIssueComments(owner, repo, prNumber)
  const hit = items.find((c) => typeof c.body === "string" && c.body.includes(STALE_HEAD_MARKER))
  return hit ? hit.id : null
}
