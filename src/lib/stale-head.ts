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
import { enqueuePrReviewJob } from "../do/webhook-enqueue"

export const STALE_HEAD_MARKER = "<!-- sigilix:stale-head-skipped -->"

/**
 * ARC-251: hard cap on auto-requeue depth for stale-head events.
 * With depth=0 being the original webhook-driven attempt, MAX=2 means
 * at most 3 swings at the PR head before falling through to the
 * sticky comment. Calibrated for cost: each requeue can run a full
 * ensemble (4 specialists), so MAX=3 (4 attempts) is too much spend
 * on a thrashing PR; MAX=1 is too brittle for the after-review guard.
 *
 * The cap counts ONLY stale-head-driven retries — it is independent
 * of DO `maxRetries` (which bounds infrastructure/consumer retries).
 */
export const MAX_STALE_HEAD_REQUEUES = 2

export type StaleHeadGuardSource =
  | "phase3"
  | "ensemble-before-fanout"
  | "ensemble-after-review"
  | "ensemble-after-inline-overview"

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
  /**
   * PR base.sha from the same `getPullRequest` call that surfaced the
   * stale head. Required to re-enqueue against the live SHA — the
   * webhook-enqueue path passes this through to the DO. May be null
   * when the GitHub API response omits base (rare; handled by treating
   * as no-baseSha on the requeue).
   */
  baseSha: string | null
  /**
   * Current attempt's requeue depth. 0 = original webhook-driven
   * attempt; 1+ = a previous stale-head requeue. The helper compares
   * against MAX_STALE_HEAD_REQUEUES to decide between requeue and
   * fall-through to sticky.
   */
  depth: number
  source: StaleHeadGuardSource
  /**
   * SIG-247 Phase 1: immutable repo.id threaded from EnsembleHandlerArgs.
   * Forwarded to `enqueuePrReviewJob` on the auto-requeue path so the
   * fresh attempt preserves dual-write semantics. Absent on legacy
   * call sites that haven't been updated; the requeue then falls back
   * to legacy-only review-memory lookups.
   */
  repoId?: number
}

export type StaleHeadOutcome =
  | { posted: "created"; commentId: number }
  | { posted: "updated"; commentId: number }
  | { posted: "failed"; reason: string }
  | { requeued: true; newHeadSha: string; nextDepth: number }

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
  const { env, owner, repo, prNumber, installationId, queuedHeadSha, currentHeadSha, baseSha, depth, source, repoId } = args

  console.log(JSON.stringify({
    event: "pr-review-stale-head",
    guard_source: source,
    owner,
    repo,
    pr_number: prNumber,
    installation_id: installationId,
    queued_head_sha: queuedHeadSha,
    current_head_sha: currentHeadSha,
    depth,
  }))

  // ARC-251: auto-requeue against the live head when retry budget
  // remains. Each requeue increments depth by 1. After MAX swings we
  // fall through to the sticky comment so the customer learns to
  // push or run `/sigilix review`. The requeue uses the same
  // `enqueuePrReviewJob` the webhook handler uses, so DO mode (post)
  // exercises the supersede path and legacy mode (off/shadow) just
  // sends a new queue message — both paths are dedupe-safe because
  // dedupe keys are per-SHA.
  //
  // CodeRabbit catch (phase-end): on requeue FAILURE (non-ok result
  // or thrown), we MUST NOT return early — the dispatcher treats this
  // as `stale_head` and acks the job, so a silent early-return would
  // reintroduce the exact silent-drop bug ARC-250 was meant to fix.
  // Fall through to the sticky-comment path instead so the customer
  // still gets a user-visible signal.
  if (depth < MAX_STALE_HEAD_REQUEUES) {
    try {
      const result = await enqueuePrReviewJob(env, {
        owner,
        repo,
        prNumber,
        headSha: currentHeadSha,
        baseSha,
        installationId,
        deliveryId: null, // not a webhook delivery
        staleHeadRequeueDepth: depth + 1,
        // SIG-247 Phase 1: thread the repo.id through the auto-requeue
        // path so the fresh attempt preserves dual-write keyspace.
        ...(repoId !== undefined ? { repoId } : {}),
      })
      if (result.ok) {
        console.log(JSON.stringify({
          event: "pr-review-stale-head-requeued",
          owner, repo, pr_number: prNumber, installation_id: installationId,
          guard_source: source,
          queued_head_sha: queuedHeadSha,
          new_head_sha: currentHeadSha,
          next_depth: depth + 1,
          route: result.route,
        }))
        return { requeued: true, newHeadSha: currentHeadSha, nextDepth: depth + 1 }
      }
      // result.ok === false → fall through to sticky.
      const reason = `enqueue_${result.reason}${result.status ? `_${result.status}` : ""}`
      console.error(JSON.stringify({
        event: "pr-review-stale-head-requeue-failed",
        reason,
        owner, repo, pr_number: prNumber, installation_id: installationId,
        guard_source: source, depth,
      }))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(JSON.stringify({
        event: "pr-review-stale-head-requeue-failed",
        reason,
        owner, repo, pr_number: prNumber, installation_id: installationId,
        guard_source: source, depth,
      }))
      // fall through to sticky
    }
  }

  // Reached when either:
  //   (a) depth >= MAX_STALE_HEAD_REQUEUES — retry budget exhausted, or
  //   (b) depth <  MAX but the requeue itself failed (non-ok / thrown).
  // Either way the customer needs a visible signal that Sigilix gave
  // up so they can push or `/sigilix review` to recover.
  console.log(JSON.stringify({
    event: "pr-review-stale-head-fallthrough",
    owner, repo, pr_number: prNumber, installation_id: installationId,
    guard_source: source, depth,
    cap: MAX_STALE_HEAD_REQUEUES,
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
