// SIG-376 leaf (+ SIG-304): the GitHub-App client builder for the PR-overview
// pass, split out of triage-pr-overview.ts to keep that file under the
// 1,000-line budget. `handlePrOverview` calls this only when no client is
// injected (the SIG-304 CLI seam supplies a PAT-backed client directly).

import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

export async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be configured")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}
