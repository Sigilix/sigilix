// SIG-304 (review CLI) Phase 1 — argument parsing + mode dispatch for `sigilix`.
// Phase 1 surface: `sigilix review --repo <owner/repo> --pr <n> [--json|--ai|--plain]`.
// Output modes: --json (machine), --ai (agent markdown), --plain (terse; default).
// The rich truecolor terminal render + animated splash land in Phase 1b (Kimi UI).
// Returns the process exit code; never calls process.exit (the bin does).

import { parseArgs } from "node:util"
import { runReviewInNode } from "./run-review-in-node"
import { exitCodeForFindings } from "./exit-code"
import { toFindingView } from "@/src/cli/render/finding-view"
import { renderJson } from "@/src/cli/render/json"
import { renderAgentMarkdown } from "@/src/cli/render/agent-markdown"
import { renderPlain } from "@/src/cli/render/plain"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"

const USAGE = `sigilix review — local PR review (BYO model key via env)

Usage:
  sigilix review --repo <owner/repo> --pr <number> [--json | --ai | --plain] [--token <gh-token>]

Options:
  --repo    owner/repo (required)
  --pr      pull-request number (required)
  --json    machine-readable JSON (findings + proof tiers)
  --ai      deterministic markdown for an AI coding agent (Claude Code / Codex)
  --plain   terse one-line-per-finding (default)
  --token   GitHub token (else \$GITHUB_TOKEN / \$GH_TOKEN); used only to read the PR

Model key: set \$OPENROUTER_API_KEY (or your provider key) in the environment.
Exit codes: 0 clean · 1 blocking (P0/P1) · 2 advisory (P2/P3).`

export function renderReview(review: DryRunReview, mode: "json" | "ai" | "plain"): string {
  if (mode === "json") return renderJson(review)
  if (mode === "ai") return renderAgentMarkdown(review)
  return renderPlain(review)
}

export async function cliMain(argv: readonly string[]): Promise<number> {
  const sub = argv[0]
  if (sub === undefined || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE + "\n")
    return sub === undefined ? 2 : 0
  }
  if (sub !== "review") {
    process.stderr.write(`sigilix: unknown command '${sub}'\n\n${USAGE}\n`)
    return 2
  }

  const { values } = parseArgs({
    args: [...argv.slice(1)],
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      token: { type: "string" },
      json: { type: "boolean" },
      ai: { type: "boolean" },
      plain: { type: "boolean" },
    },
    allowPositionals: false,
  })

  const repo = values.repo
  if (repo === undefined || !repo.includes("/")) {
    process.stderr.write("sigilix: --repo <owner/repo> is required\n")
    return 2
  }
  const prNumber = Number(values.pr)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    process.stderr.write("sigilix: --pr <number> is required\n")
    return 2
  }
  const githubToken = values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (githubToken === undefined || githubToken.length === 0) {
    process.stderr.write("sigilix: a GitHub token is required (--token or $GITHUB_TOKEN)\n")
    return 2
  }
  const slash = repo.indexOf("/")
  const owner = repo.slice(0, slash)
  const repoName = repo.slice(slash + 1)
  const mode: "json" | "ai" | "plain" = values.json ? "json" : values.ai ? "ai" : "plain"

  const review = await runReviewInNode({ owner, repo: repoName, prNumber, githubToken })
  if (review === null) {
    process.stdout.write("sigilix: nothing to review\n")
    return 0
  }
  const out = renderReview(review, mode)
  process.stdout.write(out.endsWith("\n") ? out : out + "\n")
  const views = [...review.verdict.findings, ...review.unanchoredFindings].map(toFindingView)
  return exitCodeForFindings(views)
}
