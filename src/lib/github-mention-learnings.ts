// SIG-104 PR-1: explicit Learnings command surface for GitHub @-mentions.
// Kept as a sibling leaf so the already-large mention handler stays under
// the file-size budget. The domain/store logic lives in `features/learnings`;
// this file only adapts GitHub replies + repo-id/authz context to that public
// feature barrel.

import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import {
  appendLearning,
  computeLearningId,
  emitLearningAudit,
  forgetLearning,
  hasRepoWriteAccess,
  loadLearnings,
  normalizeRule,
  recordConfirmationMapForThread,
  renderConfirmReply,
  renderForgetConfirm,
  renderOverviewFooter,
  resolveConfirmationMap,
} from "@/src/features/learnings"
import type { LearningEntry } from "@/src/features/learnings"

const LEARNING_DEDUPE_PREFIX = "learning-capture-seen:github-mention"
const LEARNING_COMMAND_DEDUPE_TTL = 60 * 60 * 24 * 30

type LearningsCommand = { kind: "remember"; rule: string } | { kind: "forget" } | { kind: "list" }
export type GithubMentionLearningSurface = "issue" | "review-comment"
export type GithubMentionLearningClient = Pick<GitHubClient, "createIssueComment" | "replyToReviewComment" | "restGet">

export interface GithubMentionLearningSourceComment {
  author: string
  inReplyToId?: number
}

export async function handleGithubMentionLearningsCommand(args: {
  client: GithubMentionLearningClient
  env: Env
  owner: string
  repo: string
  prNumber: number
  surface: GithubMentionLearningSurface
  commentId: number
  sourceComment: GithubMentionLearningSourceComment
  subjectId: string
  command: LearningsCommand
  threadRootId?: number
  dedupeKey: string
}): Promise<void> {
  switch (args.command.kind) {
    case "remember":
      return handleRememberLearningCommand(args, args.command.rule)
    case "forget":
      return handleForgetLearningCommand(args)
    case "list":
      return handleListLearningCommand(args)
  }
}

export function learningCommandDedupeKey(commentId: number): string {
  return `${LEARNING_DEDUPE_PREFIX}:${commentId}`
}

export function validGithubRepoId(repoId: number | undefined): number | undefined {
  return typeof repoId === "number" && Number.isInteger(repoId) && repoId > 0 ? repoId : undefined
}

async function handleRememberLearningCommand(
  args: Omit<Parameters<typeof handleGithubMentionLearningsCommand>[0], "command">,
  rawRule: string,
): Promise<void> {
  const { client, env, owner, repo, prNumber, surface, commentId, sourceComment, subjectId, threadRootId, dedupeKey } =
    args
  const authorized = await hasRepoWriteAccess(client, owner, repo, sourceComment.author)
  if (!authorized) {
    logLearningCommandRejected("remember", {
      owner,
      repo,
      prNumber,
      surface,
      commentId,
      actor: sourceComment.author,
    })
    return
  }

  const rule = normalizeRule(rawRule)
  if (rule.length === 0) {
    console.log(
      JSON.stringify({
        event: "gh-mention-learning-command-skipped",
        reason: "empty_normalized_rule",
        command: "remember",
        owner,
        repo,
        prNumber,
        surface,
        commentId,
      }),
    )
    return
  }

  const learningId = await computeLearningId(rule)
  const createdTs = new Date().toISOString()
  const entry: LearningEntry = {
    id: learningId,
    rule,
    polarity: "context",
    category: null,
    pathGlob: null,
    scope: "repo",
    subjectId,
    source: { kind: "command", prNumber, commentId },
    createdTs,
    appliedCount: 0,
    authorLogin: sourceComment.author,
  }

  const appended = await appendLearning(env, "repo", subjectId, entry, Date.parse(createdTs))
  if (!appended) return

  const replyCommentId = await postGithubMentionLearningReply({
    client,
    owner,
    repo,
    prNumber,
    surface,
    threadRootId: threadRootId ?? commentId,
    body: renderConfirmReply(rule),
  })
  await recordConfirmationMapForThread(env, replyCommentId, threadRootId ?? commentId, {
    scope: "repo",
    subjectId,
    learningId,
  })
  emitLearningAudit({
    actor: sourceComment.author,
    scope: "repo",
    subjectId,
    action: "remember",
    learningId,
    ts: createdTs,
  })
  await recordLearningCommandSeen(env, dedupeKey, {
    command: "remember",
    replyCommentId,
    learningId,
  })
}

async function handleForgetLearningCommand(
  args: Omit<Parameters<typeof handleGithubMentionLearningsCommand>[0], "command">,
): Promise<void> {
  const { client, env, owner, repo, prNumber, surface, commentId, sourceComment, subjectId, threadRootId, dedupeKey } =
    args
  const authorized = await hasRepoWriteAccess(client, owner, repo, sourceComment.author)
  if (!authorized) {
    logLearningCommandRejected("forget", {
      owner,
      repo,
      prNumber,
      surface,
      commentId,
      actor: sourceComment.author,
    })
    return
  }

  const confirmationCommentId = sourceComment.inReplyToId ?? threadRootId
  if (confirmationCommentId === undefined) {
    await postLearningHintReply(args)
    return
  }

  const mapping = await resolveConfirmationMap(env, confirmationCommentId)
  if (mapping === null || mapping.scope !== "repo" || mapping.subjectId !== subjectId) {
    await postLearningHintReply(args)
    return
  }

  const forgot = await forgetLearning(env, mapping.scope, mapping.subjectId, mapping.learningId)
  if (!forgot) return

  const replyCommentId = await postGithubMentionLearningReply({
    client,
    owner,
    repo,
    prNumber,
    surface,
    threadRootId: threadRootId ?? commentId,
    body: renderForgetConfirm(),
  })
  const ts = new Date().toISOString()
  emitLearningAudit({
    actor: sourceComment.author,
    scope: mapping.scope,
    subjectId: mapping.subjectId,
    action: "forget",
    learningId: mapping.learningId,
    ts,
  })
  await recordLearningCommandSeen(env, dedupeKey, {
    command: "forget",
    replyCommentId,
    learningId: mapping.learningId,
  })
}

async function handleListLearningCommand(
  args: Omit<Parameters<typeof handleGithubMentionLearningsCommand>[0], "command">,
): Promise<void> {
  const { client, env, owner, repo, prNumber, surface, commentId, subjectId, threadRootId, dedupeKey } = args
  const store = await loadLearnings(env, "repo", subjectId)
  const entries = store?.entries ?? []
  const body = entries.length > 0 ? renderOverviewFooter(entries) : "No learned rules for this repo yet."
  const replyCommentId = await postGithubMentionLearningReply({
    client,
    owner,
    repo,
    prNumber,
    surface,
    threadRootId: threadRootId ?? commentId,
    body,
  })
  await recordLearningCommandSeen(env, dedupeKey, {
    command: "list",
    replyCommentId,
  })
}

async function postLearningHintReply(
  args: Omit<Parameters<typeof handleGithubMentionLearningsCommand>[0], "command">,
): Promise<void> {
  const { client, owner, repo, prNumber, surface, commentId, threadRootId, env, dedupeKey } = args
  const replyCommentId = await postGithubMentionLearningReply({
    client,
    owner,
    repo,
    prNumber,
    surface,
    threadRootId: threadRootId ?? commentId,
    body: "Reply `@sigilix forget` directly to the learning confirmation.",
  })
  await recordLearningCommandSeen(env, dedupeKey, {
    command: "forget-hint",
    replyCommentId,
  })
}

function logLearningCommandRejected(
  command: "remember" | "forget",
  fields: {
    owner: string
    repo: string
    prNumber: number
    surface: GithubMentionLearningSurface
    commentId: number
    actor: string
  },
): void {
  console.log(
    JSON.stringify({
      event: "gh-mention-learning-command-rejected",
      reason: "missing_write_access",
      command,
      owner: fields.owner,
      repo: fields.repo,
      prNumber: fields.prNumber,
      surface: fields.surface,
      comment_id: fields.commentId,
      actor: fields.actor,
    }),
  )
}

async function recordLearningCommandSeen(
  env: Env,
  key: string,
  value: { command: string; replyCommentId: number; learningId?: string },
): Promise<void> {
  await env.OPENCLAW_STATE.put(key, JSON.stringify(value), {
    expirationTtl: LEARNING_COMMAND_DEDUPE_TTL,
  }).catch((err: unknown) => {
    console.warn("[gh-mention] learning command dedupe persistence failed", {
      key,
      err: err instanceof Error ? err.message : String(err),
    })
  })
}

export async function postGithubMentionLearningReply(args: {
  client: GithubMentionLearningClient
  owner: string
  repo: string
  prNumber: number
  surface: GithubMentionLearningSurface
  threadRootId: number
  body: string
}): Promise<number> {
  const { client, owner, repo, prNumber, surface, threadRootId, body } = args
  if (surface === "issue") {
    const res = await client.createIssueComment(owner, repo, prNumber, body)
    return res.id
  }
  const res = await client.replyToReviewComment(owner, repo, prNumber, threadRootId, body)
  return res.id
}
