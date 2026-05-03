// GitHub @-mention reply pipeline. When Arc is @-mentioned on a PR
// thread (top-level conversation comment OR an inline review comment),
// this handler fetches the PR + the surrounding thread, runs codebase
// retrieval, asks Ollama for a greptile-style verification reply, and
// posts the answer back on the right surface:
//
//   surface = "issue"           → POST /repos/{o}/{r}/issues/{n}/comments
//   surface = "review-comment"  → POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies
//
// Idempotency: KV-keyed on the source comment ID with a 30-day TTL so
// re-deliveries of the same Comment.create event don't double-reply.

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import {
  GitHubClient,
  type IssueComment,
  type ReviewComment,
} from "./github"
import { parseFirstJsonObject } from "./json-extract"
import { GITHUB_MENTION_SCHEMA } from "./schemas"
import { GITHUB_MENTION_PROMPT } from "../prompts/github-mention"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { arcInThreadAbove, bodyMentionsBot, getMentionTriggers, stripMentionFromBody } from "./mention"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const KV_PREFIX = "gh-mention"
const REPLY_MARKER = "<!-- openclaw:gh-mention-reply -->"

const LIMITS = {
  prDiff: 18_000,
  prBody: 3_000,
  threadComment: 1_200,
  threadComments: 12,
  questionChars: 4_000,
}

export type GhMentionSurface = "issue" | "review-comment"

export interface GithubMentionArgs {
  owner: string
  repo: string
  prNumber: number
  installationId: number
  surface: GhMentionSurface
  commentId: number
  /**
   * For "review-comment" surface — the comment to reply *under*. When
   * the asker's comment is a reply itself, this should be the thread
   * root (the comment with no `in_reply_to_id`). For "issue" surface
   * this is unused.
   */
  threadRootId?: number
  env: Env
}

interface GithubMentionVerdict {
  answer: string
  confidence: number
  abstain: boolean
}

export async function handleGithubMention(args: GithubMentionArgs): Promise<void> {
  const { owner, repo, prNumber, installationId, surface, commentId, env } = args
  const t0 = Date.now()
  const since = (label: string, extra?: Record<string, unknown>): void => {
    console.log(`[gh-mention] ${label} +${Date.now() - t0}ms`, {
      owner,
      repo,
      prNumber,
      surface,
      commentId,
      ...extra,
    })
  }

  since("start")

  const kvKey = `${KV_PREFIX}:${commentId}`
  const seen = await env.OPENCLAW_STATE.get(kvKey)
  if (seen) {
    since("already-replied")
    return
  }

  const client = await buildClient(env, installationId)
  since("auth-ready")

  // Stage 1 — cheap gate. Fetch ONLY the source comment (and, if we
  // need to evaluate implicit-thread on review-comment, the review
  // comment list for the chain walk). This keeps human-only review
  // replies from burning the full PR/diff/thread fanout, and makes
  // the 👀 ack land in seconds rather than after the heavy fetch.
  const sourceComment = await fetchSourceComment(client, owner, repo, prNumber, surface, commentId)
  if (!sourceComment) {
    console.warn("source comment not found", { commentId, surface })
    return
  }
  since("source-fetched")

  const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
  const explicit = bodyMentionsBot(sourceComment.body, triggers)

  // Implicit-thread: only relevant when there's no explicit mention,
  // and only on review-comment surface (top-level issue_comment has
  // no chain structure — see comment in src/lib/mention.ts:arcIn-
  // ThreadAbove). Reuses the paginated listPullRequestReviewComments
  // result later by passing it to fetchThread, so we don't refetch.
  let implicit = false
  let cachedReviewComments: ReviewComment[] | null = null
  if (!explicit && surface === "review-comment") {
    cachedReviewComments = await client.listPullRequestReviewComments(owner, repo, prNumber)
    implicit = arcInThreadAbove(cachedReviewComments, commentId)
  }
  if (!explicit && !implicit) {
    since("skip-no-mention-no-thread")
    return
  }

  // Eye-emoji "ack". Posts a 👀 reaction on the source comment so the
  // asker knows Arc saw the message before the LLM call returns
  // (Ollama Turbo is 30-90s typical). Best-effort — if the reaction
  // call fails for any reason we still proceed with the actual reply.
  // Fires NOW so the user sees it within ~1s of webhook delivery,
  // before the PR/diff fetch + Ollama call.
  const addReaction =
    surface === "issue"
      ? client.addReactionToIssueComment.bind(client)
      : client.addReactionToReviewComment.bind(client)
  await addReaction(owner, repo, commentId, "eyes").catch((error: unknown) => {
    console.warn("[gh-mention] eye-reaction failed (non-fatal)", {
      commentId,
      error: String(error),
    })
  })
  since("eye-reaction-posted", { explicit, implicit })

  // Strip the mention from the body before passing to the model. For
  // implicit-thread fires there's no mention to strip; the body is
  // already the question text.
  const question = (
    explicit ? stripMentionFromBody(sourceComment.body, triggers) : sourceComment.body
  ).slice(0, LIMITS.questionChars)
  if (!question) {
    since("empty-question-after-strip")
    return
  }

  // Stage 2 — heavy fanout. Now that we know we're going to reply,
  // fetch PR meta + diff + thread context in parallel. Reuse the
  // review-comment list from the implicit-thread check if we have
  // it (avoids re-paginating).
  const [meta, diff, thread] = await Promise.all([
    client.getPullRequest(owner, repo, prNumber),
    client.getPullRequestDiff(owner, repo, prNumber),
    fetchThread(
      client,
      owner,
      repo,
      prNumber,
      surface,
      commentId,
      args.threadRootId,
      cachedReviewComments
    ),
  ])
  since("github-fetched", { threadCount: thread.length })

  // Codebase retrieval scoped to the repo. The Vectorize namespace
  // matches the repo name lowercased (same convention scripts/index-
  // repo.mjs uses). teamKeyToNamespace() lowercases as a fallback,
  // but normalize at the boundary too so a case-sensitive entry in
  // OPENCLAW_TEAM_REPO_MAP can't accidentally collide with a mixed-
  // case repo name. Soft-fails to empty when retrieval errors or the
  // repo isn't indexed — the prompt instructs the model to abstain
  // rather than fabricate when chunks are empty.
  const retrievalText = `${meta.title}\n\n${question}`
  const chunks = await retrieveChunks({
    text: retrievalText,
    teamKey: repo.toLowerCase(),
    env,
  })
  since("retrieval-done", { chunks: chunks.length })

  const prompt = buildPrompt({
    surface,
    prNumber,
    title: meta.title,
    body: meta.body ?? "",
    diff,
    askerHandle: sourceComment.author,
    question,
    inlineAnchor: surface === "review-comment" ? extractAnchor(sourceComment) : null,
    thread,
    sourceCommentId: commentId,
    codebaseChunks: formatChunksForPrompt(chunks),
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  since("ollama-start")
  const response = await generate({
    model,
    prompt,
    apiKey: env.OLLAMA_API_KEY,
    format: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
  })
  since("ollama-done")

  const verdict = parseGithubMentionResponse(response)
  if (!verdict) {
    console.error("gh-mention verdict did not parse", {
      commentId,
      responseLength: response.length,
    })
    return
  }

  const replyBody = formatReply(verdict)
  const newId = await postReply({
    client,
    owner,
    repo,
    prNumber,
    surface,
    threadRootId: args.threadRootId ?? commentId,
    body: replyBody,
  })
  since("reply-posted", { newId })

  await env.OPENCLAW_STATE.put(kvKey, String(newId), {
    expirationTtl: 60 * 60 * 24 * 30, // 30 days
  })
}

interface SourceComment {
  id: number
  body: string
  author: string
  path?: string
  line?: number | null
}

async function fetchSourceComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  surface: GhMentionSurface,
  commentId: number
): Promise<SourceComment | null> {
  if (surface === "issue") {
    const all = await client.listIssueComments(owner, repo, prNumber)
    const hit = all.find((c) => c.id === commentId)
    if (!hit) return null
    return {
      id: hit.id,
      body: hit.body ?? "",
      author: hit.user?.login ?? "(unknown)",
    }
  }
  const all = await client.listPullRequestReviewComments(owner, repo, prNumber)
  const hit = all.find((c) => c.id === commentId)
  if (!hit) return null
  return {
    id: hit.id,
    body: hit.body ?? "",
    author: hit.user?.login ?? "(unknown)",
    path: hit.path,
    line: hit.line,
  }
}

interface ThreadEntry {
  author: string
  body: string
  createdAt?: string
}

async function fetchThread(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  surface: GhMentionSurface,
  commentId: number,
  threadRootId: number | undefined,
  /** Pre-fetched review comments — avoids re-paginating when the
   * caller already paid for `listPullRequestReviewComments` (e.g.
   * for the implicit-thread chain walk). Ignored for "issue" surface. */
  prefetchedReviewComments?: ReviewComment[] | null
): Promise<ThreadEntry[]> {
  if (surface === "issue") {
    const all = await client.listIssueComments(owner, repo, prNumber)
    return all
      .filter((c) => c.id !== commentId)
      .slice(-LIMITS.threadComments)
      .map((c) => issueCommentToEntry(c))
  }

  const all =
    prefetchedReviewComments ??
    (await client.listPullRequestReviewComments(owner, repo, prNumber))
  const byId = new Map<number, ReviewComment>()
  for (const c of all) byId.set(c.id, c)
  // Always walk up from whichever ID we have. The webhook's
  // `in_reply_to_id` points to the *immediate* parent, not necessarily
  // the thread root — replies to mid-chain comments would otherwise
  // omit the real root + everything above it from the prompt context.
  const startId = threadRootId ?? commentId
  const rootId = findThreadRootId(byId, startId) ?? startId
  // Thread = the root + every comment that descends to it via the
  // `in_reply_to_id` chain. GitHub flattens this — replies-to-replies
  // all carry `in_reply_to_id = root_id` in practice, but we walk the
  // chain to be safe.
  const inThread = all.filter((c) => c.id === rootId || descendsTo(byId, c, rootId))
  return inThread
    .filter((c) => c.id !== commentId)
    .slice(-LIMITS.threadComments)
    .map((c) => reviewCommentToEntry(c))
}

function issueCommentToEntry(c: IssueComment): ThreadEntry {
  return {
    author: c.user?.login ?? "(unknown)",
    body: c.body ?? "",
  }
}

function reviewCommentToEntry(c: ReviewComment): ThreadEntry {
  const anchor = c.path && c.line ? ` (${c.path}:${c.line})` : ""
  return {
    author: (c.user?.login ?? "(unknown)") + anchor,
    body: c.body ?? "",
  }
}

function findThreadRootId(byId: Map<number, ReviewComment>, id: number): number | null {
  if (!byId.has(id)) return null
  let curId = id
  // Walk up while we have an in_reply_to_id and can find that parent
  // in the map. Cap iterations to defend against pathological cycles.
  for (let i = 0; i < 32; i++) {
    const cur = byId.get(curId)
    if (!cur) return curId
    const parentId = cur.in_reply_to_id
    if (typeof parentId !== "number") return curId
    if (!byId.has(parentId)) return curId
    curId = parentId
  }
  return curId
}

function descendsTo(
  byId: Map<number, ReviewComment>,
  c: ReviewComment,
  rootId: number
): boolean {
  if (c.id === rootId) return true
  let curId = c.in_reply_to_id
  for (let i = 0; i < 32; i++) {
    if (typeof curId !== "number") return false
    if (curId === rootId) return true
    const next = byId.get(curId)
    if (!next) return false
    curId = next.in_reply_to_id
  }
  return false
}

interface InlineAnchor {
  path: string
  line: number | null
}

function extractAnchor(c: SourceComment): InlineAnchor | null {
  if (!c.path) return null
  return { path: c.path, line: c.line ?? null }
}

interface PromptCtx {
  surface: GhMentionSurface
  prNumber: number
  title: string
  body: string
  diff: string
  askerHandle: string
  question: string
  inlineAnchor: InlineAnchor | null
  thread: ThreadEntry[]
  sourceCommentId: number
  codebaseChunks: string | null
}

function buildPrompt(ctx: PromptCtx): string {
  const sections: string[] = [
    "[SYSTEM INSTRUCTIONS]",
    GITHUB_MENTION_PROMPT.trim(),
    "",
    "[SURFACE]",
    `Type: ${ctx.surface === "issue" ? "issue_comment" : "review_comment"}`,
    `PR: #${ctx.prNumber}`,
    `Title: ${ctx.title}`,
    "Body:",
    truncate(ctx.body || "(no description)", LIMITS.prBody),
    "",
    "[PR DIFF]",
    truncate(ctx.diff, LIMITS.prDiff),
    "",
  ]

  if (ctx.inlineAnchor) {
    sections.push(
      "[INLINE ANCHOR]",
      `File: ${ctx.inlineAnchor.path}`,
      ctx.inlineAnchor.line ? `Line: ${ctx.inlineAnchor.line}` : "Line: (deleted/multi)",
      ""
    )
  }

  sections.push("[ASKER]", `@${ctx.askerHandle}`, "", "[QUESTION]", ctx.question, "")

  if (ctx.thread.length > 0) {
    const block = ctx.thread
      .map((c) => `[${c.author}] ${truncate(c.body, LIMITS.threadComment)}`)
      .join("\n\n---\n\n")
    sections.push("[THREAD CONTEXT — chronological]", block, "")
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
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * Parse the model's response. Tolerates clean JSON, fenced JSON, AND
 * prose-wrapped JSON via balanced-brace extraction. Returns null on
 * shape errors. Pure — exported for tests.
 */
export function parseGithubMentionResponse(text: string): GithubMentionVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null

  const answer = typeof obj.answer === "string" ? obj.answer.trim() : ""
  if (!answer) return null
  const confidenceRaw = Number(obj.confidence)
  const confidence =
    Number.isFinite(confidenceRaw) && confidenceRaw >= 1 && confidenceRaw <= 5
      ? Math.round(confidenceRaw)
      : 3
  const abstain = Boolean(obj.abstain)
  return { answer, confidence, abstain }
}

/**
 * Wrap the model's answer with a dedupe marker so subsequent runs can
 * detect Arc's own replies in a thread (e.g. for follow-up @-mentions
 * the bot left in a previous turn). The marker is invisible on
 * GitHub — HTML comments don't render.
 */
export function formatReply(verdict: GithubMentionVerdict): string {
  return `${REPLY_MARKER}\n${verdict.answer}`
}

interface PostReplyArgs {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  surface: GhMentionSurface
  threadRootId: number
  body: string
}

async function postReply(args: PostReplyArgs): Promise<number> {
  const { client, owner, repo, prNumber, surface, threadRootId, body } = args
  if (surface === "issue") {
    const res = await client.createIssueComment(owner, repo, prNumber, body)
    return res.id
  }
  const res = await client.replyToReviewComment(owner, repo, prNumber, threadRootId, body)
  return res.id
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
