// Pipeline for replying to @-mentions on Linear comments.
// Mirrors triage.ts shape: fetch context → retrieve codebase chunks →
// build prompt → call Ollama → parse → post reply.
//
// Dedupe: each reply gets a marker that includes the source comment ID so
// re-firing the same Comment.create webhook (Linear retries on 5xx) doesn't
// produce a second reply. KV is the fast path; the comment-body marker
// scan is the fallback for cold-cache scenarios.

import { generate } from "./ollama"
import { LinearClient, buildLinearAuth } from "./linear"
import { markBotAuthoredComment, isBotAuthoredComment } from "./bot-authored-comments"
import {
  bodyMentionsBot,
  getMentionTriggers,
  isLikelyBotAuthor,
  stripMentionFromBody,
} from "./mention"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { indexNamespace, readRepoIndexManifest } from "./repo-index-manifest"
import { MENTION_REPLY_SCHEMA } from "./schemas"
import type { Env } from "../shared/types/env"
import { MENTION_REPLY_PROMPT } from "../prompts/mention-reply"
import { extractPullRequestRefs, type PrRef } from "./github-pr-refs"
import {
  listIndexedRepos,
  listTeamRepoMappings,
  parseTeamGithubRepo,
} from "./github-installation"
import { fetchPullRequestContext, type PrContext } from "./github-pr-context"
import { escapeXmlAttribute, escapeXmlText } from "./xml-escape"
import { runAgentLoop } from "./agent-loop"
import { createAgentTools } from "./agent-tools"
import { makeKvTelemetrySink } from "./agent-telemetry-kv"
import { AGENT_SYSTEM_PROMPT } from "../prompts/agent-system"
import { parseBranchNamespace } from "./index-branch"

const DEFAULT_MODEL = "glm-5.1:cloud"
// Note: no HTML-comment marker in the rendered body. Linear renders
// `<!-- ... -->` as visible plain text in comment bodies (unlike
// GitHub which hides them), so leaking a marker shows up as
// `<!-- sigilix:mention-reply src=abc -->` at the bottom of every
// reply. KV (`mention-reply:<commentId>`) is the authoritative dedupe.
const KV_PREFIX = "mention-reply"

const LIMITS = {
  threadComment: 1_000,
  recentComments: 10,
  questionChars: 4_000,
}
const MAX_PROMPT_VISIBLE_NAMESPACES = 50

export interface LinearAgentRepoScope {
  repo: string | null
  mappedRepo: string | null
  availableRepos: string[]
  status:
    | "unmapped"
    | "mapped_indexed"
    | "mapped_not_indexed"
    | "mapped_default_not_indexed"
}

export function linearRetrievalTeamKey(
  teamRepo: { owner: string; repo: string } | null,
): string | null {
  return teamRepo ? indexNamespace(teamRepo.owner, teamRepo.repo) : null
}

export async function resolveLinearAgentRepoScope(
  env: { OPENCLAW_STATE: KVNamespace; OPENCLAW_TEAM_GITHUB_REPO_MAP?: string | undefined },
  teamRepo: { owner: string; repo: string } | null,
): Promise<LinearAgentRepoScope> {
  if (!teamRepo) {
    // SIG-221: an unmapped Linear team should still see the workspace's
    // indexed codebase. Derive the workspace's known GitHub owners from
    // OPENCLAW_TEAM_GITHUB_REPO_MAP — every owner that ANY team in the
    // map points at is in-scope for this Linear workspace. This keeps
    // the tenant boundary (a workspace can't see an owner it has zero
    // team-mappings for) while removing the per-team mapping gate.
    const knownOwners = new Set<string>()
    for (const { owner } of listTeamRepoMappings(env.OPENCLAW_TEAM_GITHUB_REPO_MAP)) {
      knownOwners.add(owner.toLowerCase())
    }
    if (knownOwners.size === 0) {
      return { repo: null, mappedRepo: null, availableRepos: [], status: "unmapped" }
    }
    const fallbackAvailable = new Set<string>()
    for (const owner of knownOwners) {
      try {
        for (const repo of await listIndexedRepos(env, { owner, includeBranches: true })) {
          fallbackAvailable.add(repo)
        }
      } catch (err) {
        console.warn(JSON.stringify({
          event: "linear-agent-repo-scope-list-failed",
          owner,
          err: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    const availableRepos = Array.from(fallbackAvailable).sort((a, b) => a.localeCompare(b))
    return {
      repo: null,
      mappedRepo: null,
      availableRepos,
      status: "unmapped",
    }
  }
  const defaultRepo = indexNamespace(teamRepo.owner, teamRepo.repo)
  const available = new Set<string>()
  try {
    for (const repo of await listIndexedRepos(env, {
      owner: teamRepo.owner,
      includeBranches: true,
    })) {
      available.add(repo)
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "linear-agent-repo-scope-list-failed",
      owner: teamRepo.owner,
      repo: teamRepo.repo,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
  try {
    const exactManifest = await readRepoIndexManifest(env as Env, teamRepo.owner, teamRepo.repo)
    if (exactManifest.kind === "ok") available.add(defaultRepo)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "linear-agent-repo-scope-manifest-read-failed",
      owner: teamRepo.owner,
      repo: teamRepo.repo,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
  const availableRepos = Array.from(available).sort((a, b) => a.localeCompare(b))
  const defaultIndexed = available.has(defaultRepo)
  return {
    repo: defaultIndexed ? defaultRepo : null,
    mappedRepo: defaultRepo,
    availableRepos,
    status: defaultIndexed
      ? "mapped_indexed"
      : availableRepos.length > 0
        ? "mapped_default_not_indexed"
        : "mapped_not_indexed",
  }
}

interface MentionVerdict {
  answer: string
  confidence: number
  abstain: boolean
}

export interface HandleMentionOpts {
  /** SIG-225 — the reason the producer enqueued this job. The consumer
   *  uses it to decide whether to enforce the body-must-@-mention-us
   *  gate (`"mention"` path, today's default) or skip it (`"thread-
   *  followup"` path — the founder replied inside a thread Sigilix has
   *  already posted in, so no `@` is required). Defaults to `"mention"`
   *  if absent so existing callers and any redelivered pre-SIG-225
   *  jobs keep the legacy behavior. */
  triggerReason?: "mention" | "thread-followup"
}

/**
 * SIG-225 — pure gate-decision helper extracted from `handleMention` so
 * the branching is unit-testable without a Linear/KV/Ollama/GitHub mock
 * stack. The consumer (`handleMention`) calls this exactly once after
 * fetching the comment and uses the result to decide whether to
 * short-circuit at `[mention] no-mention` or continue with the
 * extracted question text.
 *
 * Routes:
 *   "mention" (legacy + default): the body MUST `bodyMentionsBot()`.
 *     This is the authoritative defense-in-depth gate that protected
 *     the consumer from spurious queue messages when the producer's
 *     pre-check was the only filter. If the body has no @-mention,
 *     returns `{ skip: "no-mention" }` and the caller bails.
 *
 *   "thread-followup" (SIG-225): the producer (webhook handler) has
 *     ALREADY verified the comment is a reply inside a thread Sigilix
 *     authored, via the parent-chain walk. The body intentionally has
 *     no @-mention — that's the whole point of the SIG-225 trigger.
 *     Enforcing the @-gate here would unconditionally drop every
 *     thread-followup job, which is exactly the bug the founder hit
 *     on the first prod test of SIG-225 (see commit `5bba8d6`). The
 *     strip step is skipped too — there's no mention to strip, so the
 *     full body (trimmed) becomes the question.
 */
export type MentionQuestionGate =
  | { skip: "no-mention" }
  | { skip: null; fullQuestion: string }

export function resolveMentionQuestion(args: {
  triggerReason: "mention" | "thread-followup"
  body: string
  triggers: ReturnType<typeof getMentionTriggers>
}): MentionQuestionGate {
  if (args.triggerReason === "thread-followup") {
    return { skip: null, fullQuestion: args.body.trim() }
  }
  if (!bodyMentionsBot(args.body, args.triggers)) {
    return { skip: "no-mention" }
  }
  return { skip: null, fullQuestion: stripMentionFromBody(args.body, args.triggers) }
}

/**
 * SIG-225 follow-up — pure helper that resolves the parent comment id
 * the bot should reply UNDER, given the source comment data fetched
 * via `LinearClient.getCommentWithIssue`.
 *
 * Contract:
 *   - source has `parent: { id: "X" }` → returns "X"  (thread reply)
 *   - source has `parent: null`        → returns undefined (top-level)
 *   - source has `parent: { id: "" }`  → returns undefined (defensive)
 *
 * Linear's thread model is FLAT: every reply in a thread shares the
 * same parentId (= the thread-root comment's id). Using the SOURCE
 * comment's parentId — NOT its own id — makes the bot's reply a
 * sibling of the user's reply under the same thread root, which is
 * how Linear's UI renders nested conversations.
 *
 * Extracted from `handleMention` so the branching is unit-testable
 * without a Linear/KV/Ollama/GitHub mock stack — addresses Sigilix
 * bot's "handleMention threading logic lacks test coverage" finding
 * on PR #200 by giving the plumbing a directly-testable surface.
 */
export interface ResolveReplyParentSource {
  parent: { id: string } | null
}

export function resolveReplyParentId(source: ResolveReplyParentSource): string | undefined {
  const id = source.parent?.id
  if (typeof id !== "string" || id.length === 0) return undefined
  return id
}

export async function handleMention(
  commentId: string,
  env: Env,
  opts: HandleMentionOpts = {},
): Promise<void> {
  const t0 = Date.now()
  const triggerReason = opts.triggerReason ?? "mention"
  const log = (label: string, extra?: Record<string, unknown>): void => {
    console.log(`[mention] ${label} +${Date.now() - t0}ms`, {
      commentId,
      triggerReason,
      ...extra,
    })
  }

  log("start")

  // Idempotency — skip if we've already replied to this source comment.
  const kvKey = `${KV_PREFIX}:${commentId}`
  const seen = await env.OPENCLAW_STATE.get(kvKey)
  if (seen) {
    log("already-replied")
    return
  }

  // SIG-225 — queue-consumer self-filter: catches the case where the
  // webhook handler raced past `isBotAuthoredComment` because of
  // Cloudflare KV's cross-POP eventual-consistency window. By the
  // time the consumer runs the queue-delivery delay has typically
  // surpassed propagation, so the stamp is visible here even if it
  // wasn't at webhook time.
  if (await isBotAuthoredComment(env.OPENCLAW_STATE, commentId)) {
    log("skip-bot-authored-tracker")
    return
  }

  const linear = new LinearClient(await buildLinearAuth(env))
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

  const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
  const gate = resolveMentionQuestion({ triggerReason, body: data.body, triggers })
  if (gate.skip === "no-mention") {
    log("no-mention")
    return
  }
  const fullQuestion = gate.fullQuestion
  const question = fullQuestion.slice(0, LIMITS.questionChars)
  if (!question) {
    log("empty-question-after-strip")
    return
  }

  // Linked-PR context: extract PR refs from the full pre-truncation
  // question text (NOT issueBody — a stale PR URL in the issue
  // description would poison context for unrelated follow-up questions).
  // Using the pre-truncation text ensures a long comment with a PR ref
  // at the end isn't silently stripped by the questionChars limit.
  // Each ref gets an independent fetch with isolated failure handling.
  const teamKey = data.issue.team?.key ?? null
  // SIG-134: this mapping is the Linear tenant boundary for agentic
  // codebase retrieval. Values must be explicit `{ owner, repo }`
  // objects so the agent can scope all indexed namespaces to the
  // requesting tenant owner before advertising or enforcing them.
  const teamRepo = parseTeamGithubRepo(env.OPENCLAW_TEAM_GITHUB_REPO_MAP, teamKey)
  const repoScope = await resolveLinearAgentRepoScope(env, teamRepo)
  const inferRepo = (): { owner: string; repo: string } | null => teamRepo
  const prRefs = extractPullRequestRefs(fullQuestion, inferRepo)
  const { contexts: linkedPrs, failures: linkedPrFailures } = await fetchLinkedPrs(prRefs, env)
  log("linked-prs", {
    refs: prRefs.length,
    fetched: linkedPrs.length,
    failures: linkedPrFailures.length,
  })

  // Codebase retrieval scoped to the issue's team. Soft-fails to empty.
  const retrievalText = `${data.issue.title}\n\n${question}`
  const retrievalTeamKey = linearRetrievalTeamKey(teamRepo)
  const chunks = retrievalTeamKey
    ? await retrieveChunks({
      text: retrievalText,
      teamKey: retrievalTeamKey,
      env,
    })
    : []
  log("retrieval-done", { chunks: chunks.length, namespace: retrievalTeamKey })

  const askerHandle = data.user?.displayName ?? data.user?.name ?? "there"
  const prompt = buildPrompt({
    issueIdentifier: data.issue.identifier,
    issueTitle: data.issue.title,
    issueBody: data.issue.description ?? "",
    askerHandle,
    question,
    recentComments: data.issue.comments.nodes,
    sourceCommentId: data.id,
    codebaseStatus: renderCodebaseRetrievalStatus(repoScope, chunks.length),
    codebaseChunks: formatChunksForPrompt(chunks),
    linkedPrs,
    linkedPrFailures,
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  let verdict: MentionVerdict | null = null

  if (env.OPENCLAW_AGENTIC_LINEAR_MODE === "on") {
    log("agent-loop-start")
    // Resolved once so the prompt's advisory list and the tool's
    // hard enforcement can't drift (CR PR #30 caught the gap where
    // the prompt advertised the universe but the tool didn't enforce
    // it — the model could still query unindexed namespaces).
    // ARC-239: `listIndexedRepos` is now KV-backed (reads
    // `repo-index-manifest:*` keys). The agent loop already runs in
    // an async context so the new `await` adds no surface cost.
    const loopResult = await runAgentLoop({
      model,
      apiKey: env.OLLAMA_API_KEY,
      env,
      surface: "linear-mention",
      commentId: data.id,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      initialUserMessage: buildAgentInitialUserMessage({
        issueIdentifier: data.issue.identifier,
        issueTitle: data.issue.title,
        issueBody: data.issue.description ?? "",
        askerHandle,
        question,
        // CR PR #24 catch: pass the resolved repo namespace so the
        // model knows which `repo` to pass to its only tool. Without
        // this the model has to guess; if the team→repo mapping is
        // missing it can't ground retrieval at all.
        // SIG-132: the namespace is `<owner>/<repo>` lowercased, matching
        // the `availableRepos` entries (which are KV-key suffixes).
        repo: repoScope.repo,
        mappedRepo: repoScope.mappedRepo,
        repoStatus: repoScope.status,
        // The full set of indexed namespaces the agent is allowed to
        // query. The team's primary repo (above) is the default, but
        // the model picks a different namespace from this list when the
        // issue is clearly about another repo (e.g. ARC-team issue
        // about the website).
        availableRepos: repoScope.availableRepos,
      }),
      tools: createAgentTools({
        env,
        surface: "linear-mention",
        // Same set the prompt advertises — enforced inside
        // retrieve_codebase so a hallucinated namespace gets a
        // recoverable error with the valid choices, not a silent
        // empty-result.
        allowedRepos: repoScope.availableRepos,
        // Linear surface — no GitHub auth/repo identity, so no fetch_pr/read_file_lines.
      }),
      finalAnswerSchema: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
      telemetry: makeKvTelemetrySink(env.OPENCLAW_STATE),
      telemetryContext: {
        singleShotPrompt: prompt,
        singleShotSchema: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
        promptBuilderVersion: "linear-mention-reply-v7",
        promptBuilderSource: MENTION_REPLY_PROMPT,
      },
      log: (event) => log(`agent-loop ${event.kind}`),
    })
    log("agent-loop-done", { ok: loopResult.ok })
    if (loopResult.ok) {
      verdict = parseVerdict(JSON.stringify(loopResult.answer))
    } else {
      // Loop failed for any reason — fall back to single-shot using the
      // EXISTING prompt and schema, no drift. This is the structural
      // contract from the spec: agent loop's value is captured in the
      // happy path; failure means we degrade to the proven path.
      console.warn("[mention-reply] agent loop fell back to single-shot", {
        commentId,
        reason: loopResult.reason,
      })
      const { text: response } = await generate({
        model,
        prompt,
        apiKey: env.OLLAMA_API_KEY,
        format: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
      })
      verdict = parseVerdict(response)
    }
  } else {
    log("ollama-start")
    const { text: response } = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
    })
    log("ollama-done")
    verdict = parseVerdict(response)
  }

  if (!verdict) {
    console.error("mention verdict did not parse", { commentId })
    return
  }

  const body = formatReply({ verdict, askerHandle })
  const replyParentId = resolveReplyParentId(data)
  const newCommentId = await linear.createComment(data.issue.id, body, replyParentId)
  log("reply-posted", { newCommentId, replyParentId: replyParentId ?? null })

  // SIG-225: stamp the bot-authored commentId so Linear's
  // Comment.create webhook for THIS new reply is filtered as self by
  // the webhook handler. Was the entire fix point of SIG-225 — the
  // legacy `isBotHandle(displayName)` filter missed when Linear set
  // data.user to the OAuth app owner instead of the bot, and the
  // SIG-225 thread-walk re-fired the bot into its own previous
  // thread. Best-effort — failure is logged and swallowed inside the
  // helper so the user-facing reply is never blocked.
  await markBotAuthoredComment(env.OPENCLAW_STATE, newCommentId)

  // Mark KV so re-deliveries of the same Comment.create event don't
  // produce a duplicate reply. 30-day TTL — webhooks from Linear get
  // retried at most over a few hours, so this is generous.
  await env.OPENCLAW_STATE.put(kvKey, newCommentId, { expirationTtl: 60 * 60 * 24 * 30 })
}

export interface LinkedPrFailure {
  owner: string
  repo: string
  number: number
  reason: "no_installation" | "not_found" | "forbidden" | "timeout" | "error"
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
  codebaseStatus: string
  codebaseChunks: string | null
  linkedPrs: PrContext[]
  linkedPrFailures: LinkedPrFailure[]
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

  sections.push("[CODEBASE RETRIEVAL STATUS]", ctx.codebaseStatus, "")

  // Linked PR context goes BEFORE retrieval chunks so the model treats
  // it as ground truth for the specific PRs being asked about. Every
  // user-controlled field is XML-escaped to prevent a malicious PR
  // title/body containing `</pr_context>` from breaking out of the
  // structural delimiters and injecting fake system instructions.
  // Failed-to-fetch refs are rendered as `<pr_unavailable>` markers so
  // the model can tell "PR was referenced but couldn't be loaded" from
  // "no PR was referenced" — without these, retrieval-only fallback
  // would let the model answer with false confidence.
  if (ctx.linkedPrs.length > 0 || ctx.linkedPrFailures.length > 0) {
    const blocks: string[] = []
    for (const pr of ctx.linkedPrs) blocks.push(renderPrContext(pr))
    for (const f of ctx.linkedPrFailures) blocks.push(renderPrUnavailable(f))
    sections.push(
      "[LINKED PR CONTEXT — ground truth for what these PRs changed]",
      blocks.join("\n\n"),
      ""
    )
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

export function renderPrContext(pr: PrContext): string {
  const attrs = [
    `owner="${escapeXmlAttribute(pr.owner)}"`,
    `repo="${escapeXmlAttribute(pr.repo)}"`,
    `number="${pr.number}"`,
    `state="${escapeXmlAttribute(pr.state)}"`,
    `merged_at="${escapeXmlAttribute(pr.mergedAt ?? "")}"`,
  ].join(" ")
  const filesBlock =
    typeof pr.filesChanged === "string"
      ? `  <pr_files_changed status="${pr.filesChanged.slice(1, -1)}" />`
      : `  <pr_files_changed total="${pr.filesChanged.total}">\n${pr.filesChanged.items
          .map((f) => `    ${escapeXmlText(f)}`)
          .join("\n")}\n  </pr_files_changed>`
  const diffBlock =
    pr.diff === "[timeout]" || pr.diff === "[error]" || pr.diff === "[truncated]"
      ? `  <pr_diff status="${pr.diff.slice(1, -1)}" />`
      : `  <pr_diff>\n${escapeXmlText(pr.diff)}\n  </pr_diff>`
  return [
    `<pr_context ${attrs}>`,
    `  <pr_title>${escapeXmlText(pr.title)}</pr_title>`,
    `  <pr_body>${escapeXmlText(pr.body)}</pr_body>`,
    filesBlock,
    diffBlock,
    `</pr_context>`,
  ].join("\n")
}

export function renderPrUnavailable(f: LinkedPrFailure): string {
  const attrs = [
    `owner="${escapeXmlAttribute(f.owner)}"`,
    `repo="${escapeXmlAttribute(f.repo)}"`,
    `number="${f.number}"`,
    `reason="${escapeXmlAttribute(f.reason)}"`,
  ].join(" ")
  return `<pr_unavailable ${attrs} />`
}

/**
 * SIG-221: status copy no longer frames the team→repo mapping as a hard
 * access gate. When the team has no mapping (or the mapped repo isn't
 * indexed yet) but OTHER repos are indexed for the org, we surface
 * those as available choices instead of telling the user "no access".
 * Mapping is a soft prior, not a precondition.
 */
export function renderCodebaseRetrievalStatus(
  scope: LinearAgentRepoScope,
  chunkCount: number,
): string {
  if (scope.repo && chunkCount === 0) {
    return `Repo '${scope.repo}' is indexed, but retrieval returned no relevant chunks for this question.`
  }
  if (scope.repo) {
    return `Retrieved ${chunkCount} relevant codebase chunk(s) from '${scope.repo}'.`
  }
  if (scope.availableRepos.length > 0 && scope.mappedRepo) {
    return `The Linear team's default '${scope.mappedRepo}' is not indexed yet, but ${scope.availableRepos.length} indexed repo(s) are available for retrieval: ${scope.availableRepos.map((r) => `'${r}'`).join(", ")}.`
  }
  if (scope.availableRepos.length > 0) {
    return `${scope.availableRepos.length} indexed repo(s) available for retrieval: ${scope.availableRepos.map((r) => `'${r}'`).join(", ")}. The agent will pick based on the issue and question.`
  }
  if (scope.mappedRepo) {
    return `The Linear team maps to '${scope.mappedRepo}', but no indexed repos are available for this org yet (indexing may be in progress).`
  }
  return "No indexed repos are available for this Linear org yet (indexing may be in progress)."
}

interface AgentInitialMessageCtx {
  issueIdentifier: string
  issueTitle: string
  issueBody: string
  askerHandle: string
  question: string
  repo: string | null
  mappedRepo: string | null
  availableRepos: string[]
  repoStatus: LinearAgentRepoScope["status"]
}

/**
 * Build the initial user message for the Phase 3 agent loop. Single
 * compact text block; the agent decides what to fetch from there
 * using its tools (vs the single-shot path which pre-fetches
 * codebase chunks + linked PRs and stuffs them into the prompt).
 */
export function buildAgentInitialUserMessage(ctx: AgentInitialMessageCtx): string {
  // Surface the full set of indexed namespaces so the agent can pick
  // the right one when an issue is clearly about a different repo or
  // branch than the team's primary. Keep the prompt-visible list
  // bounded; retrieve_codebase authorization still uses the full
  // allowed namespace set outside this prompt.
  const universe = ctx.availableRepos.length > 0
    ? ctx.availableRepos
    : ctx.repo
      ? [ctx.repo]
      : []
  let visibleUniverse = universe.slice(0, MAX_PROMPT_VISIBLE_NAMESPACES)
  if (
    ctx.repo &&
    universe.includes(ctx.repo) &&
    !visibleUniverse.includes(ctx.repo) &&
    visibleUniverse.length > 0
  ) {
    visibleUniverse = [...visibleUniverse.slice(0, -1), ctx.repo]
  }
  const hiddenUniverseCount = Math.max(0, universe.length - visibleUniverse.length)
  const universeText = visibleUniverse.length > 0
    ? `${visibleUniverse.map(formatIndexedNamespaceForPrompt).join(", ")}${hiddenUniverseCount > 0 ? `, ... (+${hiddenUniverseCount} more)` : ""}`
    : "(none configured)"
  // SIG-221: collapsed six prompt variants into three, with no hard
  // "do not call retrieve_codebase" gates. Whenever the indexed
  // universe has at least one entry, the agent may always call
  // retrieve_codebase and pick from the list — the team→repo
  // mapping (when set) becomes a SOFT prior, not a precondition.
  // Mirrors how Jira / Notion / Cursor surface code-aware agents:
  // the model infers the relevant repo from issue + question, with
  // any configured default as a starting point.
  let repoLine: string
  if (universe.length > 0) {
    const defaultHint = ctx.repo
      ? ` The default for this Linear team is '${ctx.repo}' — start there if the issue doesn't clearly point elsewhere, but pick a different repo from the list when the question is about one.`
      : ctx.mappedRepo
        ? ` The Linear team maps to '${ctx.mappedRepo}' but that repo is not indexed yet; pick whichever indexed choice best matches the issue's subject. If the question is specifically about '${ctx.mappedRepo}', mention that it's mapped but not indexed yet.`
        : " Pick the indexed choice that best matches the issue's subject and the question."
    repoLine = `Use your tools to gather context as needed. retrieve_codebase takes a 'repo' argument and an optional human 'branch' argument. The indexed choices are: ${universeText}.${defaultHint} For entries marked '(non-default branch index)', never pass the internal __branch__ namespace; only pass a human branch name if the user explicitly provides one. If multiple repos look plausible, you may call retrieve_codebase on each and synthesize. If no choice clearly fits and you can't tell from the issue, return a final answer that says you don't have enough information and offer the user the indexed list to pick from. Final answer is the JSON shape defined by the system prompt.`
  } else if (ctx.mappedRepo) {
    repoLine = `The Linear team maps to '${ctx.mappedRepo}', but no indexed repos are available for this org yet (indexing may be in progress). Answer from the issue and thread context only — retrieve_codebase has no namespaces to search. If repo context is essential to the question, mention that the codebase index is still being built. Final answer is the JSON shape defined by the system prompt.`
  } else {
    repoLine = "No indexed repos are available for this Linear org yet (indexing may be in progress). Answer from the issue and thread context only — retrieve_codebase has no namespaces to search. If repo context is essential to the question, mention that the codebase index is still being built. Final answer is the JSON shape defined by the system prompt."
  }
  const lines: string[] = [
    "[SURFACE] Linear issue comment",
    `[ISSUE] ${ctx.issueIdentifier} — ${ctx.issueTitle}`,
    `[INDEXED REPOS] ${universeText}`,
    `[MAPPED REPO] ${ctx.mappedRepo ?? "(none configured)"}`,
    `[DEFAULT REPO] ${ctx.repo ?? (ctx.mappedRepo ? `(not indexed: ${ctx.mappedRepo})` : "(none configured)")}`,
    `[REPO STATUS] ${ctx.repoStatus}`,
    "[ISSUE BODY]",
    ctx.issueBody.length > 0 ? ctx.issueBody : "(no description)",
    "",
    `[ASKER] @${ctx.askerHandle}`,
    "",
    "[QUESTION]",
    ctx.question,
    "",
    repoLine,
  ]
  return lines.join("\n")
}

function formatIndexedNamespaceForPrompt(namespace: string): string {
  const parsed = parseBranchNamespace(namespace)
  if (!parsed) return `'${namespace}'`
  // SIG-218: the encoded branch segment is a 64-bit hash of the original
  // branch name; the human-readable branch can no longer be recovered from
  // the namespace alone. Display the structural shape so the model knows
  // this is a non-default branch index without claiming a specific name.
  return `'${parsed.owner}/${parsed.repo}' (non-default branch index)`
}

interface LinkedPrFetchResult {
  contexts: PrContext[]
  failures: LinkedPrFailure[]
}

async function fetchLinkedPrs(refs: PrRef[], env: Env): Promise<LinkedPrFetchResult> {
  if (refs.length === 0) return { contexts: [], failures: [] }
  const pairs = await Promise.all(
    refs.map(async (r) => ({
      ref: r,
      result: await fetchPullRequestContext({
        owner: r.owner,
        repo: r.repo,
        number: r.number,
        env,
      }),
    }))
  )
  const contexts: PrContext[] = []
  const failures: LinkedPrFailure[] = []
  for (const { ref, result } of pairs) {
    if (result.ok) {
      contexts.push(result.context)
    } else {
      console.warn(
        `[linear-mention] pr-fetch.skip ref=${ref.owner}/${ref.repo}#${ref.number} reason=${result.reason}`
      )
      failures.push({ owner: ref.owner, repo: ref.repo, number: ref.number, reason: result.reason })
    }
  }
  return { contexts, failures }
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
    lines.push(`@${askerHandle}`)
    lines.push("")
  }
  lines.push(verdict.answer)
  return lines.join("\n")
}

