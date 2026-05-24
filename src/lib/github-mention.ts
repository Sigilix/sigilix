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
import { indexNamespace } from "./repo-index-manifest"
import { arcInThreadAbove, bodyMentionsBot, getMentionTriggers, stripMentionFromBody } from "./mention"
import { runAgentLoop } from "./agent-loop"
import { createAgentTools } from "./agent-tools"
import { makeKvTelemetrySink } from "./agent-telemetry-kv"
import { AGENT_SYSTEM_PROMPT } from "../prompts/agent-system"
import { writeWithdrawal } from "./review-withdrawal-store"
import {
  LEGACY_REVIEW_BODY_MARKER,
  SIGILIX_BOT_LOGIN,
  SIGILIX_REVIEW_BODY_MARKER,
} from "./dismiss-prior-reviews"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const KV_PREFIX = "gh-mention"
const REPLY_MARKER = "<!-- sigilix:gh-mention-reply -->"
const MENTION_DEDUPE_TTL = 60 * 60 * 24 * 30
const DISMISS_IN_PROGRESS_TTL = 60 * 15
const DISMISS_IN_PROGRESS_KIND = "review-dismiss-in-progress"
const DISMISS_DEDUPE_KIND = "review-dismiss-result"

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

type ReviewDismissClient = Pick<GitHubClient, "listPullRequestReviews" | "dismissReview">

export type ReviewDismissResult =
  | { kind: "dismissed"; reviewId: number }
  | { kind: "not-found" }
  | { kind: "list-failed"; error: string }
  | { kind: "dismiss-failed"; reviewId: number; error: string }

export type ReviewDismissDedupeRecord =
  | { kind: typeof DISMISS_IN_PROGRESS_KIND; token?: string; createdAt?: number }
  | { kind: typeof DISMISS_DEDUPE_KIND; result: ReviewDismissResult; replyCommentId?: number }

interface GithubMentionVerdict {
  answer: string
  confidence: number
  abstain: boolean
  /**
   * SIG-160 PR3: "answer" (default) — just replying to a question.
   * "concede" — the human's pushback was right and we're withdrawing
   * the original finding. Only meaningful on `review-comment` surface
   * with an `inlineAnchor`; the handler persists a WithdrawalRecord
   * so subsequent reviews on the same PR don't re-emit the conceded
   * finding.
   */
  verdict: "answer" | "concede"
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
  const dismissDedupe = parseReviewDismissDedupeRecord(seen)
  if (dismissDedupe?.kind === DISMISS_IN_PROGRESS_KIND) {
    since("dismiss-already-in-progress")
    return
  }
  const pendingDismissReply = dismissDedupe && typeof dismissDedupe.replyCommentId !== "number"
    ? dismissDedupe
    : null
  if (seen && !pendingDismissReply) {
    since("already-replied")
    console.log(JSON.stringify({
      event: "github-mention-skipped",
      dedupe_system: "kv",
      reason: "already_replied",
      owner, repo, prNumber, surface, commentId,
    }))
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

  if (explicit && isReviewDismissRequest(question)) {
    let dismiss: ReviewDismissResult | null = null
    if (pendingDismissReply) {
      dismiss = pendingDismissReply.result
    } else {
      const lock = await acquireReviewDismissInProgressLock(env.OPENCLAW_STATE, kvKey)
      if (!lock.acquired) {
        const record = lock.record
        if (record?.kind === DISMISS_DEDUPE_KIND && typeof record.replyCommentId !== "number") {
          dismiss = record.result
        } else {
          since("dismiss-lock-not-acquired", { storedKind: record?.kind ?? null })
          return
        }
      } else {
        try {
          dismiss = await dismissLatestBlockingSigilixReview({
            client,
            owner,
            repo,
            prNumber,
          })
          await env.OPENCLAW_STATE.put(kvKey, serializeReviewDismissDedupeRecord(dismiss), {
            expirationTtl: MENTION_DEDUPE_TTL,
          })
        } catch (err) {
          await releaseReviewDismissInProgressLock(env.OPENCLAW_STATE, kvKey, lock.token)
          throw err
        }
      }
    }
    const newId = await postReply({
      client,
      owner,
      repo,
      prNumber,
      surface,
      threadRootId: args.threadRootId ?? commentId,
      body: formatReviewDismissReply(dismiss),
    })
    since("dismiss-reply-posted", { newId, result: dismiss.kind })
    await env.OPENCLAW_STATE
      .put(kvKey, serializeReviewDismissDedupeRecord(dismiss, newId), {
        expirationTtl: MENTION_DEDUPE_TTL,
      })
      .catch((err: unknown) => {
        console.warn("[gh-mention] dismiss reply-id persistence failed", {
          owner,
          repo,
          prNumber,
          surface,
          commentId,
          replyCommentId: newId,
          err: err instanceof Error ? err.message : String(err),
        })
      })
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

  // Codebase retrieval scoped to the repo. SIG-132: the Vectorize
  // namespace is `<owner>/<repo>` lowercased (multi-tenant isolation),
  // built via indexNamespace(). teamKeyToNamespace() lowercases as a
  // fallback, but we pass the fully-formed namespace here. Soft-fails to
  // empty when retrieval errors or the repo isn't indexed — the prompt
  // instructs the model to abstain rather than fabricate when chunks are
  // empty.
  const retrievalText = `${meta.title}\n\n${question}`
  const chunks = await retrieveChunks({
    text: retrievalText,
    teamKey: indexNamespace(owner, repo),
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
  let verdict: ReturnType<typeof parseGithubMentionResponse> = null

  if (env.OPENCLAW_AGENTIC_GITHUB_MODE === "on") {
    since("agent-loop-start")
    const loopResult = await runAgentLoop({
      model,
      apiKey: env.OLLAMA_API_KEY,
      env,
      surface: "github-mention",
      commentId: String(commentId),
      prNumber,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      initialUserMessage: buildGhAgentInitialUserMessage({
        owner,
        repo,
        prNumber,
        title: meta.title,
        question,
        askerHandle: sourceComment.author,
        inlineAnchor: surface === "review-comment" ? extractAnchor(sourceComment) : null,
        // CR PR #24 catch: forward existing thread context. Without it
        // the agent restarts the conversation cold and can't see what
        // earlier replies in the same review-thread already said.
        thread,
      }),
      tools: createAgentTools({
        env,
        surface: "github-mention",
        github: {
          githubClient: client,
          allowedRepos: [{ owner, repo }],
          defaultRef: meta.head?.ref ?? "main",
          installationId,
        },
      }),
      finalAnswerSchema: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
      telemetry: makeKvTelemetrySink(env.OPENCLAW_STATE),
      telemetryContext: {
        singleShotPrompt: prompt,
        singleShotSchema: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
        promptBuilderVersion: "github-mention-v1",
        promptBuilderSource: GITHUB_MENTION_PROMPT,
      },
      log: (event) => since(`agent-loop ${event.kind}`),
    })
    since("agent-loop-done", { ok: loopResult.ok })
    if (loopResult.ok) {
      verdict = parseGithubMentionResponse(JSON.stringify(loopResult.answer))
    } else {
      console.warn("[gh-mention] agent loop fell back to single-shot", {
        commentId,
        reason: loopResult.reason,
      })
      const response = await generate({
        model,
        prompt,
        apiKey: env.OLLAMA_API_KEY,
        format: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
      })
      verdict = parseGithubMentionResponse(response)
    }
  } else {
    since("ollama-start")
    const response = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
    })
    since("ollama-done")
    verdict = parseGithubMentionResponse(response)
  }

  if (!verdict) {
    console.error("gh-mention verdict did not parse", { commentId })
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

  // SIG-160 PR3: when the model explicitly concedes on an inline thread,
  // persist a WithdrawalRecord so the review-emit path drops the
  // re-emerging finding on the next push to this PR. Concedes are only
  // meaningful when (a) the surface is `review-comment` (we have a
  // pinned path+line), (b) the inlineAnchor parsed cleanly, and (c)
  // the thread contains the bot's original finding to snapshot the
  // body from. Failure modes log + continue — a missed withdrawal is
  // a missed suppression, not a correctness break.
  if (verdict.verdict === "concede" && surface === "review-comment") {
    const inlineAnchor = extractAnchor(sourceComment)
    const originalFindingBody = findOriginalFindingBody(thread)
    if (inlineAnchor && inlineAnchor.line !== null && originalFindingBody !== null) {
      // `meta.head?.sha` (PR HEAD at the moment the concession was decided)
      // is the audit-trail field; cast-narrow to string with a safe fallback.
      const prHeadSha = typeof meta.head?.sha === "string" ? meta.head.sha : ""
      await writeWithdrawal({
        env,
        owner,
        repo,
        prNumber,
        path: inlineAnchor.path,
        line: inlineAnchor.line,
        bodySnapshot: originalFindingBody,
        withdrawnByCommentId: newId,
        prHeadSha,
      })
    } else {
      console.warn(JSON.stringify({
        event: "review-withdrawal-skip-incomplete-context",
        owner, repo, pr_number: prNumber, comment_id: newId,
        has_anchor: inlineAnchor !== null && inlineAnchor.line !== null,
        has_finding_body: originalFindingBody !== null,
      }))
    }
  }

  await env.OPENCLAW_STATE.put(kvKey, String(newId), {
    expirationTtl: MENTION_DEDUPE_TTL,
  })
}

/**
 * SIG-160 PR3: scan the thread context for the bot's ORIGINAL inline
 * finding so we can snapshot its body into the WithdrawalRecord. The
 * thread is chronological (oldest first), and the original finding is
 * the first sigilix-authored entry that carries the
 * `<!-- sigilix:pr-review-finding -->` marker (vs a regular mention
 * reply, which carries `<!-- sigilix:gh-mention-reply -->`).
 */
function findOriginalFindingBody(thread: ThreadEntry[]): string | null {
  const FINDING_MARKER = "<!-- sigilix:pr-review-finding -->"
  for (const entry of thread) {
    if (entry.body.includes(FINDING_MARKER)) return entry.body
  }
  return null
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
  // SIG-160 PR3: default to "answer" when missing or invalid. Only
  // explicit "concede" triggers withdrawal persistence — a missing
  // field on an older deployed model output must not silently mark
  // every reply as a concession.
  const verdict: "answer" | "concede" = obj.verdict === "concede" ? "concede" : "answer"
  return { answer, confidence, abstain, verdict }
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

export function serializeReviewDismissInProgressRecord(token?: string): string {
  const record: ReviewDismissDedupeRecord = token
    ? { kind: DISMISS_IN_PROGRESS_KIND, token, createdAt: Date.now() }
    : { kind: DISMISS_IN_PROGRESS_KIND }
  return JSON.stringify(record)
}

export function serializeReviewDismissDedupeRecord(
  result: ReviewDismissResult,
  replyCommentId?: number,
): string {
  const record: ReviewDismissDedupeRecord = typeof replyCommentId === "number"
    ? { kind: DISMISS_DEDUPE_KIND, result, replyCommentId }
    : { kind: DISMISS_DEDUPE_KIND, result }
  return JSON.stringify(record)
}

export function parseReviewDismissDedupeRecord(value: string | null): ReviewDismissDedupeRecord | null {
  if (!value) return null
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as {
    kind?: unknown
    token?: unknown
    createdAt?: unknown
    result?: unknown
    replyCommentId?: unknown
  }
  if (record.kind === DISMISS_IN_PROGRESS_KIND) {
    return {
      kind: DISMISS_IN_PROGRESS_KIND,
      ...(typeof record.token === "string" && record.token.length > 0
        ? { token: record.token }
        : {}),
      ...(typeof record.createdAt === "number" ? { createdAt: record.createdAt } : {}),
    }
  }
  if (record.kind !== DISMISS_DEDUPE_KIND || !isReviewDismissResult(record.result)) {
    return null
  }
  if (typeof record.replyCommentId === "number") {
    return { kind: DISMISS_DEDUPE_KIND, result: record.result, replyCommentId: record.replyCommentId }
  }
  return { kind: DISMISS_DEDUPE_KIND, result: record.result }
}

type ReviewDismissLock =
  | { acquired: true; token: string }
  | { acquired: false; record: ReviewDismissDedupeRecord | null }

export async function acquireReviewDismissInProgressLock(
  kv: KVNamespace,
  key: string,
): Promise<ReviewDismissLock> {
  const before = parseReviewDismissDedupeRecord(await kv.get(key))
  if (before) return { acquired: false, record: before }

  const token = createReviewDismissLockToken()
  await kv.put(key, serializeReviewDismissInProgressRecord(token), {
    expirationTtl: DISMISS_IN_PROGRESS_TTL,
  })

  // Workers KV has no CAS primitive. The token readback gives us a
  // create-if-missing single-flight guard: only the request that can see
  // its own sentinel is allowed to perform the GitHub dismissal.
  const after = parseReviewDismissDedupeRecord(await kv.get(key))
  if (after?.kind === DISMISS_IN_PROGRESS_KIND && after.token === token) {
    return { acquired: true, token }
  }
  if (after?.kind !== DISMISS_DEDUPE_KIND) {
    await releaseReviewDismissInProgressLock(kv, key, token)
  }
  return { acquired: false, record: after }
}

export async function releaseReviewDismissInProgressLock(
  kv: KVNamespace,
  key: string,
  token: string,
): Promise<void> {
  try {
    const current = parseReviewDismissDedupeRecord(await kv.get(key))
    if (current?.kind === DISMISS_IN_PROGRESS_KIND && current.token === token) {
      await kv.delete(key)
    }
  } catch (err) {
    console.warn("[gh-mention] dismiss lock cleanup failed", {
      key,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

function createReviewDismissLockToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function isReviewDismissResult(value: unknown): value is ReviewDismissResult {
  if (typeof value !== "object" || value === null) return false
  const result = value as {
    kind?: unknown
    reviewId?: unknown
    error?: unknown
  }
  switch (result.kind) {
    case "dismissed":
      return typeof result.reviewId === "number"
    case "not-found":
      return true
    case "list-failed":
      return typeof result.error === "string"
    case "dismiss-failed":
      return typeof result.reviewId === "number" && typeof result.error === "string"
    default:
      return false
  }
}

export function isReviewDismissRequest(question: string): boolean {
  const normalized = question
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
  return normalized === "dismiss" ||
    normalized === "dismiss review" ||
    normalized === "dismiss this review"
}

export async function dismissLatestBlockingSigilixReview(args: {
  client: ReviewDismissClient
  owner: string
  repo: string
  prNumber: number
}): Promise<ReviewDismissResult> {
  let reviews: Awaited<ReturnType<ReviewDismissClient["listPullRequestReviews"]>>
  try {
    reviews = await args.client.listPullRequestReviews(args.owner, args.repo, args.prNumber)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(JSON.stringify({
      event: "gh-mention-dismiss-list-failed",
      owner: args.owner, repo: args.repo, prNumber: args.prNumber,
      err: error,
    }))
    return { kind: "list-failed", error }
  }

  const target = reviews
    .filter((r) =>
      r.state === "CHANGES_REQUESTED" &&
      r.user?.login === SIGILIX_BOT_LOGIN &&
      (r.body.includes(SIGILIX_REVIEW_BODY_MARKER) ||
        r.body.includes(LEGACY_REVIEW_BODY_MARKER)),
    )
    // Review IDs are monotonic; sort defensively instead of relying on
    // REST list ordering when choosing the latest blocking Sigilix review.
    .sort((a, b) => b.id - a.id)[0]

  if (!target) {
    console.log(JSON.stringify({
      event: "gh-mention-dismiss-no-blocking-review",
      owner: args.owner, repo: args.repo, prNumber: args.prNumber,
    }))
    return { kind: "not-found" }
  }

  try {
    await args.client.dismissReview(
      args.owner,
      args.repo,
      args.prNumber,
      target.id,
      "Dismissed by explicit @sigilix dismiss request.",
    )
    console.log(JSON.stringify({
      event: "gh-mention-dismissed-blocking-review",
      owner: args.owner, repo: args.repo, prNumber: args.prNumber,
      review_id: target.id,
    }))
    return { kind: "dismissed", reviewId: target.id }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(JSON.stringify({
      event: "gh-mention-dismiss-failed",
      owner: args.owner, repo: args.repo, prNumber: args.prNumber,
      review_id: target.id,
      err: error,
    }))
    return { kind: "dismiss-failed", reviewId: target.id, error }
  }
}

export function formatReviewDismissReply(result: ReviewDismissResult): string {
  switch (result.kind) {
    case "dismissed":
      return `${REPLY_MARKER}\nDismissed the latest blocking Sigilix review. GitHub should recalculate the PR review decision shortly.`
    case "not-found":
      return `${REPLY_MARKER}\nI couldn't find an active blocking Sigilix review to dismiss on this PR.`
    case "list-failed":
      return `${REPLY_MARKER}\nI saw the dismiss request, but couldn't list this PR's reviews from GitHub. Please retry in a moment.`
    case "dismiss-failed":
      return `${REPLY_MARKER}\nI found the blocking Sigilix review, but GitHub rejected the dismissal request. Please verify the GitHub App has permission to dismiss pull request reviews and retry.`
  }
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

interface GhAgentInitialMessageCtx {
  owner: string
  repo: string
  prNumber: number
  title: string
  question: string
  askerHandle: string
  inlineAnchor: InlineAnchor | null
  thread: ThreadEntry[]
}

function buildGhAgentInitialUserMessage(ctx: GhAgentInitialMessageCtx): string {
  const lines: string[] = [
    "[SURFACE] GitHub PR mention",
    `[REPO] ${ctx.owner}/${ctx.repo}`,
    `[PR] #${ctx.prNumber} — ${ctx.title}`,
    "",
    `[ASKER] @${ctx.askerHandle}`,
    "",
  ]
  if (ctx.inlineAnchor) {
    lines.push(
      "[INLINE ANCHOR]",
      `File: ${ctx.inlineAnchor.path}`,
      ctx.inlineAnchor.line ? `Line: ${ctx.inlineAnchor.line}` : "Line: (deleted/multi)",
      "",
    )
  }
  if (ctx.thread.length > 0) {
    lines.push("[THREAD CONTEXT — earlier replies in this thread, oldest first]")
    for (const entry of ctx.thread) {
      // Mirror the single-shot path's per-comment cap so a few long
      // replies can't blow the agent's context budget.
      lines.push(`- @${entry.author}: ${truncate(entry.body, LIMITS.threadComment)}`)
    }
    lines.push("")
  }
  lines.push(
    "[QUESTION]",
    ctx.question,
    "",
    "Use your tools to gather context. fetch_pr can pull this PR (or others the asker references) — owner/repo/number must match the allowed-repos set. retrieve_codebase queries the lowercased repo name. Final answer is the JSON shape defined by the system prompt.",
  )
  return lines.join("\n")
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
