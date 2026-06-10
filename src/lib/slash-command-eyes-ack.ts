// ARC-190 Task 10: 👀 eye-emoji ack on slash-command receipt.
//
// Mirrors the @-mention path's instant ack (see
// `src/lib/github-mention.ts:131-147`) so reviewers driving Sigilix
// from `/sigilix review`, `/sigilix improve`, etc. see visible
// feedback within ~1s of webhook delivery instead of waiting on the
// queue + LLM round-trip.
//
// Best-effort: every failure path is swallowed + logged. The user-
// facing ack is a UX bonus, never a correctness gate; the actual
// command result still posts when the queue consumer finishes.
//
// Designed to run via `ctx.waitUntil(...)` from the webhook handler
// so the slash-command path returns 202 immediately while the
// reaction POST happens in the background.

import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import type { GhMentionSurface } from "./github-mention"
import type { Env } from "@/src/shared/types/env"

export interface SlashCommandEyesAckArgs {
  env: Env
  owner: string
  repo: string
  commentId: number
  surface: GhMentionSurface
  installationId: number
}

/**
 * Post a 👀 reaction on the source slash-command comment. Resolves
 * to undefined on every path — the caller never branches on the
 * result. Logs a single warning on failure.
 */
export async function postSlashCommandEyesAck(
  args: SlashCommandEyesAckArgs,
): Promise<void> {
  const { env, owner, repo, commentId, surface, installationId } = args

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.warn(JSON.stringify({
      event: "slash-command-eyes-ack-misconfigured",
      reason: "missing_github_app_credentials",
      owner, repo, commentId, surface,
    }))
    return
  }

  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    if (surface === "issue") {
      await client.addReactionToIssueComment(owner, repo, commentId, "eyes")
    } else {
      await client.addReactionToReviewComment(owner, repo, commentId, "eyes")
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "slash-command-eyes-ack-failed",
      err: err instanceof Error ? err.message : String(err),
      owner, repo, commentId, surface,
    }))
  }
}
