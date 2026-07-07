// sig-gitlab-adapter (GitLab support PR 3): the `gitlab-mr-review` CONSUMER —
// split out of `index-dispatch.ts` to keep that file under its size budget. PR-2
// shipped the INGRESS (webhook verify + event-parse + enqueue) and the GitLab
// review CLIENT and DEFERRED the consumer; this file replaces the deferral with
// the real path:
//
//   1. Resolve the per-project GitLab token (KV-first, global fall-back) and run
//      the pre-launch project allowlist gate (`resolveGitLabProjectToken` /
//      `isGitLabProjectAllowlisted`). Non-allowlisted projects are ignored+logged.
//   2. Build the GitLab review client via `selectScmProvider("gitlab")`.
//   3. Run the SAME SCM-agnostic review ensemble GitHub uses
//      (`handlePrReviewEnsemble`) with the GitLab client injected — the four
//      specialists + synthesizer never learn which forge they review. The
//      orchestrator's publish phase posts through the GitLab client (per-discussion
//      inline + summary note, from PR-2's `GitLabClient.submitReview`).
//
// RECALL-SAFETY is sacred: an errored/degraded run must SURFACE on the MR, never
// silently read as a clean pass. This mirrors the GitHub `pr-review` dispatch
// case exactly — on `errored` we log loudly and, when the orchestrator errored
// BEFORE it could post any notice (`reviewMeta` undefined — e.g. GitLab truncated
// the diff and the fetch threw), we post a failure note ourselves (GitLab's
// equivalent of GitHub's red check run). We do NOT throw on `errored` (the GitHub
// path completes its check as a failure and returns without throwing).

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { selectScmProvider } from "@/src/index-scm-provider"
import { resolveGitLabProjectToken, isGitLabProjectAllowlisted } from "@/src/index-gitlab-scm-provider"
import { handlePrReviewEnsemble } from "@/src/lib/triage-pr-review-ensemble"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import { postReviewWorkBlocked } from "@/src/index-dispatch-post-review-work"

/** The failure note posted on the MR when the ensemble errored before it could
 *  post its own skip-notice — so a degraded/errored run is NEVER a silent clean
 *  pass (GitLab has no check-run to turn red; a note is the visible signal). */
const GITLAB_REVIEW_FAILED_NOTE =
  "Sigilix could not complete this review (an internal error or a degraded/truncated diff). " +
  "This is **not** a clean pass — nothing was verified. Re-push or re-open the MR to retry."

/** KV-key prefix (in `OPENCLAW_STATE`) marking a `(projectId, mrIid, headSha)`
 *  that has already been REVIEWED to completion — the GitLab stand-in for the
 *  GitHub `PrReviewRunDO` `/enqueue` dedup (GitLab has no DO). Keyed by headSha,
 *  so a real new push (new head) never collides with a prior mark. */
const GITLAB_REVIEW_DONE_KV_PREFIX = "gitlab-mr-review-done:"
/** TTL for the done-marker: long enough to swallow a late webhook redelivery /
 *  queue re-delivery, bounded because the key is head-scoped anyway. */
const GITLAB_REVIEW_DONE_TTL_SECONDS = 6 * 60 * 60

function gitlabReviewDoneKey(job: Extract<JobMessage, { type: "gitlab-mr-review" }>): string {
  return `${GITLAB_REVIEW_DONE_KV_PREFIX}${job.projectId}:${job.mrIid}:${job.headSha}`
}

/**
 * Whether this exact `(projectId, mrIid, headSha)` was already reviewed to
 * completion (a duplicate webhook / queue re-delivery). FAILS OPEN: a KV read
 * error returns `false` so a blip can never SUPPRESS a review — recall over
 * de-dup (unlike the token read, which fails closed for tenant isolation).
 */
async function alreadyReviewedThisHead(env: Env, key: string): Promise<boolean> {
  try {
    return (await env.OPENCLAW_STATE.get(key)) !== null
  } catch {
    return false
  }
}

/** Mark this head reviewed (best-effort; only on a NON-errored terminal state so
 *  a genuine retry after failure is never dedup-suppressed). */
async function markReviewedThisHead(env: Env, key: string): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(key, "1", { expirationTtl: GITLAB_REVIEW_DONE_TTL_SECONDS })
  } catch {
    /* best-effort — a failed mark only risks a duplicate review, never a miss */
  }
}

/**
 * Split a GitLab `group[/subgroup...]/project` path into (owner, repo) such that
 * `${owner}/${repo}` reconstructs the full path the `GitLabClient` URL-encodes as
 * the project `:id`. Split at the FIRST slash so `owner` is the top-level group
 * and nested-group projects survive (`grp/sub/proj` -> `grp` + `sub/proj`).
 */
export function splitGitLabProjectPath(projectPath: string): { owner: string; repo: string } {
  const i = projectPath.indexOf("/")
  if (i < 0) return { owner: projectPath, repo: "" }
  return { owner: projectPath.slice(0, i), repo: projectPath.slice(i + 1) }
}

export async function dispatchGitLabMrReview(
  job: Extract<JobMessage, { type: "gitlab-mr-review" }>,
  env: Env,
  backgroundWaitUntil?: (promise: Promise<void>) => void,
): Promise<void> {
  const logTag = {
    project: job.projectPath,
    project_id: job.projectId,
    mr_iid: job.mrIid,
    head_sha: job.headSha.slice(0, 7),
    delivery_id: job.deliveryId,
  }

  // ── 1. per-tenant token + allowlist gate ──────────────────────────────────
  const resolved = await resolveGitLabProjectToken(env, job.projectId)
  const hasPerProjectToken = resolved?.source === "per-project"
  if (!isGitLabProjectAllowlisted(env, job.projectId, job.projectPath, hasPerProjectToken)) {
    // Ignored, not errored: the pre-launch gate is opt-in and non-allowlisted
    // projects are intentionally out of scope. Recall-safe (nothing suppressed —
    // there is no review to run for a project we don't serve).
    console.log(JSON.stringify({ event: "gitlab-mr-review-project-not-allowlisted", ...logTag }))
    return
  }
  if (!resolved) {
    // Allowed but no token configured anywhere — cannot authenticate to GitLab,
    // so there is no MR handle to post to. Log loudly (never a silent success).
    console.error(JSON.stringify({ event: "gitlab-mr-review-misconfigured", reason: "no_gitlab_token", ...logTag }))
    return
  }

  // ── 1b. dedup: a duplicate webhook / queue re-delivery of a head we already
  // reviewed to completion must not re-run the whole ensemble (double notes +
  // double model spend). The GitHub path gets this from PrReviewRunDO; GitLab
  // has no DO, so we use a head-scoped KV marker. FAILS OPEN (see the helper).
  const doneKey = gitlabReviewDoneKey(job)
  if (await alreadyReviewedThisHead(env, doneKey)) {
    console.log(JSON.stringify({ event: "gitlab-mr-review-deduped", ...logTag }))
    return
  }

  // ── 2. build the GitLab review client via the SCM provider ────────────────
  const client = await selectScmProvider("gitlab").buildReviewClient(env, job.projectId, resolved.token)
  const { owner, repo } = splitGitLabProjectPath(job.projectPath)

  // ── 2b. skip an MR that closed/merged between webhook enqueue and consume ──
  // Mirrors the GitHub `prClosedOrMerged` guard: a `close` event skips at
  // ingress, but a job already queued for this MR still lands here — reviewing a
  // closed MR burns model budget + posts a pointless review. The orchestrator's
  // merged-on-approve short-circuit only covers MERGED (merged_at set), not
  // closed-unmerged, so guard both here. FAILS OPEN (recall over thrift): any
  // fetch error proceeds to review rather than wrongly skipping a live MR.
  try {
    const meta = await client.getPullRequest(owner, repo, job.mrIid)
    if (meta.merged_at != null || meta.state === "closed") {
      console.log(JSON.stringify({ event: "gitlab-mr-review-skipped-mr-not-open", state: meta.state, ...logTag }))
      return
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "gitlab-mr-review-open-check-failed",
        err: err instanceof Error ? err.message : String(err),
        ...logTag,
      }),
    )
  }

  console.log(JSON.stringify({ event: "gitlab-mr-review-started", token_source: resolved.source, ...logTag }))

  // ── 3. run the SAME SCM-agnostic ensemble GitHub uses ─────────────────────
  // The GitLabClient STRUCTURALLY satisfies the review-client port surface; it is
  // injected in the `githubClient` slot the orchestrator reads (mirrors
  // api-review-route.ts's `diffReviewClient(...) as unknown as GitHubClient`).
  // `installationId` is a GitHub concept — pass 0. `repoId` is intentionally
  // OMITTED so the GitHub-only usage-metering + runner-evidence/receipt-join
  // paths (which key on `repoId`, and would call GitHub-only client verbs like
  // `getCommit` the GitLab client lacks) stay inert.
  const result = await handlePrReviewEnsemble({
    owner,
    repo,
    prNumber: job.mrIid,
    headSha: job.headSha,
    installationId: 0,
    env,
    ensembleConfig: parseEnsembleConfig(env),
    githubClient: client as unknown as GitHubClient,
    ...(backgroundWaitUntil !== undefined ? { backgroundWaitUntil } : {}),
  })

  // ── 4. recall-safety: an errored/degraded run must surface, never pass clean ─
  switch (result.status) {
    case "posted": {
      // Merge-gated follow-up work (the invariant-lens amendment lane, when
      // OPENCLAW_INVARIANT_LENS_MODE is on) may post ADDITIONAL high-severity
      // findings. Mirror the GitHub dispatcher: AWAIT it (so it completes inside
      // the isolate, not dropped after return) and surface a blocked outcome
      // loudly. On the default path `postReviewWork` is undefined -> a no-op.
      const blocked = await postReviewWorkBlocked(result.postReviewWork, {
        owner,
        repo,
        prNumber: job.mrIid,
        headSha: job.headSha,
      })
      console.log(JSON.stringify({ event: "gitlab-mr-review-posted", post_review_work_blocked: blocked, ...logTag }))
      break
    }
    case "skipped":
      // A legitimate clean skip (nothing to review / label gate / empty delta).
      // No finding was suppressed — the orchestrator only returns `skipped` on
      // paths that produced a verdict-free clean state.
      console.log(
        JSON.stringify({
          event: "gitlab-mr-review-skipped",
          reason: result.telemetry.fellBackReason ?? null,
          ...logTag,
        }),
      )
      break
    case "stale_head":
      // The MR head moved between webhook receipt and consume (rare: GitLab pins
      // `last_commit.id` == `diff_refs.head_sha`, so the guard only fires on a
      // push landing in that window). NOT a recall hole — the next `update`
      // webhook re-enqueues a fresh `gitlab-mr-review`. KNOWN LIMITATION (PR-4
      // follow-up): the reused orchestrator's stale-head handler attempts a
      // GitHub-side requeue with installationId 0; that GitHub `pr-review` job
      // simply fails to build a GitHub client and no-ops (no wrong review posted).
      console.log(JSON.stringify({ event: "gitlab-mr-review-stale-head", ...logTag }))
      break
    case "shadow_recorded":
      // Dead in prod (mode is pinned "post"); no review posted -> log, don't pass clean.
      console.log(JSON.stringify({ event: "gitlab-mr-review-shadow-recorded", ...logTag }))
      break
    case "errored": {
      // The ONLY errored path that already posted a customer-visible notice is
      // `bailWithSkipNotice` succeeding, which stamps `reviewMeta.surface ===
      // "skip-notice"`. Every other errored path (a bail whose post failed, the
      // deterministic-annotation errored meta, the outer-catch) leaves NO MR note
      // — a bare `reviewMeta !== undefined` is NOT proof of a posted notice
      // (Codex P2). Gate on the skip-notice surface so an errored run with only
      // Lane-A check annotations still gets a failure note (never silent).
      const noticePosted = result.reviewMeta?.surface === "skip-notice"
      console.error(
        JSON.stringify({
          event: "gitlab-mr-review-errored",
          notice_posted: noticePosted,
          internal_error: result.telemetry.internalError ?? result.telemetry.fellBackReason ?? null,
          ...logTag,
        }),
      )
      // When the orchestrator already posted its own skip-notice, the MR carries
      // the visible non-clean signal — don't double-post. Otherwise surface a
      // failure note ourselves so the MR is never silently clean.
      if (!noticePosted) {
        try {
          await client.createIssueComment(owner, repo, job.mrIid, GITLAB_REVIEW_FAILED_NOTE)
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "gitlab-mr-review-failure-note-failed",
              err: err instanceof Error ? err.message : String(err),
              ...logTag,
            }),
          )
        }
      }
      break
    }
    default: {
      const exhaustive: never = result.status
      console.error(JSON.stringify({ event: "gitlab-mr-review-unknown-status", status: String(exhaustive), ...logTag }))
    }
  }

  // Dedup marker: set only on a NON-errored terminal outcome. An errored run is
  // left UNMARKED so a genuine re-delivery gets another chance to complete
  // (recall over dedup); a duplicate delivery of a successfully-reviewed head is
  // suppressed by the `alreadyReviewedThisHead` gate above.
  if (result.status !== "errored") {
    await markReviewedThisHead(env, doneKey)
  }
}
