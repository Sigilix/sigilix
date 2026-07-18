// SIG-156 PR3: periodic reconciliation. Enumerate every installation +
// every repo it grants access to, and enqueue an index-repo job for each
// repo whose persisted index contract is incomplete. Catches dropped install /
// repos-added webhooks, citation-metadata migrations, active-index rollout
// gaps, and missing graph versions through one idempotent operator surface.
//
// SIG-155 extends the same reconciler to graph health: when graph indexing
// is enabled, a repo with a fresh vector manifest but no matching active
// graph version is also enqueued. That closes the rollout gap where vector
// indexing predated OPENCLAW_GRAPH_INDEX and the consumer's fresh-manifest
// skip prevented the graph from ever being built.
//
// Why not compare manifest headSha to the live default branch:
// staleness is the push webhook's job (every merge re-indexes). The cron
// only needs to plug dropped install / repos-added webhooks and graph
// rollout gaps. Comparing against the current head SHA would require a
// GitHub API call per repo and add no value over the push path.
//
// Idempotent + safe to run hourly: the consumer freshness-skips repos
// whose manifest was written between the cron's read and the job pickup.

import type { Env } from "@/src/shared/types/env"
import { listAppInstallationIds, listInstallationRepoFullNames } from "@/src/shared/adapters/github/github-app"
import { enqueueIndexJobsForRepos, parseFullName } from "./index-producer"
import { readRepoIndexManifest } from "./repo-index-manifest"
import { debugActiveGraphVersion } from "./repo-graph-client"
import { graphIndexEnabled } from "./graph-flags"
import { CITATION_CHUNK_VERSION } from "./chunk-core"
import { activeIndexAllowsFreshSkip, activeIndexModeForBootstrap } from "./indexer-active-index"
import type { RepoActiveIndexMode } from "./repo-active-index"

export interface ReconciliationSummary {
  installations: number
  reposChecked: number
  /** Repos whose manifest KV read returned `missing` or `invalid`. */
  reposMissingManifest: number
  /** Repos whose vector manifest exists but graph active version is missing/stale. */
  reposMissingGraph: number
  /** Repos whose vectors predate the current citation-verification splitter identity. */
  reposMissingCitationMetadata: number
  /** Repos without an exact active-index snapshot for the current writer mode. */
  reposMissingActiveIndex: number
  /** Repos that passed every manifest, citation, active-index, and graph check. */
  reposReady: number
  /** Graph active-version reads that failed and were treated as fail-soft. */
  graphReadErrors: number
  /** Active-index tenant-copy reads that failed and were treated as fail-soft. */
  activeIndexReadErrors: number
  /** Writer mode whose exact snapshot contract was checked. */
  activeIndexMode: RepoActiveIndexMode
  /** Whether the active-index writer's D1 dependency is available for this mode. */
  activeIndexAvailable: boolean
  /**
   * Codex review pass: `dryRun: true` short-circuits the per-installation
   * `enqueueIndexJobsForRepos` call, so `enqueued` / `sensitiveSkipped` /
   * `perRepoFailed` are always 0 in dry-run output by design. Read those
   * fields only on real runs; for dry-run, use the `reposMissing*` fields and
   * the fail-closed `ready` signal.
   */
  enqueued: number
  sensitiveSkipped: number
  perRepoFailed: number
  dryRun: boolean
  /**
   * true if enumeration was partial OR any per-repo manifest read threw.
   * Operator should re-run / check telemetry for the affected installation.
   */
  enumerationIncomplete: boolean
  /** Fail-closed rollout signal. Re-run dry-run until this is true before enabling strict reads. */
  ready: boolean
}

export async function runIndexReconciliation(env: Env, opts: { dryRun: boolean }): Promise<ReconciliationSummary> {
  const activeIndexMode = activeIndexModeForBootstrap(env, true)
  // Promotion readiness is deliberately stricter than shadow freshness.
  // Shadow's no-D1 fallback keeps legacy indexing available, but it cannot
  // prove that an active-index writer is provisioned for later strict reads.
  const activeIndexAvailable = activeIndexMode === "off" || env.SIGILIX_PLATFORM_DB !== undefined
  const summary: ReconciliationSummary = {
    installations: 0,
    reposChecked: 0,
    reposMissingManifest: 0,
    reposMissingGraph: 0,
    reposMissingCitationMetadata: 0,
    reposMissingActiveIndex: 0,
    reposReady: 0,
    graphReadErrors: 0,
    activeIndexReadErrors: 0,
    activeIndexMode,
    activeIndexAvailable,
    enqueued: 0,
    sensitiveSkipped: 0,
    perRepoFailed: 0,
    dryRun: opts.dryRun,
    enumerationIncomplete: false,
    ready: false,
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return summary

  const installs = await listAppInstallationIds(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY)
  summary.installations = installs.items.length
  if (!installs.complete) summary.enumerationIncomplete = true

  for (const installationId of installs.items) {
    // CodeRabbit review-pass: an upstream throw here (token refresh, GH 5xx,
    // timeout) used to abort the WHOLE reconciliation for every remaining
    // installation. Wrap fail-soft so one bad install can't poison the run.
    let repos: Awaited<ReturnType<typeof listInstallationRepoFullNames>>
    try {
      repos = await listInstallationRepoFullNames(
        env.OPENCLAW_STATE,
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        installationId,
      )
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "index-reconcile-repos-list-error",
          installation_id: installationId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      summary.enumerationIncomplete = true
      continue
    }
    if (!repos.complete) summary.enumerationIncomplete = true
    summary.reposChecked += repos.items.length

    const missing: { full_name: string }[] = []
    for (const fullName of repos.items) {
      // Codex review pass: delegate to the producer's parser so reconcile's
      // "is this enqueueable" decision matches what enqueueIndexJobsForRepos
      // will actually accept — otherwise dry-run can count repos as
      // `missing` that the producer would silently reject (false positive).
      const parsed = parseFullName({ full_name: fullName })
      if (parsed === null) {
        console.warn(
          JSON.stringify({
            event: "index-reconcile-skip-invalid-fullname",
            installation_id: installationId,
            full_name: fullName,
          }),
        )
        summary.enumerationIncomplete = true
        continue
      }
      const { owner, repo } = parsed
      let result
      try {
        result = await readRepoIndexManifest(env, owner, repo)
      } catch (err) {
        // KV read transient. Skipping (NOT enqueueing) avoids spamming
        // jobs for repos that may already be fresh; flag incomplete so
        // the next tick retries the read.
        console.warn(
          JSON.stringify({
            event: "index-reconcile-manifest-read-error",
            installation_id: installationId,
            owner,
            repo,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        summary.enumerationIncomplete = true
        continue
      }
      if (result.kind === "ok") {
        let repoNeedsReindex = false
        let repoCheckFailed = false
        if (result.manifest.citationChunkVersion !== CITATION_CHUNK_VERSION) {
          summary.reposMissingCitationMetadata += 1
          repoNeedsReindex = true
        }
        if (activeIndexMode !== "off") {
          if (!activeIndexAvailable) {
            summary.reposMissingActiveIndex += 1
            repoCheckFailed = true
          } else {
            const githubRepoId = result.manifest.githubRepoId
            if (typeof githubRepoId !== "number" || !Number.isSafeInteger(githubRepoId) || githubRepoId <= 0) {
              summary.reposMissingActiveIndex += 1
              repoNeedsReindex = true
            } else {
              try {
                const activeIndexReady = await activeIndexAllowsFreshSkip({
                  env,
                  mode: activeIndexMode,
                  isDefaultBranch: true,
                  githubRepoId,
                  manifest: result.manifest,
                })
                if (!activeIndexReady) {
                  summary.reposMissingActiveIndex += 1
                  repoNeedsReindex = true
                }
              } catch (err) {
                summary.activeIndexReadErrors += 1
                summary.enumerationIncomplete = true
                repoCheckFailed = true
                console.warn(
                  JSON.stringify({
                    event: "index-reconcile-active-index-read-error",
                    installation_id: installationId,
                    owner,
                    repo,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                )
              }
            }
          }
        }
        const graphStatus = await graphMissingForManifest(env, owner, repo, result.manifest.runId)
        if (graphStatus.readError) summary.graphReadErrors += 1
        if (graphStatus.missing) {
          summary.reposMissingGraph += 1
          repoNeedsReindex = true
        }
        if (graphStatus.readError) repoCheckFailed = true
        // A dependency read failure leaves the repair decision unproven. Do
        // not enqueue on a different known mismatch and create a retry storm;
        // the next reconciliation tick re-evaluates the whole repo contract.
        if (repoNeedsReindex && !repoCheckFailed) missing.push({ full_name: fullName })
        else if (!repoCheckFailed) summary.reposReady += 1
        continue
      }
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
      console.warn(
        JSON.stringify({
          event: "index-reconcile-enqueue-error",
          installation_id: installationId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      summary.enumerationIncomplete = true
    }
  }

  summary.ready =
    summary.installations > 0 &&
    summary.reposChecked > 0 &&
    summary.activeIndexAvailable &&
    !summary.enumerationIncomplete &&
    summary.reposMissingManifest === 0 &&
    summary.reposMissingGraph === 0 &&
    summary.reposMissingCitationMetadata === 0 &&
    summary.reposMissingActiveIndex === 0 &&
    summary.graphReadErrors === 0 &&
    summary.activeIndexReadErrors === 0 &&
    summary.sensitiveSkipped === 0 &&
    summary.perRepoFailed === 0 &&
    summary.reposReady === summary.reposChecked
  console.log(JSON.stringify({ event: "index-reconcile-complete", ...summary }))
  return summary
}

async function graphMissingForManifest(
  env: Env,
  owner: string,
  repo: string,
  runId: string,
): Promise<{ missing: boolean; readError: boolean }> {
  if (!graphIndexEnabled(env)) return { missing: false, readError: false }
  let activeGraphVersion: string | null = null
  try {
    activeGraphVersion = await debugActiveGraphVersion(env, owner, repo)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "index-reconcile-graph-read-error",
        owner,
        repo,
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return { missing: false, readError: true }
  }
  return { missing: activeGraphVersion !== runId, readError: false }
}
