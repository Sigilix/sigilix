import type { Env } from "@/src/shared/types/env"
import {
  appendLearning,
  computeLearningId,
  emitLearningAudit,
  extractLearning,
  hasRepoWriteAccess,
  normalizeRule,
  recordConfirmationMapForThread,
  renderConfirmReply,
  resolveLearningsMode,
} from "@/src/features/learnings"
import type { LearningEntry } from "@/src/features/learnings"
import type {
  GithubMentionLearningClient,
  GithubMentionLearningSourceComment,
  GithubMentionLearningSurface,
} from "./github-mention-learnings"

const QA_LEARNING_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * The captured-but-not-yet-posted result of a QA auto-learning extraction.
 * The QA surface always has a host reply (the bot's answer), so the caller
 * folds `rule` into that SAME comment via `renderConfirmReply` instead of
 * this module posting a second, separate confirmation comment — see
 * `postGithubMentionQaReply`.
 */
export interface GithubMentionQaLearningCapture {
  rule: string
  learningId: string
  subjectId: string
  createdTs: string
}

/**
 * Extract + persist (KV-append) a learning from the human's Q&A question.
 * Does NOT post any comment. Returns `null` when no learning applies (mode
 * off/shadow, unauthorized, dedupe hit, nothing extracted, or any internal
 * error) so the caller's reply is never blocked. Internal — the public entry
 * point is `postGithubMentionQaReply`.
 */
async function captureGithubMentionQaLearning(args: {
  client: GithubMentionLearningClient
  env: Env
  owner: string
  repo: string
  prNumber: number
  surface: GithubMentionLearningSurface
  commentId: number
  sourceComment: GithubMentionLearningSourceComment
  repoId?: number
  question: string
}): Promise<GithubMentionQaLearningCapture | null> {
  const fields = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    surface: "qa",
    commentId: args.commentId,
  }
  try {
    const mode = resolveLearningsMode(args.env.OPENCLAW_LEARNINGS_MODE)
    if (mode === "off") return null

    const subjectRepoId = validGithubRepoId(args.repoId)
    if (subjectRepoId === undefined) {
      logLearningCaptureSkipped(fields, "missing-repo-id")
      return null
    }

    const authorized = await hasRepoWriteAccess(args.client, args.owner, args.repo, args.sourceComment.author)
    if (!authorized) {
      logLearningCaptureSkipped(fields, "missing-write-access")
      return null
    }

    const dedupeKey = `learning-capture-seen:qa:${args.commentId}`
    if (mode === "on" && (await learningAlreadySeen(args.env, dedupeKey, fields))) return null

    const extracted = await extractLearning(args.env, {
      surface: "qa",
      replyText: args.question,
    })
    if (extracted === null) return null

    const rule = normalizeRule(extracted.rule)
    if (rule.length === 0) return null

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
      return null
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
    if (!appended) return null

    return { rule, learningId, subjectId, createdTs }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "learning-capture-failed",
        ...fields,
        stage: "qa",
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
}

/**
 * Extract the QA learning (if any), fold its `renderConfirmReply` footer
 * into `baseReplyBody`, post the resulting body through the caller-supplied
 * `post`, and finalize the confirmation map + audit against the posted
 * comment's id — ONE comment, not a separate confirmation comment, while
 * keeping `@sigilix forget` resolvable exactly as before.
 */
export async function postGithubMentionQaReply(
  args: Parameters<typeof captureGithubMentionQaLearning>[0] & {
    baseReplyBody: string
    threadRootId: number
    post: (body: string) => Promise<number>
  },
): Promise<number> {
  const capture = await captureGithubMentionQaLearning(args)
  const body = capture ? `${args.baseReplyBody}\n\n${renderConfirmReply(capture.rule)}` : args.baseReplyBody
  const newId = await args.post(body)
  if (capture) {
    await finalizeGithubMentionQaLearningCapture({
      env: args.env,
      actor: args.sourceComment.author,
      threadRootId: args.threadRootId,
      confirmationCommentId: newId,
      capture,
    })
  }
  return newId
}

/**
 * Record the confirmation-map entry + emit the audit event for a QA learning
 * that was already folded into the host reply's body and posted as ONE
 * comment. `confirmationCommentId` is that same comment's id — recording the
 * map against it (dual-keyed with `threadRootId` by
 * `recordConfirmationMapForThread`) is what lets a later `@sigilix forget`
 * reply resolve the learning, exactly as it did when the confirmation was a
 * separate comment. Never throws — best-effort, matching the rest of the
 * capture pipeline. Internal — invoked only by `postGithubMentionQaReply`.
 */
async function finalizeGithubMentionQaLearningCapture(args: {
  env: Env
  actor: string
  threadRootId: number
  confirmationCommentId: number
  capture: GithubMentionQaLearningCapture
}): Promise<void> {
  try {
    await recordConfirmationMapForThread(args.env, args.confirmationCommentId, args.threadRootId, {
      scope: "repo",
      subjectId: args.capture.subjectId,
      learningId: args.capture.learningId,
    })
    emitLearningAudit({
      actor: args.actor,
      scope: "repo",
      subjectId: args.capture.subjectId,
      action: "capture",
      learningId: args.capture.learningId,
      ts: args.capture.createdTs,
    })
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "learning-capture-failed",
        surface: "qa",
        stage: "finalize",
        commentId: args.confirmationCommentId,
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
