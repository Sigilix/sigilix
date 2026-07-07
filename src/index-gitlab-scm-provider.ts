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

/** KV-key prefix (in `OPENCLAW_STATE`) for a per-project GitLab access token —
 *  the GitLab counterpart of GitHub's installation -> token resolution. Keyed by
 *  the numeric GitLab project id: `gitlab-project-token:<projectId>`. */
const GITLAB_PROJECT_TOKEN_KV_PREFIX = "gitlab-project-token:"

/**
 * Resolve the GitLab access token for a project (PR-3 per-tenant mapping). Reads
 * a per-project token from KV (`gitlab-project-token:<projectId>`) first — the
 * multi-tenant path, mirroring GitHub's per-installation token — and falls back
 * to the single global `SIGILIX_GITLAB_TOKEN` so an existing single-token deploy
 * keeps working. Returns `null` when neither is configured. `source` lets the
 * caller tell an explicitly-onboarded project (per-project) apart from the shared
 * global token (used by the allowlist gate: a per-project token IS onboarding).
 */
export async function resolveGitLabProjectToken(
  env: Env,
  projectId: number,
): Promise<{ token: string; source: "per-project" | "global" } | null> {
  let perProject: string | null
  try {
    perProject = await env.OPENCLAW_STATE.get(`${GITLAB_PROJECT_TOKEN_KV_PREFIX}${projectId}`)
  } catch (err) {
    // FAIL CLOSED (Codex PR-3): a KV read blip must NOT silently degrade a
    // per-project-onboarded tenant to the global token (wrong credential) or to
    // an allowlist skip. Rethrow so the queue RETRIES this job when KV recovers,
    // rather than reviewing with the wrong identity or dropping the review.
    console.warn(
      JSON.stringify({
        event: "gitlab-project-token-kv-read-failed",
        project_id: projectId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    throw err instanceof Error ? err : new Error(String(err))
  }
  if (typeof perProject === "string" && perProject.length > 0) {
    return { token: perProject, source: "per-project" }
  }
  const globalToken = env.SIGILIX_GITLAB_TOKEN
  if (typeof globalToken === "string" && globalToken.length > 0) {
    return { token: globalToken, source: "global" }
  }
  return null
}

/**
 * The pre-launch project gate (#815 flagged this as the multi-tenant blocker):
 * whether a GitLab project is allowed to be reviewed.
 *
 *   - A project that has its OWN per-project token (`hasPerProjectToken`) is
 *     ALWAYS allowed — configuring a token IS onboarding it.
 *   - Otherwise, when `SIGILIX_GITLAB_ALLOWED_PROJECTS` is set (a comma-separated
 *     list of numeric project ids and/or `group/project` paths), ONLY listed
 *     projects are reviewed; everything else is ignored.
 *   - When that env var is unset/empty, ALL projects are allowed — back-compat
 *     with the single-global-token deploy #815 shipped.
 *
 * Pure + exported so the gate is unit-testable in isolation.
 */
export function isGitLabProjectAllowlisted(
  env: Env,
  projectId: number,
  projectPath: string,
  hasPerProjectToken: boolean,
): boolean {
  if (hasPerProjectToken) return true
  const raw = env.SIGILIX_GITLAB_ALLOWED_PROJECTS
  if (typeof raw !== "string" || raw.trim().length === 0) return true // no allowlist configured -> allow all
  const allow = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  return allow.has(String(projectId)) || allow.has(projectPath)
}

/**
 * GitLab `ScmProvider`. Auth model (PR-3): a per-project GitLab access token
 * resolved KV-first (`gitlab-project-token:<projectId>`) with a fall-back to the
 * global `SIGILIX_GITLAB_TOKEN` (see `resolveGitLabProjectToken`), sent as the
 * `PRIVATE-TOKEN` header against REST v4 at `SIGILIX_GITLAB_BASE_URL` (default
 * `https://gitlab.com`; self-managed instances override it). The project gate
 * lives in `isGitLabProjectAllowlisted` + the consumer.
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

  // The port's `installationId` is the GitLab numeric project id here — the
  // per-tenant key `resolveGitLabProjectToken` reads. `resolvedToken` is an
  // optional pre-resolved token (the consumer already read it, alongside the
  // allowlist gate, so we don't hit KV twice); omitted callers re-resolve.
  async buildReviewClient(env: Env, projectId: number, resolvedToken?: string): Promise<GitLabClient> {
    const token = resolvedToken ?? (await resolveGitLabProjectToken(env, projectId))?.token
    if (!token) {
      throw new Error("SIGILIX_GITLAB_TOKEN (or a per-project token) required to build a GitLab review client")
    }
    const baseUrl = env.SIGILIX_GITLAB_BASE_URL
    // Address the project by its immutable numeric id (Codex hardening): a
    // group/PAT token can't be steered to a different `owner/repo` than the
    // webhook-identified project, and renames/moves don't break the client.
    return new GitLabClient({ token, projectId, ...(baseUrl ? { baseUrl } : {}) })
  }
}

export const GITLAB_SCM_PROVIDER = new GitLabScmProvider()
