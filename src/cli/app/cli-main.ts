// SIG-304 (review CLI) Phase 1 — argument parsing + mode dispatch for `sigilix`.
// Sources: --repo/--pr (a GitHub PR), --uncommitted (working tree), --diff <base>
// (a `<base>...HEAD` range). Output modes: --rich (truecolor panel + animated
// splash, default on a TTY), --json (machine), --agent (agent markdown), --plain
// (terse; default when piped). Returns the exit code; never calls process.exit.

import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { runReviewInNode } from "./run-review-in-node"
import { runOverviewInNode } from "./run-overview-in-node"
import { runReviewRemote, runReviewRemoteGrounded } from "./run-review-remote"
import { exitCodeForFindings } from "./exit-code"
import { toFindingView } from "@/src/cli/render/finding-view"
import { renderJson } from "@/src/cli/render/json"
import { renderAgentMarkdown } from "@/src/cli/render/agent-markdown"
import { renderPlain } from "@/src/cli/render/plain"
import { renderRich } from "@/src/cli/render/rich"
import { runWithSplash } from "@/src/cli/ansi/splash"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"

const USAGE = `sigilix review — code review on Sigilix's models (hosted)

Usage:
  sigilix review --repo <owner/repo> --pr <number> [output]   # review a GitHub PR (grounded)
  sigilix review --uncommitted [output]            # review your local working-tree changes
  sigilix review --diff <base> [output]            # review the <base>...HEAD range

Source (pick one):
  --repo + --pr   review a GitHub PR — grounded via our GitHub App (must be installed)
  --uncommitted   review uncommitted working-tree changes
  --diff <base>   review the <base>...HEAD range

Output (defaults to --rich on a terminal — you don't need to pass it):
  --rich    truecolor PR-style panel: overview + sequence diagram + finding cards
  --json    machine-readable JSON (findings + proof tiers)
  --agent   agent-friendly output for a coding agent (Claude Code / Codex): path:line + fixes
  --plain   terse one-line-per-finding (default when piped / non-TTY / NO_COLOR)
  --no-splash  disable the animated splash (it runs by default on a TTY while reviewing)
  --endpoint  Sigilix API base URL (else \$SIGILIX_ENDPOINT)

Auth: set \$SIGILIX_API_KEY → the review runs on Sigilix's models server-side (no model
key of your own); a PR (--repo/--pr) is reviewed grounded via our GitHub App. With no
hosted key, it falls back to a local engine on \$OPENROUTER_API_KEY (--local forces that).
SIGILIX_DEBUG=1 shows engine logs.
Exit codes: 0 clean · 1 blocking (P0/P1) · 2 advisory (P2/P3). Set NO_COLOR to force plain.`

export function renderReview(review: DryRunReview, mode: "json" | "agent" | "plain"): string {
  if (mode === "json") return renderJson(review)
  if (mode === "agent") return renderAgentMarkdown(review)
  return renderPlain(review)
}

export async function cliMain(argv: readonly string[]): Promise<number> {
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
        endpoint: { type: "string" },
        local: { type: "boolean" },
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
  // Reject an empty --diff base: `--diff ""` would label the run "...HEAD" (a range) but
  // git treats the empty ref as falsy and reviews the working tree — a silent scope mismatch.
  if (values.diff !== undefined && values.diff.trim() === "") {
    process.stderr.write("sigilix: --diff <base> needs a non-empty base ref (e.g. --diff main)\n")
    return 2
  }

  // HOSTED is the product: `sigilix review` runs on Sigilix's models server-side when
  // $SIGILIX_API_KEY is set — local sources (--uncommitted/--diff) post their diff (Mode
  // A); a PR (--repo/--pr) is reviewed GROUNDED via our GitHub App (Mode B). With NO
  // hosted key, the DEV CLI falls back to the local engine when a dev model key
  // ($OPENROUTER_API_KEY) is present (so `sigilix review` just works for us, no flags);
  // `--local` forces that path. The PUBLISHED thin client has no such fallback — it is
  // hosted-only (no user BYO). Issuing $SIGILIX_API_KEY auto-switches this to hosted.
  const hostedKey = process.env.SIGILIX_API_KEY ?? ""
  const hasLocalModelKey = Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENCLAW_MODEL)
  const useLocal = values.local === true || (hostedKey === "" && hasLocalModelKey)
  const endpoint = values.endpoint ?? process.env.SIGILIX_ENDPOINT ?? "https://api.sigilix.ai"
  if (!useLocal && hostedKey === "") {
    process.stderr.write(
      "sigilix: set $SIGILIX_API_KEY (hosted, runs on Sigilix's models) or $OPENROUTER_API_KEY (local engine) to run a review\n",
    )
    return 2
  }
  // Auto-local is SILENT — it just works. (Hosted runs show "· hosted" in the panel
  // subject; the absence of it means local, so no noisy stderr note is needed.)

  // Source: local working tree (--uncommitted) or a base range (--diff <base>),
  // else a real GitHub PR (--repo + --pr; + token only for the BYO local engine).
  const localMode = values.uncommitted === true || values.diff !== undefined
  let owner: string
  let repoName: string
  let prNumber: number
  let source: { githubToken: string } | { git: { cwd: string; base?: string } } | { grounded: true }
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
    subject = `${owner}/${repoName}#${prNumber}`
    if (!useLocal) {
      // Grounded hosted (Mode B): the server reads the PR via our GitHub App — no token.
      source = { grounded: true }
    } else {
      // --local (dev/agent BYO): a token is required to read the PR ourselves.
      const githubToken = values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
      if (githubToken === undefined || githubToken.length === 0) {
        process.stderr.write("sigilix: --local on a PR needs a GitHub token (--token or $GITHUB_TOKEN)\n")
        return 2
      }
      source = { githubToken }
    }
  }

  // Hosted is the default; --local runs the bundled engine on the user's own key. The
  // review renders identically either way; --rich shows the panel without the diagram
  // (the overview pass is a local-engine feature).
  const remote = !useLocal
  if (remote) subject = `${subject}  ·  hosted`

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
    // Hosted paths: /v1/review runs the engine server-side. No overview (it's a
    // local-engine feature) → --rich renders without the diagram.
    if ("grounded" in source) {
      // Mode B: a PR reviewed grounded via our GitHub App (server reads the PR).
      const review = await runReviewRemoteGrounded({ endpoint, apiKey: hostedKey, owner, repo: repoName, prNumber })
      return { review, overview: null }
    }
    if (remote && "git" in source) {
      // Mode A: POST the local diff (ungrounded).
      const review = await runReviewRemote({ endpoint, apiKey: hostedKey, owner, repo: repoName, git: source.git })
      return { review, overview: null }
    }
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
  return exitCodeForFindings(views, review.incomplete != null)
}
