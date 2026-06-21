// SIG-304 (review CLI) Phase 1b — the headless OVERVIEW driver. Runs the
// PR-overview pass in dry-run (no posting) via the SIG-304 seam and returns the
// verdict (summary + file table + mermaid sequence diagram) for the rich render.
// Mirrors run-review-in-node.ts: a local Env (no Cloudflare bindings) + an
// injected PAT GitHubClient + `dryRun: true`.
//
// The overview model defaults to glm-5.1:cloud (Ollama); set OPENCLAW_MODEL to
// override and supply the matching key (OLLAMA_API_KEY by default) via env.

import { handlePrOverview, type PrOverviewVerdict } from "@/src/lib/triage-pr-overview"
import { GitHubClient } from "@/src/shared/adapters/github"
import { createLocalEnv } from "@/src/cli/adapters/local-env"

export interface RunOverviewInNodeArgs {
  owner: string
  repo: string
  prNumber: number
  /** A GitHub token (PAT / `gh auth token`) used ONLY to read the PR + diff. */
  githubToken: string
  /** Env source for model keys + flags (BYO models). Defaults to `process.env`. */
  processEnv?: Record<string, string | undefined>
}

/**
 * Run the PR-overview pass headless and return its verdict WITHOUT posting.
 * Returns null when the pass produced nothing (parse failure / skipped). Throws
 * if the head SHA can't be resolved. The rich render shows the real mermaid
 * diagram + summary + file table from this.
 */
export async function runOverviewInNode(args: RunOverviewInNodeArgs): Promise<PrOverviewVerdict | null> {
  // chatEnabled MUST be on so the overview model actually runs (never hardcode
  // "off" — that is a model kill-switch). BYO model keys ride in via processEnv.
  const env = createLocalEnv({
    processEnv: { ...(args.processEnv ?? process.env), OLLAMA_CHAT_ENABLE: "on" },
  })
  const client = new GitHubClient({ token: args.githubToken })
  const meta = await client.getPullRequest(args.owner, args.repo, args.prNumber)
  const headSha = meta.head?.sha
  if (!headSha) {
    throw new Error(`sigilix: could not resolve head SHA for ${args.owner}/${args.repo}#${args.prNumber}`)
  }
  const verdict = await handlePrOverview({
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha,
    installationId: 0, // unused: the injected client bypasses buildClient
    env,
    githubClient: client,
    dryRun: true,
  })
  return verdict ?? null
}
