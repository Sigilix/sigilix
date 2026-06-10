// SIG-44 — queue consumers that POPULATE the multi-corpus namespaces:
//   - corpus-pr-upsert     one merged PR  → embed + upsert into pr:<ns>
//   - corpus-pr-backfill   onboarding     → last 90d merged PRs (Search API)
//   - corpus-issue-upsert  Linear issue   → embed + upsert into issue:<ns>
//
// All three are best-effort enrichment: a failure logs and the queue retries,
// but it never blocks code indexing or PR review. They run only when
// OPENCLAW_MULTICORPUS_RETRIEVAL is "on" (the webhook producers gate on the
// flag before enqueueing, so the consumers trust that gate).

import type { Env } from "@/src/shared/types/env"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { GitHubClient } from "@/src/shared/adapters/github"
import { readReviewManifest } from "./review-manifest"
import { buildLinearAuth, LinearClient } from "./linear"
import { listTeamRepoMappings } from "@/src/shared/adapters/github/github-installation"
import {
  upsertPrDoc,
  upsertIssueDoc,
  deriveVerdictLabel,
  type PrCorpusDoc,
} from "./multi-corpus"

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
  const verdict = manifest.kind === "ok"
    ? deriveVerdictLabel(manifest.manifest.findings)
    : undefined
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
export async function handleCorpusPrBackfill(
  env: Env,
  job: CorpusPrBackfillJob,
  nowMs: number,
): Promise<void> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    // Mirrors the indexer's guard — no GitHub App creds means no
    // installation token, so the Search-API backfill can't run. Throw so
    // the queue retries once creds are provisioned rather than silently
    // skipping the corpus.
    throw new Error("corpus-pr-backfill: GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
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
    const verdict = manifest.kind === "ok"
      ? deriveVerdictLabel(manifest.manifest.findings)
      : undefined
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
  console.log(JSON.stringify({
    event: "multicorpus-pr-backfill-complete",
    owner: job.owner, repo: job.repo,
    sinceDate, found: prs.length, upserted,
    truncated: prs.length >= BACKFILL_MAX_PRS,
  }))
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------
// corpus-issue-upsert — one Linear issue
// ---------------------------------------------------------------------

export interface CorpusIssueUpsertJob {
  linearIssueId: string
}

/**
 * Fetch a Linear issue, map its team to a GitHub repo via
 * OPENCLAW_TEAM_GITHUB_REPO_MAP, and embed+upsert it into that repo's
 * `issue:` namespace. No-ops (logs) when the issue's team isn't mapped to a
 * repo — multi-corpus issue indexing only applies to Linear-linked repos.
 */
export async function handleCorpusIssueUpsert(env: Env, job: CorpusIssueUpsertJob): Promise<void> {
  const linear = new LinearClient(await buildLinearAuth(env))
  const issue = await linear.getIssue(job.linearIssueId)
  if (!issue) {
    console.warn(JSON.stringify({ event: "multicorpus-issue-not-found", id: job.linearIssueId }))
    return
  }
  const mapping = listTeamRepoMappings(env.OPENCLAW_TEAM_GITHUB_REPO_MAP)
    .find((m) => m.teamKey === issue.team.key)
  if (!mapping) {
    console.log(JSON.stringify({
      event: "multicorpus-issue-team-unmapped",
      identifier: issue.identifier, teamKey: issue.team.key,
    }))
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
