// SIG-376 (SIG-318 Tier-1 6/8): the comment-marker-scan cluster lifted out
// of `triage-pr-overview.ts` so that file stays under the 1,000-line
// budget. These async free functions take a GitHubClient explicitly (no
// `this`, no closure capture over the handler's locals), so they relocate
// verbatim — bodies are byte-identical to their prior in-file definitions;
// only the surrounding `export` keywords + the import paths differ.
//
// This leaf also OWNS the two overview marker string constants
// (`OVERVIEW_MARKER` / `LEGACY_OVERVIEW_MARKER`) that the comment scan greps
// for; the core re-exports them (so `pr-overview-stub.ts` and the format
// leaf still resolve them) without value-importing the core, keeping the
// dependency graph acyclic. The format leaf imports `OVERVIEW_MARKER` from
// here (leaf → leaf, one-directional, no cycle).
//
// Leaf module: imports the `GitHubClient` type + the legacy-warmup marker
// from `./warmup`. It does NOT value-import the core `triage-pr-overview.ts`.

import { GitHubClient } from "@/src/shared/adapters/github"
import { LEGACY_WARMUP_MARKER } from "./warmup"

// SIG-84: exported so the stub-post helper (`pr-overview-stub.ts`) can
// reuse the SAME marker the handler greps for — preventing the stub +
// handler from diverging on what makes a comment "the sticky".
export const OVERVIEW_MARKER = "<!-- sigilix:pr-overview -->"
// SIG-85: bilingual matcher for the openclaw→sigilix rebrand. Read both
// markers so the existing-comment lookup finds legacy stickies and
// edits them in place instead of creating duplicates. Drop the legacy
// half once all pre-2026-05-18 PRs close.
export const LEGACY_OVERVIEW_MARKER = "<!-- openclaw:pr-overview -->"

/**
 * Single pass over PR comments looking for BOTH the overview sticky
 * (so we can decide POST-vs-PATCH) AND the legacy standalone warmup
 * sticky (so we can delete it after writing the overview).
 *
 * Returning both ids in one call means the overview helper doesn't
 * need a separate `listIssueComments` round trip for migration
 * cleanup — keeps the ARC-231 race-test call-count invariants intact
 * and saves one GitHub API call per PR review on repos still
 * carrying pre-unification stickies.
 */
export async function scanComments(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ overviewId: number | null; legacyWarmupId: number | null }> {
  const items = await client.listIssueComments(owner, repo, prNumber)
  let overviewId: number | null = null
  let legacyWarmupId: number | null = null
  for (const c of items) {
    if (typeof c.body !== "string") continue
    // SIG-85: bilingual matcher — pick up both `<!-- sigilix:pr-overview -->`
    // and the legacy `<!-- openclaw:pr-overview -->` stickies. Without
    // this, a PR that received its overview pre-rebrand gets a brand
    // new (duplicate) overview comment instead of an in-place edit.
    if (
      overviewId === null &&
      (c.body.includes(OVERVIEW_MARKER) || c.body.includes(LEGACY_OVERVIEW_MARKER))
    ) {
      overviewId = c.id
    }
    if (legacyWarmupId === null && c.body.includes(LEGACY_WARMUP_MARKER)) {
      legacyWarmupId = c.id
    }
    if (overviewId !== null && legacyWarmupId !== null) break
  }
  return { overviewId, legacyWarmupId }
}

/**
 * SIG-91 follow-up: hard cap on pages scanned by
 * `findExistingOverviewCommentId`. 5 pages × 100 comments = 500
 * comments — far above the ~50-comment ceiling on a typical Sigilix
 * self-PR. Beyond this cap we emit `pr-overview-comment-scan-capped`
 * and treat the PR as "no existing comment found" (the stub create
 * path runs). Constant exported for tests.
 */
export const MAX_COMMENT_SCAN_PAGES = 5

/**
 * SIG-84: smaller marker-scan used by the stub-post fallback when the
 * KV `pr-overview-stub-posted` flag is missing (delivery retry,
 * cross-region KV propagation delay). Returns the overview comment id
 * if any exists on the PR — bilingual matcher covers both the
 * current `sigilix:pr-overview` marker and the legacy
 * `openclaw:pr-overview` marker.
 *
 * Exposed (and named distinctly from the private `scanComments`) so
 * the stub helper doesn't depend on the full warmup-id tuple it
 * doesn't need; keeps the call sites focused.
 *
 * SIG-91 follow-up: paginates a page at a time, SHORT-CIRCUITS on
 * the first bilingual marker hit (sticky comment is typically near
 * the top of the PR — posted on first webhook), and CAPS the scan at
 * `MAX_COMMENT_SCAN_PAGES` pages. Prevents pathological scan cost on
 * busy PRs without losing correctness on the realistic case.
 */
export async function findExistingOverviewCommentId(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  for (let page = 1; page <= MAX_COMMENT_SCAN_PAGES; page += 1) {
    const items = await client.listIssueCommentsPage(owner, repo, prNumber, page)
    // SIG-216 CR fix-up: terminate on the empty page rather than
    // `items.length < per_page`. The `< 100` check coupled this loop
    // to `listIssueCommentsPage`'s per_page=100 default — changing
    // that constant (e.g. tuning for rate limits) would silently
    // break pagination here. Empty-page termination is the only
    // universally safe signal; the cost is at most one extra
    // empty-page fetch when the comment count is an exact multiple
    // of per_page, which is bounded by MAX_COMMENT_SCAN_PAGES anyway.
    if (items.length === 0) return null
    for (const c of items) {
      if (typeof c.body !== "string") continue
      // Bilingual matcher — matches both `<!-- sigilix:pr-overview -->`
      // and the legacy `<!-- openclaw:pr-overview -->` from before
      // the SIG-85 rebrand. First hit wins (short-circuit).
      if (c.body.includes(OVERVIEW_MARKER) || c.body.includes(LEGACY_OVERVIEW_MARKER)) {
        return c.id
      }
    }
  }
  // Hard cap hit — pathological PR with >500 comments and no marker
  // in the first 500. Treat as "not found" so the stub create path
  // runs; subsequent webhooks for the SAME head will hit the KV fast
  // path and skip this scan entirely.
  console.warn(JSON.stringify({
    event: "pr-overview-comment-scan-capped",
    owner, repo, prNumber,
    max_pages: MAX_COMMENT_SCAN_PAGES,
  }))
  return null
}

/**
 * SIG-96: richer variant of `findExistingOverviewCommentId` that returns
 * the comment BODY alongside the id. The stub-helper uses the body to
 * decide whether the sticky already carries a completed summary (do
 * NOT clobber with `_Reviewing…_`) or is itself a stub from an earlier
 * push (idempotent re-write is fine).
 *
 * Same bilingual matcher + same `MAX_COMMENT_SCAN_PAGES` cap as
 * `findExistingOverviewCommentId`. Short-circuits on the first marker
 * hit; the body field is whatever GitHub returned for that comment.
 */
export async function findExistingOverviewComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ id: number; body: string } | null> {
  for (let page = 1; page <= MAX_COMMENT_SCAN_PAGES; page += 1) {
    const items = await client.listIssueCommentsPage(owner, repo, prNumber, page)
    // SIG-216 CR fix-up: same empty-page termination as
    // `findExistingOverviewCommentId` — decouples from per_page=100.
    if (items.length === 0) return null
    for (const c of items) {
      if (typeof c.body !== "string") continue
      if (c.body.includes(OVERVIEW_MARKER) || c.body.includes(LEGACY_OVERVIEW_MARKER)) {
        return { id: c.id, body: c.body }
      }
    }
  }
  console.warn(JSON.stringify({
    event: "pr-overview-comment-scan-capped",
    owner, repo, prNumber,
    max_pages: MAX_COMMENT_SCAN_PAGES,
    helper: "findExistingOverviewComment",
  }))
  return null
}

/**
 * ARC-258 follow-up: delete the legacy standalone warmup sticky by
 * id. Caller resolved the id from `scanComments`. Best-effort: a
 * 404 (someone else deleted it first) or 403 (App missing perms)
 * logs + returns; never throws.
 */
export async function deleteLegacyWarmupSticky(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
): Promise<void> {
  try {
    await client.deleteIssueComment(owner, repo, commentId)
    console.log(JSON.stringify({
      event: "pr-overview-legacy-warmup-deleted",
      owner, repo, prNumber, comment_id: commentId,
    }))
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-overview-legacy-warmup-delete-failed",
      owner, repo, prNumber, comment_id: commentId,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}
