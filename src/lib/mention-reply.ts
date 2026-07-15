// Pipeline for replying to @-mentions on Linear comments. Mirrors triage.ts:
// fetch context → retrieve chunks → build prompt → call model → parse → reply.
// Dedupe: a KV marker keyed to the source comment id (fast path) plus a
// comment-body marker scan fallback stop a re-fired webhook double-replying.

import { generate } from "@/src/shared/adapters/model"
import { buildLinearClient } from "./linear"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { markBotAuthoredComment, isBotAuthoredComment } from "./bot-authored-comments"
import { bodyMentionsBot, getMentionTriggers, isLikelyBotAuthor, stripMentionFromBody } from "./mention"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { indexNamespace, readRepoIndexManifest } from "./repo-index-manifest"
import { MENTION_REPLY_SCHEMA } from "@/src/shared/domain/schemas"
import type { Env } from "@/src/shared/types/env"
import { MENTION_REPLY_PROMPT } from "@/src/prompts/mention-reply"
import { extractPullRequestRefs, type PrRef } from "./github-pr-refs"
import {
  listIndexedRepos,
  listTeamRepoMappings,
  parseTeamGithubRepo,
  resolveInstallation,
} from "@/src/shared/adapters/github/github-installation"
import { fetchPullRequestContextFromEnv, type PrContext } from "./github-pr-context"
import { escapeXmlAttribute, escapeXmlText } from "@/src/shared/util/xml-escape"
import { runAgentLoop } from "./agent-loop"
import { createAgentTools } from "./agent-tools"
import { makeKvTelemetrySink } from "./agent-telemetry-kv"
import { AGENT_SYSTEM_PROMPT } from "@/src/prompts/agent-system"
import { parseBranchNamespace } from "./index-branch"
import { captureInstructiveLearning, resolveLearningsMode, resolveOrgMemoryCaptureMode } from "@/src/features/learnings"
import { renderLinearSurfaceMemory } from "./mention-reply-surface-memory"
import {
  codebaseContextEnabled,
  codebaseToolsEnabled,
  getLinearConfig,
  resolveLinearTeamBinding,
  teamIsSelected,
  type LinearConfig,
  type LinearTenantContext,
} from "@/src/features/linear-integration"
import { resolveBindingRepoScope, type BindingRepoScope } from "@/src/lib/cross-repo-context"
import { loadLinearRepositoryContext } from "@/src/lib/linear-repository-context"
import { isLinearOrgTeacher } from "@/src/lib/mention-reply-org-teach"
import { resolveTenantLinearRepoScope, type LinearAgentRepoScope } from "@/src/lib/mention-reply-repo-scope"
import {
  addLinearCitationMetadata,
  MAX_LINEAR_MENTION_CITATIONS,
  prependLinearCitationVerification,
} from "@/src/lib/linear-mention-citations"

export type { LinearAgentRepoScope } from "@/src/lib/mention-reply-repo-scope"

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

export function linearRetrievalTeamKey(teamRepo: { owner: string; repo: string } | null): string | null {
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
        console.warn(
          JSON.stringify({
            event: "linear-agent-repo-scope-list-failed",
            owner,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
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
    console.warn(
      JSON.stringify({
        event: "linear-agent-repo-scope-list-failed",
        owner: teamRepo.owner,
        repo: teamRepo.repo,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  try {
    const exactManifest = await readRepoIndexManifest(env as Env, teamRepo.owner, teamRepo.repo)
    if (exactManifest.kind === "ok") available.add(defaultRepo)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-agent-repo-scope-manifest-read-failed",
        owner: teamRepo.owner,
        repo: teamRepo.repo,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
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
  citations: unknown[]
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
  tenant?: LinearTenantContext
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
export type MentionQuestionGate = { skip: "no-mention" } | { skip: null; fullQuestion: string }

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

export async function handleMention(commentId: string, env: Env, opts: HandleMentionOpts = {}): Promise<void> {
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

  // Consumer-side backstop for the webhook's eventually consistent bot stamp.
  if (await isBotAuthoredComment(env.OPENCLAW_STATE, commentId)) {
    log("skip-bot-authored-tracker")
    return
  }

  const tenant = opts.tenant
  const linear = await buildLinearClient(env, tenant)
  const data = await linear.getCommentWithIssue(commentId)
  log("comment-fetched")
  if (!data) {
    console.warn("comment not found", { commentId })
    return
  }

  let tenantConfig: LinearConfig | null = null
  let tenantScope: BindingRepoScope | null = null
  let tenantRepo: { owner: string; repo: string } | null = null
  let tenantSiblingNamespaces: string[] = []
  let tenantCitationNamespaces: string[] = []
  if (tenant) {
    const [config, binding] = await Promise.all([
      getLinearConfig(env, tenant.installationId),
      resolveLinearTeamBinding(env, tenant.organizationId, data.issue.team.id),
    ])
    tenantConfig = config
    tenantScope = binding ? await resolveBindingRepoScope(env, binding, tenant.installationId) : null
    const valid =
      !!config &&
      !!tenantScope &&
      (tenant.teamId === undefined || tenant.teamId === data.issue.team.id) &&
      teamIsSelected(config, data.issue.team.id)
    if (!valid) {
      if (!config || config.writeback.comments) {
        try {
          await linear.createComment(
            data.issue.id,
            "**Sigilix configuration warning** — this Linear team is not bound to an accessible repository in the connected GitHub installation.",
            resolveReplyParentId(data),
          )
        } catch {
          // Best-effort visibility; the tenant guard still fails closed.
        }
      }
      log("missing-tenant-binding", { teamId: data.issue.team.id })
      return
    }
    tenantRepo = tenantScope!.primary
    tenantSiblingNamespaces = tenantScope!.siblingNamespaces
    tenantCitationNamespaces = tenantScope!.allNamespaces
    if (tenantScope!.truncated > 0) {
      log("cross-repo-siblings-capped", { truncated: tenantScope!.truncated })
    }
    if (!config.writeback.comments) {
      log("comment-writeback-disabled", { teamId: data.issue.team.id })
      return
    }
  }

  // Linear fires Comment.create for bot replies too; never answer ourselves.
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

  // Extract PR refs from the full question so truncation cannot hide a trailing ref.
  const teamKey = data.issue.team?.key ?? null
  const teamRepo = tenantRepo ?? parseTeamGithubRepo(env.OPENCLAW_TEAM_GITHUB_REPO_MAP, teamKey)
  const contextEnabled = !tenantConfig || codebaseContextEnabled(tenantConfig)
  const contextToolsEnabled = !tenantConfig || codebaseToolsEnabled(tenantConfig)
  const repositoryContextPromise =
    tenant && tenantScope
      ? loadLinearRepositoryContext({
          env,
          surface: "mention",
          installationId: tenant.installationId,
          repositories: tenantScope.effectiveRepositories,
          enabled: contextEnabled,
        })
      : Promise.resolve("")
  const repoScope = contextEnabled
    ? tenant
      ? await resolveTenantLinearRepoScope(env, teamRepo, tenantSiblingNamespaces)
      : await resolveLinearAgentRepoScope(env, teamRepo)
    : { repo: null, mappedRepo: null, availableRepos: [], status: "unmapped" as const }
  const inferRepo = (): { owner: string; repo: string } | null => teamRepo
  // Linked PR context comes from GitHub directly and does not require an index
  // manifest. Authorize it from the tenant-verified binding set; only the
  // retrieval tool narrows further to the indexed subset in `repoScope`.
  const allowedPrRepos = new Set([
    ...(teamRepo ? [indexNamespace(teamRepo.owner, teamRepo.repo)] : []),
    ...tenantSiblingNamespaces,
  ])
  const prRefs = contextEnabled
    ? extractPullRequestRefs(fullQuestion, inferRepo).filter(
        (ref) => !tenant || allowedPrRepos.has(indexNamespace(ref.owner, ref.repo)),
      )
    : []
  const { contexts: linkedPrs, failures: linkedPrFailures } = contextEnabled
    ? await fetchLinkedPrs(prRefs, env)
    : { contexts: [], failures: [] }
  log("linked-prs", {
    refs: prRefs.length,
    fetched: linkedPrs.length,
    failures: linkedPrFailures.length,
  })

  // Codebase retrieval scoped to the issue's team. Soft-fails to empty.
  const retrievalText = `${data.issue.title}\n\n${question}`
  const retrievalTeamKey = linearRetrievalTeamKey(teamRepo)
  const chunks =
    contextEnabled && retrievalTeamKey
      ? await retrieveChunks({
          text: retrievalText,
          teamKey: retrievalTeamKey,
          env,
          ...(tenantRepo ? { namespace: `${tenantRepo.owner}/${tenantRepo.repo}` } : {}),
          ...(tenantSiblingNamespaces.length > 0 ? { crossRepoNamespaces: tenantSiblingNamespaces } : {}),
        })
      : []
  log("retrieval-done", { chunks: chunks.length, namespace: retrievalTeamKey })

  // Surface memory apply — ORG∪REPO learnings block for the answer prompt (see helper).
  const surfaceMemory = await renderLinearSurfaceMemory({ env, teamRepo, tenant })
  const repositoryContext = await repositoryContextPromise
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
    codebaseChunks: formatChunksForPrompt(
      addLinearCitationMetadata(
        chunks,
        repoScope.repo ?? (teamRepo ? indexNamespace(teamRepo.owner, teamRepo.repo) : ""),
      ),
    ),
    linkedPrs,
    linkedPrFailures,
    teamMemory: surfaceMemory,
    repositoryContext,
  })

  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  let verdict: MentionVerdict | null = null

  if (env.OPENCLAW_AGENTIC_LINEAR_MODE === "on" && contextToolsEnabled) {
    log("agent-loop-start")
    // Resolve the advertised and enforced repository set once so they cannot drift.
    const loopResult = await runAgentLoop({
      model,
      apiKey: env.OLLAMA_API_KEY,
      env,
      surface: "linear-mention",
      commentId: data.id,
      systemPrompt: surfaceMemory ? `${AGENT_SYSTEM_PROMPT}\n\n${surfaceMemory}` : AGENT_SYSTEM_PROMPT,
      initialUserMessage: buildAgentInitialUserMessage({
        issueIdentifier: data.issue.identifier,
        issueTitle: data.issue.title,
        issueBody: data.issue.description ?? "",
        askerHandle,
        question,
        repo: repoScope.repo,
        mappedRepo: repoScope.mappedRepo,
        repoStatus: repoScope.status,
        availableRepos: repoScope.availableRepos,
        repositoryContext,
      }),
      tools: createAgentTools({
        env,
        surface: "linear-mention",
        // The same set is advertised above and enforced by retrieve_codebase.
        allowedRepos: repoScope.availableRepos,
        // Linear surface — no GitHub auth/repo identity, so no fetch_pr/read_file_lines.
      }),
      finalAnswerSchema: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
      telemetry: makeKvTelemetrySink(env.OPENCLAW_STATE),
      telemetryContext: {
        singleShotPrompt: prompt,
        singleShotSchema: MENTION_REPLY_SCHEMA as unknown as Record<string, unknown>,
        promptBuilderVersion: "linear-mention-reply-v8",
        promptBuilderSource: MENTION_REPLY_PROMPT,
        linearMentionRetrieval: {
          availableRepos: repoScope.availableRepos,
          mappedRepo: repoScope.mappedRepo,
          repoStatus: repoScope.status,
          initialRetrievalNamespace: retrievalTeamKey,
          initialChunkCount: chunks.length,
        },
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

  const verifiedAnswer = contextEnabled
    ? await verifyLinearMentionCitations({
        env,
        teamRepo,
        citations: verdict.citations,
        allowedRepos:
          tenantCitationNamespaces.length > 0
            ? tenantCitationNamespaces
            : teamRepo
              ? [indexNamespace(teamRepo.owner, teamRepo.repo)]
              : [],
        answer: verdict.answer,
        log,
        ...(tenant ? { installationId: tenant.installationId } : {}),
      })
    : verdict.answer
  const body = formatReply({ verdict: { ...verdict, answer: verifiedAnswer }, askerHandle })
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

  // Unified learnings capture — a human INSTRUCTION/CORRECTION on a Sigilix-touched
  // (triaged or answered) Linear issue becomes an ORG-scope learning keyed to the
  // team's installation, so every surface (PR review, CLI agent, Slack) reads it
  // back through the one learnings store. Only fires when the team maps to a
  // resolvable installation; quality-gated by extractLearning on the "chat"
  // surface — ordinary questions never pass. Ships dark behind
  // OPENCLAW_LEARNINGS_MODE + OPENCLAW_ORG_MEMORY_CAPTURE. Best-effort, non-fatal.
  if (teamRepo) {
    const inst = tenant
      ? { ok: true as const, installationId: tenant.installationId }
      : env.LINEAR_TOKEN_BROKER
        ? { ok: false as const }
        : resolveInstallation(teamRepo.owner, teamRepo.repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
    if (inst.ok) {
      // ORG-TEACH AUTHZ: only a Linear workspace admin may write an org learning
      // (it shapes every teammate's reviews). Non-admins already got their normal
      // reply above — we only skip the capture. FAIL-CLOSED: if admin status
      // can't be determined we skip AND log a distinct deny so an over-denial
      // (dropped a real admin) is distinguishable from a correct denial (a
      // non-admin). The check runs only when capture would proceed past its mode
      // gates, so with learnings capture OFF (the default) it does no extra work.
      const orgTeachActive =
        resolveLearningsMode(env.OPENCLAW_LEARNINGS_MODE) !== "off" && resolveOrgMemoryCaptureMode(env) !== "off"
      if (orgTeachActive) {
        const authz = isLinearOrgTeacher(data.user)
        if (authz.authorized) {
          await captureInstructiveLearning({
            env,
            scope: "org",
            subjectId: String(inst.installationId),
            surface: "chat",
            sourceKind: "chat",
            message: question,
            dedupeId: `linear:${commentId}`,
            actor: askerHandle,
            telemetry: { surface_detail: "linear", team_key: teamKey },
          }).catch(() => {})
        } else {
          console.log(
            JSON.stringify({
              event: "org-teach-authz-denied",
              surface: "linear",
              reason: authz.reason,
              actor: askerHandle,
              subject_id: String(inst.installationId),
              team_key: teamKey,
            }),
          )
        }
      }
    }
  }
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
  teamMemory: string
  repositoryContext: string
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

  // Surface memory apply — team/repo guidance high (after system instructions).
  const memory = ctx.teamMemory ? ["[TEAM & REPOSITORY MEMORY — apply this guidance]", ctx.teamMemory, ""] : []
  const sections = ["[SYSTEM INSTRUCTIONS]", MENTION_REPLY_PROMPT.trim(), "", ...memory]

  sections.push(
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
  )

  if (recent) {
    sections.push("[RECENT THREAD CONTEXT — chronological]", recent, "")
  }

  if (ctx.repositoryContext) sections.push(ctx.repositoryContext, "")

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
    sections.push("[LINKED PR CONTEXT — ground truth for what these PRs changed]", blocks.join("\n\n"), "")
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
export function renderCodebaseRetrievalStatus(scope: LinearAgentRepoScope, chunkCount: number): string {
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
  repositoryContext: string
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
  const universe = ctx.availableRepos.length > 0 ? ctx.availableRepos : ctx.repo ? [ctx.repo] : []
  let visibleUniverse = universe.slice(0, MAX_PROMPT_VISIBLE_NAMESPACES)
  if (ctx.repo && universe.includes(ctx.repo) && !visibleUniverse.includes(ctx.repo) && visibleUniverse.length > 0) {
    visibleUniverse = [...visibleUniverse.slice(0, -1), ctx.repo]
  }
  const hiddenUniverseCount = Math.max(0, universe.length - visibleUniverse.length)
  const universeText =
    visibleUniverse.length > 0
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
    repoLine =
      "No indexed repos are available for this Linear org yet (indexing may be in progress). Answer from the issue and thread context only — retrieve_codebase has no namespaces to search. If repo context is essential to the question, mention that the codebase index is still being built. Final answer is the JSON shape defined by the system prompt."
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
    ...(ctx.repositoryContext ? [ctx.repositoryContext, ""] : []),
    "[CITATION CONTRACT] Copy exact `citation` objects returned by retrieve_codebase into the top-level `citations` array. Use an empty array when none apply. Do not write path:line citations in prose and never invent or alter citation metadata.",
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
      result: await fetchPullRequestContextFromEnv({
        owner: r.owner,
        repo: r.repo,
        number: r.number,
        env,
      }),
    })),
  )
  const contexts: PrContext[] = []
  const failures: LinkedPrFailure[] = []
  for (const { ref, result } of pairs) {
    if (result.ok) {
      contexts.push(result.context)
    } else {
      console.warn(`[linear-mention] pr-fetch.skip ref=${ref.owner}/${ref.repo}#${ref.number} reason=${result.reason}`)
      failures.push({ owner: ref.owner, repo: ref.repo, number: ref.number, reason: result.reason })
    }
  }
  return { contexts, failures }
}

async function verifyLinearMentionCitations(args: {
  env: Env
  teamRepo: { owner: string; repo: string } | null
  citations: unknown[]
  allowedRepos: string[]
  answer: string
  log: (label: string, extra?: Record<string, unknown>) => void
  installationId?: number
}): Promise<string> {
  if (args.citations.length === 0) return args.answer
  let clientPromise: Promise<GitHubClient> | null = null
  const getClient = (): Promise<GitHubClient> => {
    if (clientPromise) return clientPromise
    clientPromise = (async () => {
      if (!args.env.GITHUB_APP_ID || !args.env.GITHUB_PRIVATE_KEY || !args.env.OPENCLAW_STATE) {
        throw new Error("GitHub verification credentials unavailable")
      }
      if (!args.teamRepo) throw new Error("no mapped GitHub repo")
      const installation = args.installationId
        ? { ok: true as const, installationId: args.installationId }
        : resolveInstallation(args.teamRepo.owner, args.teamRepo.repo, args.env.OPENCLAW_GITHUB_INSTALLATION_MAP)
      if (!installation.ok) throw new Error("no GitHub installation")
      const token = await getInstallationToken({
        kv: args.env.OPENCLAW_STATE,
        appId: args.env.GITHUB_APP_ID,
        privateKey: args.env.GITHUB_PRIVATE_KEY,
        installationId: installation.installationId,
      })
      return new GitHubClient({ token })
    })()
    return clientPromise
  }
  const answer = await prependLinearCitationVerification({
    answer: args.answer,
    citations: args.citations,
    allowedRepos: args.allowedRepos,
    fetchFileContent: async (owner, repo, path, ref) => {
      const client = await getClient()
      return client.getFileContent(owner, repo, path, ref)
    },
  })
  args.log("citation-verification-complete", { citations: Math.min(args.citations.length, 24) })
  return answer
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
  const citations = Array.isArray(obj.citations) ? obj.citations.slice(0, MAX_LINEAR_MENTION_CITATIONS) : []
  return {
    answer,
    confidence: Number.isFinite(confidence) && confidence >= 1 && confidence <= 5 ? Math.round(confidence) : 3,
    abstain,
    citations,
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
