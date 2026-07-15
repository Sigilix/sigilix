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
import {
  canonicalGitLabRepositoryAuthorityIdentity,
  normalizeGitLabInstanceOrigin,
  verifyActiveGitLabRepositoryAuthorityGeneration,
} from "@/src/features/repository-context"
import { getConnection, getProjectReviewToken } from "@/src/lib/gitlab-connect/gitlab-connect-store"

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
 * Resolve the GitLab access token for a project (PR-3 per-tenant mapping). Reads
 * an authority-generation-qualified per-project token first in repository-
 * context mode; legacy mode retains the unsuffixed KV contract. A connected
 * project never falls through to the global token when its exact credential or
 * issuer no longer matches. Unconnected legacy deployments still fall back to
 * `SIGILIX_GITLAB_TOKEN`.
 */
export async function resolveGitLabProjectToken(
  env: Env,
  projectId: number,
): Promise<{ token: string; source: "per-project" | "global" } | null> {
  try {
    if (env.OPENCLAW_REPOSITORY_CONTEXT_API === "on") {
      const connection = await getConnection(env, projectId)
      if (connection) {
        const currentInstanceOrigin = normalizeGitLabInstanceOrigin(env.SIGILIX_GITLAB_BASE_URL)
        if (
          !currentInstanceOrigin ||
          !connection.instanceOrigin ||
          connection.instanceOrigin !== currentInstanceOrigin ||
          !connection.contextOwnerUserId ||
          !connection.authorityExternalId ||
          !connection.authorityClaimToken
        ) {
          console.warn(JSON.stringify({ event: "gitlab-project-token-instance-mismatch", project_id: projectId }))
          return null
        }
        const identity = await canonicalGitLabRepositoryAuthorityIdentity(currentInstanceOrigin, projectId)
        if (!identity || identity.externalId !== connection.authorityExternalId || !env.SIGILIX_PLATFORM_DB) {
          console.warn(JSON.stringify({ event: "gitlab-project-token-authority-mismatch", project_id: projectId }))
          return null
        }
        const generation = await verifyActiveGitLabRepositoryAuthorityGeneration(env.SIGILIX_PLATFORM_DB, {
          scopeId: connection.contextOwnerUserId,
          externalId: connection.authorityExternalId,
          claimToken: connection.authorityClaimToken,
        })
        if (generation.status === "unavailable") {
          throw new Error("GitLab repository authority unavailable")
        }
        if (generation.status !== "active") {
          console.warn(JSON.stringify({ event: "gitlab-project-token-generation-inactive", project_id: projectId }))
          return null
        }
        const perProject = await getProjectReviewToken(env, projectId, connection.authorityClaimToken)
        return perProject ? { token: perProject, source: "per-project" } : null
      }
      // An unsuffixed token is a legacy connection, not authority. Do not let
      // it fall through to a different issuer's global credential.
      if (await getProjectReviewToken(env, projectId)) return null
    } else {
      const perProject = await getProjectReviewToken(env, projectId)
      if (perProject) return { token: perProject, source: "per-project" }
    }
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
 * GitLab `ScmProvider`. Auth model (PR-3): authority-backed connections resolve
 * a generation-qualified per-project token only after D1 confirms that exact
 * generation; legacy unconnected deployments can still use the global
 * `SIGILIX_GITLAB_TOKEN`. The selected token is sent as `PRIVATE-TOKEN` against
 * REST v4 at the matching `SIGILIX_GITLAB_BASE_URL`.
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
