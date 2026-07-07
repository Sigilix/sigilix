// The GitHub implementation of the `ScmProvider` port (foundation for GitLab
// support). This is the entry-layer adapter that wires the PR-review INGRESS —
// webhook-signature verification, the event→review-trigger decision, and the
// per-installation review-client build — behind the SCM seam. Every method
// DELEGATES verbatim to the existing GitHub function, so the review path stays
// byte-identical; the abstraction only relocates the *selection* of which forge
// handles the delivery.
//
// It lives in the entry layer (next to `index-github-webhook.ts` /
// `index-internals.ts`) because it composes ingress helpers from three inward
// layers — the pure `decidePullRequestJobs` decision (entry-leaf
// `index-internals.ts`), the shared HMAC verifier + GitHub App auth, and the
// ensemble's per-installation client factory. Entry is the outermost layer, so
// importing inward from all three is dependency-rule-clean.

import type { Env } from "@/src/shared/types/env"
import type {
  ScmProvider,
  ScmProviderKind,
  ScmReviewDecision,
  ScmReviewEventInput,
  ScmWebhookVerifyInput,
} from "@/src/lib/ensemble/ports"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { verifyGitHubWebhook } from "@/src/shared/adapters/github/github-webhook-verify"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import { decidePullRequestJobs } from "@/src/index-internals"

/**
 * GitHub `ScmProvider`. `buildReviewClient` returns the CONCRETE `GitHubClient`
 * (a covariant narrowing of the port's `ScmReviewClient`) so callers that still
 * need GitHub-specific client methods — config load, draft-skip notice, the
 * overview stub — keep working unchanged in PR-1.
 */
export class GitHubScmProvider implements ScmProvider {
  readonly kind = "github" as const

  verifyWebhook(input: ScmWebhookVerifyInput): Promise<boolean> {
    return verifyGitHubWebhook(input.rawBody, input.signature, input.secret)
  }

  parseReviewEvent(input: ScmReviewEventInput): ScmReviewDecision {
    return decidePullRequestJobs(input)
  }

  // Returns the CONCRETE `GitHubClient` (a covariant narrowing of the port's
  // `ScmReviewClient`) so webhook-side callers that still need GitHub-specific
  // client methods keep working unchanged.
  buildReviewClient(env: Env, installationId: number): Promise<GitHubClient> {
    // `buildClient` mints the per-installation App token and constructs the
    // `GitHubClient` — identical to the inline webhook-time build it replaces.
    return buildClient(env, installationId)
  }
}

const GITHUB_SCM_PROVIDER = new GitHubScmProvider()

/**
 * Select the SCM provider for a delivery by its forge discriminant. Defaults to
 * GitHub — the only forge today; the GitLab branch is added when its adapter
 * lands. Returns the concrete `GitHubScmProvider` for `"github"` so the webhook
 * handler retains the concrete `GitHubClient` from `buildReviewClient`.
 */
export function selectScmProvider(kind: ScmProviderKind = "github"): GitHubScmProvider {
  switch (kind) {
    case "github":
      return GITHUB_SCM_PROVIDER
    default: {
      const exhaustive: never = kind
      throw new Error(`unsupported SCM provider: ${String(exhaustive)}`)
    }
  }
}
