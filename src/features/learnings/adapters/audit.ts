import type { LearningScope } from "@/src/features/learnings/domain/types"

export type LearningAuditAction = "remember" | "forget" | "hard-delete" | "capture"

export interface LearningAuditEvent {
  actor: string
  scope: LearningScope
  subjectId: string
  action: LearningAuditAction
  learningId: string
  ts: string
}

/**
 * Emit the SOC 2 audit record for a learning mutation. This is a STRUCTURED
 * `learning-mutation-audit` event (stable keys) so it can be retained off-box
 * by a Cloudflare **Logpush** filter — spec §12.9 requires a retained sink, NOT
 * best-effort stdout. The Logpush retention policy is an ops/observability
 * config (not code); pin it before relying on this for the SOC 2 evidence rail.
 * Tracked as a deploy/ops step on SIG-104 PR-1.
 */
export function emitLearningAudit(event: LearningAuditEvent): void {
  console.log(
    JSON.stringify({
      event: "learning-mutation-audit",
      actor: event.actor,
      scope: event.scope,
      subject_id: event.subjectId,
      action: event.action,
      learning_id: event.learningId,
      ts: event.ts,
    }),
  )
}
