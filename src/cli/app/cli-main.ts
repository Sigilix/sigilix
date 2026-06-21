// SIG-304 (review CLI) Phase 1 — argument parsing + mode dispatch for `sigilix`.
// Phase 1 surface: `sigilix review --repo <owner/repo> --pr <n> [--json|--ai|--plain]`.
// Output modes: --json (machine), --ai (agent markdown), --plain (terse; default).
// The rich truecolor terminal render + animated splash land in Phase 1b (Kimi UI).
// Returns the process exit code; never calls process.exit (the bin does).

import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { runReviewInNode } from "./run-review-in-node"
import { runOverviewInNode } from "./run-overview-in-node"
import { exitCodeForFindings } from "./exit-code"
import { toFindingView } from "@/src/cli/render/finding-view"
import { renderJson } from "@/src/cli/render/json"
import { renderAgentMarkdown } from "@/src/cli/render/agent-markdown"
import { renderPlain } from "@/src/cli/render/plain"
import { renderRich } from "@/src/cli/render/rich"
import { runWithSplash } from "@/src/cli/ansi/splash"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"

const USAGE = `sigilix review — local PR review (BYO model key via env)

Usage:
  sigilix review --repo <owner/repo> --pr <number> [output] [--token <gh-token>]
  sigilix review --uncommitted [output]            # review your local working-tree changes
  sigilix review --diff <base> [output]            # review <base>...HEAD (no PR / no token)

Source (pick one):
  --repo + --pr   review a GitHub PR (needs a token)
  --uncommitted   review uncommitted working-tree changes (local git, no token)
  --diff <base>   review the <base>...HEAD range (local git, no token)

Options (output):
  --rich    truecolor PR-style panel: overview + sequence diagram + findings
            (default on a TTY; also runs the overview pass for the diagram)
  --json    machine-readable JSON (findings + proof tiers)
  --ai      deterministic markdown for an AI coding agent (Claude Code / Codex)
  --plain   terse one-line-per-finding (default when piped / non-TTY / NO_COLOR)
  --splash  animated launch splash while the review runs (TTY only; off in CI / piped)
  --token   GitHub token (else \$GITHUB_TOKEN / \$GH_TOKEN); used only to read the PR

Model key: set \$OPENROUTER_API_KEY (or your provider key); --rich also needs
\$OLLAMA_API_KEY (or an \$OPENCLAW_MODEL override) for the overview pass.
Exit codes: 0 clean · 1 blocking (P0/P1) · 2 advisory (P2/P3). Set NO_COLOR to force plain.`

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

  // parseArgs THROWS on an unknown flag / positional / missing value. Catch it and
  // return the usage code (2) — otherwise it would propagate to bin.ts and exit 1,
  // which CI can't tell apart from "a blocking finding was found".
  let values
  try {
    values = parseArgs({
      args: [...argv.slice(1)],
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        token: { type: "string" },
        uncommitted: { type: "boolean" },
        diff: { type: "string" },
        rich: { type: "boolean" },
        json: { type: "boolean" },
        ai: { type: "boolean" },
        plain: { type: "boolean" },
        splash: { type: "boolean" },
      },
      allowPositionals: false,
    }).values
  } catch (err) {
    process.stderr.write(`sigilix: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`)
    return 2
  }

  // Source: local working tree (--uncommitted) or a base range (--diff <base>),
  // else a real GitHub PR (--repo + --pr + token).
  const localMode = values.uncommitted === true || values.diff !== undefined
  let owner: string
  let repoName: string
  let prNumber: number
  let source: { githubToken: string } | { git: { cwd: string; base?: string } }
  let subject: string

  if (localMode) {
    let cwd: string
    try {
      cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
    } catch {
      process.stderr.write("sigilix: --uncommitted / --diff must be run inside a git repository\n")
      return 2
    }
    // owner/repo only label local logs; honor --repo if given, else a stub.
    const rp = (values.repo ?? "local/local").split("/")
    owner = rp[0] || "local"
    repoName = rp[1] || "local"
    prNumber = 0
    source = { git: { cwd, ...(values.diff !== undefined ? { base: values.diff } : {}) } }
    subject = values.diff !== undefined ? `${values.diff}...HEAD` : "working tree"
  } else {
    // --repo must be exactly `owner/repo`, both non-empty (reject "/r", "o/", "a/b/c").
    const repoParts = (values.repo ?? "").split("/")
    if (repoParts.length !== 2 || repoParts[0]!.length === 0 || repoParts[1]!.length === 0) {
      process.stderr.write("sigilix: --repo <owner/repo> is required (or use --uncommitted / --diff <base>)\n")
      return 2
    }
    owner = repoParts[0]!
    repoName = repoParts[1]!
    // --pr must be a plain positive integer (reject "1e3", "0x10", " 12 ").
    if (!/^\d+$/.test(values.pr ?? "")) {
      process.stderr.write("sigilix: --pr <number> is required (or use --uncommitted / --diff <base>)\n")
      return 2
    }
    prNumber = Number(values.pr)
    const githubToken = values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    if (githubToken === undefined || githubToken.length === 0) {
      process.stderr.write("sigilix: a GitHub token is required (--token or $GITHUB_TOKEN)\n")
      return 2
    }
    source = { githubToken }
    subject = `${owner}/${repoName}#${prNumber}`
  }

  // Color iff an interactive TTY and NO_COLOR is unset. Rich is the default for a
  // human terminal; piped / CI / NO_COLOR get plain (ANSI-free, grep-safe).
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
  const explicitMode = values.json ? "json" : values.ai ? "ai" : values.rich ? "rich" : values.plain ? "plain" : null
  const mode: "json" | "ai" | "plain" | "rich" = explicitMode ?? (color ? "rich" : "plain")
  // Opt-in animated splash, hard-gated to an interactive non-CI terminal so piped
  // / scripted output is never touched. It animates on stderr while the review runs.
  const splash = Boolean(values.splash) && color && !process.env.CI

  const reviewWork = runReviewInNode({ owner, repo: repoName, prNumber, ...source })
  const review = splash ? await runWithSplash(reviewWork) : await reviewWork
  if (review === null) {
    process.stdout.write("sigilix: nothing to review\n")
    return 0
  }

  let out: string
  if (mode === "rich") {
    // The rich panel also runs the overview pass (summary + file table + the real
    // mermaid sequence diagram). Skip it when color is off — rich then degrades to
    // plain, so the extra model call would be wasted. A failed overview pass is
    // non-fatal: render the review alone.
    let overview: Awaited<ReturnType<typeof runOverviewInNode>> = null
    if (color) {
      try {
        overview = await runOverviewInNode({ owner, repo: repoName, prNumber, ...source })
      } catch (err) {
        process.stderr.write(
          `sigilix: overview pass failed (${err instanceof Error ? err.message : String(err)}); rendering review only\n`,
        )
      }
    }
    out = renderRich(review, overview, { color, width: process.stdout.columns ?? 88, subject })
  } else {
    out = renderReview(review, mode)
  }
  process.stdout.write(out.endsWith("\n") ? out : out + "\n")
  const views = [...review.verdict.findings, ...review.unanchoredFindings].map(toFindingView)
  return exitCodeForFindings(views)
}
