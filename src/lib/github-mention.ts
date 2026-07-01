// GitHub @-mention reply pipeline. When Sigilix is @-mentioned on a PR
// thread (top-level conversation comment OR an inline review comment),
// this handler fetches the PR + the surrounding thread, runs codebase
// retrieval, asks Ollama for a greptile-style verification reply, and
// posts the answer back on the right surface:
//
//   surface = "issue"           → POST /repos/{o}/{r}/issues/{n}/comments
//   surface = "review-comment"  → POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies
//
// Idempotency: KV-keyed on comment ID (30-day TTL); re-deliveries don't double-reply.

import { generate } from "@/src/shared/adapters/model"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import type { IssueComment, ReviewComment } from "@/src/shared/types/github"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import { GITHUB_MENTION_SCHEMA } from "@/src/shared/domain/schemas"
import { GITHUB_MENTION_PROMPT } from "@/src/prompts/github-mention"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { expandHitsToSymbols } from "./symbol-expansion"
import { mentionSymbolExpansionMode } from "./graph-flags"
import { indexNamespace } from "./repo-index-manifest"
import { arcInThreadAbove, bodyMentionsBot, getMentionTriggers, stripMentionFromBody } from "./mention"
import { runAgentLoop } from "./agent-loop"
import { createAgentTools } from "./agent-tools"
import { makeKvTelemetrySink } from "./agent-telemetry-kv"
import { AGENT_SYSTEM_PROMPT } from "@/src/prompts/agent-system"
import { writeWithdrawal } from "./review-withdrawal-store"
import { recordOutcome } from "@/src/features/precision-profile"
import {
  handleGithubMentionLearningsCommand,
  learningCommandDedupeKey,
  validGithubRepoId,
} from "./github-mention-learnings"
import { postGithubMentionQaReply } from "./github-mention-auto-learnings"
import { parseLearningsCommand, resolveLearningsMode } from "@/src/features/learnings"
import { parseFindingCategory, parseFindingFingerprint, parseFindingSeverity } from "./pr-finding-markers"
import { verifyAndSanitizeCitations } from "./citation-verifier"
export { parseFindingCategory } from "./pr-finding-markers"
import { type DismissReason } from "./dismiss-reasons"
import { recordDismissalMetric } from "./validation-metrics-client"
import type { Env } from "@/src/shared/types/env"
// Symbols the handler below calls directly from the relocated dismiss leaf.
import {
  DISMISS_DEDUPE_KIND,
  DISMISS_IN_PROGRESS_KIND,
  type ReviewDismissResult,
  acquireReviewDismissInProgressLock,
  dismissLatestBlockingSigilixReview,
  formatReviewDismissReply,
  isAuthorAllowedForReviewDismiss,
  parseDismissCommand,
  parseReviewDismissDedupeRecord,
  preferPersistedReason,
  releaseReviewDismissInProgressLock,
  serializeReviewDismissDedupeRecord,
} from "./github-mention-dismiss"
import { handleLinearTriageCommand } from "@/src/lib/github-mention-linear-triage"
export {
  type ReviewDismissDedupeRecord,
  type ReviewDismissResult,
  acquireReviewDismissInProgressLock,
  dismissLatestBlockingSigilixReview,
  formatReviewDismissReply,
  isAuthorAllowedForReviewDismiss,
  isReviewDismissRequest,
  parseDismissCommand,
  parseReviewDismissDedupeRecord,
  preferPersistedReason,
  releaseReviewDismissInProgressLock,
  serializeReviewDismissDedupeRecord,
  serializeReviewDismissInProgressRecord,
} from "./github-mention-dismiss"

const DEFAULT_MODEL = "glm-5.1:cloud"
const KV_PREFIX = "gh-mention"
const REPLY_MARKER = "<!-- sigilix:gh-mention-reply -->"
const MENTION_DEDUPE_TTL = 60 * 60 * 24 * 30

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
  /** Immutable GitHub repository id. Required for repo-scoped learnings commands. */
  repoId?: number
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
  const { owner, repo, prNumber, installationId, surface, commentId, repoId, env } = args
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
  const pendingDismissReply = dismissDedupe && typeof dismissDedupe.replyCommentId !== "number" ? dismissDedupe : null
  if (seen && !pendingDismissReply) {
    since("already-replied")
    console.log(
      JSON.stringify({
        event: "github-mention-skipped",
        dedupe_system: "kv",
        reason: "already_replied",
        owner,
        repo,
        prNumber,
        surface,
        commentId,
      }),
    )
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

  // Eye-emoji 👀 ack: best-effort, non-fatal; lets asker know we're working.
  const addReaction =
    surface === "issue" ? client.addReactionToIssueComment.bind(client) : client.addReactionToReviewComment.bind(client)
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
  const question = (explicit ? stripMentionFromBody(sourceComment.body, triggers) : sourceComment.body).slice(
    0,
    LIMITS.questionChars,
  )
  if (!question) {
    since("empty-question-after-strip")
    return
  }

  const dismissCommand = explicit ? parseDismissCommand(question) : null
  if (dismissCommand) {
    if (!isAuthorAllowedForReviewDismiss(sourceComment.authorAssociation)) {
      console.log(
        JSON.stringify({
          event: "gh-mention-dismiss-rejected",
          reason: "untrusted_author_association",
          author_association: sourceComment.authorAssociation?.toUpperCase() ?? null,
          login: sourceComment.author,
          owner,
          repo,
          prNumber,
          surface,
          commentId,
        }),
      )
      return
    }

    let dismiss: ReviewDismissResult | null = null
    // SIG-173: prefer the reason persisted at the original dismiss-time
    // over the current command's reason on a replay (see
    // `preferPersistedReason`). The fresh parse from `dismissCommand` is
    // the fallback for the first-write path where no record exists yet.
    let dismissReason: DismissReason = dismissCommand.reason
    if (pendingDismissReply) {
      dismiss = pendingDismissReply.result
      dismissReason = preferPersistedReason(pendingDismissReply, dismissCommand.reason)
    } else {
      const lock = await acquireReviewDismissInProgressLock(env.OPENCLAW_STATE, kvKey)
      if (!lock.acquired) {
        const record = lock.record
        if (record?.kind === DISMISS_DEDUPE_KIND && typeof record.replyCommentId !== "number") {
          dismiss = record.result
          dismissReason = preferPersistedReason(record, dismissCommand.reason)
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
          await env.OPENCLAW_STATE.put(kvKey, serializeReviewDismissDedupeRecord(dismiss, undefined, dismissReason), {
            expirationTtl: MENTION_DEDUPE_TTL,
          })
          // SIG-173: count the reason once per successful dismiss attempt
          // (kind === "dismissed"). Failures and not-found don't reflect
          // reviewer intent reliably enough to surface in the rollup.
          // Non-fatal: a metrics failure must never affect the reply.
          if (dismiss.kind === "dismissed") {
            await recordDismissalMetric(env, { reason: dismissReason }).catch((err: unknown) => {
              console.log(
                JSON.stringify({
                  event: "dismissal-metrics-record-error",
                  owner,
                  repo,
                  prNumber,
                  error: err instanceof Error ? err.message : String(err),
                }),
              )
            })
          }
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
      body: formatReviewDismissReply(dismiss, dismissReason),
    })
    since("dismiss-reply-posted", { newId, result: dismiss.kind, reason: dismissReason })
    await env.OPENCLAW_STATE.put(kvKey, serializeReviewDismissDedupeRecord(dismiss, newId, dismissReason), {
      expirationTtl: MENTION_DEDUPE_TTL,
    }).catch((err: unknown) => {
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

  const learningsCommand = explicit ? parseLearningsCommand(question) : null
  if (learningsCommand !== null) {
    const learningsMode = resolveLearningsMode(env.OPENCLAW_LEARNINGS_MODE)
    if (learningsMode === "off") {
      since("learnings-command-inert-off", { command: learningsCommand.kind })
      return
    }

    const subjectRepoId = validGithubRepoId(repoId)
    if (subjectRepoId === undefined) {
      console.log(
        JSON.stringify({
          event: "gh-mention-learning-command-skipped",
          reason: "missing_repo_id",
          command: learningsCommand.kind,
          owner,
          repo,
          prNumber,
          surface,
          commentId,
        }),
      )
      return
    }

    const learningDedupeKey = learningCommandDedupeKey(commentId)
    if (await env.OPENCLAW_STATE.get(learningDedupeKey)) {
      since("learnings-command-already-handled", { command: learningsCommand.kind })
      return
    }

    try {
      await handleGithubMentionLearningsCommand({
        client,
        env,
        owner,
        repo,
        prNumber,
        surface,
        commentId,
        sourceComment,
        subjectId: String(subjectRepoId),
        command: learningsCommand,
        ...(args.threadRootId !== undefined ? { threadRootId: args.threadRootId } : {}),
        dedupeKey: learningDedupeKey,
      })
      since("learnings-command-handled", { command: learningsCommand.kind })
    } catch (err) {
      // Best-effort: a learnings command must NEVER throw out of the webhook
      // path — that would re-enter the queue retry machinery on a transient GH
      // error. Log + swallow; the content-addressed learning id keeps the store
      // consistent across any partial-then-retried write (code-review P1).
      console.error(
        JSON.stringify({
          event: "gh-mention-learning-command-failed",
          command: learningsCommand.kind,
          owner,
          repo,
          prNumber,
          surface,
          commentId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    return
  }

  if (explicit) {
    const triageOutcome = await handleLinearTriageCommand({
      env,
      client,
      owner,
      repo,
      prNumber,
      commentId,
      authorLogin: sourceComment.author,
      authorAssociation: sourceComment.authorAssociation,
      question,
    })
    if (triageOutcome.handled) {
      if (triageOutcome.reply)
        await postReply({
          client,
          owner,
          repo,
          prNumber,
          surface,
          threadRootId: args.threadRootId ?? commentId,
          body: triageOutcome.reply,
        })
      since("linear-triage-done")
      return
    }
  }

  // Stage 2 — heavy fanout: PR meta + diff + thread context in parallel.
  // Reuses the cached review-comment list from the implicit-thread check.
  const [meta, diff, thread] = await Promise.all([
    client.getPullRequest(owner, repo, prNumber),
    client.getPullRequestDiff(owner, repo, prNumber),
    fetchThread(client, owner, repo, prNumber, surface, commentId, args.threadRootId, cachedReviewComments),
  ])
  since("github-fetched", { threadCount: thread.length })

  // Codebase retrieval scoped to the repo namespace (SIG-132). Soft-fails
  // to empty when the repo isn't indexed — model abstains rather than fabricates.
  const retrievalText = `${meta.title}\n\n${question}`
  const chunks = await retrieveChunks({
    text: retrievalText,
    teamKey: indexNamespace(owner, repo),
    env,
  })
  since("retrieval-done", { chunks: chunks.length })

  // The PR HEAD sha (or branch ref) — the ref every file body is fetched at.
  // Hoisted here so the SIG-407 symbol expander fetches bodies at the SAME ref
  // the citation verifier later uses.
  const citationRef =
    typeof meta.head?.sha === "string" && meta.head.sha.length > 0 ? meta.head.sha : (meta.head?.ref ?? "main")

  // SIG-407: symbol-aware retrieval. When the flag is `on`/`shadow` and we have
  // hits, expand each hit (path + line range) into its enclosing symbol body +
  // direct callers from the SIG-138 graph. `shadow` builds the block + telemeters
  // but injects NOTHING (output byte-identical to today); `on` prepends the block
  // above the raw chunks. `off`/unset never even queries the DO. The expander
  // never throws — a no-graph / fetch failure returns `{block:null}`, so the
  // mention path can only ever GAIN symbol context, never lose a chunk.
  const symbolMode = mentionSymbolExpansionMode(env)
  const formattedChunks = formatChunksForPrompt(chunks)
  let codebaseChunks = formattedChunks
  if (symbolMode !== "off" && chunks.length > 0) {
    const expansion = await expandHitsToSymbols({
      env,
      owner,
      repo,
      hits: chunks,
      fetchFileContent: (path) => client.getFileContent(owner, repo, path, citationRef),
    })
    since("symbol-expansion", {
      mode: symbolMode,
      injected: symbolMode === "on" && !!expansion.block,
      ...expansion.telemetry,
    })
    if (symbolMode === "on" && expansion.block) {
      // Additive: the symbol block goes ABOVE the raw chunks (never replaces
      // them — recall-safe). `formattedChunks` is null when chunks are empty or
      // all exceed the budget; in that case inject the block alone (joining with
      // "null" would leak the literal string into the prompt).
      codebaseChunks = formattedChunks ? `${expansion.block}\n\n${formattedChunks}` : expansion.block
    }
  }

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
    codebaseChunks,
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
      // SIG-212: `generate()` now returns `{ text, usage }`; this caller
      // only needs the text. Token-usage telemetry is wired through the
      // ensemble path (`runWithRetryAndFallback` → `emitModelAttempt`),
      // not this single-shot mention path.
      const { text: response } = await generate({
        model,
        prompt,
        apiKey: env.OLLAMA_API_KEY,
        format: GITHUB_MENTION_SCHEMA as unknown as Record<string, unknown>,
      })
      verdict = parseGithubMentionResponse(response)
    }
  } else {
    since("ollama-start")
    const { text: response } = await generate({
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

  const citationCheck = await verifyAndSanitizeCitations({
    answer: verdict.answer,
    ref: citationRef,
    fetchFileContent: (path, ref) => client.getFileContent(owner, repo, path, ref),
  })
  if (citationCheck.invalid.length > 0) {
    since("citation-verification-corrected", { invalid: citationCheck.invalid.length, ref: citationRef.slice(0, 12) })
    verdict = { ...verdict, answer: citationCheck.answer }
  }

  // Fold a captured QA learning into the SAME reply as a footer instead of
  // a second, separate confirmation comment (see github-mention-auto-learnings).
  const newId = await postGithubMentionQaReply({
    client,
    env,
    owner,
    repo,
    prNumber,
    surface,
    commentId,
    sourceComment,
    ...(repoId !== undefined ? { repoId } : {}),
    question,
    baseReplyBody: formatReply(verdict),
    threadRootId: args.threadRootId ?? commentId,
    post: (body) =>
      postReply({ client, owner, repo, prNumber, surface, threadRootId: args.threadRootId ?? commentId, body }),
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
      const prHeadSha = typeof meta.head?.sha === "string" ? meta.head.sha : ""
      const contentFingerprint = parseFindingFingerprint(originalFindingBody)
      const dismissedScore = parseFindingSeverity(originalFindingBody)
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
        ...(contentFingerprint ? { contentFingerprint } : {}),
        ...(dismissedScore !== undefined ? { score: dismissedScore } : {}),
      })
      if (contentFingerprint) {
        await recordOutcome(env, {
          repoId: `${owner}/${repo}`,
          category: parseFindingCategory(originalFindingBody),
          patternHash: contentFingerprint,
          outcome: "dismissed",
        }).catch(() => {
          /* non-fatal — telemetry must never break a dismissal */
        })
      }
    } else {
      console.warn(
        JSON.stringify({
          event: "review-withdrawal-skip-incomplete-context",
          owner,
          repo,
          pr_number: prNumber,
          comment_id: newId,
          has_anchor: inlineAnchor !== null && inlineAnchor.line !== null,
          has_finding_body: originalFindingBody !== null,
        }),
      )
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
  authorAssociation: string | null
  path?: string
  line?: number | null
  inReplyToId?: number
}

async function fetchSourceComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  surface: GhMentionSurface,
  commentId: number,
): Promise<SourceComment | null> {
  if (surface === "issue") {
    const all = await client.listIssueComments(owner, repo, prNumber)
    const hit = all.find((c) => c.id === commentId)
    if (!hit) return null
    return {
      id: hit.id,
      body: hit.body ?? "",
      author: hit.user?.login ?? "(unknown)",
      authorAssociation: hit.author_association ?? null,
    }
  }
  const all = await client.listPullRequestReviewComments(owner, repo, prNumber)
  const hit = all.find((c) => c.id === commentId)
  if (!hit) return null
  return {
    id: hit.id,
    body: hit.body ?? "",
    author: hit.user?.login ?? "(unknown)",
    authorAssociation: hit.author_association ?? null,
    path: hit.path,
    line: hit.line,
    ...(typeof hit.in_reply_to_id === "number" ? { inReplyToId: hit.in_reply_to_id } : {}),
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
  prefetchedReviewComments?: ReviewComment[] | null,
): Promise<ThreadEntry[]> {
  if (surface === "issue") {
    const all = await client.listIssueComments(owner, repo, prNumber)
    return all
      .filter((c) => c.id !== commentId)
      .slice(-LIMITS.threadComments)
      .map((c) => issueCommentToEntry(c))
  }

  const all = prefetchedReviewComments ?? (await client.listPullRequestReviewComments(owner, repo, prNumber))
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

function descendsTo(byId: Map<number, ReviewComment>, c: ReviewComment, rootId: number): boolean {
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
      "",
    )
  }

  sections.push("[ASKER]", `@${ctx.askerHandle}`, "", "[QUESTION]", ctx.question, "")

  if (ctx.thread.length > 0) {
    const block = ctx.thread.map((c) => `[${c.author}] ${truncate(c.body, LIMITS.threadComment)}`).join("\n\n---\n\n")
    sections.push("[THREAD CONTEXT — chronological]", block, "")
  }

  if (ctx.codebaseChunks) {
    sections.push(
      "[RELEVANT CODEBASE CHUNKS]",
      "Verify each is actually relevant before citing — retrieval can return false positives.",
      "",
      ctx.codebaseChunks,
      "",
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
    Number.isFinite(confidenceRaw) && confidenceRaw >= 1 && confidenceRaw <= 5 ? Math.round(confidenceRaw) : 3
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
 * detect Sigilix's own replies in a thread (e.g. for follow-up @-mentions
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

export async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
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
