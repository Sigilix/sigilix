// SIG-304 Phase 2.3 — the ENGINE-FREE main for the published thin client. Hosted
// review only: it POSTs the local diff to /v1/review (our models run server-side)
// and renders the result. Its entire import graph is arg-parsing + run-review-remote
// (which imports only the read-only git client + the DryRunReview TYPE) + the pure
// renderers + the splash — NEVER the review engine. The dependency-cruiser
// "thin-client-ships-no-engine" rule + the bundle grep-gate enforce that, so the
// published client (bin-remote.ts) ships zero moat.

import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { runReviewRemote, runReviewRemoteGrounded } from "./run-review-remote"
import { exitCodeForFindings } from "./exit-code"
import { toFindingView } from "@/src/cli/render/finding-view"
import { renderJson } from "@/src/cli/render/json"
import { renderAgentMarkdown } from "@/src/cli/render/agent-markdown"
import { renderPlain } from "@/src/cli/render/plain"
import { renderRich } from "@/src/cli/render/rich"
import { runWithSplash } from "@/src/cli/ansi/splash"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"

const USAGE = `sigilix review — hosted code review (runs on Sigilix's models)

Usage:
  sigilix review --repo <owner/repo> --pr <n> [output]  # review a GitHub PR (grounded)
  sigilix review --uncommitted [output]      # review your working-tree changes
  sigilix review --diff <base> [output]      # review the <base>...HEAD range

Output:
  --rich    truecolor panel (default on a TTY)   --json   machine-readable JSON
  --agent   agent-friendly (Claude Code / Codex)  --plain  terse one-line-per-finding
  --no-splash   disable the animated splash       --endpoint <url>  Sigilix API base URL

Auth: set \$SIGILIX_API_KEY. --repo/--pr is reviewed GROUNDED via our GitHub App (no
token needed); it must be installed on the repo. Override the host with --endpoint.
Exit: 0 clean · 1 blocking (P0/P1) · 2 advisory (P2/P3). NO_COLOR forces plain.`

function renderReview(review: DryRunReview, mode: "json" | "agent" | "plain"): string {
  if (mode === "json") return renderJson(review)
  if (mode === "agent") return renderAgentMarkdown(review)
  return renderPlain(review)
}

export async function cliMainRemote(argv: readonly string[]): Promise<number> {
  // --help / -h ANYWHERE → the full guide, exit 0 (so `sigilix review --help` works too).
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n")
    return 0
  }
  const sub = argv[0]
  if (sub === undefined) {
    process.stdout.write(USAGE + "\n")
    return 2
  }
  if (sub !== "review") {
    process.stderr.write(`sigilix: unknown command '${sub}'\n\n${USAGE}\n`)
    return 2
  }

  let values
  try {
    values = parseArgs({
      args: [...argv.slice(1)],
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        uncommitted: { type: "boolean" },
        diff: { type: "string" },
        rich: { type: "boolean" },
        json: { type: "boolean" },
        agent: { type: "boolean" },
        plain: { type: "boolean" },
        "no-splash": { type: "boolean" },
        endpoint: { type: "string" },
      },
      allowPositionals: false,
    }).values
  } catch (err) {
    process.stderr.write(`sigilix: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`)
    return 2
  }

  const apiKey = process.env.SIGILIX_API_KEY ?? ""
  if (apiKey === "") {
    process.stderr.write("sigilix: set $SIGILIX_API_KEY to run a hosted review\n")
    return 2
  }
  const endpoint = values.endpoint ?? process.env.SIGILIX_ENDPOINT ?? "https://api.sigilix.ai"

  // Source: exactly one of --repo/--pr (grounded), --uncommitted, or --diff <base>. The
  // PR source is keyed off --pr (matching the full CLI); --repo is validated in-branch.
  const hasPr = values.pr !== undefined
  const hasUncommitted = values.uncommitted === true
  const hasDiff = values.diff !== undefined
  if ([hasPr, hasUncommitted, hasDiff].filter(Boolean).length !== 1) {
    process.stderr.write("sigilix: pick exactly one source — --repo/--pr, --uncommitted, or --diff <base>\n")
    return 2
  }
  // Reject an empty --diff base (would mislabel a working-tree review as a range).
  if (values.diff !== undefined && values.diff.trim() === "") {
    process.stderr.write("sigilix: --diff <base> needs a non-empty base ref (e.g. --diff main)\n")
    return 2
  }

  let compute: () => Promise<DryRunReview | null>
  let subject: string

  if (hasPr) {
    // Grounded PR review: the server reads the PR via our GitHub App (no token, no clone).
    const repoParts = (values.repo ?? "").split("/")
    if (repoParts.length !== 2 || repoParts[0]!.length === 0 || repoParts[1]!.length === 0) {
      process.stderr.write("sigilix: --repo <owner/repo> is required with --pr\n")
      return 2
    }
    if (!/^\d+$/.test(values.pr ?? "")) {
      process.stderr.write("sigilix: --pr <number> is required with --repo\n")
      return 2
    }
    const owner = repoParts[0]!
    const repo = repoParts[1]!
    const prNumber = Number(values.pr)
    subject = `${owner}/${repo}#${prNumber}  ·  hosted`
    compute = () => runReviewRemoteGrounded({ endpoint, apiKey, owner, repo, prNumber })
  } else {
    let cwd: string
    try {
      cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
    } catch {
      process.stderr.write("sigilix: --uncommitted / --diff must be run inside a git repository\n")
      return 2
    }
    // SIG-490: --uncommitted reviews tracked + untracked (new) files; no warning needed.
    const git = { cwd, ...(values.diff !== undefined ? { base: values.diff } : {}) }
    subject = `${values.diff !== undefined ? `${values.diff}...HEAD` : "working tree"}  ·  hosted`
    compute = () => runReviewRemote({ endpoint, apiKey, owner: "local", repo: "local", git })
  }

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
  const splashOn = color && !process.env.CI && values["no-splash"] !== true

  const review = splashOn ? await runWithSplash(compute()) : await compute()
  if (review === null) {
    process.stdout.write("sigilix: nothing to review\n")
    return 0
  }
  const out =
    mode === "rich"
      ? renderRich(review, null, { color, width: process.stdout.columns ?? 88, subject })
      : renderReview(review, mode)
  process.stdout.write(out.endsWith("\n") ? out : out + "\n")
  return exitCodeForFindings(
    [...review.verdict.findings, ...review.unanchoredFindings].map(toFindingView),
    review.incomplete != null,
  )
}
