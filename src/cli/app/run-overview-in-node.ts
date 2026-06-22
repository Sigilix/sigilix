// SIG-304 (review CLI) Phase 1b — the headless OVERVIEW driver. Runs the
// PR-overview pass in dry-run (no posting) via the SIG-304 seam and returns the
// verdict (summary + file table + mermaid sequence diagram) for the rich render.
// Mirrors run-review-in-node.ts: a local Env (no Cloudflare bindings) + an
// injected PAT GitHubClient + `dryRun: true`.
//
// The overview pass calls Ollama's `generate` directly (glm-5.1:cloud, structured
// output) — it is NOT on the OpenRouter provider router yet, so it needs
// OLLAMA_API_KEY. Without it the rich render degrades to review-only (cli-main
// skips the overview). Routing it through the provider router so --rich works on a
// BYO OpenRouter key is a follow-up (SIG-491). Override the model via OPENCLAW_MODEL.

import { handlePrOverview, type PrOverviewVerdict } from "@/src/lib/triage-pr-overview"
import { GitHubClient } from "@/src/shared/adapters/github"
import { createLocalEnv } from "@/src/cli/adapters/local-env"
import { localGitClient } from "@/src/cli/adapters/local-git-client"

export interface RunOverviewInNodeArgs {
  owner: string
  repo: string
  prNumber: number
  /** A GitHub token (PAT / `gh auth token`) to read the PR + diff. Required unless `git` is set. */
  githubToken?: string
  /** Local-git source (SIG-304): working tree (`--uncommitted`) or `<base>...HEAD` (`--diff`). */
  git?: { cwd: string; base?: string }
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
  // Default the overview model to OpenRouter (z-ai/glm-5.1) so it uses the same
  // run the overview model (BYO keys via processEnv).
  const env = createLocalEnv({
    processEnv: { ...(args.processEnv ?? process.env), OLLAMA_CHAT_ENABLE: "on" },
  })
  const client: GitHubClient = args.git
    ? (localGitClient(args.git) as unknown as GitHubClient)
    : new GitHubClient({ token: args.githubToken ?? "" })
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
