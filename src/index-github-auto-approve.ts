// SIG-223: GitHub webhook glue for resolved-finding auto-APPROVE.
// Kept out of index-github-webhook.ts so the main router stays under
// the 1,000-line compliance budget.

import type { Env } from "@/src/shared/types/env"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { SIGILIX_BOT_LOGIN } from "@/src/lib/dismiss-prior-reviews"
import {
  bodyHasSigilixResolutionCommand,
  markTrustedAutoApproveThreadResolved,
  maybeAutoApproveResolvedSigilixReview,
  type AutoApproveTrigger,
} from "@/src/lib/pr-review-auto-approve"
import type { GitHubWebhookPayload } from "@/src/index-internals"

export function scheduleAutoApproveOnResolution(args: {
  env: Env
  ctx: ExecutionContext
  owner: string
  repo: string
  prNumber: number
  installationId: number
  trigger: AutoApproveTrigger
  beforeCheck?: () => Promise<void>
}): void {
  const { env, ctx, owner, repo, prNumber, installationId, trigger, beforeCheck } = args
  ctx.waitUntil(
    (async () => {
      if (beforeCheck) await beforeCheck()
      if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return
      const token = await getInstallationToken({
        kv: env.OPENCLAW_STATE,
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_PRIVATE_KEY,
        installationId,
      })
      const client = new GitHubClient({ token })
      await maybeAutoApproveResolvedSigilixReview({ env, client, owner, repo, prNumber, trigger })
    })().catch((err) => {
      console.warn(
        JSON.stringify({
          event: "pr-review-auto-approve-dispatch-failed",
          owner,
          repo,
          prNumber,
          trigger,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }),
  )
}

export function handleReviewThreadAutoApproveWebhook(args: {
  env: Env
  ctx: ExecutionContext
  payload: GitHubWebhookPayload
  owner: string
  repo: string
  installationId: number
}): Response {
  const { env, ctx, payload, owner, repo, installationId } = args
  if (payload.action !== "resolved") {
    return new Response("skip review_thread action\n", { status: 200 })
  }
  const prNumber = payload.pull_request?.number
  if (typeof prNumber !== "number") {
    return new Response("missing pr number\n", { status: 400 })
  }
  const threadId = payload.thread?.node_id
  if (typeof threadId !== "string" || threadId.length === 0) {
    return new Response("missing thread id\n", { status: 400 })
  }
  const senderLogin = payload.sender?.login ?? null
  const prAuthorLogin = payload.pull_request?.user?.login ?? null
  if (!senderLogin || senderLogin === SIGILIX_BOT_LOGIN || senderLogin === prAuthorLogin) {
    console.log(
      JSON.stringify({
        event: "pr-review-auto-approve-skipped-untrusted-thread-resolution",
        owner,
        repo,
        prNumber,
        threadId,
        senderLogin,
        prAuthorLogin,
      }),
    )
    return new Response("skip untrusted thread resolver\n", { status: 200 })
  }
  scheduleAutoApproveOnResolution({
    env,
    ctx,
    owner,
    repo,
    prNumber,
    installationId,
    trigger: "thread-resolved",
    beforeCheck: () => markTrustedAutoApproveThreadResolved({ env, owner, repo, prNumber, threadId, senderLogin }),
  })
  return new Response("queued auto-approve check\n", { status: 202 })
}

export function maybeScheduleAutoApproveFromIssueComment(args: {
  env: Env
  ctx: ExecutionContext
  payload: GitHubWebhookPayload
  owner: string
  repo: string
  installationId: number
}): void {
  const { env, ctx, payload, owner, repo, installationId } = args
  if (
    typeof payload.issue?.number === "number" &&
    payload.comment?.user?.login !== SIGILIX_BOT_LOGIN &&
    bodyHasSigilixResolutionCommand(payload.comment?.body)
  ) {
    scheduleAutoApproveOnResolution({
      env,
      ctx,
      owner,
      repo,
      prNumber: payload.issue.number,
      installationId,
      trigger: "issue-command",
    })
  }
}

export function maybeScheduleAutoApproveFromReviewComment(args: {
  env: Env
  ctx: ExecutionContext
  payload: GitHubWebhookPayload
  owner: string
  repo: string
  installationId: number
}): void {
  const { env, ctx, payload, owner, repo, installationId } = args
  if (
    typeof payload.pull_request?.number === "number" &&
    payload.comment?.user?.login !== SIGILIX_BOT_LOGIN &&
    typeof payload.comment?.in_reply_to_id === "number"
  ) {
    scheduleAutoApproveOnResolution({
      env,
      ctx,
      owner,
      repo,
      prNumber: payload.pull_request.number,
      installationId,
      trigger: "review-comment-created",
    })
  }
}
