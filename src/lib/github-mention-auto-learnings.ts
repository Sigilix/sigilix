import type { Env } from "@/src/shared/types/env"
import {
  appendLearning,
  computeLearningId,
  emitLearningAudit,
  extractLearning,
  hasRepoWriteAccess,
  normalizeRule,
  recordConfirmationMap,
  renderConfirmReply,
  resolveLearningsMode,
} from "@/src/features/learnings"
import type { LearningEntry } from "@/src/features/learnings"
import {
  postGithubMentionLearningReply,
  type GithubMentionLearningClient,
  type GithubMentionLearningSourceComment,
  type GithubMentionLearningSurface,
} from "./github-mention-learnings"

const QA_LEARNING_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60

export async function captureGithubMentionQaLearning(args: {
  client: GithubMentionLearningClient
  env: Env
  owner: string
  repo: string
  prNumber: number
  surface: GithubMentionLearningSurface
  commentId: number
  sourceComment: GithubMentionLearningSourceComment
  repoId?: number
  threadRootId?: number
  question: string
}): Promise<void> {
  const fields = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    surface: "qa",
    commentId: args.commentId,
  }
  try {
    const mode = resolveLearningsMode(args.env.OPENCLAW_LEARNINGS_MODE)
    if (mode === "off") return

    const subjectRepoId = validGithubRepoId(args.repoId)
    if (subjectRepoId === undefined) {
      logLearningCaptureSkipped(fields, "missing-repo-id")
      return
    }

    const authorized = await hasRepoWriteAccess(args.client, args.owner, args.repo, args.sourceComment.author)
    if (!authorized) {
      logLearningCaptureSkipped(fields, "missing-write-access")
      return
    }

    const dedupeKey = `learning-capture-seen:qa:${args.commentId}`
    if (mode === "on" && (await learningAlreadySeen(args.env, dedupeKey, fields))) return

    const extracted = await extractLearning(args.env, {
      surface: "qa",
      replyText: args.question,
    })
    if (extracted === null) return

    const rule = normalizeRule(extracted.rule)
    if (rule.length === 0) return

    const subjectId = String(subjectRepoId)
    if (mode === "shadow") {
      console.log(
        JSON.stringify({
          event: "learning-extract-shadow",
          ...fields,
          actor: args.sourceComment.author,
          subject_id: subjectId,
          rule,
          polarity: extracted.polarity,
          category: extracted.category ?? null,
          path_glob: extracted.pathGlob ?? null,
        }),
      )
      return
    }

    await markLearningSeen(args.env, dedupeKey, fields)
    const learningId = await computeLearningId(rule)
    const createdTs = new Date().toISOString()
    const entry: LearningEntry = {
      id: learningId,
      rule,
      polarity: extracted.polarity,
      category: extracted.category ?? null,
      pathGlob: extracted.pathGlob ?? null,
      scope: "repo",
      subjectId,
      source: { kind: "qa", prNumber: args.prNumber, commentId: args.commentId },
      createdTs,
      appliedCount: 0,
      authorLogin: args.sourceComment.author,
    }

    const appended = await appendLearning(args.env, "repo", subjectId, entry, Date.parse(createdTs))
    if (!appended) return

    const replyCommentId = await postGithubMentionLearningReply({
      client: args.client,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      surface: args.surface,
      threadRootId: args.threadRootId ?? args.commentId,
      body: renderConfirmReply(rule),
    })
    await recordConfirmationMap(args.env, replyCommentId, { scope: "repo", subjectId, learningId })
    emitLearningAudit({
      actor: args.sourceComment.author,
      scope: "repo",
      subjectId,
      action: "capture",
      learningId,
      ts: createdTs,
    })
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "learning-capture-failed",
        ...fields,
        stage: "qa",
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

async function learningAlreadySeen(env: Env, key: string, fields: Record<string, unknown>): Promise<boolean> {
  try {
    const seen = await env.OPENCLAW_STATE.get(key)
    if (seen !== null) {
      logLearningCaptureSkipped(fields, "already-seen")
      return true
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "learning-capture-failed",
        ...fields,
        stage: "dedupe-read",
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  return false
}

async function markLearningSeen(env: Env, key: string, fields: Record<string, unknown>): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(key, "1", {
      expirationTtl: QA_LEARNING_DEDUPE_TTL_SECONDS,
    })
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "learning-capture-failed",
        ...fields,
        stage: "dedupe-write",
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

function logLearningCaptureSkipped(fields: Record<string, unknown>, reason: string): void {
  console.log(
    JSON.stringify({
      event: "learning-capture-skipped",
      ...fields,
      reason,
    }),
  )
}

function validGithubRepoId(repoId: number | undefined): number | undefined {
  return typeof repoId === "number" && Number.isInteger(repoId) && repoId > 0 ? repoId : undefined
}
