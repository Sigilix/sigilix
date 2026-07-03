// sig-dashboard-review-config: resolve the EFFECTIVE per-PR config by merging the
// committed `sigilix.json` with the portal's server-persisted dashboard config.
//
// PRECEDENCE (highest wins): committed file > repo dashboard > org dashboard >
// built-in defaults. Config-as-code wins outright per field (the standard model);
// where a repo commits no file, the dashboard config now actually applies.
//
// RECALL-SAFETY: the dashboard layers pass through `dashboardRecallSafeSubset`
// (an allowlist of additive/shaping fields) BEFORE the merge, so a dashboard
// setting can shape judgment but can never drop a file, PR, scanner, or finding
// pre-severity and silence a P0/P1 — that power stays with the committed file
// (see merge.ts for the full rationale). With no dashboard config the merge is a
// no-op passthrough of the committed config → the committed path never regresses.

import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import { loadSigilixConfigWithVisibleParseError } from "@/src/lib/sigilix-config-error-comment"
import { resolveDashboardConfigLayers } from "@/src/lib/review-config-store"
import { mergeSigilixConfigLayers, dashboardRecallSafeSubset } from "@/src/shared/domain/config/merge"
import type { SigilixConfig } from "@/src/shared/domain/config/types"

export interface ResolveEffectiveConfigArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** GitHub App installation id; absent → no dashboard layer (committed + defaults). */
  installationId?: number
}

/**
 * Load the committed file (at head SHA, with the SIG-107 visible-parse-error
 * comment) AND the dashboard layers in parallel, then merge committed-wins.
 */
export async function resolveEffectiveSigilixConfig(a: ResolveEffectiveConfigArgs): Promise<SigilixConfig> {
  const { env, client, owner, repo, prNumber, headSha, installationId } = a
  const [committedConfig, dashboardLayers] = await Promise.all([
    loadSigilixConfigWithVisibleParseError({ env, client, owner, repo, prNumber, headSha }),
    resolveDashboardConfigLayers(env, installationId, owner, repo),
  ])
  return mergeSigilixConfigLayers(
    dashboardLayers.org ? dashboardRecallSafeSubset(dashboardLayers.org) : null,
    dashboardLayers.repo ? dashboardRecallSafeSubset(dashboardLayers.repo) : null,
    committedConfig,
  )
}
