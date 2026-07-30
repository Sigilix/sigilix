// SIG-44 — queue consumers that POPULATE the multi-corpus namespaces:
//   - corpus-pr-upsert     one merged PR  → embed + upsert into pr:<ns>
//   - corpus-pr-backfill   onboarding     → last 90d merged PRs (Search API)
//   - corpus-issue-upsert  Linear issue   → embed + upsert into issue:<ns>
//
// All three are best-effort enrichment: a failure logs and the queue retries,
// but it never blocks code indexing or PR review. They run only when
// OPENCLAW_MULTICORPUS_RETRIEVAL is "on" (the webhook producers gate on the
// flag before enqueueing, so the consumers trust that gate).

import {
  claimCorpusPrBackfill,
  markCorpusPrBackfillComplete,
  releaseCorpusPrBackfillClaim,
} from "@/src/lib/multi-corpus-backfill-guard"
import type { Env } from "@/src/shared/types/env"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { GitHubClient } from "@/src/shared/adapters/github"
import { readReviewManifest } from "./review-manifest"
import { buildLinearClient } from "./linear"
import { listTeamRepoMappings } from "@/src/shared/adapters/github/github-installation"
import { upsertPrDoc, upsertIssueDoc, deriveVerdictLabel, type PrCorpusDoc } from "./multi-corpus"
import {
  resolveLinearTeamBinding,
  teamIsSelected,
  getLinearConfig,
  type LinearTenantContext,
} from "@/src/features/linear-integration"

/** Default backfill window: 90 days of merged PRs (per SIG-44). */
const BACKFILL_DAYS = 90
/** Bound the backfill so a huge monorepo can't exhaust the Search API quota. */
const BACKFILL_MAX_PRS = 300

// ---------------------------------------------------------------------
// corpus-pr-upsert — one merged PR
// ---------------------------------------------------------------------

export interface CorpusPrUpsertJob {
  owner: string
  repo: string
  prNumber: number
  title: string
  body: string
}

/**
 * Embed + upsert a single merged PR into the `pr:` namespace, attaching the
 * verdict derived from its persisted review findings (undefined when the PR
 * merged without a Sigilix review). Reads the manifest from KV — no GitHub
 * round-trip needed since the merge webhook already carried title/body.
 */
export async function handleCorpusPrUpsert(env: Env, job: CorpusPrUpsertJob): Promise<void> {
  const manifest = await readReviewManifest(env, job.owner, job.repo, job.prNumber)
  const verdict = manifest.kind === "ok" ? deriveVerdictLabel(manifest.manifest.findings) : undefined
  const doc: PrCorpusDoc = {
    owner: job.owner,
    repo: job.repo,
    number: job.prNumber,
    title: job.title,
    body: job.body,
    ...(verdict !== undefined ? { verdict } : {}),
  }
  await upsertPrDoc(env, doc)
}

// ---------------------------------------------------------------------
// corpus-pr-backfill — 90-day merged-PR catch-up on repo onboarding
// ---------------------------------------------------------------------

export interface CorpusPrBackfillJob {
  owner: string
  repo: string
  installationId: number
  /** Override the 90-day window (YYYY-MM-DD). Mainly for tests. */
  sinceDate?: string
  /** Deliberately re-run a backfill that already completed (e.g. after an
   *  embedding-model migration). Bypasses the once-ever guard. */
  force?: boolean
}

/**
 * Backfill the `pr:` corpus with the repo's recently-merged PRs. Uses the
 * GitHub Search API (installation-scoped token) to enumerate PRs merged in the
 * last 90 days, then embeds+upserts each with its derived verdict. Bounded by
 * BACKFILL_MAX_PRS; logs how many it covered so a truncation is visible.
 *
 * `nowMs` is injected (not read from Date.now()) so the window is deterministic
 * in tests and the caller controls "now".
 */
export async function handleCorpusPrBackfill(env: Env, job: CorpusPrBackfillJob, nowMs: number): Promise<void> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    // Mirrors the indexer's guard — no GitHub App creds means no
    // installation token, so the Search-API backfill can't run. Throw so
    // the queue retries once creds are provisioned rather than silently
    // skipping the corpus.
    throw new Error("corpus-pr-backfill: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  // Once-ever guard FIRST — before any GitHub call and before any embed. The job is
  // enqueued from several ungated producers (installation.created,
  // installation_repositories.added, webhook redelivery, queue retry), so the
  // consumer is the only place that reliably sees every attempt.
  const claim = await claimCorpusPrBackfill(env, {
    owner: job.owner,
    repo: job.repo,
    nowMs,
    ...(job.force !== undefined ? { force: job.force } : {}),
  })
  if (!claim.ok) {
    console.log(
      JSON.stringify({
        event: "multicorpus-pr-backfill-skipped",
        owner: job.owner,
        repo: job.repo,
        reason: claim.reason,
        completedAtMs: claim.record.completedAtMs ?? null,
      }),
    )
    return
  }
  // Everything below runs under the claim. On ANY failure we release it before
  // rethrowing — otherwise the queue's immediate retries all see `in-flight`, ack
  // cleanly, and the backfill is lost forever (it only fires on install, so nothing
  // re-triggers it after the stale window).
  try {
    const sinceDate = job.sinceDate ?? isoDate(nowMs - BACKFILL_DAYS * 24 * 60 * 60 * 1000)
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId: job.installationId,
    })
    const client = new GitHubClient({ token })
    const prs = await client.searchMergedPullRequests(job.owner, job.repo, sinceDate, {
      maxItems: BACKFILL_MAX_PRS,
    })
    let upserted = 0
    for (const pr of prs) {
      const manifest = await readReviewManifest(env, job.owner, job.repo, pr.number)
      const verdict = manifest.kind === "ok" ? deriveVerdictLabel(manifest.manifest.findings) : undefined
      const ok = await upsertPrDoc(env, {
        owner: job.owner,
        repo: job.repo,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        ...(verdict !== undefined ? { verdict } : {}),
      })
      if (ok) upserted += 1
    }
    // ⚠️ upsertPrDoc SWALLOWS Workers AI / Vectorize failures and returns false, so a
    // transient AI outage yields found:300 / upserted:0 with no throw. Marking that
    // "complete" would suppress the backfill FOREVER — the corpus would be
    // permanently empty and nothing re-fires. Only a fully-successful pass earns the
    // completion marker; anything less releases so the queue's retry re-runs it.
    if (upserted < prs.length) {
      await releaseCorpusPrBackfillClaim(env, { owner: job.owner, repo: job.repo })
      console.warn(
        JSON.stringify({
          event: "multicorpus-pr-backfill-incomplete",
          owner: job.owner,
          repo: job.repo,
          found: prs.length,
          upserted,
        }),
      )
      throw new Error(`corpus-pr-backfill: ${prs.length - upserted}/${prs.length} PR upserts failed`)
    }
    await markCorpusPrBackfillComplete(env, {
      owner: job.owner,
      repo: job.repo,
      // A FRESH clock — `nowMs` is dispatch time, so reusing it made every record
      // claim the run took 0ms. That's the field you read during a cost incident.
      nowMs: Date.now(),
      startedAtMs: nowMs,
      found: prs.length,
      upserted,
    })
    console.log(
      JSON.stringify({
        event: "multicorpus-pr-backfill-complete",
        owner: job.owner,
        repo: job.repo,
        sinceDate,
        found: prs.length,
        upserted,
        truncated: prs.length >= BACKFILL_MAX_PRS,
      }),
    )
  } catch (error) {
    // Release so the queue's retry is a real retry, not a silent no-op.
    await releaseCorpusPrBackfillClaim(env, { owner: job.owner, repo: job.repo })
    throw error
  }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------
// corpus-issue-upsert — one Linear issue
// ---------------------------------------------------------------------

export interface CorpusIssueUpsertJob {
  linearIssueId: string
  tenant?: LinearTenantContext
}

/**
 * Fetch a Linear issue, map its team to a GitHub repo via
 * OPENCLAW_TEAM_GITHUB_REPO_MAP, and embed+upsert it into that repo's
 * `issue:` namespace. No-ops (logs) when the issue's team isn't mapped to a
 * repo — multi-corpus issue indexing only applies to Linear-linked repos.
 */
export async function handleCorpusIssueUpsert(env: Env, job: CorpusIssueUpsertJob): Promise<void> {
  const linear = await buildLinearClient(env, job.tenant)
  const issue = await linear.getIssue(job.linearIssueId)
  if (!issue) {
    console.warn(JSON.stringify({ event: "multicorpus-issue-not-found", id: job.linearIssueId }))
    return
  }
  let mapping: { owner: string; repo: string } | undefined
  if (job.tenant) {
    const [binding, config] = await Promise.all([
      resolveLinearTeamBinding(env, job.tenant.organizationId, issue.team.id),
      getLinearConfig(env, job.tenant.installationId),
    ])
    const parts = binding?.githubRepoFullName.split("/") ?? []
    if (
      binding &&
      config &&
      binding.installationId === job.tenant.installationId &&
      binding.accessState === "allowed" &&
      parts.length === 2 &&
      parts[0] &&
      parts[1] &&
      teamIsSelected(config, issue.team.id)
    ) {
      mapping = { owner: parts[0], repo: parts[1] }
    }
  } else {
    mapping = listTeamRepoMappings(env.OPENCLAW_TEAM_GITHUB_REPO_MAP).find((m) => m.teamKey === issue.team.key)
  }
  if (!mapping) {
    console.log(
      JSON.stringify({
        event: "multicorpus-issue-team-unmapped",
        identifier: issue.identifier,
        teamKey: issue.team.key,
      }),
    )
    return
  }
  await upsertIssueDoc(env, {
    owner: mapping.owner,
    repo: mapping.repo,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
  })
}
