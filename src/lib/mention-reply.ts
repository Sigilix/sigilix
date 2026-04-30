// Pipeline for replying to @-mentions on Linear comments.
// Mirrors triage.ts shape: fetch context → retrieve codebase chunks →
// build prompt → call Ollama → parse → post reply.
//
// Dedupe: each reply gets a marker that includes the source comment ID so
// re-firing the same Comment.create webhook (Linear retries on 5xx) doesn't
// produce a second reply. KV is the fast path; the comment-body marker
// scan is the fallback for cold-cache scenarios.

import { generate } from "./ollama"
import { LinearClient } from "./linear"
import { getAppActorToken } from "./linear-oauth"
import {
  bodyMentionsBot,
  getMentionTriggers,
  isLikelyBotAuthor,
  stripMentionFromBody,
} from "./mention"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { MENTION_REPLY_SCHEMA } from "./schemas"
import type { Env } from "../index"
import { MENTION_REPLY_PROMPT } from "../prompts/mention-reply"

const DEFAULT_MODEL = "glm-5.1:cloud"
// Note: no HTML-comment marker in the rendered body. Linear renders
// `<!-- ... -->` as visible plain text in comment bodies (unlike
// GitHub which hides them), so leaking a marker shows up as
// `<!-- openclaw:mention-reply src=abc -->` at the bottom of every
// reply. KV (`mention-reply:<commentId>`) is the authoritative dedupe.
const KV_PREFIX = "mention-reply"

const LIMITS = {
  threadComment: 1_000,
  recentComments: 10,
  questionChars: 4_000,
}

interface MentionVerdict {
  answer: string
  confidence: number
  abstain: boolean
}

export async function handleMention(commentId: string, env: Env): Promise<void> {
  const t0 = Date.now()
  const log = (label: string, extra?: Record<string, unknown>): void => {
    console.log(`[mention] ${label} +${Date.now() - t0}ms`, { commentId, ...extra })
  }

  log("start")

  // Idempotency — skip if we've already replied to this source comment.
  const kvKey = `${KV_PREFIX}:${commentId}`
  const seen = await env.OPENCLAW_STATE.get(kvKey)
  if (seen) {
    log("already-replied")
    return
  }

  const linear = new LinearClient(await buildAuth(env))
  const data = await linear.getCommentWithIssue(commentId)
  log("comment-fetched")
  if (!data) {
    console.warn("comment not found", { commentId })
    return
  }

  // Skip self — never reply to our own comments. Linear's webhook fires
  // for every Comment.create including the bot's own posts, so without
  // this guard the bot loops on its own replies forever.
  if (isLikelyBotAuthor(data.user?.displayName ?? data.user?.name ?? null)) {
    log("skip-bot-author")
    return
  }

  // Skip if the comment doesn't actually mention us. handleMention is
  // also called from the manual-trigger route which doesn't pre-check,
  // so this is the authoritative gate.
  const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
  if (!bodyMentionsBot(data.body, triggers)) {
    log("no-mention")
    return
  }

  const question = stripMentionFromBody(data.body, triggers).slice(0, LIMITS.questionChars)
  if (!question) {
    log("empty-question-after-strip")
    return
  }

  // Codebase retrieval scoped to the issue's team. Soft-fails to empty.
  const retrievalText = `${data.issue.title}\n\n${question}`
  const chunks = await retrieveChunks({
    text: retrievalText,
    teamKey: data.issue.team?.key ?? null,
    env,
  })
  log("retrieval-done", { chunks: chunks.length })

  const askerHandle = data.user?.displayName ?? data.user?.name ?? "there"
  const prompt = buildPrompt({
    issueIdentifier: data.issue.identifier,
    issueTitle: data.issue.title,
    issueBody: data.issue.description ?? "",
    askerHandle,
    question,
    recentComments: data.issue.comments.nodes,
    sourceCommentId: data.id,
    codebaseChunks: formatChunksForPrompt(chunks),
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  log("ollama-start")
  const response = await generate({
    model,
    prompt,
    apiKey: env.OLLAMA_API_KEY,
    format: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
  })
  log("ollama-done")

  const verdict = parseVerdict(response)
  if (!verdict) {
    console.error("mention verdict did not parse", {
      commentId,
      response: response.slice(0, 500),
    })
    return
  }

  const body = formatReply({ verdict, askerHandle })
  const newCommentId = await linear.createComment(data.issue.id, body)
  log("reply-posted", { newCommentId })

  // Mark KV so re-deliveries of the same Comment.create event don't
  // produce a duplicate reply. 30-day TTL — webhooks from Linear get
  // retried at most over a few hours, so this is generous.
  await env.OPENCLAW_STATE.put(kvKey, newCommentId, { expirationTtl: 60 * 60 * 24 * 30 })
}

interface PromptCtx {
  issueIdentifier: string
  issueTitle: string
  issueBody: string
  askerHandle: string
  question: string
  recentComments: Array<{
    id: string
    body: string
    createdAt: string
    user: { name: string | null; displayName: string | null } | null
  }>
  sourceCommentId: string
  codebaseChunks: string | null
}

function buildPrompt(ctx: PromptCtx): string {
  const recent = ctx.recentComments
    .filter((c) => c.id !== ctx.sourceCommentId)
    .slice(-LIMITS.recentComments)
    .map((c) => {
      const author = c.user?.displayName ?? c.user?.name ?? "(unknown)"
      const body = truncate(c.body ?? "", LIMITS.threadComment)
      return `[${author}] ${body}`
    })
    .join("\n\n---\n\n")

  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    MENTION_REPLY_PROMPT.trim(),
    "",
    "[SURFACE]",
    "Type: issue_comment",
    `Identifier: ${ctx.issueIdentifier}`,
    `Title: ${ctx.issueTitle}`,
    "Body:",
    truncate(ctx.issueBody || "(no description)", LIMITS.threadComment),
    "",
    "[ASKER]",
    `@${ctx.askerHandle}`,
    "",
    "[QUESTION]",
    ctx.question,
    "",
  ]

  if (recent) {
    sections.push("[RECENT THREAD CONTEXT — chronological]", recent, "")
  }

  if (ctx.codebaseChunks) {
    sections.push(
      "[RELEVANT CODEBASE CHUNKS]",
      "Verify each is actually relevant before citing — retrieval can return false positives.",
      "",
      ctx.codebaseChunks,
      ""
    )
  }

  sections.push("[OUTPUT]", "Return only the JSON object. No prose, no Markdown fence.")
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

function parseVerdict(text: string): MentionVerdict | null {
  let body = text.trim()
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1]) body = fence[1].trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const answer = typeof obj.answer === "string" ? obj.answer.trim() : ""
  if (!answer) return null
  const confidence = Number(obj.confidence)
  const abstain = Boolean(obj.abstain)
  return {
    answer,
    confidence:
      Number.isFinite(confidence) && confidence >= 1 && confidence <= 5
        ? Math.round(confidence)
        : 3,
    abstain,
  }
}

interface FormatArgs {
  verdict: MentionVerdict
  askerHandle: string
}

function formatReply({ verdict, askerHandle }: FormatArgs): string {
  const lines: string[] = []
  if (askerHandle && !askerHandle.toLowerCase().includes("[bot]")) {
    lines.push(`@${askerHandle} ⚓`)
    lines.push("")
  }
  lines.push(verdict.answer)
  return lines.join("\n")
}

async function buildAuth(env: Env): Promise<{ apiKey: string } | { oauthToken: string }> {
  if (env.LINEAR_OAUTH_CLIENT_ID && env.LINEAR_OAUTH_CLIENT_SECRET) {
    const token = await getAppActorToken(
      env.OPENCLAW_STATE,
      env.LINEAR_OAUTH_CLIENT_ID,
      env.LINEAR_OAUTH_CLIENT_SECRET
    )
    return { oauthToken: token }
  }
  return { apiKey: env.LINEAR_API_KEY }
}
