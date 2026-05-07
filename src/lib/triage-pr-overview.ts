// PR-overview triage pipeline. Triggered by `pull_request` webhook on
// opened / synchronize / reopened — fetches the PR + diff + commits,
// asks Ollama Turbo for a structured overview, and posts (or PATCHes
// in place) a single sticky top-level comment.
//
// Ported from rema-portal/tools/openclaw/triage-pr-overview.mjs +
// lib/pr-overview.mjs. No filesystem, no gh CLI — everything goes
// through the GitHubClient.

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import { GitHubClient, type PrCommit, type PullRequestMeta } from "./github"
import { parseFirstJsonObject } from "./json-extract"
import { PR_OVERVIEW_SCHEMA } from "./schemas"
import { PR_OVERVIEW_PROMPT } from "../prompts/pr-overview"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const OVERVIEW_MARKER = "<!-- openclaw:pr-overview -->"

const LIMITS = {
  prDiff: 28_000,
  prBody: 4_000,
  newCommitsBlock: 2_000,
}

export interface PrOverviewVerdict {
  summary: string
  files: Array<{ path: string; score: number; overview: string; nextStep: string }>
  confidence: number
  confidenceReason: string
  bullets: string[]
}

export interface PrOverviewArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
}

const DEDUPE_PREFIX = "pr-overview:"
const DEDUPE_TTL_SECONDS = 300

export async function handlePrOverview(args: PrOverviewArgs): Promise<void> {
  const { owner, repo, prNumber, headSha, installationId, env } = args
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[pr-overview] ${label} +${Date.now() - t0}ms`, {
      owner,
      repo,
      prNumber,
      headSha: headSha.slice(0, 7),
    })
  }

  since("start")

  // Concurrent-run guard. Two pull_request webhooks fired in quick
  // succession on the same head SHA would otherwise both reach the
  // listIssueComments → no-marker branch and POST a duplicate top-level
  // comment. Keyed on (prNumber, headSha) so a new push (different SHA)
  // still runs again as expected. Released on any exit path via the
  // try/finally below — queue retries can re-attempt without being
  // blocked by a stale lock.
  const dedupeKey = `${DEDUPE_PREFIX}${owner}/${repo}#${prNumber}@${headSha}`
  if (await env.OPENCLAW_STATE.get(dedupeKey)) {
    console.log(JSON.stringify({
      event: "pr-overview-skipped",
      dedupe_system: "kv",
      reason: "already_running",
      owner, repo, prNumber, headSha: headSha.slice(0, 7),
    }))
    return
  }
  await env.OPENCLAW_STATE.put(dedupeKey, String(Date.now()), {
    expirationTtl: DEDUPE_TTL_SECONDS,
  })

  try {
    const client = await buildClient(env, installationId)
    since("auth-ready")

    const [meta, diff, commits] = await Promise.all([
      client.getPullRequest(owner, repo, prNumber),
      client.getPullRequestDiff(owner, repo, prNumber),
      client.getPullRequestCommits(owner, repo, prNumber).catch(() => [] as PrCommit[]),
    ])
    since("pr-fetched")

    const existing = await findExistingOverviewComment(client, owner, repo, prNumber)
    const isFirstRun = existing == null
    since("dedupe-checked")

    // For incremental runs we only show the most recent commits (matches the
    // upstream `commits[-10:]` slice). First-run gets the same window — the
    // prompt says "summarize the whole change" and the diff carries the full
    // story in either case.
    const recentCommits = commits.slice(-10)

    const prompt = buildPrompt({
      prNumber,
      meta,
      diff,
      newCommits: recentCommits,
      isFirstRun,
    })

    const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    since("ollama-start")
    const response = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: PR_OVERVIEW_SCHEMA as unknown as Record<string, unknown>,
    })
    since("ollama-done")

    const verdict = parseOverviewResponse(response)
    if (!verdict) {
      console.error("pr-overview verdict did not parse", {
        owner,
        repo,
        prNumber,
        responseLength: response.length,
      })
      return
    }

    const body = formatOverviewComment({ verdict, isFirstRun })

    if (existing != null) {
      await client.updateIssueComment(owner, repo, existing, body)
      since("comment-updated")
      console.log(
        `pr-overview updated on ${owner}/${repo}#${prNumber} (confidence=${verdict.confidence}/5, ${verdict.files.length} files)`
      )
    } else {
      const created = await client.createIssueComment(owner, repo, prNumber, body)
      since("comment-created")
      console.log(
        `pr-overview created on ${owner}/${repo}#${prNumber} as comment ${created.id} (confidence=${verdict.confidence}/5, ${verdict.files.length} files)`
      )
    }
  } finally {
    // Always release the dedupe lock — even on failure — so the queue's
    // retry can attempt again. Without this, the first failure leaves
    // a 5-min lock that blocks every retry until it expires.
    await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
  }
}

interface PromptCtx {
  prNumber: number
  meta: PullRequestMeta
  diff: string
  newCommits: PrCommit[]
  isFirstRun: boolean
}

function buildPrompt(ctx: PromptCtx): string {
  const commitsBlock = ctx.newCommits
    .map((c) => `- ${c.sha?.slice(0, 7) ?? "?"} ${c.message?.split("\n")[0] ?? ""}`)
    .join("\n")

  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    PR_OVERVIEW_PROMPT.trim(),
    "",
    "[PR SCOPE]",
    `Number: #${ctx.prNumber}`,
    `Title: ${ctx.meta.title}`,
    "Body:",
    truncate(ctx.meta.body ?? "(no description)", LIMITS.prBody),
    "",
    ctx.isFirstRun
      ? "[RECENT COMMITS — context for the first overview; the [DIFF] section below is the full change to summarize]"
      : "[NEW COMMITS — only summarize what's been pushed since the previous overview]",
    truncate(commitsBlock, LIMITS.newCommitsBlock),
    "",
    "[DIFF]",
    truncate(ctx.diff, LIMITS.prDiff),
    "",
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence, no array.",
  ]
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * Parse the model's overview response into a typed verdict. Tolerates:
 *   1. Clean JSON object
 *   2. JSON wrapped in a ```json ... ``` fence
 *   3. JSON embedded in surrounding prose ("Here's the overview: { ... }")
 *
 * Returns null when the output contains no valid JSON object that has
 * the required shape, so callers can fail loudly rather than post junk.
 */
export function parseOverviewResponse(text: string): PrOverviewVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const confidence = Number(obj.confidence)
  if (!Number.isFinite(confidence) || confidence < 1 || confidence > 5) return null

  const files = Array.isArray(obj.files)
    ? obj.files
        .filter(
          (f): f is Record<string, unknown> =>
            !!f && typeof f === "object" && !Array.isArray(f) && typeof (f as { path?: unknown }).path === "string"
        )
        .filter((f) => (f.path as string).trim().length > 0)
        .slice(0, 5)
        .map((f) => ({
          path: (f.path as string).trim(),
          score: Number.isFinite(Number(f.score))
            ? Math.max(1, Math.min(5, Math.round(Number(f.score))))
            : 3,
          overview: typeof f.overview === "string" ? f.overview.trim() : "",
          nextStep: typeof f.nextStep === "string" ? f.nextStep.trim() : "",
        }))
    : []

  const bullets = Array.isArray(obj.bullets)
    ? obj.bullets
        .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
        .map((b) => b.trim())
    : []

  const confidenceReason =
    typeof obj.confidenceReason === "string" ? obj.confidenceReason.trim() : ""

  return {
    summary,
    files,
    confidence: Math.round(confidence),
    confidenceReason,
    bullets,
  }
}

interface FormatArgs {
  verdict: PrOverviewVerdict
  isFirstRun: boolean
}

/**
 * Render the verdict into the markdown body posted on GitHub. The marker
 * on line 1 is what `findExistingOverviewComment` greps for to decide
 * between POST-new and PATCH-in-place.
 */
export function formatOverviewComment({ verdict, isFirstRun }: FormatArgs): string {
  const lines: string[] = [OVERVIEW_MARKER, ""]
  lines.push("## Sigilix Overview")
  lines.push("")
  lines.push(`### Summary${isFirstRun ? "" : " — latest push"}`)
  lines.push("")
  lines.push(verdict.summary)

  if (verdict.files.length > 0) {
    lines.push("")
    lines.push("### Important files")
    lines.push("")
    lines.push("| File | Score | Notes | Next step |")
    lines.push("| --- | :---: | --- | --- |")
    for (const f of verdict.files) {
      // Model output is interpolated into a markdown table — a literal
      // `|` in `overview` or `nextStep` would split the cell and corrupt
      // the table. Escape with `\|` per CommonMark.
      lines.push(
        `| \`${f.path}\` | ${f.score}/5 | ${escapeTableCell(f.overview) || "—"} | ${escapeTableCell(f.nextStep) || "—"} |`
      )
    }
  }

  lines.push("")
  lines.push(`### Confidence: ${verdict.confidence}/5`)
  if (verdict.confidenceReason) {
    lines.push("")
    lines.push(verdict.confidenceReason)
  }

  if (verdict.bullets.length > 0) {
    lines.push("")
    for (const b of verdict.bullets) {
      lines.push(`- ${b}`)
    }
  }

  return lines.join("\n")
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

async function findExistingOverviewComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  const items = await client.listIssueComments(owner, repo, prNumber)
  const hit = items.find((c) => typeof c.body === "string" && c.body.includes(OVERVIEW_MARKER))
  return hit ? hit.id : null
}

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
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
