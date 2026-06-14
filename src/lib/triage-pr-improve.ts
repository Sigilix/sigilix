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
//   - Findings without anchorable suggestion blocks are kept in the
//     review/comment summary with file:line context. Apply-able patches
//     still post inline; non-applyable advice is no longer silent.
//   - No 7-day dedupe lock — reviewers can re-run /improve anytime
//   - Sensitive-repo gate IS enforced (we never send code to LLMs
//     for repos on the OPENCLAW_SENSITIVE_REPOS denylist)

import { generate } from "@/src/shared/adapters/model"
import { GitHubClient, GitHubHttpError } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import type { SubmitReviewBody, SubmitReviewComment } from "@/src/shared/types/github"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import { PR_IMPROVE_SCHEMA } from "@/src/shared/domain/schemas"
import { PR_IMPROVE_PROMPT } from "@/src/prompts/pr-improve"
import {
  parseDiffToReviewablePositions,
  deriveSide,
  isContiguousRightRange,
  type ReviewableMap,
} from "@/src/shared/util/diff-positions"
export { isContiguousRightRange } from "@/src/shared/util/diff-positions"
import { isRepoSensitive } from "./repo-policy"
import { loadSigilixConfigSource, parseSigilixConfigSource, resolveCommandConfig, EMPTY_CONFIG } from "./sigilix-config"
import { postConfigErrorComment } from "./sigilix-config-error-comment"
import type { Env } from "@/src/shared/types/env"

const DEFAULT_MODEL = "glm-5.1:cloud"

const LIMITS = {
  prDiff: 80_000,
  prBody: 4_000,
}

export type ImproveCategory = "naming" | "clarity" | "dead-code" | "error-handling" | "style" | "docs"

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
      owner,
      repo,
      prNumber,
    })
  }

  // Sensitive-repo gate: identical contract to ARC-183 — never fetch
  // the diff or call any model for denylisted repos.
  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(
      JSON.stringify({
        event: "pr-improve-skipped",
        reason: "sensitive_repo",
        owner,
        repo,
        prNumber,
      }),
    )
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
    console.log(
      JSON.stringify({
        event: "pr-improve-skipped",
        dedupe_system: "kv",
        reason: "already_ran",
        owner,
        repo,
        prNumber,
        headSha: headSha.slice(0, 7),
      }),
    )
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

    // ARC-185/SIG-291: load repo config with detailed parse so we can post
    // a parse-error PR comment on user-invoked slash commands. On
    // parse failure: fire-and-forget the comment (idempotent per
    // head SHA) and continue with EMPTY_CONFIG (degraded mode).
    const configSource = await loadSigilixConfigSource(client, owner, repo, headSha)
    let sigilixConfig: typeof EMPTY_CONFIG = EMPTY_CONFIG
    if (configSource !== null) {
      const result = parseSigilixConfigSource(configSource)
      if (result.ok) {
        sigilixConfig = result.config
      } else {
        console.log(
          JSON.stringify({
            event: "command-config-parse-error",
            owner,
            repo,
            prNumber,
            command: "improve",
            reason: result.reason,
          }),
        )
        // Fire-and-forget — never block the user-invoked command.
        postConfigErrorComment({
          env,
          client,
          owner,
          repo,
          prNumber,
          headSha,
          reason: result.reason,
          raw: result.raw,
        }).catch((err) => {
          console.error(
            JSON.stringify({
              event: "command-config-error-comment-bubbled",
              err: err instanceof Error ? err.message : String(err),
              owner,
              repo,
              prNumber,
            }),
          )
        })
      }
    }
    // rawConfig === null → file missing or fetch failed → silent
    // EMPTY_CONFIG (same as loadSigilixConfig's null path).
    const commandConfig = resolveCommandConfig(sigilixConfig, "improve")

    const prompt = buildPrompt(
      {
        prNumber,
        title: meta.title,
        body: meta.body ?? "",
        diff,
      },
      commandConfig.promptAddendum,
    )

    // ARC-185: precedence — sigilix.json `commands.improve.model.primary`
    // > env.OPENCLAW_MODEL > DEFAULT_MODEL. Per-command fallback chain
    // (when override: true) is appended to the call list.
    const primaryModel = commandConfig.modelPrimary ?? env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    const modelChain = commandConfig.modelFallbacks.override
      ? [primaryModel, ...commandConfig.modelFallbacks.models]
      : [primaryModel]

    if (
      commandConfig.promptAddendum !== null ||
      commandConfig.modelPrimary !== null ||
      commandConfig.modelFallbacks.override
    ) {
      console.log(
        JSON.stringify({
          event: "command-config-resolved",
          owner,
          repo,
          prNumber,
          command: "improve",
          hasPromptAddendum: commandConfig.promptAddendum !== null,
          modelPrimary: commandConfig.modelPrimary,
          modelFallbacksCount: commandConfig.modelFallbacks.override ? commandConfig.modelFallbacks.models.length : 0,
        }),
      )
    }

    since("ollama-start")
    let verdict: ReturnType<typeof parsePrImproveResponse> = null
    let lastErr: unknown
    let modelUsed = primaryModel
    for (const m of modelChain) {
      modelUsed = m
      try {
        const { text: response } = await generate({
          model: m,
          prompt,
          apiKey: env.OLLAMA_API_KEY,
          format: PR_IMPROVE_SCHEMA as unknown as Record<string, unknown>,
        })
        const parsed = parsePrImproveResponse(response)
        if (parsed) {
          verdict = parsed
          break
        }
        console.error(
          JSON.stringify({
            event: "pr-improve-parse-failed",
            owner,
            repo,
            prNumber,
            model: m,
            responseLength: response.length,
          }),
        )
      } catch (err) {
        lastErr = err
        console.error(
          JSON.stringify({
            event: "pr-improve-call-failed",
            owner,
            repo,
            prNumber,
            model: m,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }
    since(`ollama-done (model=${modelUsed})`)
    if (!verdict) {
      throw new Error(
        `pr-improve verdict did not parse after ${modelChain.length} attempt(s); last error: ${lastErr instanceof Error ? lastErr.message : "parse-failed"}`,
      )
    }

    // Split suggestions into applyable inline patches and summary-only
    // fallbacks. Empty suggestion blocks are valid deletion patches.
    const partition = partitionImproveSuggestions(verdict.suggestions, reviewable)
    const valid = partition.valid
    const fallback = partition.fallback
    since(`filtered ${valid.length}/${verdict.suggestions.length}`)

    if (valid.length === 0) {
      if (fallback.length > 0) {
        await client.createIssueComment(
          owner,
          repo,
          prNumber,
          renderUnpostedImproveBody(verdict.summary, fallback, headSha),
        )
        posted = true
        since("unposted-suggestions-comment-posted")
        return
      }
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
      unpostedSuggestions: fallback,
      headSha,
    })
    try {
      const submitted = await client.submitReview(owner, repo, prNumber, reviewBody)
      posted = true
      since(`improve-submitted-${submitted.state}`)
      console.log(
        JSON.stringify({
          event: "pr-improve-posted",
          owner,
          repo,
          prNumber,
          suggestionsRequested: verdict.suggestions.length,
          suggestionsPosted: valid.length,
          headSha: headSha.slice(0, 7),
        }),
      )
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
        const fallbackBody = renderInlineFallbackBody(verdict.summary, [...valid, ...fallback], headSha)
        await client.createIssueComment(owner, repo, prNumber, fallbackBody)
        posted = true
        since("improve-422-fallback-posted")
        console.log(
          JSON.stringify({
            event: "pr-improve-422-fallback",
            owner,
            repo,
            prNumber,
            suggestionsRequested: verdict.suggestions.length,
            suggestionsPosted: valid.length,
            headSha: headSha.slice(0, 7),
          }),
        )
        return
      }
      throw err
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pr-improve-error",
        err: err instanceof Error ? err.message : String(err),
        owner,
        repo,
        prNumber,
      }),
    )
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
  // CodeRabbit catch on PR #87: prefer the typed `GitHubHttpError.status`
  // field over regex-matching the message string. The previous regex
  // `/\b(\d{3})\b/` could match digits from a URL path
  // (e.g. `/repos/.../pulls/422`) and silently misclassify a 5xx as
  // 4xx (or vice versa). Falling back to a `HTTP <NNN>`-anchored regex
  // keeps the fallback narrow enough to avoid URL-path false matches.
  if (err instanceof GitHubHttpError) return err.status
  if (!(err instanceof Error)) return null
  const m = err.message.match(/\bHTTP\s+(\d{3})\b/)
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

function buildPrompt(ctx: PromptCtx, addendum: string | null = null): string {
  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    PR_IMPROVE_PROMPT.trim(),
    ...(addendum ? ["", "[REPO-SPECIFIC GUIDANCE]", addendum] : []),
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
    const categoryRaw = typeof item.category === "string" ? item.category.trim().toLowerCase() : ""
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
 *   - **startLine must be <= line, in-diff, and on the same side.**
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
  return partitionImproveSuggestions(raw, reviewable).valid
}

export interface PartitionedImproveSuggestions {
  valid: PrImproveSuggestion[]
  fallback: PrImproveSuggestion[]
}

export function partitionImproveSuggestions(
  raw: PrImproveSuggestion[],
  reviewable: ReviewableMap,
): PartitionedImproveSuggestions {
  const seen = new Set<string>()
  const valid: PrImproveSuggestion[] = []
  const fallback: PrImproveSuggestion[] = []
  for (const s of raw) {
    const lineSide = deriveSide(reviewable, s.path, s.line)
    let anchorable = lineSide === "RIGHT" && hasSuggestionBlock(s.body)
    if (typeof s.startLine === "number") {
      if (s.startLine > s.line) {
        anchorable = false
      } else if (s.startLine < s.line) {
        if (!isContiguousRightRange(reviewable, s.path, s.startLine, s.line)) {
          anchorable = false
        }
      }
    }
    if (!anchorable) {
      fallback.push(s)
      continue
    }
    const key = `${s.path}:${s.startLine ?? s.line}-${s.line}`
    if (seen.has(key)) {
      fallback.push(s)
      continue
    }
    seen.add(key)
    valid.push(s)
  }
  return { valid, fallback }
}

/**
 * Return true iff the body contains at least one fenced
 * `\`\`\`suggestion ...\`\`\`` block. Empty content is valid and means
 * a deletion suggestion in GitHub's apply-suggestion semantics. The
 * model is instructed to emit exactly one; we accept the first one we
 * see and ignore the rest.
 */
export function hasSuggestionBlock(body: string): boolean {
  if (typeof body !== "string") return false
  return /```suggestion\s*\n[\s\S]*?```/.test(body)
}

interface BuildImproveArgs {
  verdict: PrImproveVerdict
  validSuggestions: PrImproveSuggestion[]
  unpostedSuggestions?: PrImproveSuggestion[]
  headSha: string
}

function buildImproveReview(args: BuildImproveArgs): SubmitReviewBody {
  const { verdict, validSuggestions, unpostedSuggestions = [], headSha } = args
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
  ]
  const unposted = renderUnpostedImproveSuggestions(unpostedSuggestions)
  if (unposted !== "") {
    bodyParts.push("", unposted)
  }
  bodyParts.push(
    "",
    `<sub>Run on \`${headSha.slice(0, 7)}\`. Suggestions are advisory — apply via the "Commit suggestion" button.</sub>`,
  )

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

export function renderUnpostedImproveSuggestions(suggestions: PrImproveSuggestion[]): string {
  if (suggestions.length === 0) return ""
  const parts = [
    "### Findings not posted inline",
    "",
    "These suggestions could not be represented as apply-able GitHub inline patches, so they are preserved here instead of being dropped.",
    "",
  ]
  for (const s of suggestions) {
    const range =
      typeof s.startLine === "number" && s.startLine < s.line
        ? `${s.path}:${s.startLine}-${s.line}`
        : `${s.path}:${s.line}`
    parts.push(`- **\`${s.category}\`: ${s.headline}** — \`${range}\``)
    parts.push("")
    parts.push(s.body)
    parts.push("")
  }
  return parts.join("\n").trimEnd()
}

function renderUnpostedImproveBody(summary: string, suggestions: PrImproveSuggestion[], headSha: string): string {
  return [
    "**Sigilix improve** — suggestions not posted inline.",
    "",
    summary,
    "",
    renderUnpostedImproveSuggestions(suggestions),
    "",
    `<sub>Run on \`${headSha.slice(0, 7)}\`. Suggestions are preserved with file:line anchors when GitHub inline application is not available.</sub>`,
  ].join("\n")
}

/**
 * Fallback body when GitHub rejects the inline-review submission with
 * a 422. We can't anchor patches to specific lines anymore, so we
 * inline them as code blocks the reviewer can copy-paste manually.
 */
export function renderInlineFallbackBody(summary: string, suggestions: PrImproveSuggestion[], headSha: string): string {
  const parts: string[] = ["**Sigilix improve** — inline fallback (could not anchor to diff).", "", summary, ""]
  for (const s of suggestions) {
    const range =
      typeof s.startLine === "number" && s.startLine < s.line
        ? `${s.path}:${s.startLine}-${s.line}`
        : `${s.path}:${s.line}`
    parts.push(`### \`${s.category}\`: ${s.headline}`)
    parts.push("")
    parts.push(`Anchor: \`${range}\``)
    parts.push("")
    parts.push(s.body)
    parts.push("")
  }
  parts.push(
    `<sub>Run on \`${headSha.slice(0, 7)}\`. GitHub rejected the inline anchors; apply any included \`\`\`suggestion blocks manually where present, and treat prose-only items as advisory.</sub>`,
  )
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
