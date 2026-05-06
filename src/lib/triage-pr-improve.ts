// ARC-179: `/sigilix improve` handler. Runs a single-shot LLM pass
// that generates GitHub suggested-change blocks against the PR's
// current head SHA. Each suggestion gets posted as an inline review
// comment with a `\`\`\`suggestion` block — reviewers apply patches
// from the GitHub UI's "Commit suggestion" button.
//
// Differences from `handlePrReview`:
//   - Does NOT consume the ensemble daily budget (it's a separate
//     codepath — single model call, not 4 specialists + synthesizer)
//   - REQUEST_CHANGES is never used; the review event is always
//     COMMENT (suggestions are advisory, not blocking)
//   - Findings without anchorable suggestion blocks get dropped
//     silently — the whole point is apply-able patches, so prose-
//     only "advice" doesn't belong here (it goes to /review)
//   - No 7-day dedupe lock — reviewers can re-run /improve anytime
//   - Sensitive-repo gate IS enforced (we never send code to LLMs
//     for repos on the OPENCLAW_SENSITIVE_REPOS denylist)

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import {
  GitHubClient,
  type SubmitReviewBody,
  type SubmitReviewComment,
} from "./github"
import { parseFirstJsonObject } from "./json-extract"
import { PR_IMPROVE_SCHEMA } from "./schemas"
import { PR_IMPROVE_PROMPT } from "../prompts/pr-improve"
import {
  parseDiffToReviewablePositions,
  deriveSide,
  isPositionReviewable,
  type ReviewableMap,
} from "./diff-positions"
import { isRepoSensitive } from "./repo-policy"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"

const LIMITS = {
  prDiff: 80_000,
  prBody: 4_000,
}

export type ImproveCategory =
  | "naming"
  | "clarity"
  | "dead-code"
  | "error-handling"
  | "style"
  | "docs"

const IMPROVE_CATEGORIES: ReadonlySet<ImproveCategory> = new Set([
  "naming",
  "clarity",
  "dead-code",
  "error-handling",
  "style",
  "docs",
])

export interface PrImproveSuggestion {
  path: string
  line: number
  startLine?: number
  category: ImproveCategory
  headline: string
  body: string
}

export interface PrImproveVerdict {
  summary: string
  suggestions: PrImproveSuggestion[]
}

export interface TriagePrImproveArgs {
  owner: string
  repo: string
  prNumber: number
  installationId: number
  env: Env
}

export async function handlePrImprove(args: TriagePrImproveArgs): Promise<void> {
  const { owner, repo, prNumber, installationId, env } = args
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[pr-improve] ${label} +${Date.now() - t0}ms`, {
      owner, repo, prNumber,
    })
  }

  // Sensitive-repo gate: identical contract to ARC-183 — never fetch
  // the diff or call any model for denylisted repos.
  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(JSON.stringify({
      event: "pr-improve-skipped",
      reason: "sensitive_repo",
      owner, repo, prNumber,
    }))
    return
  }

  since("start")

  // Resolve head SHA up front so we can install the dedupe lock
  // BEFORE any LLM call. Two-step pattern matches handlePrReview's
  // try/finally release shape.
  const client = await buildClient(env, installationId)
  since("auth-ready")
  const meta = await client.getPullRequest(owner, repo, prNumber)
  const headSha = meta.head.sha

  // Per-(PR, headSha) dedupe lock (review-team B2). Without this,
  // a transient 5xx that retries the queue message would post the
  // suggestions twice. 1-hour TTL — long enough to outlive realistic
  // queue-retry chains, short enough that a reviewer can re-run
  // /sigilix improve later in the day on the same head if they want
  // a fresh pass after manually clearing it. The lock is released in
  // `finally` if we never made it to the post step.
  const dedupeKey = `pr-improve:${owner}/${repo}#${prNumber}@${headSha}`
  const seen = await env.OPENCLAW_STATE.get(dedupeKey)
  if (seen) {
    console.log(JSON.stringify({
      event: "pr-improve-skipped",
      reason: "already_ran",
      owner, repo, prNumber, headSha: headSha.slice(0, 7),
    }))
    return
  }
  await env.OPENCLAW_STATE.put(dedupeKey, String(Date.now()), {
    expirationTtl: 60 * 60, // 1 hour
  })

  let posted = false
  try {
    const diff = await client.getPullRequestDiff(owner, repo, prNumber)
    since("pr-fetched")

    const reviewable = parseDiffToReviewablePositions(diff)

    const prompt = buildPrompt({
      prNumber,
      title: meta.title,
      body: meta.body ?? "",
      diff,
    })

    const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    since("ollama-start")
    const response = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: PR_IMPROVE_SCHEMA as unknown as Record<string, unknown>,
    })
    since("ollama-done")

    const verdict = parsePrImproveResponse(response)
    if (!verdict) {
      console.error(JSON.stringify({
        event: "pr-improve-parse-failed",
        owner, repo, prNumber,
        responseLength: response.length,
      }))
      throw new Error("pr-improve verdict did not parse")
    }

    // Filter suggestions to those that anchor cleanly to the diff,
    // carry a non-empty `\`\`\`suggestion` block, and don't duplicate
    // an earlier suggestion at the same anchor.
    const valid = filterAnchorableSuggestions(verdict.suggestions, reviewable)
    since(`filtered ${valid.length}/${verdict.suggestions.length}`)

    if (valid.length === 0) {
      // No-suggestions branch (acceptance criterion): post a brief
      // top-level comment so the reviewer doesn't think the command
      // got dropped on the floor.
      const noOpBody = renderNoSuggestionsBody(verdict.summary)
      await client.createIssueComment(owner, repo, prNumber, noOpBody)
      posted = true
      since("no-suggestions-comment-posted")
      return
    }

    const reviewBody = buildImproveReview({
      verdict,
      validSuggestions: valid,
      headSha,
    })
    try {
      const submitted = await client.submitReview(owner, repo, prNumber, reviewBody)
      posted = true
      since(`improve-submitted-${submitted.state}`)
      console.log(JSON.stringify({
        event: "pr-improve-posted",
        owner, repo, prNumber,
        suggestionsRequested: verdict.suggestions.length,
        suggestionsPosted: valid.length,
        headSha: headSha.slice(0, 7),
      }))
    } catch (err) {
      // 422 fallback (review-team B1). GitHub rejects the entire
      // review on a single un-anchorable comment — even after our
      // filter pass, a model may have slipped through with a line
      // that's listed as reviewable but not actually applyable
      // (e.g., a binary file's hunk). Rather than fail the whole
      // pass and trigger queue retries (which would dup-post once
      // GitHub recovers), drop down to a single top-level comment
      // with the suggestions inlined as `\`\`\`suggestion` blocks
      // — they won't be one-click applyable but the reviewer can
      // copy-paste.
      const status = readHttpStatus(err)
      if (status === 422) {
        const fallbackBody = renderInlineFallbackBody(verdict.summary, valid, headSha)
        await client.createIssueComment(owner, repo, prNumber, fallbackBody)
        posted = true
        since("improve-422-fallback-posted")
        console.log(JSON.stringify({
          event: "pr-improve-422-fallback",
          owner, repo, prNumber,
          suggestionsRequested: verdict.suggestions.length,
          suggestionsPosted: valid.length,
          headSha: headSha.slice(0, 7),
        }))
        return
      }
      throw err
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: "pr-improve-error",
      err: err instanceof Error ? err.message : String(err),
      owner, repo, prNumber,
    }))
    throw err
  } finally {
    if (!posted) {
      // Release the dedupe lock so a queue retry can re-run. Same
      // pattern as handlePrReview — only the SUCCESS path keeps the
      // lock, so transient failures don't permanently block re-runs.
      await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
    }
  }
}

/**
 * Best-effort extraction of a numeric HTTP status from an error.
 * Sigilix's GitHubClient throws plain Errors with the status embedded
 * in the message string (`GitHub: 422 ...`); this matches that
 * pattern and tolerates other shapes.
 */
function readHttpStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null
  const m = err.message.match(/\b(\d{3})\b/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

interface PromptCtx {
  prNumber: number
  title: string
  body: string
  diff: string
}

function buildPrompt(ctx: PromptCtx): string {
  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    PR_IMPROVE_PROMPT.trim(),
    "",
    "[PR SCOPE]",
    `Number: #${ctx.prNumber}`,
    `Title: ${ctx.title}`,
    "Body:",
    truncate(ctx.body || "(no description)", LIMITS.prBody),
    "",
    "[PR DIFF]",
    truncate(ctx.diff, LIMITS.prDiff),
    "",
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence.",
  ]
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * Parse the model response into a verdict. Tolerant to lightly
 * malformed JSON via parseFirstJsonObject. Returns null on shape
 * failures so the caller can fail loudly (queue retry path).
 */
export function parsePrImproveResponse(text: string): PrImproveVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const suggestions: PrImproveSuggestion[] = []
  const raw = Array.isArray(obj.suggestions) ? obj.suggestions : []
  for (const s of raw) {
    if (!s || typeof s !== "object") continue
    const item = s as Record<string, unknown>
    const path = typeof item.path === "string" ? item.path.trim() : ""
    const line = Number(item.line)
    const headline = typeof item.headline === "string" ? item.headline.trim() : ""
    const body = typeof item.body === "string" ? item.body.trim() : ""
    const categoryRaw = typeof item.category === "string"
      ? item.category.trim().toLowerCase()
      : ""
    if (!path || !Number.isFinite(line) || line <= 0) continue
    if (!headline || !body) continue
    const category: ImproveCategory = IMPROVE_CATEGORIES.has(categoryRaw as ImproveCategory)
      ? (categoryRaw as ImproveCategory)
      : "clarity"
    const startLineRaw = Number(item.startLine)
    const validStart =
      Number.isFinite(startLineRaw) && startLineRaw > 0 && startLineRaw <= Math.floor(line)
        ? Math.floor(startLineRaw)
        : null
    const out: PrImproveSuggestion = {
      path,
      line: Math.floor(line),
      category,
      headline,
      body,
    }
    if (validStart != null && validStart < Math.floor(line)) {
      out.startLine = validStart
    }
    suggestions.push(out)
    if (suggestions.length >= 5) break
  }

  return { summary, suggestions }
}

/**
 * Drop suggestions whose anchor doesn't exist in the diff or whose
 * body lacks a `\`\`\`suggestion` block. Also dedupe suggestions
 * that target the same anchor — the first-seen wins, since the
 * model should already cap at 5 and any duplicate is a model-side
 * mistake.
 *
 * Hard rules (review-team B1 / H2 / CR PR #61 catch):
 *   - **RIGHT-side only.** `\`\`\`suggestion` blocks can't be applied
 *     against deleted lines (the file no longer has those lines).
 *     Drop any anchor whose primary side resolves to LEFT.
 *   - **startLine must also be in-diff and on the same side.**
 *     GitHub 422s the whole review on one bad anchor, so a model
 *     that picks a valid `line` but an out-of-hunk `startLine` would
 *     poison the whole batch.
 *   - **The full \[startLine..line\] range must be contiguous in the
 *     diff** — every line in between must be RIGHT-reviewable.
 *     `ReviewableMap` doesn't track hunk boundaries, but the absence
 *     of an intermediate line is exactly the signal that the range
 *     escapes its hunk. CR PR #61 catch: validating only the two
 *     endpoints would let a range jumping across hunks through, and
 *     `submitReview()` would 422 the whole batch.
 */
export function filterAnchorableSuggestions(
  raw: PrImproveSuggestion[],
  reviewable: ReviewableMap,
): PrImproveSuggestion[] {
  const seen = new Set<string>()
  const out: PrImproveSuggestion[] = []
  for (const s of raw) {
    const lineSide = deriveSide(reviewable, s.path, s.line)
    if (lineSide !== "RIGHT") continue
    if (!hasSuggestionBlock(s.body)) continue
    if (typeof s.startLine === "number" && s.startLine < s.line) {
      if (!isContiguousRightRange(reviewable, s.path, s.startLine, s.line)) {
        continue
      }
    }
    const key = `${s.path}:${s.startLine ?? s.line}-${s.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * Return true iff every line in `[startLine..line]` is RIGHT-reviewable
 * for the given path. Used by `filterAnchorableSuggestions` to ensure a
 * multi-line suggestion's range stays inside one hunk — `ReviewableMap`
 * records every reviewable position, so a missing intermediate line is
 * a sufficient signal that the range crosses a hunk boundary or
 * escapes the hunk altogether.
 *
 * Pure — exported for tests.
 */
export function isContiguousRightRange(
  reviewable: ReviewableMap,
  path: string,
  startLine: number,
  line: number,
): boolean {
  if (startLine > line) return false
  for (let l = startLine; l <= line; l++) {
    if (!isPositionReviewable(reviewable, path, l, "RIGHT")) return false
  }
  return true
}

/**
 * Return true iff the body contains at least one fenced
 * `\`\`\`suggestion ...\`\`\`` block with non-empty content. The model
 * is instructed to emit exactly one; we accept the first one we see
 * and ignore the rest.
 */
export function hasSuggestionBlock(body: string): boolean {
  if (typeof body !== "string") return false
  const match = body.match(/```suggestion\s*\n([\s\S]*?)```/)
  if (!match) return false
  const inner = match[1] ?? ""
  return inner.trim().length > 0
}

interface BuildImproveArgs {
  verdict: PrImproveVerdict
  validSuggestions: PrImproveSuggestion[]
  headSha: string
}

function buildImproveReview(args: BuildImproveArgs): SubmitReviewBody {
  const { verdict, validSuggestions, headSha } = args
  // Pre-condition: every entry in validSuggestions has already been
  // proved RIGHT-side anchorable by `filterAnchorableSuggestions`.
  // No need to re-derive side here.
  const comments: SubmitReviewComment[] = validSuggestions.map((s) => {
    const comment: SubmitReviewComment = {
      path: s.path,
      body: renderSuggestionComment(s),
      line: s.line,
      side: "RIGHT",
    }
    if (typeof s.startLine === "number" && s.startLine < s.line) {
      comment.start_line = s.startLine
      comment.start_side = "RIGHT"
    }
    return comment
  })

  const bodyParts = [
    `**Sigilix improve** — ${comments.length} apply-able suggestion${comments.length === 1 ? "" : "s"}.`,
    "",
    verdict.summary,
    "",
    `<sub>Run on \`${headSha.slice(0, 7)}\`. Suggestions are advisory — apply via the "Commit suggestion" button.</sub>`,
  ]

  return {
    body: bodyParts.join("\n"),
    event: "COMMENT",
    commit_id: headSha,
    comments,
  }
}

function renderSuggestionComment(s: PrImproveSuggestion): string {
  return `**\`${s.category}\`:** ${s.headline}\n\n${s.body}`
}

function renderNoSuggestionsBody(summary: string): string {
  return [
    "**Sigilix improve** — no high-confidence patches.",
    "",
    summary,
    "",
    "<sub>This pass focuses on style / clarity / refactor opportunities only. For correctness or security findings, use `/sigilix review`.</sub>",
  ].join("\n")
}

/**
 * Fallback body when GitHub rejects the inline-review submission with
 * a 422. We can't anchor patches to specific lines anymore, so we
 * inline them as code blocks the reviewer can copy-paste manually.
 */
export function renderInlineFallbackBody(
  summary: string,
  suggestions: PrImproveSuggestion[],
  headSha: string,
): string {
  const parts: string[] = [
    "**Sigilix improve** — inline fallback (could not anchor to diff).",
    "",
    summary,
    "",
  ]
  for (const s of suggestions) {
    const range = typeof s.startLine === "number" && s.startLine < s.line
      ? `${s.path}:${s.startLine}-${s.line}`
      : `${s.path}:${s.line}`
    parts.push(`### \`${s.category}\`: ${s.headline}`)
    parts.push("")
    parts.push(`Anchor: \`${range}\``)
    parts.push("")
    parts.push(s.body)
    parts.push("")
  }
  parts.push(`<sub>Run on \`${headSha.slice(0, 7)}\`. GitHub rejected the inline anchors; copy each \`\`\`suggestion block into a manual review comment to apply.</sub>`)
  return parts.join("\n")
}

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}
