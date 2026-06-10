// SIG-363 (PR 11) — the review-sink / GitHub-client adapter (adapters layer):
// owns the per-installation `GitHubClient` construction (`buildClient`) and the
// post-submit visibility check (`verifyReviewPersisted`), both moved VERBATIM
// out of the god-file. The factory returns the CONCRETE `GitHubClient`, which
// STRUCTURALLY satisfies both `GitHubPort` (read) and `ReviewSinkPort` (write/
// deliver) — tsc proves the assignability (PR 6), so no retyping is needed here;
// the port-typed handoff is PR 12. `buildClient` / `verifyReviewPersisted` /
// `REVIEW_LIST_PAGE_CAP` were private in the god-file and are EXPORTED here
// (permitted delta — the god-file imports them back; public surface unchanged).

import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"

/** Single-page cap on `listPullRequestReviews`. Reviews are returned
 *  in ASC (oldest-first) submission order, so a freshly-posted review
 *  sits at the END of the list — meaning a >=100-review PR pushes our
 *  just-submitted review off page 1. Treat the cap as inconclusive
 *  rather than flipping a real submit to `not_persisted`. */
export const REVIEW_LIST_PAGE_CAP = 100

/**
 * ARC-258 follow-up (PR #84 anomaly, refined after PR #86): after
 * `submitReview` returns a 2xx, verify the review is actually
 * visible publicly. The Check Run reflects whatever the ensemble
 * returns — a fake-looking 2xx whose review never appears in the
 * Reviews tab would otherwise produce a green "Review posted"
 * check with no review behind it.
 *
 * PR #86 observation: `getReview(id)` is fetch-by-id and returns
 * the review object even when GitHub has left it in `PENDING`
 * (draft) state — invisible to anyone but the App that authored
 * it. The public list endpoint (`listPullRequestReviews`) filters
 * `PENDING` rows out, which mirrors what's actually visible in
 * the Reviews tab. The earlier 404-only verify missed the silent-
 * success case it was built to catch. We now use the list endpoint
 * and require the row to be present AND in a published state
 * (anything but `PENDING`).
 *
 * Cap handling (code-review on this PR): the list endpoint has no
 * `direction` parameter and returns ASC. With `per_page=100`
 * single-page, a PR with >=100 prior reviews pushes our just-
 * submitted review off page 1 and verify would wrongly flip a
 * legitimate submit to `errored`. When the list returns the page
 * cap, default to `true` (inconclusive → assume persisted) and
 * emit `pr-review-verify-list-capped` so we notice when this
 * actually fires.
 *
 * Returns:
 *   - `true` when the review id appears in the public list with a
 *     non-`PENDING` state.
 *   - `true` defensively when the list returns the page cap
 *     (`REVIEW_LIST_PAGE_CAP`) and the row isn't on page 1 — we
 *     can't tell from one page whether the review is missing or
 *     just paginated. Inconclusive → assume persisted.
 *   - `false` when it's absent from the (non-capped) list OR
 *     present but in `PENDING` (silently rejected by GitHub).
 *   - `true` defensively on any GET error — a transient blip on
 *     the verify path should NOT mark a real submit as errored.
 *
 * `submitPath` is the dispatcher-side label of which submit path
 * called us (`inline-anchored` / `anchorless-fallback` / `phase3`).
 * It flows into the verify-side telemetry so log analysis can
 * slice missing/pending rates per path without joining records.
 */
export async function verifyReviewPersisted(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
  submitPath: string,
  submittedState: string,
): Promise<boolean> {
  try {
    const list = await client.listPullRequestReviews(owner, repo, prNumber)
    const found = list.find((r) => r.id === reviewId)
    if (found) {
      if (found.state === "PENDING") {
        console.warn(JSON.stringify({
          event: "pr-review-verify-pending",
          owner, repo, prNumber, review_id: reviewId,
          submit_path: submitPath,
          submitted_state: submittedState,
        }))
        return false
      }
      return true
    }
    // Not on page 1. If the list hit the per-page cap we can't
    // tell missing-from-everywhere apart from on-a-later-page;
    // assume persisted and emit a distinct event so we notice.
    if (list.length >= REVIEW_LIST_PAGE_CAP) {
      console.warn(JSON.stringify({
        event: "pr-review-verify-list-capped",
        owner, repo, prNumber, review_id: reviewId,
        submit_path: submitPath,
        list_size: list.length,
        note: "listPullRequestReviews returned page cap; cannot confirm review present, defaulting to verified=true.",
      }))
      return true
    }
    console.warn(JSON.stringify({
      event: "pr-review-verify-missing",
      owner, repo, prNumber, review_id: reviewId,
      submit_path: submitPath,
      submitted_state: submittedState,
      list_size: list.length,
    }))
    return false
  } catch (err) {
    // Network blip / transient 5xx — we'd rather false-positive a
    // posted review than false-negative one that actually exists.
    // The Check Run's `success` conclusion stays; if the review
    // genuinely didn't post, the customer will notice and we can
    // grep telemetry for `pr-review-verify-error`.
    console.warn(JSON.stringify({
      event: "pr-review-verify-error",
      owner, repo, prNumber, review_id: reviewId,
      submit_path: submitPath,
      err: err instanceof Error ? err.message : String(err),
    }))
    return true
  }
}

export async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}
