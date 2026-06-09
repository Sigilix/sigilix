// SIG-156: one-time (operator-triggered) backfill that indexes every repo of
// every GitHub App installation. Fixes the gap where installs predating
// OPENCLAW_INDEXER_ENABLED=on never bootstrapped (and push won't bootstrap a
// repo with no manifest). Idempotent: the consumer freshness-skips repos that
// already have a current manifest, so re-running is safe.

import type { Env } from "../shared/types/env"
import { listAppInstallationIds, listInstallationRepoFullNames } from "./github-app"
import { enqueueIndexJobsForRepos } from "./index-producer"

export interface BackfillSummary {
  installations: number
  repos: number
  enqueued: number
  sensitiveSkipped: number
  perRepoFailed: number
  dryRun: boolean
  /** true if any installation/repo enumeration was partial (GitHub error or
   *  the MAX_PAGES cap) — coverage may be incomplete; re-run to be sure. */
  enumerationIncomplete: boolean
}

/**
 * Enumerate all installations → their repos → enqueue an index-repo job each
 * (reason "manual"). `dryRun` counts what WOULD be enqueued without sending.
 * Per-installation/per-repo failures are fail-soft (logged, counted) so one
 * bad installation can't abort the whole fan-out.
 */
export async function runIndexBackfill(
  env: Env,
  opts: { dryRun: boolean },
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    installations: 0,
    repos: 0,
    enqueued: 0,
    sensitiveSkipped: 0,
    perRepoFailed: 0,
    dryRun: opts.dryRun,
    enumerationIncomplete: false,
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return summary

  const installs = await listAppInstallationIds(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY)
  summary.installations = installs.items.length
  if (!installs.complete) summary.enumerationIncomplete = true

  for (const installationId of installs.items) {
    const repos = await listInstallationRepoFullNames(
      env.OPENCLAW_STATE,
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      installationId,
    )
    if (!repos.complete) summary.enumerationIncomplete = true
    summary.repos += repos.items.length
    if (opts.dryRun || repos.items.length === 0) continue

    try {
      const res = await enqueueIndexJobsForRepos({
        env,
        installationId,
        repositories: repos.items.map((full_name) => ({ full_name })),
        reason: "manual",
      })
      summary.enqueued += res.succeeded
      summary.sensitiveSkipped += res.sensitiveSkipped
      summary.perRepoFailed += res.perRepoFailed
    } catch (err) {
      // Preserve per-installation fail-soft: an unexpected throw on one
      // installation's fan-out (queue binding broken, etc.) must not abort
      // the whole backfill. Flag coverage as incomplete so the operator
      // re-runs.
      console.warn(JSON.stringify({
        event: "index-backfill-enqueue-error",
        installation_id: installationId,
        error: err instanceof Error ? err.message : String(err),
      }))
      summary.enumerationIncomplete = true
    }
  }

  console.log(JSON.stringify({ event: "index-backfill-complete", ...summary }))
  return summary
}
