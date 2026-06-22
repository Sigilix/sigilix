// SIG-304 (review CLI) Phase 1 — argument parsing + mode dispatch for `sigilix`.
// Sources: --repo/--pr (a GitHub PR), --uncommitted (working tree), --diff <base>
// (a `<base>...HEAD` range). Output modes: --rich (truecolor panel + animated
// splash, default on a TTY), --json (machine), --agent (agent markdown), --plain
// (terse; default when piped). Returns the exit code; never calls process.exit.

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
  --agent   agent-friendly output for a coding agent (Claude Code / Codex): path:line + fixes
  --plain   terse one-line-per-finding (default when piped / non-TTY / NO_COLOR)
  --no-splash  disable the animated splash (it runs by default on a TTY while reviewing)
  --token   GitHub token (else \$GITHUB_TOKEN / \$GH_TOKEN); used only to read the PR

Model key: set \$OPENROUTER_API_KEY (the review runs on it). The --rich sequence
diagram also runs an overview pass that needs \$OLLAMA_API_KEY today (else --rich
degrades to review-only). Set SIGILIX_DEBUG=1 to see engine logs.
Exit codes: 0 clean · 1 blocking (P0/P1) · 2 advisory (P2/P3). Set NO_COLOR to force plain.`

export function renderReview(review: DryRunReview, mode: "json" | "agent" | "plain"): string {
  if (mode === "json") return renderJson(review)
  if (mode === "agent") return renderAgentMarkdown(review)
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
        agent: { type: "boolean" },
        plain: { type: "boolean" },
        "no-splash": { type: "boolean" },
      },
      allowPositionals: false,
    }).values
  } catch (err) {
    process.stderr.write(`sigilix: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`)
    return 2
  }

  // Source must be EXACTLY one of: a PR (--pr), --uncommitted, or --diff <base>.
  // Reject ambiguous combos so a fat-fingered flag never silently reviews the wrong
  // thing (e.g. `--pr 5 --uncommitted` would otherwise ignore the PR). (--repo on
  // its own is allowed in local mode — it only labels logs.)
  const sources = [values.pr !== undefined, values.uncommitted === true, values.diff !== undefined].filter(Boolean)
  if (sources.length > 1) {
    process.stderr.write("sigilix: pick ONE source — --repo/--pr, --uncommitted, or --diff <base> (not several)\n")
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
    // RECALL-SAFETY: `--uncommitted` reviews `git diff HEAD` (tracked changes only).
    // Untracked/new files are NOT in that diff — and new files are the highest-risk
    // content pre-commit. Warn loudly so a clean result is never silently misleading.
    if (values.diff === undefined) {
      try {
        const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" })
          .split("\n")
          .filter((l) => l.trim() !== "")
        if (untracked.length > 0) {
          const shown = untracked.slice(0, 8).join(", ") + (untracked.length > 8 ? ", …" : "")
          process.stderr.write(
            `sigilix: ⚠ ${untracked.length} untracked file(s) will NOT be reviewed (\`git add\` them first): ${shown}\n`,
          )
        }
      } catch {
        // non-fatal: the warning is best-effort
      }
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
  const color =
    !process.env.NO_COLOR &&
    (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true")
  const explicitMode = values.json
    ? "json"
    : values.agent
      ? "agent"
      : values.rich
        ? "rich"
        : values.plain
          ? "plain"
          : null
  const mode: "json" | "agent" | "plain" | "rich" = explicitMode ?? (color ? "rich" : "plain")
  // Splash is the DEFAULT on a color TTY: the spinning Earth + starfield animate
  // while we wait, then the review prints UNDER the landed frame. Off when piped /
  // CI / NO_COLOR / --no-splash so scripted + non-TTY output is never touched.
  const splashOn = color && !process.env.CI && values["no-splash"] !== true

  // Compute review (+ the overview pass for rich) — wrapped by the splash so it
  // covers the whole wait. A failed overview pass is non-fatal (review-only).
  const compute = async (): Promise<{
    review: Awaited<ReturnType<typeof runReviewInNode>>
    overview: Awaited<ReturnType<typeof runOverviewInNode>>
  }> => {
    const review = await runReviewInNode({ owner, repo: repoName, prNumber, ...source })
    if (review === null || mode !== "rich" || !color) return { review, overview: null }
    // The overview pass (summary + sequence diagram) is Ollama-only today (SIG-491),
    // so skip it cleanly when there's no Ollama key — the rich panel degrades to
    // review-only rather than erroring with an Ollama 404 for BYO OpenRouter users.
    const hasOllama = Boolean(process.env.OLLAMA_API_KEY || process.env.OPENCLAW_MODEL)
    if (!hasOllama) return { review, overview: null }
    let overview: Awaited<ReturnType<typeof runOverviewInNode>> = null
    try {
      overview = await runOverviewInNode({ owner, repo: repoName, prNumber, ...source })
    } catch (err) {
      process.stderr.write(
        `sigilix: overview pass failed (${err instanceof Error ? err.message : String(err)}); rendering review only\n`,
      )
    }
    return { review, overview }
  }

  const { review, overview } = splashOn ? await runWithSplash(compute()) : await compute()
  if (review === null) {
    process.stdout.write("sigilix: nothing to review\n")
    return 0
  }

  const out =
    mode === "rich"
      ? renderRich(review, overview, { color, width: process.stdout.columns ?? 88, subject })
      : renderReview(review, mode)
  process.stdout.write(out.endsWith("\n") ? out : out + "\n")
  const views = [...review.verdict.findings, ...review.unanchoredFindings].map(toFindingView)
  return exitCodeForFindings(views)
}
