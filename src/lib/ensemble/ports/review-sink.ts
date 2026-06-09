// Port: the WRITE / deliver side of GitHub for the PR-review ensemble — where a
// finished review (or its fallback) is posted, and where stale prior reviews are
// dismissed. Signatures match the concrete `GitHubClient` (in
// `@/shared/adapters/github`) so the client STRUCTURALLY satisfies this interface
// with no changes. Types only; imports nothing outward.
//
// NOTE on method shape: inline findings are delivered as the `comments` array of
// a single `submitReview` call (GitHub bundles them into one coherent review) —
// there is no separate "post inline comments" RPC on the client. The fallback
// single-comment + overview poster is `createIssueComment`; the threaded
// per-comment reply is `replyToReviewComment`.

import type { SubmitReviewBody } from "@/shared/types/github"

export interface ReviewSinkPort {
  /** Submit ONE PR review (body + inline `comments` + APPROVE/COMMENT/REQUEST_CHANGES). */
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody,
  ): Promise<{ id: number; state: string }>

  /** Post a top-level issue/PR-conversation comment — the fallback + overview poster. */
  createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number }>

  /** Reply to an existing inline review comment (threaded under the parent). */
  replyToReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }>

  /** Dismiss a prior (APPROVED / CHANGES_REQUESTED) review when a new commit lands. */
  dismissReview(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
    message: string,
  ): Promise<void>

  /** PATCH a prior review body in place (e.g. prepend a stale-notice block). */
  updateReviewBody(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
    body: string,
  ): Promise<void>
}
