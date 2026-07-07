// Port: the SCM-provider seam for the PR/MR review path (foundation for GitLab
// support). Today the review flow is GitHub-hardcoded at three ingress points —
// webhook-signature verification, the event→review-trigger decision, and the
// per-installation review-client build. This port names exactly those
// operations so a second forge (GitLab) can be added as another implementation
// without touching the review ENGINE (the four specialists + synthesizer are
// SCM-agnostic — they operate on a diff).
//
// PR-1 scope (behavior-neutral): GitHub is the first and only implementation;
// every method delegates VERBATIM to the existing GitHub function, so review
// output stays byte-identical. @mention / CI-triage / learnings / runner /
// Linear paths stay GitHub-direct (Phase-3 parity).
//
// Types only; imports nothing outward (DTOs come from `@/shared/types`, the
// read/write surface from the sibling `./github` + `./review-sink` ports).

import type { Env } from "@/src/shared/types/env"
import type { GitHubPort } from "./github"
import type { ReviewSinkPort } from "./review-sink"

/** Discriminant identifying which forge a provider speaks to. `"github"` is the
 *  original; `"gitlab"` was added by the GitLab MR-review adapter (PR 2). */
export type ScmProviderKind = "github" | "gitlab"

/**
 * The read + write handle a single review run uses against the forge — the
 * union of the pre-existing READ (`GitHubPort`) and WRITE (`ReviewSinkPort`)
 * seams. The concrete `GitHubClient` STRUCTURALLY satisfies this today, so a
 * GitHub provider returns it with no wrapper. A GitLab provider returns its own
 * client that satisfies the same surface.
 *
 * Crosswalk from the task's normalized verbs onto the existing method names
 * (kept verbatim in PR-1 to avoid a parallel surface):
 *   - fetchDiff        → `getPullRequestDiff`   (unified diff for a PR)
 *   - listChangedFiles → `listPullRequestFiles` / `listPullFilesForManifest`
 *   - fetchFileContent → `getFileContent`       (file at a ref, null when absent)
 *   - resolveRefs      → `getBranch` + `getMergeBase` (tip/tree SHA, merge-base)
 *   - postReview       → `submitReview`         (body + inline comments in one call)
 */
export type ScmReviewClient = GitHubPort & ReviewSinkPort

/** Inputs to the webhook-signature check. GitHub signs the raw body with
 *  HMAC-SHA256 and sends `sha256=<hex>` in `X-Hub-Signature-256`; a GitLab
 *  adapter would instead compare `X-Gitlab-Token` against the shared secret. */
export interface ScmWebhookVerifyInput {
  /** The raw request body, read exactly once before verification. */
  rawBody: string
  /** The provider signature header value (GitHub: `X-Hub-Signature-256`). */
  signature: string
  /** The per-installation webhook secret. */
  secret: string
}

/**
 * The already-normalized inputs to the review-trigger decision. These are the
 * SCM-neutral facts a webhook carries about a PR/MR change; the provider maps
 * its native event vocabulary onto them (GitHub: `opened` / `synchronize` /
 * `reopened` / `ready_for_review`; GitLab: `open` / `update` / `reopen`).
 */
export interface ScmReviewEventInput {
  action: string
  draft: boolean
  prBody?: string | null | undefined
  baseRef?: string
  headRef?: string
  skipReleasePromotions?: boolean
}

/**
 * The review-routing decision: whether this event should fire the overview
 * side-effects and/or the full ensemble review. Shape matches the existing
 * `decidePullRequestJobs` return so the ingress swap is byte-identical.
 */
export interface ScmReviewDecision {
  overview: boolean
  review: boolean
}

/**
 * The SCM-provider port. Captures exactly the forge I/O the PR-review ingress
 * needs, minimal and faithful to current behavior.
 */
export interface ScmProvider {
  /** Which forge this provider speaks to. */
  readonly kind: ScmProviderKind

  /** Verify a webhook delivery's signature against the shared secret. */
  verifyWebhook(input: ScmWebhookVerifyInput): Promise<boolean>

  /** Decide whether a (already-parsed) review event should trigger overview / review. */
  parseReviewEvent(input: ScmReviewEventInput): ScmReviewDecision

  /** Build the per-installation read/write client for a review run. */
  buildReviewClient(env: Env, installationId: number): Promise<ScmReviewClient>
}
