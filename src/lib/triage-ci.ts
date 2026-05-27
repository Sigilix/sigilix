// CI failure triage pipeline. Triggered by `workflow_run` webhook on
// completed runs with conclusion=failure. Pulls failed jobs + their
// logs, the PR diff, file contents the log mentions, and (when the
// codebase index is populated) Vectorize chunks similar to the failure.
// Asks Ollama Turbo for a structured diagnosis and posts/updates a
// single sticky comment on the PR.
//
// Ported from rema-portal/tools/openclaw/triage-ci.mjs +
// lib/build-prompt.mjs. No `gh run view --log-failed` — Workers have
// no shell — so we use the Actions REST API: list jobs, fetch each
// failed job's plain-text log, concat them.

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import { GitHubClient, GitHubHttpError, type WorkflowJob } from "./github"
import { retrieveChunks } from "./retrieval"
import { indexNamespace } from "./repo-index-manifest"
import { CI_TRIAGE_PROMPT } from "../prompts/ci-triage"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const CI_MARKER = "<!-- sigilix:ci-triage -->"
// SIG-85: bilingual matcher for the openclaw→sigilix rebrand. Read both
// markers so the existing-comment lookup finds legacy stickies and
// edits them in place instead of creating duplicates. Drop the legacy
// half once all pre-2026-05-18 PRs close.
const LEGACY_CI_MARKER = "<!-- openclaw:ci-triage -->"
const DEDUPE_PREFIX = "ci-triage:"
const DEDUPE_TTL_SECONDS = 300
const MAX_FILES_FROM_LOG = 6
const MAX_FAILED_JOBS = 5

const LIMITS = {
  prDiff: 20_000,
  ciLog: 12_000,
  fileContext: 30_000,
  fileContextPerFile: 8_000,
  prBody: 4_000,
  relatedChunks: 16_000,
}

interface CiVerdict {
  raw: string
  confidence: "high" | "medium" | "low"
}

export interface TriageCiArgs {
  owner: string
  repo: string
  prNumber: number
  runId: number
  headSha: string
  installationId: number
  env: Env
}

export async function handleCiTriage(args: TriageCiArgs): Promise<void> {
  const { owner, repo, prNumber, runId, headSha, installationId, env } = args
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[ci-triage] ${label} +${Date.now() - t0}ms`, {
      owner,
      repo,
      prNumber,
      runId,
    })
  }

  since("start")

  // Concurrent-run guard. Two retried webhooks for the same workflow
  // run must not both reach the listIssueComments → no-marker branch.
  // Keyed on (prNumber, runId, headSha) — same run + same head = skip.
  // A subsequent push (different headSha) and a different failing run
  // (different runId) both produce different keys and re-run as expected.
  const dedupeKey = `${DEDUPE_PREFIX}${owner}/${repo}#${prNumber}@${headSha}/run/${runId}`
  if (await env.OPENCLAW_STATE.get(dedupeKey)) {
    console.log(JSON.stringify({
      event: "ci-triage-skipped",
      dedupe_system: "kv",
      reason: "already_running",
      owner, repo, prNumber, runId, headSha: headSha.slice(0, 7),
    }))
    return
  }
  await env.OPENCLAW_STATE.put(dedupeKey, String(Date.now()), {
    expirationTtl: DEDUPE_TTL_SECONDS,
  })

  try {
    await runCiTriage({
      owner,
      repo,
      prNumber,
      runId,
      headSha,
      installationId,
      env,
      since,
    })
  } finally {
    // Release on any exit path so queue retries can re-attempt.
    await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
  }
}

interface CiTriageInner {
  owner: string
  repo: string
  prNumber: number
  runId: number
  headSha: string
  installationId: number
  env: Env
  since: (label: string) => void
}

async function runCiTriage(args: CiTriageInner): Promise<void> {
  const { owner, repo, prNumber, runId, headSha, installationId, env, since } = args
  const client = await buildClient(env, installationId)
  since("auth-ready")

  const meta = await client.getPullRequest(owner, repo, prNumber)
  since("pr-fetched")

  // Stale-run guard. The webhook fires when a workflow run completes,
  // but by then the PR head may have moved (developer pushed again
  // while CI was running). Mixing an old failure log with the latest
  // PR diff produces a misleading diagnosis — the diff shows code that
  // the failure didn't actually run against. When the run's head SHA
  // doesn't match the PR head, skip rather than post nonsense.
  if (meta.head.sha !== headSha) {
    console.log(
      `ci-triage stale run on ${owner}/${repo}#${prNumber} — run head ${headSha.slice(0, 7)} != PR head ${meta.head.sha.slice(0, 7)}; skipping`
    )
    return
  }

  const failedJobs = await listFailedJobs(client, owner, repo, runId)
  if (failedJobs.length === 0) {
    console.log(`No failed jobs on run ${runId} — nothing to triage`)
    return
  }
  since(`failed-jobs-${failedJobs.length}`)

  const ciLog = await fetchFailedJobLogs(client, owner, repo, failedJobs)
  since(`logs-${ciLog.length}chars`)

  const diff = await client.getPullRequestDiff(owner, repo, prNumber)
  since("diff-fetched")

  // File context — pull the contents of files the failure log names so
  // the model can reason about the fix in context. Capped to a handful
  // to stay inside the prompt budget.
  const mentioned = extractMentionedFiles(ciLog).slice(0, MAX_FILES_FROM_LOG)
  const fileContexts: Array<{ path: string; content: string }> = []
  for (const path of mentioned) {
    const content = await client.getFileContent(owner, repo, path, headSha).catch(() => null)
    if (content != null) fileContexts.push({ path, content })
  }
  since(`file-context-${fileContexts.length}`)

  // Codebase retrieval — semantic similarity on the failure log + diff.
  // Soft-fails to no chunks if the index is empty / unconfigured.
  let relatedChunks: Array<{
    path: string
    lineStart: number
    lineEnd: number
    content: string
    score: number
  }> = []
  try {
    const chunks = await retrieveChunks({
      text: `${ciLog}\n\n${diff}`,
      teamKey: indexNamespace(owner, repo),
      env,
    })
    const excludePaths = new Set(fileContexts.map((f) => f.path))
    relatedChunks = chunks.filter((c) => !excludePaths.has(c.path)).slice(0, 5)
  } catch (error) {
    console.warn("ci-triage retrieval failed (continuing)", { error: String(error) })
  }
  since(`retrieval-${relatedChunks.length}`)

  const prompt = buildPrompt({
    prNumber,
    prTitle: meta.title,
    prBody: meta.body ?? "",
    prDiff: diff,
    ciLog,
    fileContexts,
    relatedChunks,
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  since("ollama-start")
  const { text: response } = await generate({
    model,
    prompt,
    apiKey: env.OLLAMA_API_KEY,
    temperature: 0.2,
  })
  since("ollama-done")

  const verdict = parseConfidence(response)
  if (verdict == null || verdict === "low") {
    console.log(
      `Skipping ci-triage post — confidence=${verdict ?? "unparsed"} on ${owner}/${repo}#${prNumber}`
    )
    return
  }

  const footer = `\n\n${CI_MARKER}\n_⚓ Auto-triage by Sigilix · model \`${model}\` · run \`${runId}\` · confidence \`${verdict}\`_`
  const body = response + footer

  const existing = await findExistingCiComment(client, owner, repo, prNumber)
  if (existing != null) {
    await client.updateIssueComment(owner, repo, existing, body)
    since("comment-updated")
    console.log(
      `ci-triage updated on ${owner}/${repo}#${prNumber} (run ${runId}, confidence ${verdict})`
    )
  } else {
    const created = await client.createIssueComment(owner, repo, prNumber, body)
    since("comment-created")
    console.log(
      `ci-triage created on ${owner}/${repo}#${prNumber} as comment ${created.id} (run ${runId}, confidence ${verdict})`
    )
  }
}

/**
 * Heuristic: extract distinct file paths the failure log mentions.
 * Looks for `<path>:<line>:<col>` and `<path>:<line>` patterns common to
 * TS / Vitest / ESLint output. Returns deduplicated paths in
 * first-mention order. Pure — exported for tests.
 */
export function extractMentionedFiles(log: string): string[] {
  if (typeof log !== "string" || log.length === 0) return []
  const pattern =
    /(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|mjs|js|jsx|rs|md|yml|yaml|json|sh)):(\d+)/g
  const seen = new Set<string>()
  const ordered: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(log)) !== null) {
    const path = match[1]
    if (path && !seen.has(path)) {
      seen.add(path)
      ordered.push(path)
    }
  }
  return ordered
}

/**
 * Parse the confidence rating out of the model's free-form response.
 * Strips markdown decorations first, then matches on the literal
 * "Confidence: <level>" line. Pure — exported for tests.
 */
export function parseConfidence(response: string): "high" | "medium" | "low" | null {
  if (typeof response !== "string") return null
  const stripped = response.replace(/[*_`]/g, "")
  const match = stripped.match(/Confidence:\s*(high|medium|low)\b/i)
  if (!match || !match[1]) return null
  const level = match[1].toLowerCase()
  if (level === "high" || level === "medium" || level === "low") return level
  return null
}

interface PromptCtx {
  prNumber: number
  prTitle: string
  prBody: string
  prDiff: string
  ciLog: string
  fileContexts: Array<{ path: string; content: string }>
  relatedChunks: Array<{
    path: string
    lineStart: number
    lineEnd: number
    content: string
    score: number
  }>
}

function buildPrompt(ctx: PromptCtx): string {
  const sections: string[] = [
    "[SYSTEM INSTRUCTIONS]",
    CI_TRIAGE_PROMPT.trim(),
    "",
    "[PR METADATA]",
    `Number: #${ctx.prNumber}`,
    `Title: ${ctx.prTitle}`,
    "",
    "Body:",
    truncate(ctx.prBody || "(no description)", LIMITS.prBody),
    "",
    "[PR DIFF (truncated)]",
    truncate(ctx.prDiff, LIMITS.prDiff),
    "",
    "[FAILED CI LOG (filtered to failed steps, truncated)]",
    truncate(ctx.ciLog, LIMITS.ciLog),
  ]

  if (ctx.fileContexts.length > 0) {
    sections.push("", "[AFFECTED FILE CONTEXT]")
    let remaining = LIMITS.fileContext
    for (const file of ctx.fileContexts) {
      if (remaining <= 0) break
      const slice = truncate(file.content, Math.min(remaining, LIMITS.fileContextPerFile))
      remaining -= slice.length
      sections.push(`--- ${file.path} ---`, slice, "")
    }
  }

  if (ctx.relatedChunks.length > 0) {
    sections.push(
      "",
      "[RELATED CODEBASE CONTEXT (semantic similarity to the failure)]",
      "These chunks were retrieved by embedding-based similarity to the failure log + diff. They may or may not be relevant — use them only if they help explain the root cause."
    )
    let remaining = LIMITS.relatedChunks
    for (const chunk of ctx.relatedChunks) {
      if (remaining <= 0) break
      const slice = truncate(chunk.content, Math.min(remaining, 4_000))
      remaining -= slice.length
      const span = `${chunk.path}:${chunk.lineStart}-${chunk.lineEnd}`
      sections.push(`--- ${span} (score=${chunk.score.toFixed(3)}) ---`, slice, "")
    }
  }

  sections.push("", "[OUTPUT]", "Produce the comment in the exact format specified above. No preamble.")
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

async function listFailedJobs(
  client: GitHubClient,
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowJob[]> {
  const jobs = await client.getWorkflowRunJobs(owner, repo, runId)
  return jobs.filter((j) => j.conclusion === "failure").slice(0, MAX_FAILED_JOBS)
}

/**
 * Fetch and concatenate plain-text logs from each failed job. Each block
 * is prefixed with `=== job: <name> ===` so the model can attribute log
 * lines back to a specific job. Logs that fail to fetch (missing perms,
 * 410 archived runs, etc.) get a placeholder line so we don't fail the
 * whole pipeline on one missing log.
 */
async function fetchFailedJobLogs(
  client: GitHubClient,
  owner: string,
  repo: string,
  jobs: WorkflowJob[]
): Promise<string> {
  const blocks: string[] = []
  for (const job of jobs) {
    blocks.push(`=== job: ${job.name} ===`)
    try {
      const log = await client.getWorkflowJobLog(owner, repo, job.id)
      blocks.push(log)
    } catch (error) {
      const status = error instanceof GitHubHttpError ? error.status : "?"
      blocks.push(`(failed to fetch log for job ${job.id}, HTTP ${status})`)
    }
    blocks.push("")
  }
  return blocks.join("\n")
}

async function findExistingCiComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  const items = await client.listIssueComments(owner, repo, prNumber)
  // SIG-85: bilingual matcher — pick up both `<!-- sigilix:ci-triage -->`
  // and the legacy `<!-- openclaw:ci-triage -->` stickies so legacy
  // stickies get edited in place instead of duplicated.
  const hit = items.find(
    (c) =>
      typeof c.body === "string" &&
      (c.body.includes(CI_MARKER) || c.body.includes(LEGACY_CI_MARKER)),
  )
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

// Type used internally — exported for tests.
export type { CiVerdict }
