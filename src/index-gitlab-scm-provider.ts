// The GitLab implementation of the `ScmProvider` port (GitLab support PR 2) —
// the GitLab counterpart of `GitHubScmProvider` (index-scm-provider.ts). It
// wires the three MR-review INGRESS operations the seam names — webhook-token
// verification, the event->review-trigger decision, and the review-client build
// — behind the same port the review engine consumes, so the SCM-agnostic
// ensemble never learns which forge it is reviewing.
//
// Divergences from GitHub, each handled here:
//   - verifyWebhook: GitLab sends the shared secret VERBATIM as the plaintext
//     `X-Gitlab-Token` header (no HMAC). The ingress passes that header value in
//     the port's `signature` field; we constant-time-compare it to the secret.
//   - parseReviewEvent: GitLab's `object_attributes.action` vocabulary
//     (`open` / `reopen` / `update`; `merge` / `close` = skip) is mapped onto
//     GitHub's (`opened` / `reopened` / `synchronize`) and delegated to the SAME
//     pure `decidePullRequestJobs`, so the trigger decision is byte-identical to
//     GitHub's (notably `reopen` -> overview-only, no re-review).
//   - buildReviewClient: GitHub mints a per-installation App token; GitLab has
//     no App-install equivalent, so we build a `GitLabClient` from a per-tenant
//     access token + base URL read from env (see the auth-model note below).

import type { Env } from "@/src/shared/types/env"
import type {
  ScmProvider,
  ScmReviewDecision,
  ScmReviewEventInput,
  ScmWebhookVerifyInput,
} from "@/src/lib/ensemble/ports"
import { GitLabClient } from "@/src/shared/adapters/gitlab"
import { verifyGitLabWebhook } from "@/src/shared/adapters/gitlab/gitlab-webhook-verify"
import { decidePullRequestJobs } from "@/src/index-internals"

/**
 * Map a GitLab merge-request `object_attributes.action` onto the GitHub
 * `pull_request` action vocabulary that `decidePullRequestJobs` understands.
 * Returns `null` for any action that should not trigger a review (`merge`,
 * `close`, `approved`, `unapproved`, …) so the caller can short-circuit to a
 * no-op decision. Pure + exported so the mapping is unit-testable in isolation.
 */
export function mapGitLabActionToGitHubAction(action: string): string | null {
  switch (action) {
    case "open":
      return "opened"
    case "reopen":
      return "reopened"
    case "update":
      return "synchronize"
    default:
      // merge / close / approved / unapproved / approval / unapproval / … — no review.
      return null
  }
}

/**
 * GitLab `ScmProvider`. Auth model (v0): a single per-tenant GitLab access token
 * (`SIGILIX_GITLAB_TOKEN`, a Project/Group Access Token or PAT) sent as the
 * `PRIVATE-TOKEN` header against REST v4 at `SIGILIX_GITLAB_BASE_URL`
 * (default `https://gitlab.com`; self-managed instances override it).
 *
 * FOR THE FOUNDER — before customer/multi-tenant launch this single global
 * token needs either a project allowlist or a `projectId -> token` mapping
 * (mirroring GitHub's installation -> token, e.g. keyed in KV). `buildReviewClient`
 * takes the `installationId` the port passes so that per-tenant lookup can slot
 * in without a signature change. Alternatives weighed in the PR body.
 */
export class GitLabScmProvider implements ScmProvider {
  readonly kind = "gitlab" as const

  verifyWebhook(input: ScmWebhookVerifyInput): Promise<boolean> {
    // GitLab has no signature to recompute — the `signature` field carries the
    // raw `X-Gitlab-Token` header, compared constant-time to the shared secret.
    return Promise.resolve(verifyGitLabWebhook(input.signature, input.secret))
  }

  parseReviewEvent(input: ScmReviewEventInput): ScmReviewDecision {
    const ghAction = mapGitLabActionToGitHubAction(input.action)
    if (ghAction === null) return { overview: false, review: false }
    return decidePullRequestJobs({ ...input, action: ghAction })
  }

  // GitLab has no App-installation token. `_installationId` is accepted to match
  // the port signature (and to host the future per-tenant token lookup); the v0
  // client is built from the env-configured token + base URL.
  buildReviewClient(env: Env, _installationId: number): Promise<GitLabClient> {
    const token = env.SIGILIX_GITLAB_TOKEN
    if (!token) {
      throw new Error("SIGILIX_GITLAB_TOKEN required to build a GitLab review client")
    }
    const baseUrl = env.SIGILIX_GITLAB_BASE_URL
    return Promise.resolve(new GitLabClient(baseUrl ? { token, baseUrl } : { token }))
  }
}

export const GITLAB_SCM_PROVIDER = new GitLabScmProvider()
