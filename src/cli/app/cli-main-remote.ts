// SIG-304 Phase 2.3 — the ENGINE-FREE main for the published thin client. Hosted
// review only: it POSTs the local diff to /v1/review (our models run server-side)
// and renders the result. Its entire import graph is arg-parsing + run-review-remote
// (which imports only the read-only git client + the DryRunReview TYPE) + the pure
// renderers + the splash — NEVER the review engine. The dependency-cruiser
// "thin-client-ships-no-engine" rule + the bundle grep-gate enforce that, so the
// published client (bin-remote.ts) ships zero moat.

import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { runReviewRemote } from "./run-review-remote"
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
  sigilix review --uncommitted [output]      # review your working-tree changes
  sigilix review --diff <base> [output]      # review the <base>...HEAD range

Output:
  --rich    truecolor panel (default on a TTY)   --json   machine-readable JSON
  --agent   agent-friendly (Claude Code / Codex)  --plain  terse one-line-per-finding
  --no-splash   disable the animated splash       --endpoint <url>  Sigilix API base URL

Auth: set \$SIGILIX_API_KEY. Override the API host with --endpoint / \$SIGILIX_ENDPOINT.
Exit: 0 clean · 1 blocking (P0/P1) · 2 advisory (P2/P3). NO_COLOR forces plain.`

function renderReview(review: DryRunReview, mode: "json" | "agent" | "plain"): string {
  if (mode === "json") return renderJson(review)
  if (mode === "agent") return renderAgentMarkdown(review)
  return renderPlain(review)
}

export async function cliMainRemote(argv: readonly string[]): Promise<number> {
  const sub = argv[0]
  if (sub === undefined || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE + "\n")
    return sub === undefined ? 2 : 0
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

  // Source: exactly one of --uncommitted / --diff <base>.
  const hasUncommitted = values.uncommitted === true
  const hasDiff = values.diff !== undefined
  if (hasUncommitted === hasDiff) {
    process.stderr.write("sigilix: pick exactly one source — --uncommitted or --diff <base>\n")
    return 2
  }
  let cwd: string
  try {
    cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  } catch {
    process.stderr.write("sigilix: must be run inside a git repository\n")
    return 2
  }
  // RECALL-SAFETY: --uncommitted reviews tracked changes only; warn about untracked files.
  if (hasUncommitted) {
    try {
      const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" })
        .split("\n")
        .filter((l) => l.trim() !== "")
      if (untracked.length > 0) {
        const shown = untracked.slice(0, 8).join(", ") + (untracked.length > 8 ? ", …" : "")
        process.stderr.write(`sigilix: ⚠ ${untracked.length} untracked file(s) will NOT be reviewed: ${shown}\n`)
      }
    } catch {
      /* best-effort */
    }
  }
  const git = { cwd, ...(values.diff !== undefined ? { base: values.diff } : {}) }
  const subject = `${values.diff !== undefined ? `${values.diff}...HEAD` : "working tree"}  ·  hosted`

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

  const compute = (): Promise<DryRunReview | null> =>
    runReviewRemote({ endpoint, apiKey, owner: "local", repo: "local", git })
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
  return exitCodeForFindings([...review.verdict.findings, ...review.unanchoredFindings].map(toFindingView))
}
