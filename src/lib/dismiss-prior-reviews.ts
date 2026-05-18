// ARC-258 follow-up — dismiss stale prior Sigilix reviews on each
// new submit.
//
// Without this, GitHub's Reviews tab keeps showing "Sigilix approved
// a while ago" against an earlier commit even after Sigilix has
// re-reviewed the new head. Per-commit Check Runs handle the
// in-progress signal correctly, but the Reviews tab is per-PR and
// doesn't auto-dismiss prior approvals when new commits land.
//
// The dispatcher calls `dismissPriorSigilixReviews` immediately after
// a successful `submitReview` (+ verify) so the customer always sees
// exactly ONE Sigilix review on the PR — the one matching the
// current head.
//
// Identity: prior Sigilix reviews are identified by BOTH the
// `<!-- openclaw:pr-review -->` marker in the body AND the
// reviewer's `user.login === "sigilix[bot]"`. Defense in depth:
// the marker alone could be impersonated by a human pasting the
// HTML comment into their own review body; the login check
// guarantees we only ever dismiss our own App's reviews.
//
// Best-effort: any dismissal failure (4xx / 5xx / network) logs and
// continues. The new review is already posted; a missed dismissal
// just leaves the stale approval visible until the next push.

import { GitHubClient } from "./github"

/** The marker every Sigilix review body starts with — see
 *  `buildReviewSubmission` / `buildFallbackSubmission` in
 *  triage-pr-review.ts. Match-by-marker is the FIRST half of the
 *  dismissal gate; the user-login check below is the second. */
export const SIGILIX_REVIEW_BODY_MARKER = "<!-- openclaw:pr-review -->"

/** The bot login under which the Sigilix App posts reviews. Pair
 *  with the body marker to defend against any review whose body
 *  happens to contain the marker but was authored by a human or
 *  another bot. If the App's slug ever changes, update here. */
const SIGILIX_BOT_LOGIN = "sigilix[bot]"

/** States that GitHub allows `POST /dismissals` to operate on.
 *  COMMENTED and PENDING are rejected with 422; DISMISSED is a
 *  no-op (already dismissed). */
const DISMISSIBLE_STATES = new Set(["APPROVED", "CHANGES_REQUESTED"])

export interface DismissPriorArgs {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  /** The review we JUST posted. Excluded from dismissal so we
   *  don't undo our own fresh review. */
  currentReviewId: number
  /** The SHA of the new head Sigilix just reviewed. Used to name
   *  the new commit in the dismissal message so readers don't have
   *  to scroll/search for which review is the current one. The
   *  GitHub timeline places the "dismissed their stale review"
   *  banner BELOW the new review, so the message can't point
   *  directionally ("see the most recent review") — it has to be
   *  self-contained. Optional for backwards compatibility with
   *  callers that don't yet plumb the head SHA through. */
  headSha?: string
}

export interface DismissPriorResult {
  /** Number of prior Sigilix reviews dismissed. */
  dismissed: number
  /** Number we tried to dismiss but failed (e.g. 422 race, network blip). */
  failed: number
}

/**
 * List the PR's reviews; for each one that:
 *   - has a different id than `currentReviewId`,
 *   - is in an APPROVED or CHANGES_REQUESTED state,
 *   - and carries the Sigilix marker in its body,
 * issue a dismissal. Per-review failures are isolated.
 *
 * Pure-effect; never throws. List-call failure returns zeros.
 */
export async function dismissPriorSigilixReviews(
  args: DismissPriorArgs,
): Promise<DismissPriorResult> {
  const { client, owner, repo, prNumber, currentReviewId, headSha } = args
  let reviews: Array<{
    id: number
    state: string
    user: { login: string } | null
    body: string
    commitId: string | null
  }>
  try {
    reviews = await client.listPullRequestReviews(owner, repo, prNumber)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-dismiss-list-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
    return { dismissed: 0, failed: 0 }
  }
  // code-reviewer H1 catch: the body marker alone could in theory be
  // impersonated (a human pasting the HTML comment into their review
  // body would bypass our identity check). Require BOTH the marker
  // AND a `sigilix[bot]` author login — defense in depth.
  const targets = reviews.filter((r) =>
    r.id !== currentReviewId &&
    DISMISSIBLE_STATES.has(r.state) &&
    r.user?.login === SIGILIX_BOT_LOGIN &&
    r.body.includes(SIGILIX_REVIEW_BODY_MARKER),
  )
  // code-reviewer M2 catch: when the list returns the 100-item cap,
  // we may be missing older Sigilix reviews. Log a warning so we
  // notice if any real PR ever accumulates that many.
  if (reviews.length >= 100) {
    console.warn(JSON.stringify({
      event: "pr-review-dismiss-list-capped",
      owner, repo, prNumber,
      review_count: reviews.length,
      note: "listPullRequestReviews returned >=100 items; older Sigilix reviews may not be dismissed in this run.",
    }))
  }
  if (targets.length === 0) return { dismissed: 0, failed: 0 }
  // Short-SHA helper for the human-readable dismissal message. 7
  // chars matches `git log --oneline` / GitHub's default permalink
  // truncation, which is what most readers visually recognize.
  const short = (sha: string | null | undefined): string | null =>
    typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : null
  const newHead = short(headSha ?? null)
  let dismissed = 0
  let failed = 0
  for (const r of targets) {
    try {
      // The dismissal banner GitHub renders is shaped:
      //
      //   "sigilix [Bot] dismissed their stale review N minutes ago"
      //                                  ^^^^^^^^^^^^
      //                                  links to THIS review
      //   ┌────────────────────────────────────────────────────────┐
      //   │  <our message goes here>                                │
      //   └────────────────────────────────────────────────────────┘
      //
      // It appears in the timeline BELOW the new active review (the
      // dismiss API fires after the submit), so directional language
      // like "see the most recent review above" is wrong-direction
      // and "see below" is also wrong because nothing else follows.
      // We name both commits instead: the one this review was for
      // (so the reader can confirm it's stale) and the one Sigilix
      // re-reviewed (so they can find the active review by SHA).
      const oldSha = short(r.commitId)
      const oldClause = oldSha ? ` (commit \`${oldSha}\`)` : ""
      const newClause = newHead ? ` Sigilix has re-reviewed the new head (commit \`${newHead}\`).` : ""
      const message = `This Sigilix review was posted against an earlier commit${oldClause} and is no longer current.${newClause}`
      await client.dismissReview(owner, repo, prNumber, r.id, message)
      dismissed += 1
    } catch (err) {
      failed += 1
      console.warn(JSON.stringify({
        event: "pr-review-dismiss-failed",
        owner, repo, prNumber, review_id: r.id, prior_state: r.state,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
  console.log(JSON.stringify({
    event: "pr-review-dismissed-stale",
    owner, repo, prNumber,
    dismissed, failed,
    current_review_id: currentReviewId,
  }))
  return { dismissed, failed }
}
