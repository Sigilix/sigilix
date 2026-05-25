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
import { indexNamespace, readRepoIndexManifest } from "./repo-index-manifest"
import { MENTION_REPLY_SCHEMA } from "./schemas"
import type { Env } from "../index"
import { MENTION_REPLY_PROMPT } from "../prompts/mention-reply"
import { extractPullRequestRefs, type PrRef } from "./github-pr-refs"
import { listIndexedRepos, parseTeamGithubRepo } from "./github-installation"
import { fetchPullRequestContext, type PrContext } from "./github-pr-context"
import { escapeXmlAttribute, escapeXmlText } from "./xml-escape"
import { runAgentLoop } from "./agent-loop"
import { createAgentTools } from "./agent-tools"
import { makeKvTelemetrySink } from "./agent-telemetry-kv"
import { AGENT_SYSTEM_PROMPT } from "../prompts/agent-system"

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
  env: { OPENCLAW_STATE: KVNamespace },
  teamRepo: { owner: string; repo: string } | null,
): Promise<LinearAgentRepoScope> {
  if (!teamRepo) {
    return { repo: null, mappedRepo: null, availableRepos: [], status: "unmapped" }
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

  const fullQuestion = stripMentionFromBody(data.body, triggers)
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
      const response = await generate({
        model,
        prompt,
        apiKey: env.OLLAMA_API_KEY,
        format: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
      })
      verdict = parseVerdict(response)
    }
  } else {
    log("ollama-start")
    const response = await generate({
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
  const newCommentId = await linear.createComment(data.issue.id, body)
  log("reply-posted", { newCommentId })

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

export function renderCodebaseRetrievalStatus(
  scope: LinearAgentRepoScope,
  chunkCount: number,
): string {
  if (scope.status === "unmapped") {
    return "No GitHub repo mapping is configured for this Linear team. Repo-context answers require an explicit team-to-repo mapping."
  }
  if (scope.status === "mapped_not_indexed" && scope.mappedRepo) {
    return `The Linear team maps to '${scope.mappedRepo}', but that repo does not have an index manifest yet.`
  }
  if (scope.status === "mapped_default_not_indexed" && scope.mappedRepo) {
    return `The Linear team maps to '${scope.mappedRepo}', but that default repo is not indexed yet. Indexed repos available for this owner: ${scope.availableRepos.map((r) => `'${r}'`).join(", ")}.`
  }
  if (scope.repo && chunkCount === 0) {
    return `Repo '${scope.repo}' is indexed, but retrieval returned no relevant chunks for this question.`
  }
  if (scope.repo) {
    return `Retrieved ${chunkCount} relevant codebase chunk(s) from '${scope.repo}'.`
  }
  return "No codebase retrieval namespace was available for this Linear mention."
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
  // branch than the team's primary (e.g. an ARC issue about the
  // marketing site or the dev branch). Tool already accepts an arbitrary
  // `repo` arg — this just informs the model which choices are valid.
  const universe = ctx.availableRepos.length > 0
    ? ctx.availableRepos
    : ctx.repo
      ? [ctx.repo]
      : []
  const universeText = universe.length > 0 ? universe.map((r) => `'${r}'`).join(", ") : "(none configured)"
  let repoLine: string
  if (ctx.repo && universe.length > 1) {
    repoLine = `Use your tools to gather context as needed. retrieve_codebase takes a 'repo' argument naming one of the indexed namespaces: ${universeText}. The default for this Linear team is '${ctx.repo}', but pick a different namespace from the list when the issue is clearly about another repo or branch (branch indexes look like 'owner/repo/__branch__/encoded-branch'). Final answer is the JSON shape defined by the system prompt.`
  } else if (ctx.repo) {
    repoLine = `Use your tools to gather context as needed. The retrieve_codebase tool's namespace for this issue is the lowercased owner/repo namespace '${ctx.repo}'. Final answer is the JSON shape defined by the system prompt.`
  } else if (ctx.mappedRepo && universe.length > 0) {
    repoLine = `The Linear team maps to '${ctx.mappedRepo}', but that default repo is not indexed yet. You may call retrieve_codebase only for indexed namespaces: ${universeText}. Pick one only if it clearly matches the issue's subject; if the question is about '${ctx.mappedRepo}', explain that the repo is mapped but not indexed yet. Final answer is the JSON shape defined by the system prompt.`
  } else if (ctx.mappedRepo) {
    repoLine = `The Linear team maps to '${ctx.mappedRepo}', but that repo does not have an index manifest yet. Do not call retrieve_codebase; explain that the repo is mapped but not indexed yet. Final answer is the JSON shape defined by the system prompt.`
  } else if (universe.length > 0) {
    repoLine = `Use your tools to gather context as needed. retrieve_codebase takes a 'repo' argument naming one of the indexed namespaces: ${universeText}. Pick the one that matches the issue's subject. If none clearly fits, return a final answer that says you don't have enough information. Final answer is the JSON shape defined by the system prompt.`
  } else {
    repoLine = "No GitHub repo mapping is configured for this Linear team, so do not call retrieve_codebase. Answer from the issue and thread context only; if repo context is required, say the Linear team needs a GitHub repo mapping before code retrieval can run. Final answer is the JSON shape defined by the system prompt."
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
