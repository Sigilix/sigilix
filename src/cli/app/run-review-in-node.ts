// SIG-304 (review CLI) Phase 1 — the headless driver. Builds the engine inputs for a
// local Node run, invokes the review engine in dry-run (no posting), and returns the
// built review for the renderers. Reuses the Phase-0 seam: a local `Env` (no
// Cloudflare bindings) + an injected PAT GitHubClient + `dryRun: true`.
//
// This Phase reviews a real PR by number (BYO model key via env). Local-git diff
// sourcing (`--uncommitted` / `--diff`) lands in a follow-up via a git-backed client.

import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import { GitHubClient } from "@/src/shared/adapters/github"
import { createLocalEnv } from "@/src/cli/adapters/local-env"

export interface RunReviewInNodeArgs {
  owner: string
  repo: string
  prNumber: number
  /** A GitHub token (PAT / `gh auth token`) used ONLY to read the PR + diff. */
  githubToken: string
  /** Env source for model keys + flags (BYO models). Defaults to `process.env`. */
  processEnv?: Record<string, string | undefined>
}

/**
 * Run the review engine headless against a real PR and return the built review
 * (final verdict + body-only findings) WITHOUT posting anything. Throws if the PR's
 * head SHA can't be resolved. Returns null when the engine skipped (nothing to
 * review). The caller picks an output mode + exit code.
 */
export async function runReviewInNode(args: RunReviewInNodeArgs): Promise<DryRunReview | null> {
  // chatEnabled MUST be on so the specialist models actually run (never hardcode
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
  const result = await handlePrReviewEnsemble({
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha,
    installationId: 0, // unused: the injected client bypasses buildClient
    env,
    githubClient: client,
    dryRun: true,
    forceFullCoverage: true, // single-shot: no cross-run KV → avoid the SIG-459 empty-delta skip
  })
  return result.dryRunReview ?? null
}
