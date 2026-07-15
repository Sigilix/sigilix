// sig-gitlab-adapter (GitLab support PR 2): the GitLab webhook INGRESS leaf —
// the GitLab counterpart of `handleGitHubWebhook` (index-github-webhook.ts). It
// routes the three ingress operations through the SCM seam
// (`selectScmProvider("gitlab")`): plaintext-token verification, the
// event->review-trigger decision, and (in PR-3) the review-client build.
//
// Divergences from GitHub (all owned by the GitLab provider + this leaf):
//   - Auth is a plaintext `X-Gitlab-Token` header (constant-time compare),
//     NOT an HMAC signature.
//   - The event is selected by `X-Gitlab-Event: Merge Request Hook`
//     (`object_kind === "merge_request"`); every other GitLab event acks 200.
//   - `object_attributes.action` (`open`/`reopen`/`update`; `merge`/`close`=skip)
//     is mapped onto the GitHub vocab inside the provider before the SAME pure
//     `decidePullRequestJobs` runs — so the trigger decision matches GitHub.
//
// SCOPE (PR-2): this leaf VERIFIES, PARSES, DECIDES, and ENQUEUES a distinct
// `gitlab-mr-review` job. The consumer that builds the GitLab review client via
// the provider and runs the SCM-agnostic ensemble is PR-3 (with the
// /auth/gitlab OAuth login). Keeping GitLab on its own job type leaves the
// GitHub `pr-review` queue + dispatch path (App tokens, check-runs,
// shadow-quota/fairness admission) completely untouched.

import type { Env } from "@/src/shared/types/env"
import type { ScmReviewEventInput } from "@/src/lib/ensemble/ports"
import { selectScmProvider } from "@/src/index-scm-provider"
import { getConnection, getProjectWebhookSecret } from "@/src/lib/gitlab-connect/gitlab-connect-store"
import {
  canonicalGitLabRepositoryAuthorityIdentity,
  normalizeGitLabInstanceOrigin,
  verifyActiveGitLabRepositoryAuthorityGeneration,
} from "@/src/features/repository-context"

/** Cap the pre-auth body parse (Codex sign-off #2). GitLab MR webhook payloads
 *  carry only MR metadata + commit list — comfortably under 1 MB. An oversized
 *  body is rejected before we spend cycles parsing it to pick a candidate secret. */
const MAX_WEBHOOK_BODY_BYTES = 1_000_000

/** GitLab "Merge Request Hook" payload — only the fields this ingress reads. */
interface GitLabMergeRequestEvent {
  object_kind?: string
  project?: {
    id?: number
    path_with_namespace?: string
  }
  object_attributes?: {
    iid?: number
    action?: string
    source_branch?: string
    target_branch?: string
    title?: string
    description?: string | null
    work_in_progress?: boolean
    draft?: boolean
    // GitLab sets `oldrev` ONLY when the MR's code (commits) actually changed;
    // it is absent on metadata-only `update`s (title/reviewer/labels/…).
    oldrev?: string
    last_commit?: { id?: string }
    diff_refs?: { base_sha?: string | null; head_sha?: string | null } | null
  }
}

const DRAFT_TITLE_PREFIX = /^\s*(draft|wip):/i

export async function handleGitLabWebhook(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text()
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("payload too large\n", { status: 413 })
  }

  // GitLab sends the shared secret verbatim in this header (no HMAC). Pass it
  // through the port's `signature` field; the provider constant-time-compares it.
  const token = request.headers.get("x-gitlab-token") ?? ""
  const event = request.headers.get("x-gitlab-event") ?? ""

  // Parse the body BEFORE verifying so we can pick which secret to compare
  // against. A malformed body just yields no project id -> we fall back to the
  // global-env secret (or 503 when neither is configured). Only `project.id` is
  // read pre-auth, and it never changes the failure response (Codex sign-off #2:
  // non-enumerating — an unknown/unconnected project 401s exactly like a wrong
  // token), so this can't leak which projects are connected.
  let payload: GitLabMergeRequestEvent | null = null
  try {
    payload = JSON.parse(rawBody) as GitLabMergeRequestEvent
  } catch {
    payload = null
  }

  // sig-gitlab-connector: resolve the webhook secret per project — a project
  // onboarded through the portal's connect flow has its OWN generated secret in
  // KV (`gitlab-webhook-secret:<projectId>`); fall back to the global env secret
  // so the existing single-secret deploy behaves EXACTLY as before.
  const projectIdForSecret = payload?.project?.id
  let secret: string | undefined
  let rejectStoredProject = false
  // The per-project secret lives in KV. Guard the binding + a read blip: a
  // missing OPENCLAW_STATE or a transient KV error must NEVER drop the global
  // secret path (fail-safe — a project connected via the global secret still
  // verifies). A connect-flow project always has OPENCLAW_STATE bound in prod.
  if (typeof projectIdForSecret === "number" && env.OPENCLAW_STATE) {
    try {
      if (env.OPENCLAW_REPOSITORY_CONTEXT_API === "on") {
        const connection = await getConnection(env, projectIdForSecret)
        const currentInstanceOrigin = normalizeGitLabInstanceOrigin(env.SIGILIX_GITLAB_BASE_URL)
        if (connection) {
          if (
            !connection.instanceOrigin ||
            !currentInstanceOrigin ||
            connection.instanceOrigin !== currentInstanceOrigin ||
            !connection.contextOwnerUserId ||
            !connection.authorityExternalId ||
            !connection.authorityClaimToken
          ) {
            rejectStoredProject = true
          } else {
            const identity = await canonicalGitLabRepositoryAuthorityIdentity(currentInstanceOrigin, projectIdForSecret)
            if (!identity || identity.externalId !== connection.authorityExternalId || !env.SIGILIX_PLATFORM_DB) {
              rejectStoredProject = true
            } else {
              const generation = await verifyActiveGitLabRepositoryAuthorityGeneration(env.SIGILIX_PLATFORM_DB, {
                scopeId: connection.contextOwnerUserId,
                externalId: connection.authorityExternalId,
                claimToken: connection.authorityClaimToken,
              })
              if (generation.status === "unavailable") {
                return new Response("gitlab not configured\n", { status: 503 })
              }
              if (generation.status !== "active") {
                rejectStoredProject = true
              } else {
                secret =
                  (await getProjectWebhookSecret(env, projectIdForSecret, connection.authorityClaimToken)) ?? undefined
                if (!secret) rejectStoredProject = true
              }
            }
          }
        } else {
          // A legacy per-project secret is not strong authority. Refuse it in
          // authority mode rather than falling through to another instance's
          // global secret.
          secret = (await getProjectWebhookSecret(env, projectIdForSecret)) ?? undefined
          if (secret) {
            rejectStoredProject = true
            secret = undefined
          }
        }
      } else {
        secret = (await getProjectWebhookSecret(env, projectIdForSecret)) ?? undefined
      }
    } catch {
      if (env.OPENCLAW_REPOSITORY_CONTEXT_API === "on") {
        return new Response("gitlab not configured\n", { status: 503 })
      }
      secret = undefined
    }
  }
  if (rejectStoredProject) return new Response("invalid token\n", { status: 401 })
  if (!secret) secret = env.SIGILIX_GITLAB_WEBHOOK_SECRET
  if (!secret) {
    // Unconfigured deploy — no webhook secret to verify against (neither a
    // per-project connect secret nor the global env one). 503 so the sender
    // retries once configured, mirroring the GitHub handler's 503 gate.
    return new Response("gitlab not configured\n", { status: 503 })
  }

  const scm = selectScmProvider("gitlab")
  const verified = await scm.verifyWebhook({ rawBody, signature: token, secret })
  if (!verified) {
    return new Response("invalid token\n", { status: 401 })
  }

  if (!payload) {
    return new Response("invalid json\n", { status: 400 })
  }

  // Only merge-request events drive a review. GitLab's "Test" button + every
  // other hook (Push / Note / Pipeline / …) ack 200 with no work.
  if (event !== "Merge Request Hook" || payload.object_kind !== "merge_request") {
    return new Response("ignored event\n", { status: 200 })
  }

  const attrs = payload.object_attributes
  const projectPath = payload.project?.path_with_namespace
  const projectId = payload.project?.id
  const mrIid = attrs?.iid
  const action = attrs?.action
  if (
    !attrs ||
    typeof projectPath !== "string" ||
    projectPath.length === 0 ||
    typeof projectId !== "number" ||
    typeof mrIid !== "number" ||
    typeof action !== "string"
  ) {
    return new Response("missing merge request fields\n", { status: 400 })
  }

  // GitHub parity: `synchronize` fires only when code is pushed. GitLab's
  // `update` ALSO covers metadata-only edits (title/reviewer/labels), which
  // carry no `oldrev`. Treat a metadata-only `update` as a skip so we don't
  // re-review on a title change the way GitHub never would.
  if (action === "update" && typeof attrs.oldrev !== "string") {
    return new Response("skip metadata-only update\n", { status: 200 })
  }

  const isDraft =
    attrs.work_in_progress === true ||
    attrs.draft === true ||
    (typeof attrs.title === "string" && DRAFT_TITLE_PREFIX.test(attrs.title))

  const decideArgs: ScmReviewEventInput = {
    action,
    draft: isDraft,
    prBody: attrs.description ?? null,
    skipReleasePromotions: env.OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES === "on",
  }
  if (attrs.target_branch) decideArgs.baseRef = attrs.target_branch
  if (attrs.source_branch) decideArgs.headRef = attrs.source_branch
  const decision = scm.parseReviewEvent(decideArgs)
  if (!decision.overview && !decision.review) {
    return new Response("skip mr action\n", { status: 200 })
  }

  // head sha: `last_commit.id` is the MR tip; fall back to diff_refs.head_sha.
  const headSha = attrs.last_commit?.id ?? attrs.diff_refs?.head_sha ?? ""
  if (!headSha) {
    return new Response("missing head sha\n", { status: 400 })
  }
  const baseSha = attrs.diff_refs?.base_sha ?? null
  const deliveryId = request.headers.get("x-gitlab-event-uuid")

  if (decision.review) {
    // Enqueue the GitLab MR onto its OWN job type — the GitHub `pr-review` path
    // is left untouched. PR-3 wires the consumer that builds the client via
    // `GitLabScmProvider.buildReviewClient` and runs the SCM-agnostic ensemble.
    try {
      await env.OPENCLAW_JOBS.send({
        type: "gitlab-mr-review",
        projectPath,
        projectId,
        mrIid,
        headSha,
        baseSha,
        sourceBranch: attrs.source_branch ?? "",
        targetBranch: attrs.target_branch ?? "",
        deliveryId,
      })
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "gitlab-mr-review-enqueue-failed",
          project: projectPath,
          mr_iid: mrIid,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      return new Response("enqueue failed\n", { status: 503 })
    }
    console.log(
      JSON.stringify({
        event: "gitlab-mr-review-webhook-arrived",
        project: projectPath,
        mr_iid: mrIid,
        action,
        head_sha: headSha.slice(0, 7),
        delivery_id: deliveryId,
      }),
    )
  }

  return new Response("queued\n", { status: 202 })
}
