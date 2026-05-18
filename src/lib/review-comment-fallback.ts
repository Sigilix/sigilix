// ARC-279: synth-body-as-PR-comment fallback for when GitHub
// silently rejects the formal review submit.
//
// Background
//
// `submitReview` (POST /pulls/{n}/reviews) occasionally returns 2xx
// with a valid-looking `{id, state}` payload but the review never
// becomes publicly visible — it persists as a PENDING (draft) on
// GitHub's side or is silently dropped. PRs #84 and #86 each chased
// this pattern. After PR #85 + #86's verify-after-submit, the
// ensemble correctly detects the failure and returns `errored`.
//
// Pre-ARC-279, that `errored` propagated to the dispatcher which
// fell back to Phase 3, which had its own dedupe key + verify chain.
// If Phase 3 also hit a dedupe-hit (from any earlier trigger), the
// dispatcher reported `success / "Review posted"` with no review
// behind it. That's the silent-success pattern this ticket eliminates.
//
// What this module does
//
// 1. `renderReviewCommentFallback(body, submitPath)` — pure helper.
//    Wraps the synth's formal-review body with a clear header
//    ("Sigilix couldn't post this as a formal review on GitHub —
//    posting as a comment instead") so the customer knows the
//    channel changed. The body still carries the `openclaw:pr-review`
//    marker family so cross-PR memory and dismiss-prior helpers can
//    find it later.
//
// 2. `postReviewCommentFallback(...)` — async helper. KV-dedupes per
//    (PR, headSha) so a retry storm on the same SHA produces ONE
//    comment, not N. Posts via `createIssueComment`. Returns a
//    structured result so the ensemble can route the Check Run
//    correctly.
//
// Pure helpers are exported for unit tests; the async helper is
// exercised through the ensemble's integration path.

import type { GitHubClient } from "./github"
import type { Env } from "../index"

/** The marker every Sigilix review body starts with. Same marker the
 *  formal-review path uses (see `formatReviewBody` in
 *  `triage-pr-review.ts`) so dismissPriorSigilixReviews + review-memory
 *  pipelines can find a comment-fallback the same way they find a
 *  real review. */
const SIGILIX_REVIEW_BODY_MARKER = "<!-- openclaw:pr-review -->"

/** Per-(PR, headSha) dedupe key for the comment-fallback path.
 *  Distinct key family from the regular pr-review dedupe so a
 *  comment-fallback record doesn't suppress a future successful
 *  formal-review submit on the same SHA (and vice versa). */
function dedupeKeyForCommentFallback(args: {
  owner: string
  repo: string
  prNumber: number
  headSha: string
}): string {
  return `pr-review-comment-fallback:${args.owner}/${args.repo}#${args.prNumber}@${args.headSha}`
}

/** The submit path that failed verify. Surfaced in the header so the
 *  customer (and on-call) can correlate the comment with the kind of
 *  failure that produced it. */
export type CommentFallbackSubmitPath =
  | "inline-anchored"
  | "anchorless-fallback"
  | "phase3"

/**
 * Pure: produce the body Sigilix posts as a regular PR comment when
 * the formal review submit didn't persist. Prepends a clear,
 * customer-facing header so the channel change is obvious, then
 * appends the original synth body.
 *
 * Header explains:
 *   - what just happened (submit returned 2xx but didn't persist)
 *   - which submit path was tried
 *   - what they can do (`/sigilix review` to retry)
 *
 * Body marker — `<!-- openclaw:pr-review -->` already lives in the
 * synth body that gets passed in (every formal-review body emits it
 * via `formatReviewBody`); the wrapper adds a SECOND comment marker
 * for the fallback path itself so a future ARC-280-era refactor can
 * grep for "fallback-shaped comment" without parsing the whole body.
 */
export function renderReviewCommentFallback(args: {
  body: string
  submitPath: CommentFallbackSubmitPath
  headSha: string
}): string {
  const { body, submitPath, headSha } = args
  const sha7 = headSha.slice(0, 7)
  const header = [
    "<!-- sigilix:review-comment-fallback -->",
    "",
    "> [!WARNING]",
    "> **Sigilix couldn't post this as a formal review on GitHub.**",
    ">",
    `> The \`${submitPath}\` submit returned 2xx but the review never became publicly visible (PENDING / silent reject). Posting the synth output as a regular PR comment instead so the review signal isn't lost.`,
    ">",
    `> Re-run \`/sigilix review\` to try posting the formal review again. Run on \`${sha7}\`.`,
    "",
    "---",
    "",
  ].join("\n")
  // Pull the openclaw:pr-review marker that lives at the top of the
  // synth's body out so the two markers (fallback + review) stay
  // adjacent at the top. The synth body's first line is always
  // `<!-- openclaw:pr-review -->`; tolerant of variation by just
  // checking for the marker substring.
  if (body.includes(SIGILIX_REVIEW_BODY_MARKER)) {
    return `${header}${body}`
  }
  // Defensive: if the synth body somehow lacks the marker, inject
  // one so downstream tools (review-memory, dismiss-prior) can still
  // find it.
  return `${header}${SIGILIX_REVIEW_BODY_MARKER}\n${body}`
}

export interface PostReviewCommentFallbackArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** The exact body the synth-built formal review would have used.
   *  Will be wrapped with a header explaining the channel change. */
  body: string
  submitPath: CommentFallbackSubmitPath
}

export type PostReviewCommentFallbackResult =
  | { ok: true; reason: "posted"; commentId?: number }
  | { ok: true; reason: "dedupe-hit" }
  | { ok: false; reason: "post-failed"; error: string }

/**
 * Async helper. KV-dedupes per (PR, headSha) so webhook retries +
 * `/sigilix review` re-trigger storms on the same SHA produce ONE
 * comment, not N. On dedupe-hit, returns `{ ok: true, reason:
 * "dedupe-hit" }` so the caller can still report `posted` to the
 * dispatcher (a comment IS up; the new run didn't add value).
 *
 * Best-effort: never throws — every failure path returns a
 * structured result. The caller decides whether to map "post-failed"
 * to `errored` (dispatcher's Check Run = failure) or to something
 * else.
 *
 * 7-day TTL on the dedupe key matches the formal-review dedupe so
 * `/sigilix review` re-runs against the same head produce a single
 * comment.
 */
export async function postReviewCommentFallback(
  args: PostReviewCommentFallbackArgs,
): Promise<PostReviewCommentFallbackResult> {
  const { env, client, owner, repo, prNumber, headSha, body, submitPath } = args
  const tag = { owner, repo, prNumber, headSha, submit_path: submitPath }
  const key = dedupeKeyForCommentFallback({ owner, repo, prNumber, headSha })

  // Dedupe check FIRST so we don't even render the wrapper when a
  // prior fallback already landed.
  try {
    const existing = await env.OPENCLAW_STATE.get(key)
    if (existing) {
      console.log(JSON.stringify({
        event: "pr-review-comment-fallback-dedupe-hit",
        ...tag,
      }))
      return { ok: true, reason: "dedupe-hit" }
    }
  } catch (err) {
    // KV read failure is not fatal — proceed without the dedupe
    // guard. Two comments are a worse-day failure mode than zero.
    console.warn(JSON.stringify({
      event: "pr-review-comment-fallback-dedupe-read-failed",
      err: err instanceof Error ? err.message : String(err),
      ...tag,
    }))
  }

  const commentBody = renderReviewCommentFallback({ body, submitPath, headSha })

  try {
    const result = await client.createIssueComment(owner, repo, prNumber, commentBody)
    // Set the dedupe key AFTER the post succeeds. If we set it
    // first and then the post fails, a retry would dedupe-hit
    // without anything actually existing. 7-day TTL.
    await env.OPENCLAW_STATE.put(key, String(Date.now()), {
      expirationTtl: 7 * 24 * 60 * 60,
    }).catch((err) => {
      // KV write failure is non-fatal — the comment is already
      // posted; a subsequent retry would just post a duplicate.
      // Log so we notice if this fires regularly.
      console.warn(JSON.stringify({
        event: "pr-review-comment-fallback-dedupe-write-failed",
        err: err instanceof Error ? err.message : String(err),
        ...tag,
      }))
    })
    const commentId = typeof result === "object" && result !== null && "id" in result
      ? Number(result.id)
      : undefined
    console.log(JSON.stringify({
      event: "pr-review-comment-fallback-posted",
      ...tag,
      ...(commentId !== undefined ? { comment_id: commentId } : {}),
    }))
    return commentId !== undefined
      ? { ok: true, reason: "posted", commentId }
      : { ok: true, reason: "posted" }
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      event: "pr-review-comment-fallback-post-failed",
      err: errStr,
      ...tag,
    }))
    return { ok: false, reason: "post-failed", error: errStr }
  }
}
