import type { LearningScope } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

export const CONFIRMATION_MAP_TTL_SECONDS = 90 * 24 * 60 * 60

export interface LearningConfirmationMapValue {
  scope: LearningScope
  subjectId: string
  learningId: string
}

export async function recordConfirmationMap(
  env: Env,
  confirmationCommentId: number | string,
  value: LearningConfirmationMapValue,
): Promise<boolean> {
  const key = confirmationMapKey(confirmationCommentId)
  try {
    await env.OPENCLAW_STATE.put(key, JSON.stringify(value), {
      expirationTtl: CONFIRMATION_MAP_TTL_SECONDS,
    })
    console.log(
      JSON.stringify({
        event: "learning-confirmation-map-recorded",
        confirmation_comment_id: String(confirmationCommentId),
        scope: value.scope,
        subject_id: value.subjectId,
        learning_id: value.learningId,
      }),
    )
    return true
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "learning-confirmation-map-record-failed",
        confirmation_comment_id: String(confirmationCommentId),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return false
  }
}

/**
 * Record the confirmation→learning map under BOTH the confirmation comment id and the
 * thread-root (original finding) comment id. GitHub flattens review-comment threads, so a user's
 * `@sigilix forget` reply carries `in_reply_to` = the thread root, not the confirmation comment.
 * Keying both lets the forget handler — which resolves `inReplyToId ?? threadRootId` — find the
 * learning either way. (SIG-464)
 */
export async function recordConfirmationMapForThread(
  env: Env,
  confirmationCommentId: number | string,
  threadRootId: number | string | undefined,
  value: LearningConfirmationMapValue,
): Promise<boolean> {
  const recorded = await recordConfirmationMap(env, confirmationCommentId, value)
  if (threadRootId === undefined || String(threadRootId) === String(confirmationCommentId)) {
    return recorded
  }
  const rootRecorded = await recordConfirmationMap(env, threadRootId, value)
  return recorded && rootRecorded
}

export async function resolveConfirmationMap(
  env: Env,
  confirmationCommentId: number | string,
): Promise<LearningConfirmationMapValue | null> {
  const key = confirmationMapKey(confirmationCommentId)
  try {
    const raw = await env.OPENCLAW_STATE.get(key)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    return isValidConfirmationMapValue(parsed) ? parsed : null
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "learning-confirmation-map-resolve-failed",
        confirmation_comment_id: String(confirmationCommentId),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
}

function confirmationMapKey(confirmationCommentId: number | string): string {
  return `learning-confirmation:${confirmationCommentId}`
}

function isValidConfirmationMapValue(value: unknown): value is LearningConfirmationMapValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Partial<LearningConfirmationMapValue>
  return isScope(record.scope) && typeof record.subjectId === "string" && typeof record.learningId === "string"
}

function isScope(value: unknown): value is LearningScope {
  return value === "repo" || value === "org" || value === "project"
}
