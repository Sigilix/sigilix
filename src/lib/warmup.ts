// ARC-236 — cold-start warmup UX for the customer-ready indexing pipeline.
//
// When a customer installs Sigilix on a fresh repo, the install
// webhook enqueues an `index-repo` job (ARC-234) that walks the tree
// + chunks + embeds + upserts (ARC-235). That takes seconds to
// minutes depending on repo size. If a PR webhook fires for the
// repo BEFORE indexing completes, the ensemble's `retrieve_codebase`
// returns zero chunks and the review degrades to diff-only with no
// signal to the customer.
//
// This module surfaces that race + closes it:
//   * `postWarmupStickyIfUnindexed` — at PR-review entry, check
//     `repo-index-manifest:<repo>`; if missing, post a sticky comment
//     telling the customer indexing is in flight. The review still
//     proceeds (degraded but real).
//   * `enqueueWarmupRerunsForIndex` — at index-job completion, list
//     open PRs on the repo, filter to those carrying the warmup
//     sticky, and enqueue a `pr-review-rerun` for each. The
//     customer gets a fresh codebase-aware review automatically.
//   * `updateWarmupStickyToReady` — after a successful review POST,
//     update the sticky comment to "Index ready — see the full
//     review below" so the customer knows the upgrade landed.
//
// All three are best-effort: a KV/GitHub blip can't take down the
// review pipeline. Telemetry events flow regardless.

import type { Env, JobMessage } from "../index"
import { GitHubClient } from "./github"
import { getInstallationToken } from "./github-app"
import { readRepoIndexManifest } from "./repo-index-manifest"

export const WARMUP_MARKER = "<!-- sigilix:warmup -->"

const WARMUP_BODY_PENDING = [
  WARMUP_MARKER,
  "",
  "**Sigilix is warming up its index for this repo.**",
  "",
  "This first review uses only the diff — cross-file context isn't available yet because indexing is still running. As soon as it completes, Sigilix will automatically re-review this PR with full codebase-aware retrieval.",
].join("\n")

const WARMUP_BODY_READY = [
  WARMUP_MARKER,
  "",
  "**Index ready — see the full review below.**",
  "",
  "Sigilix has finished indexing this repo and re-reviewed this PR with full codebase-aware retrieval. The diff-only review above is superseded.",
].join("\n")

// ---------------------------------------------------------------------
// Entry-time: post sticky if repo isn't indexed yet
// ---------------------------------------------------------------------

export interface PostWarmupStickyArgs {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
}

export type WarmupStickyOutcome =
  | { posted: "created"; commentId: number }
  | { posted: "updated"; commentId: number }
  | { skipped: "already-indexed" }
  | { skipped: "missing-creds" }
  | { failed: string }

/**
 * Check whether the repo is indexed (per `repo-index-manifest:<repo>`).
 * If not, post / upsert the warmup sticky. Returns the outcome so
 * callers can include it in telemetry, but the PR-review pipeline
 * proceeds either way — a missing index just means the review will
 * be diff-only.
 */
export async function postWarmupStickyIfUnindexed(
  args: PostWarmupStickyArgs,
): Promise<WarmupStickyOutcome> {
  const { env, owner, repo, prNumber, installationId } = args

  const manifest = await readRepoIndexManifest(env, repo)
  if (manifest.kind === "ok") {
    return { skipped: "already-indexed" }
  }

  console.log(JSON.stringify({
    event: "pr-review-warmup-detected",
    owner, repo, pr_number: prNumber, installation_id: installationId,
    manifest_kind: manifest.kind,
  }))

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error(JSON.stringify({
      event: "pr-review-warmup-skip-missing-creds",
      owner, repo, pr_number: prNumber, installation_id: installationId,
    }))
    return { skipped: "missing-creds" }
  }

  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    const existing = await findWarmupComment(client, owner, repo, prNumber)
    if (existing !== null) {
      // Already posted — refresh to the pending body in case the
      // previous run had replaced it with the "ready" copy (e.g.,
      // rerun fired but ran against a stale index that's since been
      // invalidated). Idempotent upsert.
      await client.updateIssueComment(owner, repo, existing, WARMUP_BODY_PENDING)
      console.log(JSON.stringify({
        event: "pr-review-warmup-posted",
        owner, repo, pr_number: prNumber, installation_id: installationId,
        action: "updated", comment_id: existing,
      }))
      return { posted: "updated", commentId: existing }
    }
    const created = await client.createIssueComment(owner, repo, prNumber, WARMUP_BODY_PENDING)
    console.log(JSON.stringify({
      event: "pr-review-warmup-posted",
      owner, repo, pr_number: prNumber, installation_id: installationId,
      action: "created", comment_id: created.id,
    }))
    return { posted: "created", commentId: created.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      event: "pr-review-warmup-post-failed",
      owner, repo, pr_number: prNumber, installation_id: installationId,
      err: message,
    }))
    return { failed: message }
  }
}

// ---------------------------------------------------------------------
// Exit-time: update sticky to "ready" after a successful review post
// ---------------------------------------------------------------------

export type UpdateWarmupOutcome =
  | { updated: true; commentId: number }
  | { skipped: "no-sticky" }
  | { skipped: "not-yet-indexed" }
  | { skipped: "missing-creds" }
  | { failed: string }

/**
 * Best-effort update of the warmup sticky to the "ready" body after a
 * review has been posted. Only flips when the manifest now exists
 * (indexing has completed) — otherwise the review just posted was
 * diff-only and the sticky should stay in "warming up" state. Also
 * no-ops when the sticky doesn't exist (typical: PR opened after
 * indexing already completed). Called from the review pipelines'
 * success paths.
 */
export async function updateWarmupStickyToReady(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
}): Promise<UpdateWarmupOutcome> {
  const { env, owner, repo, prNumber, installationId } = args
  // Gate on manifest existence. If we're still in the warmup
  // window, the review just posted was diff-only — don't tell the
  // customer indexing is ready.
  const manifest = await readRepoIndexManifest(env, repo)
  if (manifest.kind !== "ok") {
    return { skipped: "not-yet-indexed" }
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return { skipped: "missing-creds" }
  }
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    const existing = await findWarmupComment(client, owner, repo, prNumber)
    if (existing === null) {
      return { skipped: "no-sticky" }
    }
    await client.updateIssueComment(owner, repo, existing, WARMUP_BODY_READY)
    console.log(JSON.stringify({
      event: "pr-review-warmup-completed",
      owner, repo, pr_number: prNumber, installation_id: installationId,
      comment_id: existing,
    }))
    return { updated: true, commentId: existing }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      event: "pr-review-warmup-update-failed",
      owner, repo, pr_number: prNumber, installation_id: installationId,
      err: message,
    }))
    return { failed: message }
  }
}

// ---------------------------------------------------------------------
// Index-job-completed: fan out reruns for PRs that warmed up
// ---------------------------------------------------------------------

/**
 * After an `index-repo` job's final shard writes the manifest, scan
 * open PRs in the repo and enqueue a `pr-review-rerun` for each PR
 * that has a warmup sticky. Returns the enqueue count for telemetry.
 *
 * Called from `handleIndexRepoJob`'s success path with an
 * already-built client to avoid a second installation-token mint.
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

  let openPrs: Array<{ number: number }>
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
    let hasSticky = false
    try {
      hasSticky = await prHasWarmupSticky(client, owner, repo, pr.number)
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
    if (!hasSticky) continue
    try {
      // code-reviewer M1 catch on PR #80: silent=true so the rerun
      // handler skips the slash-command ack comment. The customer
      // didn't type `/sigilix review` — these reruns are automatic
      // post-indexing and shouldn't generate unsolicited noise on
      // every open PR.
      const message: JobMessage = {
        type: "pr-review-rerun",
        owner, repo, prNumber: pr.number, installationId,
        silent: true,
      }
      await env.OPENCLAW_JOBS.send(message)
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
  }
  console.log(JSON.stringify({
    event: "pr-review-warmup-rerun-fanout-done",
    owner, repo, installation_id: installationId,
    scanned: openPrs.length, enqueued,
  }))
  return { enqueued, scanned: openPrs.length }
}

// ---------------------------------------------------------------------
// Shared comment-scan helper
// ---------------------------------------------------------------------

async function findWarmupComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const items = await client.listIssueComments(owner, repo, prNumber)
  const hit = items.find((c) => typeof c.body === "string" && c.body.includes(WARMUP_MARKER))
  return hit ? hit.id : null
}

async function prHasWarmupSticky(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  return (await findWarmupComment(client, owner, repo, prNumber)) !== null
}
