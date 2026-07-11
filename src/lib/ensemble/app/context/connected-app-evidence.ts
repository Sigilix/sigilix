import { buildPrReviewMcpRuntime, collectPrReviewAppEvidence } from "@/src/features/pr-review-app-evidence"
import type { EnsembleHandlerArgs } from "@/src/lib/ensemble/app/orchestrator-types"
import type { GitHubClient } from "@/src/shared/adapters/github"

/** Start exact trusted-base connected-app reads before the expensive review
 * phases. The returned promise owns a shared 5s deadline and never rejects;
 * callers must route it only to deterministic overview rendering. */
export function startPrReviewConnectedAppEvidence(args: EnsembleHandlerArgs, client: GitHubClient, baseSha: string) {
  const { env, installationId, owner, repo, prNumber, headSha } = args
  return collectPrReviewAppEvidence({
    client,
    runtime: buildPrReviewMcpRuntime(env, `tenant:${installationId}`, `pr:${installationId}:${prNumber}:${headSha}`),
    owner,
    repo,
    baseSha,
    headSha,
  })
}
