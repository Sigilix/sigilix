import type { Env } from "@/src/shared/types/env"
import { captureInstructiveLearning, resolveLearningsMode, resolveOrgMemoryCaptureMode } from "@/src/features/learnings"
import { isSlackOrgTeacher } from "@/src/lib/slack/slack-api"

/**
 * Org-teach capture for the Slack QA path, gated on the messaging user being a
 * Slack workspace admin (fail-closed). Extracted from `runQa` to keep
 * `slack-agent.ts` within the file-size budget; behaviour is identical.
 *
 * Only writes an org-scope learning when capture modes are on AND the author is
 * an admin. A non-admin / undetermined author is denied and logged with a
 * distinct `org-teach-authz-denied` event, so an over-denial (a dropped real
 * admin: reason `unknown`/`api-*`/`lookup-error`) is distinguishable from a
 * correct denial (`not-admin`). With learnings capture OFF (the default) the
 * admin check — and its `users.info` call — never runs.
 */
export async function maybeCaptureSlackOrgTeach(
  env: Env,
  args: {
    botToken?: string | null | undefined
    slackUserId: string
    installationId: string | number
    channelId: string
    threadTs: string
    mentionText: string
    teamId: string
  },
): Promise<void> {
  const orgTeachActive =
    resolveLearningsMode(env.OPENCLAW_LEARNINGS_MODE) !== "off" && resolveOrgMemoryCaptureMode(env) !== "off"
  if (!orgTeachActive) return

  // A missing bot token can't verify admin; pass "" so the workspace-admin check
  // fails closed inside isSlackOrgTeacher (users.info rejects an empty token).
  const authz = await isSlackOrgTeacher({
    botToken: args.botToken ?? "",
    userId: args.slackUserId,
  })
  if (authz.authorized) {
    await captureInstructiveLearning({
      env,
      scope: "org",
      subjectId: String(args.installationId),
      surface: "chat",
      sourceKind: "chat",
      message: args.mentionText,
      dedupeId: `slack:${args.channelId}:${args.threadTs}:${args.slackUserId}`,
      actor: `slack:${args.slackUserId}`,
      telemetry: { surface_detail: "slack", team_id: args.teamId },
    }).catch(() => {})
    return
  }

  console.log(
    JSON.stringify({
      event: "org-teach-authz-denied",
      surface: "slack",
      reason: authz.reason,
      actor: `slack:${args.slackUserId}`,
      subject_id: String(args.installationId),
      team_id: args.teamId,
    }),
  )
}
