// ARC-258 / SIG-85 — detect stale prior Sigilix reviews on each
// new submit.
//
// SIG-85 (2026-05-18): bot-initiated dismissal removed. GitHub's
// repo-level "Dismiss stale pull request approvals when new commits
// are pushed" branch-protection setting handles staleness natively
// and attributes the dismissal to the commit pusher (instead of
// `sigilix[bot] dismissed their stale review`). Customers must enable
// the setting; see docs/setup/customer-onboarding.md. This module now
// only LISTS + FILTERS prior reviews and emits a telemetry event per
// stale prior — useful for observability + future dismissal-pathway
// decisions.
//
// Identity: prior Sigilix reviews are identified by BOTH a Sigilix
// review-body marker (`<!-- sigilix:pr-review -->` OR the legacy
// `<!-- openclaw:pr-review -->` — SIG-85 bilingual matcher) AND the
// reviewer's `user.login === "sigilix[bot]"`. Defense in depth: the
// marker alone could be impersonated by a human pasting the HTML
// comment into their own review body; the login check guarantees we
// only ever count our own App's reviews.

import { GitHubClient } from "./github"

/** The marker every Sigilix review body starts with — see
 *  `buildReviewSubmission` / `buildFallbackSubmission` in
 *  triage-pr-review.ts. Match-by-marker is the FIRST half of the
 *  stale-detector identity gate; the user-login check below is the
 *  second. */
export const SIGILIX_REVIEW_BODY_MARKER = "<!-- sigilix:pr-review -->"

// SIG-85: bilingual matcher for the openclaw→sigilix rebrand. Read both
// markers so the existing-comment lookup finds legacy stickies and
// edits them in place instead of creating duplicates. Drop the legacy
// half once all pre-2026-05-18 PRs close.
export const LEGACY_REVIEW_BODY_MARKER = "<!-- openclaw:pr-review -->"

/** The bot login under which the Sigilix App posts reviews. Pair
 *  with the body marker to defend against any review whose body
 *  happens to contain the marker but was authored by a human or
 *  another bot. If the App's slug ever changes, update here. */
const SIGILIX_BOT_LOGIN = "sigilix[bot]"

/** States we treat as actionable for the stale-detector. Same set as
 *  the pre-SIG-85 dismissible states — COMMENTED + PENDING were never
 *  dismissible via the API (422), DISMISSED is already terminal — so
 *  the filter still matches "review states a reviewer would consider
 *  current." */
const DISMISSIBLE_STATES = new Set(["APPROVED", "CHANGES_REQUESTED"])

export interface DismissPriorArgs {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  /** The review we JUST posted, excluded from the stale-detector so
   *  we don't flag our own fresh review.
   *
   *  ARC-287: `null` is the new sentinel for "dismiss-then-post" —
   *  the helper fires BEFORE submitReview, so there's no current
   *  review yet to exclude. The filter flags ALL matching prior
   *  reviews in that case. A numeric ID retains the post-then-dismiss
   *  semantics for any caller that hasn't migrated to the new order. */
  currentReviewId: number | null
  /** SIG-85: retained for caller back-compat. Pre-SIG-85 this was
   *  inlined into the dismissal message; bot-initiated dismissal has
   *  since been removed, so the field is accepted and ignored. */
  headSha?: string
}

export interface DismissPriorResult {
  /**
   * SIG-85: always 0. Kept in the return shape so callers don't need
   * to be updated when bot-initiated dismissal was removed. GitHub's
   * branch-protection "Dismiss stale pull request approvals when new
   * commits are pushed" setting now does the actual dismissal.
   */
  dismissed: number
  /**
   * SIG-85: always 0. Kept in the return shape for caller back-compat.
   */
  failed: number
}

/**
 * List the PR's reviews; for each prior Sigilix review that:
 *   - has a different id than `currentReviewId`,
 *   - is in an APPROVED or CHANGES_REQUESTED state,
 *   - is authored by `sigilix[bot]`,
 *   - and carries a Sigilix review-body marker (current or legacy),
 * emit a `pr-review-stale-detected` telemetry event.
 *
 * SIG-85: bot-initiated `dismissReview` removed. Customers enable the
 * repo-level "Dismiss stale pull request approvals when new commits
 * are pushed" branch-protection setting; GitHub then handles the
 * dismissal natively and attributes it to the commit pusher.
 *
 * Pure-effect; never throws. List-call failure returns zeros.
 */
export async function dismissPriorSigilixReviews(
  args: DismissPriorArgs,
): Promise<DismissPriorResult> {
  const { client, owner, repo, prNumber, currentReviewId } = args
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
  //
  // SIG-85: bilingual matcher for the openclaw→sigilix rebrand. Read
  // both markers so legacy stickies are still recognized as Sigilix
  // reviews. Drop the legacy half once all pre-2026-05-18 PRs close.
  //
  // ARC-287: when `currentReviewId === null`, the helper fires BEFORE
  // the new submitReview, so there's no current review yet — every
  // matching prior review counts as stale. The `r.id !== null` check
  // is structurally always true in that case (review IDs are always
  // numeric), so the filter naturally skips the exclude.
  const targets = reviews.filter((r) =>
    r.id !== currentReviewId &&
    DISMISSIBLE_STATES.has(r.state) &&
    r.user?.login === SIGILIX_BOT_LOGIN &&
    (r.body.includes(SIGILIX_REVIEW_BODY_MARKER) ||
      r.body.includes(LEGACY_REVIEW_BODY_MARKER)),
  )
  // code-reviewer M2 catch: when the list returns the 100-item cap,
  // we may be missing older Sigilix reviews. Log a warning so we
  // notice if any real PR ever accumulates that many.
  if (reviews.length >= 100) {
    console.warn(JSON.stringify({
      event: "pr-review-dismiss-list-capped",
      owner, repo, prNumber,
      review_count: reviews.length,
      note: "listPullRequestReviews returned >=100 items; older Sigilix reviews may not be detected in this run.",
    }))
  }
  for (const r of targets) {
    // SIG-85: bot-initiated dismissal removed. GitHub's repo-level
    // "Dismiss stale pull request approvals when new commits are
    // pushed" setting handles staleness natively and attributes the
    // dismissal to the commit pusher (instead of sigilix[bot]).
    // Customers must enable this setting; see
    // docs/setup/customer-onboarding.md.
    console.log(JSON.stringify({
      event: "pr-review-stale-detected",
      owner, repo, prNumber, review_id: r.id, prior_state: r.state,
      commit_id: r.commitId ?? null,
    }))
  }
  // `dismissed` always 0; return shape kept for caller back-compat.
  return { dismissed: 0, failed: 0 }
}
