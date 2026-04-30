// CodeRabbit comment evaluator. Triggered by `pull_request_review_comment`
// webhooks where the author is `coderabbitai*` — for each fresh CR
// comment, we ask Ollama Turbo to classify it (ACCEPT / SKIP_NITPICK /
// SKIP_OUT_OF_SCOPE / SKIP_FALSE_POSITIVE) using the team's house rules,
// then post an inline reply with the verdict. SKIP_* verdicts also
// resolve the review thread via GraphQL.
//
// Ported from rema-portal/tools/openclaw/triage-cr.mjs +
// lib/cr-evaluator.mjs. Per-comment dispatch (one webhook → one LLM
// call) instead of the original batch-of-N loop, so CR comments get
// answered individually as they arrive.
//
// App auth is required — we never want to post under a developer's
// PAT for CR replies. Without GITHUB_APP_ID + GITHUB_PRIVATE_KEY the
// handler aborts.

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import { GitHubClient, type ReviewComment } from "./github"
import { CR_EVAL_SCHEMA } from "./schemas"
import { parseFirstJsonValue } from "./json-extract"
import { CR_EVALUATION_PROMPT } from "../prompts/cr-evaluation"
import { deleteMarker, getMarker, setMarker } from "./dedupe"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const REPLY_MARKER_PREFIX = "<!-- openclaw:cr-eval:"
const FILE_CONTEXT_RADIUS = 20

const VALID_CLASSIFICATIONS = new Set([
  "ACCEPT",
  "SKIP_NITPICK",
  "SKIP_OUT_OF_SCOPE",
  "SKIP_FALSE_POSITIVE",
])

type Classification =
  | "ACCEPT"
  | "SKIP_NITPICK"
  | "SKIP_OUT_OF_SCOPE"
  | "SKIP_FALSE_POSITIVE"

const TAG_BY_CLASS: Record<Classification, string> = {
  ACCEPT: "ACCEPT",
  SKIP_NITPICK: "NITPICK — safe to skip",
  SKIP_OUT_OF_SCOPE: "OUT OF SCOPE",
  SKIP_FALSE_POSITIVE: "FALSE POSITIVE",
}

const LIMITS = {
  prBody: 4_000,
  commentBody: 2_000,
  fileContext: 1_500,
}

export interface CrVerdict {
  commentId: number
  classification: Classification
  headline: string
  body: string
  opener?: string
  location?: string
}

export interface TriageCrArgs {
  owner: string
  repo: string
  prNumber: number
  comment: ReviewComment
  installationId: number
  env: Env
}

export async function handleCrEval(args: TriageCrArgs): Promise<void> {
  const { owner, repo, prNumber, comment, installationId, env } = args
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[cr-eval] ${label} +${Date.now() - t0}ms`, {
      owner,
      repo,
      prNumber,
      commentId: comment.id,
    })
  }

  since("start")

  // Idempotency: KV marker keyed by comment id. Re-firing webhooks won't
  // double-reply. The on-thread `<!-- openclaw:cr-eval:{id} -->` marker
  // serves as a backup signal but KV is the authoritative gate.
  const dedupeKey = `cr-eval:${comment.id}`
  const existing = await getMarker(env.OPENCLAW_STATE, dedupeKey)
  if (existing) {
    console.log(`cr-eval already handled comment ${comment.id} — skipping`)
    return
  }

  const client = await buildClient(env, installationId)
  since("auth-ready")

  const meta = await client.getPullRequest(owner, repo, prNumber)
  since("pr-fetched")

  // ±20 lines of file context around the comment's anchor line. GitHub
  // doesn't include this in the webhook payload, so we fetch the file
  // contents at the comment's commit (not head — the comment was made
  // against a specific commit and its line numbers refer to that).
  const ref = comment.original_commit_id ?? comment.commit_id ?? meta.head.sha
  let fileContext: string | null = null
  if (comment.path) {
    const content = await client.getFileContent(owner, repo, comment.path, ref).catch(() => null)
    if (content != null) {
      const line = comment.line ?? comment.original_line ?? 0
      fileContext = extractFileContext(content, line)
    }
  }
  since("file-context-ready")

  const prompt = buildEvaluatorPrompt({
    prNumber,
    prTitle: meta.title,
    prBody: meta.body ?? "",
    comment,
    fileContext,
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  since("ollama-start")
  const response = await generate({
    model,
    prompt,
    apiKey: env.OLLAMA_API_KEY,
    format: CR_EVAL_SCHEMA as unknown as Record<string, unknown>,
  })
  since("ollama-done")

  const verdicts = parseEvaluatorResponse(response)
  if (!verdicts || verdicts.length === 0) {
    // Log only metadata — never raw model output (could echo PR
    // content / secrets into Worker logs).
    console.error("cr-eval verdict did not parse", {
      commentId: comment.id,
      responseLength: response.length,
    })
    return
  }
  const verdict = verdicts.find((v) => v.commentId === comment.id) ?? verdicts[0]
  if (!verdict) {
    console.error("cr-eval verdict array empty after parse", { commentId: comment.id })
    return
  }
  // Force the commentId to match the input — model occasionally echoes a
  // different number when it parses the prompt loosely. We're posting on
  // the inbound comment's thread regardless.
  verdict.commentId = comment.id

  const author = meta.user?.login ?? null
  const reply = formatVerdictReply(verdict, author)

  // Set the dedupe marker BEFORE posting so a retried webhook (Linear /
  // GitHub will retry on 5xx) can't slip a duplicate reply through if the
  // setMarker call lost a race after the post succeeded. If the post
  // itself fails, we roll the marker back so a manual retrigger is still
  // possible.
  await setMarker(env.OPENCLAW_STATE, dedupeKey, String(comment.id))
  try {
    await client.replyToReviewComment(owner, repo, prNumber, comment.id, reply)
    since("reply-posted")
    console.log(
      `cr-eval ${verdict.classification} replied on ${owner}/${repo}#${prNumber} comment ${comment.id}`
    )
  } catch (error) {
    await deleteMarker(env.OPENCLAW_STATE, dedupeKey)
    console.error("cr-eval reply post failed", {
      commentId: comment.id,
      error: String(error),
    })
    return
  }

  // Auto-resolve thread on SKIP_*. ACCEPT threads stay open so the human
  // reviewer can act on them. Failure is non-fatal — the reply is the
  // primary deliverable.
  if (verdict.classification.startsWith("SKIP_")) {
    try {
      await resolveThreadForComment(client, owner, repo, prNumber, comment.id)
      since("thread-resolved")
    } catch (error) {
      console.warn("cr-eval thread resolve failed", {
        commentId: comment.id,
        error: String(error),
      })
    }
  }
}

interface PromptCtx {
  prNumber: number
  prTitle: string
  prBody: string
  comment: ReviewComment
  fileContext: string | null
}

/**
 * Strip CodeRabbit's "🤖 Prompt for AI Agents" `<details>` block from
 * the comment body so CR's own meta-prompt doesn't leak into our model's
 * prompt. Pure — exported for tests.
 */
export function stripCRAgentPrompt(body: string): string {
  if (typeof body !== "string") return ""
  return body.replace(
    /<details>\s*<summary>[^<]*Prompt for AI Agents[^<]*<\/summary>[\s\S]*?<\/details>/gi,
    ""
  )
}

/**
 * Slice ±radius lines around `line` from `content`. 1-based line input;
 * returns the slice prefixed with line numbers so the model can quote
 * specific lines accurately. Pure — exported for tests.
 */
export function extractFileContext(
  content: string,
  line: number,
  radius: number = FILE_CONTEXT_RADIUS
): string {
  if (typeof content !== "string" || content.length === 0) return ""
  if (!Number.isFinite(line) || line <= 0) return ""
  const lines = content.split("\n")
  const start = Math.max(0, line - 1 - radius)
  const end = Math.min(lines.length, line + radius)
  const width = String(end).length
  const out: string[] = []
  for (let i = start; i < end; i++) {
    const number = String(i + 1).padStart(width, " ")
    const marker = i + 1 === line ? ">" : " "
    out.push(`${marker} ${number}: ${lines[i]}`)
  }
  return out.join("\n")
}

function buildEvaluatorPrompt(ctx: PromptCtx): string {
  const cleanedCommentBody = truncate(
    stripCRAgentPrompt(ctx.comment.body ?? ""),
    LIMITS.commentBody
  )
  const lineDisplay = ctx.comment.line ?? ctx.comment.original_line ?? "?"

  const commentBlock: string[] = [
    `[1] commentId=${ctx.comment.id} ${ctx.comment.path}:${lineDisplay}`,
    "Body:",
    cleanedCommentBody,
  ]
  if (ctx.fileContext && ctx.fileContext.length > 0) {
    commentBlock.push(
      "",
      `File context (${ctx.comment.path}, around line ${lineDisplay}):`,
      "```",
      truncate(ctx.fileContext, LIMITS.fileContext),
      "```"
    )
  }

  // No PR diff section here — the per-comment ±20-line file context above
  // is the surgical context the verdict actually needs, and the diff is
  // expensive to fetch + tokenize for the marginal benefit. See
  // upstream rema-portal triage-cr.mjs which dropped the diff for the
  // same reason.
  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    CR_EVALUATION_PROMPT.trim(),
    "",
    "[PR SCOPE]",
    `Number: #${ctx.prNumber}`,
    `Title: ${ctx.prTitle}`,
    "Body:",
    truncate(ctx.prBody || "(no description)", LIMITS.prBody),
    "",
    "[CR COMMENT TO EVALUATE]",
    commentBlock.join("\n"),
    "",
    "[OUTPUT]",
    "Return only the JSON array. No prose, no Markdown fence.",
  ]
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * Parse the model's evaluator output into typed verdicts. Tolerates
 * markdown fences, prose preambles, AND malformations like unescaped
 * newlines / trailing commas / smart quotes via jsonrepair. Returns
 * null when output isn't a JSON array of verdicts so callers can fail
 * loudly rather than post junk.
 */
export function parseEvaluatorResponse(text: string): CrVerdict[] | null {
  if (typeof text !== "string") return null
  const parsed = parseFirstJsonValue(text)
  // Some models occasionally return a single object even though the
  // prompt asks for an array. Tolerate that — wrap it.
  const arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null
  if (!arr) return null

  const result: CrVerdict[] = []
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") return null
    const obj = entry as Record<string, unknown>
    const commentId = Number(obj.commentId)
    const classification = obj.classification
    if (!Number.isFinite(commentId)) return null
    if (typeof classification !== "string" || !VALID_CLASSIFICATIONS.has(classification)) {
      return null
    }
    const headline = typeof obj.headline === "string" ? obj.headline.trim() : ""
    const bodyStr =
      typeof obj.body === "string"
        ? obj.body
        : typeof obj.reason === "string"
          ? obj.reason
          : ""
    const verdict: CrVerdict = {
      commentId,
      classification: classification as Classification,
      headline,
      body: bodyStr,
    }
    if (typeof obj.opener === "string" && obj.opener.trim().length > 0) {
      verdict.opener = obj.opener.trim()
    }
    if (typeof obj.location === "string" && obj.location.trim().length > 0) {
      verdict.location = obj.location.trim()
    }
    result.push(verdict)
  }
  return result
}

/**
 * Render a verdict as the inline reply body. Greptile-style: bracketed
 * tag, headline as the first line, technical body underneath. ACCEPTs
 * @-mention the PR author; SKIPs stay quiet. Suggestion blocks the
 * model emits in `body` are passed through verbatim — GitHub renders
 * them as one-click "Commit suggestion" UI.
 */
export function formatVerdictReply(verdict: CrVerdict, prAuthor: string | null): string {
  const tag = TAG_BY_CLASS[verdict.classification] ?? verdict.classification
  const headline = verdict.headline?.trim() || ""

  const lines: string[] = [`${REPLY_MARKER_PREFIX}${verdict.commentId} -->`]
  lines.push(`⚓ [${tag}] ${headline}`.trim())
  lines.push("")

  if (verdict.classification === "ACCEPT" && prAuthor && !prAuthor.toLowerCase().includes("[bot]")) {
    // Reject openers containing `@` — the LLM output is interpolated
    // nearly verbatim, and a stray `@username` would notify a real user.
    // Static phrase wins over an unsafe opener.
    const opener = verdict.opener?.trim()
    const safeOpener = opener && !opener.includes("@") ? opener : ""
    const trimmedOpener = safeOpener
      ? safeOpener.replace(/^[—–-]\s*/, "").replace(/[.!]+$/, "")
      : ""
    if (trimmedOpener) {
      lines.push(`@${prAuthor} — ${trimmedOpener}.`)
    } else {
      lines.push(`@${prAuthor} — flagging since this read holds up.`)
    }
    lines.push("")
  }

  if (verdict.body && verdict.body.trim().length > 0) {
    lines.push(verdict.body.trim())
  }

  if (verdict.classification === "ACCEPT" && verdict.location && verdict.location.trim().length > 0) {
    lines.push("")
    lines.push(`**Where:** \`${verdict.location.trim()}\``)
  }

  return lines.join("\n")
}

/**
 * Find the review thread containing `commentId` and resolve it via
 * GraphQL. The REST API doesn't expose thread resolution, so this is
 * the only path. We page through the first 100 review threads on the
 * PR — enough for any reasonable review. Beyond that we'd need
 * cursor-based pagination, but team PRs don't hit that.
 */
async function resolveThreadForComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number
): Promise<void> {
  const query = /* GraphQL */ `
    query($owner: String!, $repo: String!, $num: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $num) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 20) { nodes { databaseId } }
            }
          }
        }
      }
    }
  `
  const data = await client.graphql<{
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string
            isResolved: boolean
            comments: { nodes: Array<{ databaseId: number }> }
          }>
        }
      }
    }
  }>(query, { owner, repo, num: prNumber })

  const thread = data.repository.pullRequest.reviewThreads.nodes.find((t) =>
    t.comments.nodes.some((c) => c.databaseId === commentId)
  )
  if (!thread) return
  if (thread.isResolved) return

  const mutation = /* GraphQL */ `
    mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) {
        thread { id isResolved }
      }
    }
  `
  await client.graphql(mutation, { id: thread.id })
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

/**
 * Heuristic for the inbound webhook router: is this comment authored by
 * CodeRabbit? Pattern matches `coderabbitai`, `coderabbitai[bot]`, and
 * `coderabbit-staging[bot]`. Pure — exported for tests.
 */
export function isCodeRabbitAuthor(login: string | null | undefined): boolean {
  if (!login) return false
  return /^coderabbit/i.test(login)
}
