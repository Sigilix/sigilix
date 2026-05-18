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
 *  failure that produced it.
 *
 *  - `inline-anchored` — verify-fail on the primary inline-anchored
 *    submit (the most common case ARC-279 was built for).
 *  - `anchorless-fallback` — verify-fail on the 422-fallback path.
 *  - `phase3` — legacy single-shot reviewer (ARC-280 deleted the
 *    code path, retained for historical telemetry).
 *  - `inline-anchored-error` — ARC-287 follow-up: non-422 errors
 *    thrown by the inline-anchored submitReview call. Pre-ARC-287
 *    these rethrew and the prior review stayed visible; post-ARC-287
 *    the prior is already dismissed, so we ALWAYS post the synth
 *    body as a comment to preserve the customer signal. */
export type CommentFallbackSubmitPath =
  | "inline-anchored"
  | "inline-anchored-error"
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
  // The reason line varies by submit-path. ARC-279's original two
  // paths (`inline-anchored` + `anchorless-fallback`) hit this code
  // when submitReview returned 2xx but the review never persisted
  // — describe that. ARC-287 added `inline-anchored-error`: the
  // submit actually threw (timeout, 5xx, rate limit), not silently
  // failed. The two failure modes deserve distinct copy so the
  // customer reading the comment knows what to expect on retry.
  const reason: string = (() => {
    switch (submitPath) {
      case "inline-anchored-error":
        return `> The \`${submitPath}\` submit failed with a transient GitHub error (timeout, 5xx, rate limit, etc). Posting the synth output as a regular PR comment instead so the review signal isn't lost.`
      case "inline-anchored":
      case "anchorless-fallback":
      case "phase3":
      default:
        return `> The \`${submitPath}\` submit returned 2xx but the review never became publicly visible (PENDING / silent reject). Posting the synth output as a regular PR comment instead so the review signal isn't lost.`
    }
  })()
  const header = [
    "<!-- sigilix:review-comment-fallback -->",
    "",
    "> [!WARNING]",
    "> **Sigilix couldn't post this as a formal review on GitHub.**",
    ">",
    reason,
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

// ARC-280 follow-up (PR #92 review): the ensemble has paths that
// historically fell through to Phase 3 (router_no_specialists,
// specialists_all_failed, synth retry exhausted, internal_error).
// With Phase 3 deleted, those paths returned `skipped` / `errored`
// with NO review body — recreating the silent-skip pattern ARC-275
// was meant to eliminate.
//
// `postReviewSkipNotice` posts a minimal "Sigilix couldn't generate
// a review for this PR" comment on those paths so the user sees
// what happened. Distinct KV key family from
// `postReviewCommentFallback` (which fires when we HAVE a synth
// body but submit silently rejected) so a "couldn't generate"
// notice + a later successful review on the same head don't
// collide.

/** Customer-facing reason name surfaced in the skip-notice header. */
export type SkipNoticeReason =
  | "router_no_specialists"
  | "specialists_all_failed"
  | "synth_timeout"
  | "synth_failed_parse"
  | "synth_invalid_provenance"
  | "internal_error"

function dedupeKeyForSkipNotice(args: {
  owner: string
  repo: string
  prNumber: number
  headSha: string
}): string {
  return `pr-review-skip-notice:${args.owner}/${args.repo}#${args.prNumber}@${args.headSha}`
}

/** Pure: render the body for a "Sigilix couldn't review" comment.
 *  Carries the existing `openclaw:pr-review` marker so dismiss-prior
 *  / review-memory pipelines treat it as a Sigilix review surface,
 *  plus a dedicated `sigilix:review-skip-notice` marker so a future
 *  cleanup pass can tell skip-notices apart from real reviews +
 *  ARC-279 comment-fallbacks. */
export function renderReviewSkipNotice(args: {
  reason: SkipNoticeReason
  headSha: string
  /** ARC-280 (CR catch on PR #92): when reason is
   *  `specialists_all_failed`, name the roles the router actually
   *  dispatched. Otherwise the message claimed "all four
   *  specialists" even when the router only ran 1–3. */
  dispatchedRoles?: readonly string[]
}): string {
  const { reason, headSha, dispatchedRoles } = args
  const sha7 = headSha.slice(0, 7)
  const roles = dispatchedRoles && dispatchedRoles.length > 0
    ? dispatchedRoles.join(", ")
    : "logic, security, performance, tests"
  const explanation: Record<SkipNoticeReason, string> = {
    router_no_specialists:
      "The diff didn't match any specialist's domain (logic / security / performance / tests), so no specialist could run.",
    specialists_all_failed:
      `Every specialist the router dispatched (${roles}) failed to return a verdict (model timeout / rate-limit / parse-fail). Synth had no input to work with.`,
    synth_timeout:
      "The synth call timed out twice (primary + retry). Specialist verdicts were produced but couldn't be merged.",
    synth_failed_parse:
      "The synth model returned output that couldn't be parsed as JSON, even after a retry with a tightened prompt.",
    synth_invalid_provenance:
      "The synth model produced a verdict whose provenance couldn't be validated against the specialist inputs, even after a retry.",
    internal_error:
      "An unexpected internal error fired during the ensemble run. The on-call team has a telemetry record.",
  }
  return [
    "<!-- openclaw:pr-review -->",
    "<!-- sigilix:review-skip-notice -->",
    "",
    "> [!WARNING]",
    "> **Sigilix couldn't generate a review for this PR.**",
    ">",
    `> Reason: \`${reason}\` — ${explanation[reason]}`,
    ">",
    `> Re-run \`/sigilix review\` to try again. Run on \`${sha7}\`.`,
  ].join("\n")
}

export interface PostReviewSkipNoticeArgs {
  env: Env
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  reason: SkipNoticeReason
  /** ARC-280 (CR catch on PR #92): roles the router actually
   *  dispatched. Only meaningful for `specialists_all_failed`;
   *  passed through to `renderReviewSkipNotice` so the message
   *  names the right set instead of asserting "all four." */
  dispatchedRoles?: readonly string[]
}

export type PostReviewSkipNoticeResult =
  | { ok: true; reason: "posted"; commentId?: number }
  | { ok: true; reason: "dedupe-hit" }
  | { ok: false; reason: "post-failed"; error: string }

/**
 * Best-effort skip-notice poster. KV-deduped per (PR, headSha) with
 * a 7-day TTL so retry storms produce one notice per head. KV-read
 * failure proceeds with the post (better one extra comment than
 * zero); KV-write failure on success is non-fatal.
 *
 * Never throws — every failure path returns a structured result.
 */
export async function postReviewSkipNotice(
  args: PostReviewSkipNoticeArgs,
): Promise<PostReviewSkipNoticeResult> {
  const { env, client, owner, repo, prNumber, headSha, reason, dispatchedRoles } = args
  const tag = { owner, repo, prNumber, headSha, skip_reason: reason }
  const key = dedupeKeyForSkipNotice({ owner, repo, prNumber, headSha })

  try {
    const existing = await env.OPENCLAW_STATE.get(key)
    if (existing) {
      console.log(JSON.stringify({
        event: "pr-review-skip-notice-dedupe-hit",
        ...tag,
      }))
      return { ok: true, reason: "dedupe-hit" }
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-skip-notice-dedupe-read-failed",
      err: err instanceof Error ? err.message : String(err),
      ...tag,
    }))
  }

  const body = renderReviewSkipNotice({
    reason,
    headSha,
    ...(dispatchedRoles !== undefined ? { dispatchedRoles } : {}),
  })

  try {
    const result = await client.createIssueComment(owner, repo, prNumber, body)
    await env.OPENCLAW_STATE.put(key, String(Date.now()), {
      expirationTtl: 7 * 24 * 60 * 60,
    }).catch((err) => {
      console.warn(JSON.stringify({
        event: "pr-review-skip-notice-dedupe-write-failed",
        err: err instanceof Error ? err.message : String(err),
        ...tag,
      }))
    })
    const commentId = typeof result === "object" && result !== null && "id" in result
      ? Number(result.id)
      : undefined
    console.log(JSON.stringify({
      event: "pr-review-skip-notice-posted",
      ...tag,
      ...(commentId !== undefined ? { comment_id: commentId } : {}),
    }))
    return commentId !== undefined
      ? { ok: true, reason: "posted", commentId }
      : { ok: true, reason: "posted" }
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({
      event: "pr-review-skip-notice-post-failed",
      err: errStr,
      ...tag,
    }))
    return { ok: false, reason: "post-failed", error: errStr }
  }
}
