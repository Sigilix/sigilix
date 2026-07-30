// History-ingest queue consumers: the one-time leased BACKFILL and the cheap
// per-merged-PR incremental upsert.
//
// The founder's model: ingest a repo's history ONCE on install (commit messages +
// the humans' own PR review discussion), then keep it current per merged PR. The
// backfill is the biggest embed job in the system, so it runs under the D1 lease
// (history-ingest-lease.ts) — sharded, resumable from a cursor, run-until-complete
// — never the KV run-once pattern (see migration 0039's header for the full why).
//
// COST SHAPE, honestly: one backfill ≈ up to 300 merged PRs × ~5–15 docs ≈ low
// thousands of embeds ≈ single dollars per repo, ONCE. The per-merge upsert is a
// handful of embeds per merged PR. The failure mode that actually costs money is
// UNBOUNDED REPETITION, which the lease exists to prevent.

import type { Env } from "@/src/shared/types/env"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { GitHubClient } from "@/src/shared/adapters/github"
import {
  historyCorpusEnabled,
  isHistoryDocWorthEmbedding,
  upsertHistoryDoc,
  type HistoryDoc,
} from "@/src/lib/history-corpus"
import {
  advanceHistoryLease,
  claimHistoryLease,
  completeHistoryLease,
  expireHistoryLease,
  renewHistoryLease,
} from "@/src/lib/history-ingest-lease"

/** How far back the one-time backfill reaches. The Search API is bounded at ~1000
 *  results regardless; HISTORY_BACKFILL_MAX_PRS is the real ceiling. */
const HISTORY_BACKFILL_DAYS = 365
const HISTORY_BACKFILL_MAX_PRS = 300
/** PRs per queue invocation. Small enough that a shard finishes well inside the
 *  lease window; large enough that a 300-PR repo completes in ~12 invocations. */
const SHARD_PRS = 25
/** Bound a pathological PR (bot spam, 400-comment threads) — the cap is LOGGED. */
const MAX_DOCS_PER_PR = 60

export interface HistoryIngestJob {
  op: "backfill" | "pr-upsert"
  owner: string
  repo: string
  installationId: number
  /** pr-upsert only. */
  prNumber?: number
  /** backfill only: bypass an already-complete lease (operator re-index). */
  force?: boolean
  /** backfill CONTINUATION only: the shard chain's lease token. A continuation
   *  RENEWS (it already owns the run); re-claiming would find its own live lease,
   *  be denied, ack, and stall the run forever. */
  leaseToken?: string
}

function buildGithubClient(env: Env, installationId: number): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("history-ingest: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  return getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
}

/** Collect one PR's history docs: its commits' messages + the human discussion. */
async function collectPrHistoryDocs(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<HistoryDoc[]> {
  const [commits, reviewComments, reviews] = await Promise.all([
    client.getPullRequestCommits(owner, repo, prNumber),
    client.listPullRequestReviewComments(owner, repo, prNumber),
    client.listPullRequestReviews(owner, repo, prNumber),
  ])
  const docs: HistoryDoc[] = []
  for (const c of commits) {
    docs.push({
      owner,
      repo,
      kind: "commit",
      sourceId: c.sha,
      ref: c.sha.slice(0, 7),
      text: c.message,
      prNumber,
    })
  }
  for (const rc of reviewComments) {
    docs.push({
      owner,
      repo,
      kind: "review-comment",
      sourceId: String(rc.id),
      ref: `#${prNumber} ${rc.path}`,
      text: rc.body,
      prNumber,
    })
  }
  for (const r of reviews) {
    docs.push({
      owner,
      repo,
      kind: "review",
      sourceId: String(r.id),
      ref: `#${prNumber}`,
      text: r.body,
      prNumber,
    })
  }
  const worth = docs.filter(isHistoryDocWorthEmbedding)
  if (worth.length > MAX_DOCS_PER_PR) {
    console.log(
      JSON.stringify({
        event: "history-pr-docs-capped",
        owner,
        repo,
        prNumber,
        docs: worth.length,
        cap: MAX_DOCS_PER_PR,
      }),
    )
    return worth.slice(0, MAX_DOCS_PER_PR)
  }
  return worth
}

export async function handleHistoryIngest(env: Env, job: HistoryIngestJob, nowMs: number): Promise<void> {
  if (!historyCorpusEnabled(env)) return // dark — producers are also gated; consumer is the backstop
  if (job.op === "pr-upsert") return handlePrUpsert(env, job)
  return handleBackfill(env, job, nowMs)
}

/** One merged PR, incrementally. No lease: bounded, cheap, and idempotent (doc ids
 *  are immutable GitHub ids, so a queue-retry overwrite duplicates nothing). A
 *  failure THROWS so the queue retries — never a silent hole. */
async function handlePrUpsert(env: Env, job: HistoryIngestJob): Promise<void> {
  const prNumber = job.prNumber
  if (typeof prNumber !== "number") return
  const token = await buildGithubClient(env, job.installationId)
  const client = new GitHubClient({ token })
  const docs = await collectPrHistoryDocs(client, job.owner, job.repo, prNumber)
  let failed = 0
  for (const doc of docs) {
    if (!(await upsertHistoryDoc(env, doc))) failed += 1
  }
  if (failed > 0) {
    // upsertHistoryDoc swallows embed errors and returns false — surface them here
    // so the retry re-runs the PR (the found:N/upserted:0-marked-complete lesson).
    throw new Error(`history-pr-upsert: ${failed}/${docs.length} doc upserts failed for #${prNumber}`)
  }
  console.log(
    JSON.stringify({
      event: "history-pr-upsert-complete",
      owner: job.owner,
      repo: job.repo,
      prNumber,
      docs: docs.length,
    }),
  )
}

/**
 * One SHARD of the leased backfill. Claims (or resumes) the lease, processes up to
 * SHARD_PRS merged PRs from the cursor, persists progress, and re-enqueues itself
 * until done. Every failure path expires the lease first (keeping the cursor) so
 * the queue's immediate retry RESUMES rather than seeing a live lease and acking
 * the run into oblivion.
 *
 * Honest limitation: the merged-PR list is re-queried per shard, so a PR that
 * merges MID-backfill can shift the ordering slightly — a duplicate is a free-ish
 * overwrite (immutable doc ids) and a skipped one is covered by the per-merge
 * upsert hook from install time onward. The cursor does not need to be perfect;
 * it needs to be monotonic.
 */
async function handleBackfill(env: Env, job: HistoryIngestJob, nowMs: number): Promise<void> {
  let claim: { leaseToken: string; cursor: number; docsDone: number }
  if (job.leaseToken) {
    // Continuation shard: we already own the run — renew, don't re-claim.
    const renewed = await renewHistoryLease(env, {
      owner: job.owner,
      repo: job.repo,
      leaseToken: job.leaseToken,
      nowMs,
    })
    if (!renewed.ok) return // lease moved on — the successor owns the continuation
    claim = { leaseToken: job.leaseToken, cursor: renewed.cursor, docsDone: renewed.docsDone }
  } else {
    const claimed = await claimHistoryLease(env, {
      owner: job.owner,
      repo: job.repo,
      installationId: job.installationId,
      nowMs,
      ...(job.force !== undefined ? { force: job.force } : {}),
    })
    if (!claimed.ok) {
      console.log(
        JSON.stringify({ event: "history-backfill-skipped", owner: job.owner, repo: job.repo, reason: claimed.reason }),
      )
      return
    }
    claim = claimed
  }

  try {
    const token = await buildGithubClient(env, job.installationId)
    const client = new GitHubClient({ token })
    const sinceDate = new Date(nowMs - HISTORY_BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const prs = await client.searchMergedPullRequests(job.owner, job.repo, sinceDate, {
      maxItems: HISTORY_BACKFILL_MAX_PRS,
    })

    const shard = prs.slice(claim.cursor, claim.cursor + SHARD_PRS)
    let upserted = 0
    let failed = 0
    for (const pr of shard) {
      const docs = await collectPrHistoryDocs(client, job.owner, job.repo, pr.number)
      for (const doc of docs) {
        if (await upsertHistoryDoc(env, doc)) upserted += 1
        else failed += 1
      }
    }
    if (failed > 0) {
      // Do NOT advance the cursor past a lossy shard. Expire (keeping the cursor)
      // and throw: the retry resumes this same shard. Idempotent ids make the
      // partial re-run an overwrite, bounded by one shard.
      throw new Error(`history-backfill: ${failed} doc upserts failed in shard at cursor ${claim.cursor}`)
    }

    const nextCursor = claim.cursor + shard.length
    const docsDone = claim.docsDone + upserted
    const advanced = await advanceHistoryLease(env, {
      owner: job.owner,
      repo: job.repo,
      leaseToken: claim.leaseToken,
      cursor: nextCursor,
      docsDone,
      nowMs: Date.now(),
    })
    if (!advanced.ok) return // lease lost to a successor — it owns the continuation
    // The advance ROTATED the token; everything after this point (continuation
    // enqueue, completion, the catch's expire) must use the new one.
    claim.leaseToken = advanced.nextToken

    if (nextCursor < prs.length) {
      await env.OPENCLAW_JOBS.send({
        type: "history-ingest",
        op: "backfill",
        owner: job.owner,
        repo: job.repo,
        installationId: job.installationId,
        leaseToken: claim.leaseToken,
      })
      return
    }

    await completeHistoryLease(env, {
      owner: job.owner,
      repo: job.repo,
      leaseToken: claim.leaseToken,
      docsDone,
      nowMs: Date.now(),
    })
    console.log(
      JSON.stringify({
        event: "history-backfill-complete",
        owner: job.owner,
        repo: job.repo,
        prs: prs.length,
        docs: docsDone,
        truncated: prs.length >= HISTORY_BACKFILL_MAX_PRS,
      }),
    )
  } catch (error) {
    // Expire-not-delete: the cursor survives, the immediate retry resumes.
    await expireHistoryLease(env, { owner: job.owner, repo: job.repo, leaseToken: claim.leaseToken })
    throw error
  }
}
