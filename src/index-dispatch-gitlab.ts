// sig-gitlab-adapter (GitLab support PR 2): the `gitlab-mr-review` dispatch
// handler, split out of `index-dispatch.ts` to keep that file under its
// size budget. PR-2 ships the GitLab MR-review INGRESS (webhook verify +
// event-parse + enqueue) and the GitLab review CLIENT; the consumer that builds
// the client via `GitLabScmProvider` and runs the SCM-agnostic ensemble is PR-3
// (with the /auth/gitlab OAuth login). Deferring here is recall-safe: there is
// no prior GitLab review capability being suppressed — GitLab review does not
// exist yet, so a loud deferral is the honest outcome.

import type { JobMessage } from "@/src/shared/types/job"

export function dispatchGitLabMrReviewDeferred(job: Extract<JobMessage, { type: "gitlab-mr-review" }>): void {
  console.log(
    JSON.stringify({
      event: "gitlab-mr-review-deferred",
      project: job.projectPath,
      mr_iid: job.mrIid,
      head_sha: job.headSha.slice(0, 7),
      delivery_id: job.deliveryId,
      note: "GitLab MR-review consumer is PR-3; ingress + client landed in PR-2.",
    }),
  )
}
