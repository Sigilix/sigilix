// SIG-156 PR3: periodic reconciliation. Enumerate every installation +
// every repo it grants access to, and enqueue an index-repo job for each
// repo that has NO manifest in KV. Catches dropped install / repos-added
// webhooks (the gap that left every install dark in SIG-156 PR1/PR2).
//
// Why "missing manifest only" rather than "stale-vs-current-head":
// staleness is the push webhook's job (every merge re-indexes). The cron
// only needs to plug the gap where an install/repos-added webhook was
// dropped, which leaves the repo with NO manifest at all. Comparing
// against the current head SHA would require a GitHub API call per repo
// and add no value over the push path.
//
// Idempotent + safe to run hourly: the consumer freshness-skips repos
// whose manifest was written between the cron's read and the job pickup.

import type { Env } from "../index"
import { listAppInstallationIds, listInstallationRepoFullNames } from "./github-app"
import { enqueueIndexJobsForRepos } from "./index-producer"
import { readRepoIndexManifest } from "./repo-index-manifest"

export interface ReconciliationSummary {
  installations: number
  reposChecked: number
  /** Repos whose manifest KV read returned `missing` or `invalid`. */
  reposMissingManifest: number
  enqueued: number
  sensitiveSkipped: number
  perRepoFailed: number
  dryRun: boolean
  /**
   * true if enumeration was partial OR any per-repo manifest read threw.
   * Operator should re-run / check telemetry for the affected installation.
   */
  enumerationIncomplete: boolean
}

export async function runIndexReconciliation(
  env: Env,
  opts: { dryRun: boolean },
): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    installations: 0,
    reposChecked: 0,
    reposMissingManifest: 0,
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
    summary.reposChecked += repos.items.length

    const missing: { full_name: string }[] = []
    for (const fullName of repos.items) {
      const slash = fullName.indexOf("/")
      if (slash <= 0 || slash === fullName.length - 1) {
        // Defensive: an `o/r` slug from GitHub should always parse, but
        // we trust the upstream listing minimally and skip + log junk.
        console.warn(JSON.stringify({
          event: "index-reconcile-skip-invalid-fullname",
          installation_id: installationId,
          full_name: fullName,
        }))
        continue
      }
      const owner = fullName.slice(0, slash)
      const repo = fullName.slice(slash + 1)
      let result
      try {
        result = await readRepoIndexManifest(env, owner, repo)
      } catch (err) {
        // KV read transient. Skipping (NOT enqueueing) avoids spamming
        // jobs for repos that may already be fresh; flag incomplete so
        // the next tick retries the read.
        console.warn(JSON.stringify({
          event: "index-reconcile-manifest-read-error",
          installation_id: installationId,
          owner,
          repo,
          error: err instanceof Error ? err.message : String(err),
        }))
        summary.enumerationIncomplete = true
        continue
      }
      if (result.kind === "ok") continue
      // missing OR invalid → re-index. invalid implies corrupt KV value
      // (json-parse, shape, wrong-version); re-index regenerates a clean v1.
      summary.reposMissingManifest += 1
      missing.push({ full_name: fullName })
    }

    if (opts.dryRun || missing.length === 0) continue

    try {
      const res = await enqueueIndexJobsForRepos({
        env,
        installationId,
        repositories: missing,
        reason: "manual",
      })
      summary.enqueued += res.succeeded
      summary.sensitiveSkipped += res.sensitiveSkipped
      summary.perRepoFailed += res.perRepoFailed
    } catch (err) {
      // Match backfill semantics: per-installation throw is fail-soft.
      console.warn(JSON.stringify({
        event: "index-reconcile-enqueue-error",
        installation_id: installationId,
        error: err instanceof Error ? err.message : String(err),
      }))
      summary.enumerationIncomplete = true
    }
  }

  console.log(JSON.stringify({ event: "index-reconcile-complete", ...summary }))
  return summary
}
