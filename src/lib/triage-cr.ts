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
import { CR_EVAL_SCHEMA, CR_PUSHBACK_SCHEMA } from "./schemas"
import { parseFirstJsonObject, parseFirstJsonValue } from "./json-extract"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { CR_EVALUATION_PROMPT } from "../prompts/cr-evaluation"
import { CR_PUSHBACK_PROMPT } from "../prompts/cr-pushback"
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

  // Codex-recommended: explicit file:line parser FIRST (high-confidence
  // verification of locations CR explicitly cites), THEN Vectorize
  // semantic retrieval (catches "same pattern elsewhere" findings the
  // model would otherwise dismiss as out-of-scope without proof).
  // Both feed the prompt so cr-eval can verify CR's claims about code
  // it doesn't have anchor context for.
  const citedFiles = await fetchCitedFileSlices({
    client,
    owner,
    repo,
    ref,
    body: comment.body ?? "",
    excludePaths: comment.path ? new Set([comment.path]) : new Set(),
  })
  since(`cited-files-${citedFiles.length}`)

  const retrievalText = `${comment.body ?? ""}\n\n${fileContext ?? ""}`
  const chunks = await retrieveChunks({
    text: retrievalText,
    teamKey: repo,
    env,
  })
  // Drop chunks pointing at files we've already loaded explicitly —
  // avoids duplicate context bloat.
  const explicitlyLoaded = new Set([
    ...(comment.path ? [comment.path] : []),
    ...citedFiles.map((c) => c.path),
  ])
  const filteredChunks = chunks.filter((c) => !explicitlyLoaded.has(c.path)).slice(0, 4)
  since(`retrieval-${filteredChunks.length}`)

  const prompt = buildEvaluatorPrompt({
    prNumber,
    prTitle: meta.title,
    prBody: meta.body ?? "",
    comment,
    fileContext,
    citedFiles,
    codebaseChunks: formatChunksForPrompt(filteredChunks),
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

  // No auto-resolve. Earlier versions called resolveReviewThread on
  // SKIP_* verdicts to close the thread automatically — the assumption
  // was that Arc's reasoning was authoritative. It isn't. Arc has been
  // wrong about SKIP_OUT_OF_SCOPE classifications (PR #14, the
  // mention.ts/index.ts consistency finding), so closing the thread
  // would seal off legitimate pushback from CR or a human reviewer.
  // Threads stay open; humans / CR can resolve them after weighing in.
}

interface PromptCtx {
  prNumber: number
  prTitle: string
  prBody: string
  comment: ReviewComment
  fileContext: string | null
  /** File slices CR explicitly cited as `path:line` in its comment body. */
  citedFiles: CitedFileSlice[]
  /** Pre-formatted Vectorize chunks (semantic similarity to the CR comment). */
  codebaseChunks: string | null
}

interface CitedFileSlice {
  path: string
  line: number
  content: string
}

/** Pattern: `path/like/this.ts:42` (extension-anchored to avoid grabbing arbitrary `word:digit` pairs). */
const CITATION_REGEX =
  /(?:^|[\s(`])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|mjs|cjs|js|jsx|rs|sql|md|py|go|toml|yml|yaml|json|sh|css|html))[:#]L?(\d+)/g

/**
 * Extract every `path/file.ext:N` reference in a CR comment body and
 * fetch ±20 lines of context around each one via the GitHub Contents
 * API. The whole point is verifying CR's claims about code that
 * isn't anchored where Arc is replying — without this, cr-eval has
 * no way to confirm "the same bug exists in lib/foo.ts:42" type
 * findings and falls back to SKIP_OUT_OF_SCOPE by default.
 *
 * Caps:
 *   - At most CITATION_MAX_FILES distinct paths (avoid runaway costs
 *     on a CR comment that name-drops dozens of files).
 *   - Skips paths in `excludePaths` so we don't redundantly fetch the
 *     file the comment is already anchored to.
 */
async function fetchCitedFileSlices({
  client,
  owner,
  repo,
  ref,
  body,
  excludePaths,
}: {
  client: GitHubClient
  owner: string
  repo: string
  ref: string
  body: string
  excludePaths: Set<string>
}): Promise<CitedFileSlice[]> {
  if (!body) return []
  const seen = new Set<string>()
  const targets: Array<{ path: string; line: number }> = []
  let match: RegExpExecArray | null
  while ((match = CITATION_REGEX.exec(body)) !== null) {
    const path = match[1]
    const line = Number(match[2])
    if (!path || excludePaths.has(path)) continue
    const key = `${path}:${line}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ path, line })
    if (targets.length >= CITATION_MAX_FILES) break
  }
  const out: CitedFileSlice[] = []
  for (const target of targets) {
    const content = await client.getFileContent(owner, repo, target.path, ref).catch(() => null)
    if (!content) continue
    const slice = extractFileContext(content, target.line)
    if (!slice) continue
    out.push({ path: target.path, line: target.line, content: slice })
  }
  return out
}

const CITATION_MAX_FILES = 4

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
  //
  // Cited files: file slices CR explicitly referenced in its body (e.g.,
  // "the same bug exists in lib/foo.ts:42"). The model needs to SEE
  // those slices to verify the claim instead of dismissing as out-of-
  // scope. Codebase chunks below add semantic-similarity context for
  // findings that don't cite a specific path but describe a pattern.
  if (ctx.citedFiles.length > 0) {
    commentBlock.push(
      "",
      "[CODE AT THE PATHS THIS CR COMMENT EXPLICITLY CITES]",
      "These are the file slices the CR comment is referring to. Use them to verify whether CR's claim about that location holds.",
    )
    for (const cite of ctx.citedFiles) {
      commentBlock.push(
        "",
        `--- ${cite.path}:${cite.line} ---`,
        "```",
        truncate(cite.content, LIMITS.fileContext),
        "```"
      )
    }
  }

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
  ]

  if (ctx.codebaseChunks) {
    sections.push(
      "",
      "[RELEVANT CODEBASE CHUNKS — semantic similarity to the CR comment]",
      "Use these to verify 'same pattern elsewhere' claims when CR didn't cite an exact path. Verify each is actually relevant before relying on it.",
      "",
      ctx.codebaseChunks
    )
  }

  sections.push(
    "",
    "[OUTPUT]",
    "Return only the JSON array. No prose, no Markdown fence."
  )
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

  // No hardcoded "@coderabbitai if I've misread this..." line. The
  // cr-evaluation prompt now instructs the model to organically
  // include @coderabbitai in its body on SKIP_* classifications when
  // the call is debatable, so CR can engage via its mention carve-out.
  // Letting the model phrase the invitation keeps the prose natural
  // instead of every SKIP_* reply ending with the same canned line.

  return lines.join("\n")
}

export interface TriageCrPushbackArgs {
  owner: string
  repo: string
  prNumber: number
  installationId: number
  comment: ReviewComment
  env: Env
}

/**
 * Handle a CR threaded reply that lands in a thread Arc started.
 * Arc has been wrong about SKIP_OUT_OF_SCOPE classifications, so when
 * CR pushes back we don't re-evaluate ourselves (would risk doubling
 * down). Instead we escalate to the PR author for a tiebreaker.
 *
 * Flow:
 *   1. Fetch all comments on the parent thread (via in_reply_to_id chain).
 *   2. Find Arc's most recent message in the thread.
 *   3. If Arc's last message was a SKIP_* verdict, post one short
 *      escalation reply @-mentioning the PR author. Otherwise no-op
 *      (CR replied to a thread Arc didn't start, or replied to an
 *      ACCEPT — neither warrants escalation).
 *
 * Idempotency: KV marker keyed on the CR reply's comment ID, so the
 * same webhook delivery doesn't escalate twice.
 */
interface CrPushbackVerdict {
  decision: "retract" | "escalate"
  message: string
}

/**
 * LLM-driven cr-pushback handler. CR replied to a thread Arc started.
 * Rather than templating a canned escalation, we feed the model the
 * full thread + cited file slices and let it decide whether to
 * retract Arc's earlier verdict or escalate to the PR author for a
 * tiebreaker — and write the actual reply prose itself. The
 * formatter just wraps the model's `message` with the dedupe marker.
 *
 * If Arc's last message in the thread wasn't a SKIP_* verdict, we
 * skip the LLM call and don't reply (no point retracting an ACCEPT
 * or jumping into an unrelated thread).
 */
export async function handleCrPushback(args: TriageCrPushbackArgs): Promise<void> {
  const { owner, repo, prNumber, installationId, comment, env } = args
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[cr-pushback] ${label} +${Date.now() - t0}ms`, {
      owner,
      repo,
      prNumber,
      commentId: comment.id,
    })
  }

  since("start")

  const dedupeKey = `cr-pushback:${comment.id}`
  if (await getMarker(env.OPENCLAW_STATE, dedupeKey)) {
    console.log(`cr-pushback already handled ${dedupeKey} — skipping`)
    return
  }

  const client = await buildClient(env, installationId)
  since("auth-ready")

  const [meta, allComments] = await Promise.all([
    client.getPullRequest(owner, repo, prNumber),
    client.listPullRequestReviewComments(owner, repo, prNumber).catch(() => [] as ReviewComment[]),
  ])
  since(`thread-fetched-${allComments.length}`)

  // Reconstruct the thread chronologically: walk in_reply_to chain back
  // to the root, then collect every reply pointing at that root.
  const rootId = findThreadRoot(comment, allComments)
  const threadComments = allComments
    .filter((c) => c.id === rootId || c.in_reply_to_id === rootId)
    .sort((a, b) => a.id - b.id)

  // Skip if Arc never weighed in (we'd be replying to a thread we
  // didn't start) or if Arc's last word was an ACCEPT (no pushback
  // gymnastics needed — let CR and the human carry the conversation).
  const arcMessages = threadComments.filter((c) => isArcCopilotLogin(c.user?.login ?? null))
  const lastArcMsg = arcMessages.at(-1)
  if (!lastArcMsg) {
    console.log(`cr-pushback: no Arc message in thread — skipping`)
    return
  }
  const wasSkip = /\[(NITPICK|OUT OF SCOPE|FALSE POSITIVE)/i.test(lastArcMsg.body ?? "")
  if (!wasSkip) {
    console.log(`cr-pushback: Arc's prior verdict wasn't SKIP_* — skipping`)
    return
  }

  const prAuthor = meta.user?.login ?? null

  // Pull file slices CR cites in its pushback so the model can verify
  // claims about code that isn't anchored where this thread lives.
  const ref = comment.original_commit_id ?? comment.commit_id ?? meta.head.sha
  const citedFiles = await fetchCitedFileSlices({
    client,
    owner,
    repo,
    ref,
    body: comment.body ?? "",
    excludePaths: comment.path ? new Set([comment.path]) : new Set(),
  })
  since(`cited-files-${citedFiles.length}`)

  const prompt = buildCrPushbackPrompt({
    prNumber,
    prTitle: meta.title,
    prBody: meta.body ?? "",
    prAuthor,
    threadComments,
    triggerComment: comment,
    citedFiles,
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  since("ollama-start")
  const response = await generate({
    model,
    prompt,
    apiKey: env.OLLAMA_API_KEY,
    format: CR_PUSHBACK_SCHEMA as unknown as Record<string, unknown>,
  })
  since("ollama-done")

  const verdict = parseCrPushbackResponse(response)
  if (!verdict) {
    console.error("cr-pushback verdict did not parse", {
      commentId: comment.id,
      responseLength: response.length,
    })
    return
  }

  // Mark BEFORE posting so a retried webhook doesn't double-post.
  await setMarker(env.OPENCLAW_STATE, dedupeKey, String(comment.id))
  try {
    const reply = formatPushbackReply(verdict)
    await client.replyToReviewComment(owner, repo, prNumber, comment.id, reply)
    since(`reply-posted-${verdict.decision}`)
    console.log(
      `cr-pushback ${verdict.decision} on ${owner}/${repo}#${prNumber} comment ${comment.id}`
    )
  } catch (error) {
    await deleteMarker(env.OPENCLAW_STATE, dedupeKey)
    console.error("cr-pushback reply post failed", {
      commentId: comment.id,
      error: String(error),
    })
  }
}

function findThreadRoot(comment: ReviewComment, all: ReviewComment[]): number {
  const byId = new Map(all.map((c) => [c.id, c]))
  let cur: ReviewComment | undefined = comment
  const seen = new Set<number>()
  while (cur && typeof cur.in_reply_to_id === "number") {
    if (seen.has(cur.id)) break // cycle guard
    seen.add(cur.id)
    const parent = byId.get(cur.in_reply_to_id)
    if (!parent) break
    cur = parent
  }
  return cur?.id ?? comment.id
}

function isArcCopilotLogin(login: string | null): boolean {
  if (!login) return false
  return /^arc(-copilot)?(\[bot\])?$/i.test(login) || /^openclaw(\[bot\])?$/i.test(login)
}

interface CrPushbackPromptCtx {
  prNumber: number
  prTitle: string
  prBody: string
  prAuthor: string | null
  threadComments: ReviewComment[]
  triggerComment: ReviewComment
  citedFiles: CitedFileSlice[]
}

function buildCrPushbackPrompt(ctx: CrPushbackPromptCtx): string {
  const sections: string[] = [
    "[SYSTEM INSTRUCTIONS]",
    CR_PUSHBACK_PROMPT.trim(),
    "",
    "[PR SCOPE]",
    `Number: #${ctx.prNumber}`,
    `Title: ${ctx.prTitle}`,
    `Author: ${ctx.prAuthor ?? "(unknown)"}`,
    "Body:",
    truncate(ctx.prBody || "(no description)", LIMITS.prBody),
    "",
    "[THREAD — chronological]",
  ]

  for (const c of ctx.threadComments) {
    const author = c.user?.login ?? "(unknown)"
    const isArc = isArcCopilotLogin(c.user?.login ?? null) ? " [Arc — that's you]" : ""
    sections.push(
      `--- ${author}${isArc} on ${c.path}:${c.line ?? c.original_line ?? "?"} ---`,
      truncate(stripCRAgentPrompt(c.body ?? ""), LIMITS.commentBody)
    )
  }

  sections.push("", `[CR'S TRIGGERING REPLY — comment ${ctx.triggerComment.id}]`)
  sections.push(truncate(stripCRAgentPrompt(ctx.triggerComment.body ?? ""), LIMITS.commentBody))

  if (ctx.citedFiles.length > 0) {
    sections.push("", "[CITED FILE SLICES]")
    for (const cite of ctx.citedFiles) {
      sections.push(
        `--- ${cite.path}:${cite.line} ---`,
        "```",
        truncate(cite.content, LIMITS.fileContext),
        "```"
      )
    }
  }

  sections.push(
    "",
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence."
  )
  return sections.join("\n")
}

/**
 * Parse the cr-pushback response into a typed verdict. Pure —
 * exported for tests.
 */
export function parseCrPushbackResponse(text: string): CrPushbackVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null
  const decision = obj.decision
  const message = typeof obj.message === "string" ? obj.message.trim() : ""
  if (decision !== "retract" && decision !== "escalate") return null
  if (!message) return null
  return { decision, message }
}

/**
 * Wrap the model's pushback message with a marker. The marker varies
 * by decision so future scans can tell retractions from escalations.
 * Pure — exported for tests.
 */
export function formatPushbackReply(verdict: CrPushbackVerdict): string {
  const marker = `<!-- openclaw:cr-pushback:${verdict.decision} -->`
  return `${marker}\n${verdict.message}`
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
