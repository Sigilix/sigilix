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
