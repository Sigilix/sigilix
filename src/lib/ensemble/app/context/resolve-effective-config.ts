// sig-dashboard-review-config: resolve the EFFECTIVE per-PR config by merging the
// committed `sigilix.json` with the portal's server-persisted dashboard config.
//
// PRECEDENCE (highest wins): committed file > repo dashboard > org dashboard >
// built-in defaults. Config-as-code wins outright per field (the standard model);
// where a repo commits no file, the dashboard config now actually applies.
//
// RECALL-SAFETY: the dashboard layers use a separate, statically closed contract
// and are converted to `SigilixConfig` BEFORE the merge. That contract has no
// suppression-capable fields, so a dashboard setting can never drop a file, PR,
// scanner, category, or finding and silence a P0/P1 — that power stays with the
// committed file (see dashboard.ts + merge.ts for the full rationale).

import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import { loadSigilixConfigWithVisibleParseError } from "@/src/lib/sigilix-config-error-comment"
import { resolveDashboardConfigLayers } from "@/src/lib/review-config-store"
import { dashboardReviewConfigToSigilixConfig, mergeSigilixConfigLayers } from "@/src/shared/domain/config/merge"
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
    dashboardLayers.org ? dashboardReviewConfigToSigilixConfig(dashboardLayers.org) : null,
    dashboardLayers.repo ? dashboardReviewConfigToSigilixConfig(dashboardLayers.repo) : null,
    committedConfig,
  )
}
