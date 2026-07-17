import type { GitHubClient } from "@/src/shared/adapters/github"
import { graftReviewStatusBlock } from "./pr-review-status-render"

/**
 * Fetch the current sticky body before a direct PATCH so a standalone overview
 * run preserves the status block. A failed fetch is fail-closed; a missing
 * comment can safely be replaced by the freshly rendered body.
 */
export async function graftExistingStatusBlock(
  client: GitHubClient,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<string | null> {
  try {
    const existing = await client.getIssueComment(owner, repo, commentId)
    if (existing === null) return body
    return graftReviewStatusBlock(body, existing.body)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "pr-overview-status-graft-fetch-failed",
        owner,
        repo,
        commentId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
}
