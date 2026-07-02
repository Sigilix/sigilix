// Sigilix Worker — Linear webhooks → triage; GitHub webhooks → PR review.
//
// Routes:
//   GET  /                     liveness probe
//   POST /linear/webhook       Linear sends Issue.create / Comment.create (mention)
//   POST /linear/manual        manual triage trigger (dev/admin) — body: { issueId }
//   POST /github/webhook       GitHub sends pull_request, workflow_run,
//                              pull_request_review
//
// HMAC verification on Linear uses LINEAR_WEBHOOK_SECRET. GitHub uses
// GITHUB_WEBHOOK_SECRET (sha256= prefix).
//
// Long-running work (Ollama Turbo calls, 30-90s typical) runs in a
// Cloudflare Queue consumer instead of `ctx.waitUntil()`. The 30-second
// waitUntil cap is hard-coded by the Workers runtime (not configurable
// on any plan), so any long-running task must be deferred. Queue
// consumers get up to 15 minutes per invocation, which is plenty.
//
// Flow:
//   webhook arrives → fetch handler verifies + parses → enqueues a
//   typed JobMessage → returns 200 in ~50ms → queue() handler runs the
//   actual work (Ollama + GitHub/Linear API calls) with full budget.

import {
  detectRecallAlarm,
  recallOutcomeFromTelemetry,
  type RecallReviewOutcome,
  type RawReviewTelemetry,
} from "@/src/lib/recall-alarm"
import { handleValidationMetricsRoute } from "@/src/lib/metrics-validation-route"
import { handleReviewApiRoute } from "@/src/lib/api-review-route"
import { handleBoreasApiRoute } from "@/src/lib/boreas-gateway/api-boreas-route"
import { handlePyroeisApiRoute } from "@/src/lib/boreas-gateway/api-pyroeis-route"
import { handleAstraeusApiRoute } from "@/src/lib/boreas-gateway/api-astraeus-route"
import { handleJwksRoute, handleOpenidConfigurationRoute } from "@/src/lib/boreas-gateway/well-known-routes"
import { handleAgentContextRoute } from "@/src/lib/api-context-route"
import { handleVerifyApiRoute } from "@/src/lib/api-verify-route"
import { handleBlastRadiusApiRoute } from "@/src/lib/api-blast-radius-route"
import { handleFleetApiRoute } from "@/src/lib/api-fleet-route"
import {
  handleMemoryWriteRoute,
  handleMemoryQueryRoute,
  handleMemoryExtractRoute,
  handleMemoryListRoute,
  handleMemoryDeleteRoute,
} from "@/src/lib/agent-memory"
import { handleResearchCreate, handleResearchStream, handleResearchCancel } from "@/src/do/deep-research/routes"
import { tryHandleMcpRoute } from "@/src/do/mcp/routes"
import { handleTestSuppressionsMetricsRoute } from "@/src/lib/metrics-test-suppressions-route"
import { handleRunnerEvidenceMetricsRoute } from "@/src/lib/metrics-runner-evidence-route"
import { handleRunnerToolsMetricsRoute } from "@/src/lib/metrics-runner-tools-route"
import { handleVerificationMetricsRoute } from "@/src/lib/metrics-verification-route"
import { handleDismissalMetricsRoute } from "@/src/lib/metrics-dismissals-route"
import { handlePrecisionMetricsRoute } from "@/src/lib/metrics-precision-route"
import { handleRepeatFpsMetricsRoute } from "@/src/lib/metrics-repeat-fps-route"
import { handleGraphMetricsRoute } from "@/src/lib/metrics-graph-route"
import { handleGraphExpansionMetricsRoute } from "@/src/lib/metrics-graph-expansion-route"
import { handleGraphExpansionAbMetricsRoute } from "@/src/lib/metrics-graph-expansion-ab-route"
import { handleFpRateMetricsRoute } from "@/src/lib/metrics-fp-rate-route"
import { handleTenantUsageMetricsRoute } from "@/src/lib/metrics-tenant-usage-route"
import { handleRunnerIngestRoute } from "@/src/lib/runner-ingest-route"
import {
  handleAdminIndexRoute,
  handleAdminBackfillRoute,
  handleAdminReconcileRoute,
  handleAdminMigrateToRepoIdRoute,
  handleAdminMigrateReviewMemoryToRepoIdRoute,
  handleAdminPurgeStaleIndexesRoute,
} from "@/src/lib/admin-index-route"
import { handleAdminLinearRetrievalProbeRoute } from "@/src/lib/admin-linear-retrieval-probe-route"
import { handleAdminAgentRunRoute, handleAdminAgentStatusRoute } from "@/src/lib/agent-runner/admin-agent-run-route"
import { runIndexReconciliation } from "@/src/lib/index-reconciliation"
import { runMemoryDecayPass } from "@/src/lib/memory-decay"
import { handleReviewStatusRoute } from "@/src/do/status-route"
import { handleGitHubAuthCallback, handleGitHubAuthKickoff, handleLogout } from "@/src/lib/auth-oauth-github"
import { requireSession } from "@/src/lib/auth-middleware"
import { handleAuthMeRoute } from "@/src/lib/auth-me-route"
import { renderWelcomePage } from "@/src/lib/auth-welcome"
import { readCookie, SESSION_COOKIE_NAME } from "@/src/lib/auth-session"
import { handleInstallRedirect, handleSetupRoute } from "@/src/lib/auth-setup-route"
import { handleCreateApiKeyRoute, handleRevokeApiKeyRoute } from "@/src/lib/api-keys-route"
import { handleOnboardingContextRoute } from "@/src/lib/onboarding-context-route"
import { handleOnboardingSubmitRoute } from "@/src/lib/onboarding-submit-route"
import { handleWorkspacePrsRoute } from "@/src/lib/workspace-prs-route"
import { handleOrgOverviewRoute } from "@/src/lib/org-overview-route"
import { handleMetricsDashboardRoute } from "@/src/lib/metrics-dashboard-route"
import { handlePortalPreflight, withPortalCors } from "@/src/lib/portal-cors"
import { handleBadgeAssetRoute } from "@/src/lib/badge-assets"
import { parseValidateMode, validateEnv } from "@/src/lib/env-validate"
import { isIndexerEnabled } from "@/src/lib/index-producer"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import {
  admitTenant,
  releaseTenant,
  MAX_DEFERS,
  resolveFairnessConfig,
  resolveTenantCap,
  checkShadowQuota,
  resolveQuotaMode,
} from "@/src/features/tenancy"
import { getProviderCooldownRemainingMs } from "@/src/shared/adapters/model/provider-cooldown-client"
import {
  resolveCooldownMode,
  decorrelatedJitterMs,
  JITTER_BASE_MS,
  JITTER_CAP_MS,
} from "@/src/lib/ensemble/domain/backpressure"

// SIG-318 / SIG-376 (Tier-1 8/8): entry-module decomposition. The webhook
// handlers + the queue dispatcher + the shared mention/capture layer were
// relocated VERBATIM into sibling leaves; this entry module keeps only the
// default export (fetch/queue/scheduled), the recall-alarm scan it calls,
// the module-level validation cache (mutable state must keep its identity
// here), and the Durable Object class re-exports (wrangler resolves DO
// class names against the entry module). Every previously-public symbol is
// re-exported below so no importer or test path changes.
import { handleGitHubWebhook } from "@/src/index-github-webhook"
import { handleLinearWebhook, handleManualTrigger } from "@/src/index-webhooks"
import { dispatchJob } from "@/src/index-dispatch"
import { handleSlackRequest } from "@/src/index-slack-webhook"
import { handleSlackInstall, handleSlackOAuthCallback } from "@/src/lib/slack/slack-install"
import { handleLinearOAuthCallback, handleLinearInstall } from "@/src/lib/linear-agent-oauth"

// Re-export the relocated public symbols so the entry module's export
// surface is byte-for-byte unchanged for every importer + test pin.
export { dispatchJob } from "@/src/index-dispatch"
export { prMetaIsClosedOrMerged } from "@/src/index-dispatch"
export {
  decidePullRequestJobs,
  queueGithubMention,
  dispatchReviewMemoryCapture,
  dispatchTopLevelReviewMemoryCapture,
  dispatchDismissedReviewMemoryCapture,
} from "@/src/index-internals"

// Validation cache — Cloudflare Workers can't read `env` at module top
// level (it's per-request), so validation runs once per env signature
// inside the fetch handler. The cache key includes every env value that
// affects validation, so an isolate that multiplexes envs across
// preview/staging/prod revalidates per signature instead of locking to
// the first-request env. The key is set BEFORE the validateEnv call so
// a throw doesn't trigger a retry loop on every subsequent request.
let validatedKey: string | null = null
let validationError: Error | null = null

function validationCacheKey(env: Env): string {
  // NUL-separated to avoid ambiguity if any value contains an embedded "|".
  return [
    env.OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS ?? "warn",
    env.OPENCLAW_TEAM_GITHUB_REPO_MAP ?? "",
    env.OPENCLAW_GITHUB_INSTALLATION_MAP ?? "",
  ].join("\0")
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const badgeAsset = handleBadgeAssetRoute(request)
    if (badgeAsset) return badgeAsset

    const key = validationCacheKey(env)
    if (validatedKey !== key) {
      validatedKey = key // SET BEFORE call — prevents retry loop on throw
      validationError = null
      try {
        validateEnv(env, parseValidateMode(env.OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS))
      } catch (e) {
        validationError = e as Error
      }
    }
    if (validationError && parseValidateMode(env.OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS) === "strict") {
      // Never include validationError.message in the response body — it
      // names the team / repo / installation entries that are missing,
      // which we don't want to leak to whoever's poking the public URL.
      // The full diagnostic is already in the server logs (env-validate
      // emits console.error before throwing in strict mode).
      console.error("env validation failed", { error: validationError.message })
      return new Response("misconfigured\n", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })
    }

    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Sigilix — alive\n", {
        headers: { "content-type": "text/plain" },
      })
    }

    // SIG-545: UNAUTHENTICATED OIDC discovery for the Boreas CLI gateway — GCP's
    // Workload-Identity-Federation provider fetches these to verify the gateway's
    // self-signed assertion JWTs. JWKS serves only the public signing key.
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return handleJwksRoute(env)
    }
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return handleOpenidConfigurationRoute(env)
    }

    // SIG-119: authenticated read of rolling validator shadow telemetry.
    if (request.method === "GET" && url.pathname === "/metrics/validation") {
      return handleValidationMetricsRoute(request, env)
    }

    // SIG-347 (SIG-166 AC #4): tests-gate per-drop-reason suppression rates —
    // a focused projection of /metrics/validation's tests gate for the
    // tests-specialist over-fire precision dogwatch.
    if (request.method === "GET" && url.pathname === "/metrics/test-suppressions") {
      return handleTestSuppressionsMetricsRoute(request, env)
    }

    // SIG-173: authenticated read of rolling per-reason dismissal rollup.
    if (request.method === "GET" && url.pathname === "/metrics/dismissals") {
      return handleDismissalMetricsRoute(request, env)
    }

    // SIG-217: authenticated read of rolling repeat-FP rollup (per-reason +
    // per-specialist) — surfaces dismissal-re-fire + severity-escalation rates.
    if (request.method === "GET" && url.pathname === "/metrics/repeat-fps") {
      return handleRepeatFpsMetricsRoute(request, env)
    }

    // SIG-147: authenticated read of a repo's precision profile (FP-reduction
    // signal — how many repeatedly-dismissed patterns are now suppressed).
    if (request.method === "GET" && url.pathname === "/metrics/precision") {
      return handlePrecisionMetricsRoute(request, env)
    }

    // SIG-152: authenticated read of rolling SIG-138 graph shadow telemetry.
    if (request.method === "GET" && url.pathname === "/metrics/graph") {
      return handleGraphMetricsRoute(request, env)
    }

    // SIG-286 PR2.5: authenticated read of the rolling graph-context-expansion
    // shadow measurement (netNewTokens median + cross-file rates + GO/KILL hint).
    if (request.method === "GET" && url.pathname === "/metrics/graph-expansion") {
      return handleGraphExpansionMetricsRoute(request, env)
    }

    // SIG-286 PR3: per-arm read of the targeted-inject A/B (treatment vs control
    // finding rate). Reads the graphExpansionAb tags on ensemble-review-telemetry.
    if (request.method === "GET" && url.pathname === "/metrics/graph-expansion-ab") {
      return handleGraphExpansionAbMetricsRoute(request, env)
    }

    // SIG-114 PR 5: authenticated live read of the per-specialist dismissal-
    // based false-positive rate (the "floor" metric), computed per repo.
    if (request.method === "GET" && url.pathname === "/metrics/fp-rate") {
      return handleFpRateMetricsRoute(request, env)
    }

    // SIG-543 PR D Task 5: authenticated per-tenant usage rollup from D1.
    if (request.method === "GET" && url.pathname === "/metrics/tenant-usage") {
      return handleTenantUsageMetricsRoute(request, env)
    }

    // SIG-184 PR 5b: authenticated read of rolling runner-evidence presence
    // telemetry (adoption + the verified/pending/absent breakdown).
    if (request.method === "GET" && url.pathname === "/metrics/runner-evidence") {
      return handleRunnerEvidenceMetricsRoute(request, env)
    }

    // SIG-107: authenticated read of accepted runner scan-manifest telemetry,
    // grouped by deterministic tool and output status.
    if (request.method === "GET" && url.pathname === "/metrics/runner-tools") {
      return handleRunnerToolsMetricsRoute(request, env)
    }

    // SIG-285 PR 2: authenticated read of the rolling verification-by-execution
    // verdict distribution (the refutable-FP fraction).
    if (request.method === "GET" && url.pathname === "/metrics/verification") {
      return handleVerificationMetricsRoute(request, env)
    }

    // SIG-184: runner-evidence ingest. A Sigilix reusable workflow in the
    // customer's CI POSTs its SARIF + a GitHub OIDC token here; the token IS the
    // auth (verified + provenance-gated inside the handler), not a static bearer.
    if (request.method === "POST" && url.pathname === "/runner/ingest") {
      return handleRunnerIngestRoute(request, env, ctx)
    }

    // SIG-304 Phase 2: hosted thin-client review. Static-bearer auth; runs the
    // engine server-side (dryRun → nothing posted) + returns the DryRunReview.
    // Inert (503) until OPENCLAW_SIGILIX_API_KEY is set.
    if (request.method === "POST" && url.pathname === "/v1/review") {
      return handleReviewApiRoute(request, env, ctx)
    }

    // SIG-545: Boreas CLI gateway — authenticated proxy to Vertex AI (keyless WIF).
    // Static-bearer auth; mints/reuses a Vertex SA token server-side + forces the model.
    // Inert (503) until OPENCLAW_SIGILIX_API_KEY AND OPENCLAW_GATEWAY_ISSUER are set.
    if (request.method === "POST" && url.pathname === "/v1/boreas/chat/completions") {
      return handleBoreasApiRoute(request, env, ctx)
    }

    // SIG-545: Pyroeis CLI gateway — same keyless-WIF Vertex proxy as Boreas above,
    // forcing a different model (Gemma 4 26B serverless MaaS). Same 503-until-configured
    // + static-bearer auth + server-side SA-token mint + model forcing.
    if (request.method === "POST" && url.pathname === "/v1/pyroeis/chat/completions") {
      return handlePyroeisApiRoute(request, env, ctx)
    }

    // SIG-545: Astraeus CLI gateway — same keyless-WIF Vertex proxy as Boreas above,
    // forcing a different model (GLM-5.2 serverless MaaS). Same 503-until-configured
    // + static-bearer auth + server-side SA-token mint + model forcing.
    if (request.method === "POST" && url.pathname === "/v1/astraeus/chat/completions") {
      return handleAstraeusApiRoute(request, env, ctx)
    }

    // SIG-494: grounded-retrieval for the Sigilix CLI agent — POSTs {owner, repo, query},
    // returns a packed context slice (index + graph). Inert (503) until the API key is set.
    if (request.method === "POST" && url.pathname === "/v1/context") {
      return handleAgentContextRoute(request, env)
    }

    // Sealed pure-logic verification oracle — POSTs {owner, repo, before, after}, runs both
    // in the QuickJS sandbox over a type-aware battery, returns changed/preserved/skipped.
    // Proves behavioral change/preservation, NOT correctness. Inert (503) until the API key
    // is set.
    if (request.method === "POST" && url.pathname === "/v1/verify") {
      return handleVerifyApiRoute(request, env)
    }

    // Graph-grounded impact preview — POSTs {owner, repo, names, paths}, returns the files
    // that CALL those symbols and the files that IMPORT those files, so the agent knows
    // what its edit may break. Empty (graceful) for an un-indexed repo. Inert (503) until
    // the API key is set.
    if (request.method === "POST" && url.pathname === "/v1/blast-radius") {
      return handleBlastRadiusApiRoute(request, env)
    }

    // SIG-507: fleet intelligence (read-only surfacing). Given findings (category + headline),
    // return anonymized "seen in ~N codebases" insights for patterns past the K=5 k-anonymity gate.
    // Contributions are written server-side by the review pipeline, never here. Inert (503) until keyed.
    if (request.method === "POST" && url.pathname === "/v1/fleet") {
      return handleFleetApiRoute(request, env)
    }

    // SIG-483: agent-memory store. PUT writes a durable per-(user, repo) memory
    // (embed → Vectorize tenant namespace + KV); POST/query semantically
    // retrieves them. Static-bearer auth; inert (503) until the API key is set.
    if (request.method === "PUT" && url.pathname === "/v1/memory") {
      return handleMemoryWriteRoute(request, env)
    }
    if (request.method === "POST" && url.pathname === "/v1/memory/query") {
      return handleMemoryQueryRoute(request, env)
    }
    // POST/extract distills 0–3 durable facts from a conversation exchange via a
    // cheap model and stores each through the same write path PUT uses.
    if (request.method === "POST" && url.pathname === "/v1/memory/extract") {
      return handleMemoryExtractRoute(request, env)
    }

    // SIG-156: authenticated manual (re)index trigger.
    if (request.method === "POST" && url.pathname === "/admin/index-repo") {
      return handleAdminIndexRoute(request, env)
    }

    // SIG-156: authenticated backfill — index every repo of every installation.
    if (request.method === "POST" && url.pathname === "/admin/index-backfill") {
      return handleAdminBackfillRoute(request, env)
    }

    // SIG-156 PR3: authenticated manual trigger for the reconciliation cron
    // (same routine `scheduled` runs). Reads each repo's manifest and only
    // enqueues repos with no manifest in KV.
    if (request.method === "POST" && url.pathname === "/admin/index-reconcile") {
      return handleAdminReconcileRoute(request, env)
    }

    // SIG-419: authenticated bulk purge of stale index records (branch overlays
    // redundant after SIG-413 + caller-named dead orgs). `?dryRun=true` first.
    if (request.method === "POST" && url.pathname === "/admin/purge-stale-indexes") {
      return handleAdminPurgeStaleIndexesRoute(request, env)
    }

    // SIG-207: safe dry-run probe for Linear mention code retrieval.
    if (request.method === "POST" && url.pathname === "/admin/linear-retrieval-probe") {
      return handleAdminLinearRetrievalProbeRoute(request, env)
    }

    // SIG-243 Phase 3: authenticated migration endpoint to backfill the
    // immutable `githubRepoId` field on every legacy manifest under one
    // installation. Re-writing the manifest fires Phase 2's dual-write,
    // populating the new `repo-tenant:{id}` key. Idempotent.
    if (request.method === "POST" && url.pathname === "/admin/migrate-to-repo-id") {
      return handleAdminMigrateToRepoIdRoute(request, env)
    }

    // SIG-247 Phase 1 PR B: authenticated migration endpoint for the
    // review-memory keyspace. Walks every repo of one installation,
    // lists legacy `review-memory:<owner>/<repo>:*` keys, fetches the
    // immutable repo.id, and writes UNIONED records to the new
    // `review-memory:repo:<id>:*` keys with a `migratedAt` sentinel.
    // Supports ?dryRun=true. Idempotent re-runs.
    if (request.method === "POST" && url.pathname === "/admin/migrate-review-memory-to-repo-id") {
      return handleAdminMigrateReviewMemoryToRepoIdRoute(request, env)
    }

    // SIG-545 B1 proof harness: admin-gated manual agent-runner dispatch + status.
    if (request.method === "POST" && url.pathname === "/admin/agent-run") {
      return handleAdminAgentRunRoute(request, env)
    }
    if (request.method === "GET" && url.pathname === "/admin/agent-run-status") {
      return handleAdminAgentStatusRoute(request, env)
    }

    if (request.method === "POST" && url.pathname === "/linear/webhook") {
      return handleLinearWebhook(request, env, ctx)
    }

    if (request.method === "POST" && url.pathname === "/linear/manual") {
      return handleManualTrigger(request, env, ctx)
    }

    // Linear AGENT install (actor=app) — the founder's one-click install entry. Mints
    // a CSRF nonce + 302s to Linear's actor=app consent screen.
    if (request.method === "GET" && url.pathname === "/linear/install") {
      return handleLinearInstall(request, env)
    }

    // Linear AGENT install (actor=app) — the authorization-code callback. Verifies the
    // CSRF nonce, exchanges the code for the agent access token + stores it in KV so
    // Sigilix can post agent activities. Finalizes the install so Sigilix appears in
    // the assignee/agent picker.
    if (request.method === "GET" && url.pathname === "/linear/oauth/callback") {
      return handleLinearOAuthCallback(request, env)
    }

    if (request.method === "POST" && url.pathname === "/github/webhook") {
      return handleGitHubWebhook(request, env, ctx)
    }

    // SIG-196: Sigilix Slack agent routes (dark behind SIGILIX_SLACK_MODE).
    if (request.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackRequest(request, env, ctx)
    }
    if (request.method === "GET" && url.pathname === "/slack/install") {
      return handleSlackInstall(request, env)
    }
    if (request.method === "GET" && url.pathname === "/slack/oauth/callback") {
      return handleSlackOAuthCallback(request, env)
    }

    // ─── Phase 5 user OAuth (ARC-163) ────────────────────────────
    if (request.method === "GET" && url.pathname === "/auth/github") {
      return handleGitHubAuthKickoff(request, env)
    }
    if (request.method === "GET" && url.pathname === "/auth/github/callback") {
      return handleGitHubAuthCallback(request, env)
    }
    if (request.method === "GET" && url.pathname === "/auth/welcome") {
      const authed = await requireSession(request, env, ctx)
      if (!authed) {
        return new Response(null, { status: 302, headers: { location: "/" } })
      }
      return renderWelcomePage(authed.record)
    }
    if (request.method === "GET" && url.pathname === "/auth/me") {
      return handleAuthMeRoute(request, env, ctx)
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const sessionId = readCookie(request, SESSION_COOKIE_NAME)
      return handleLogout(request, env, sessionId)
    }
    // #155 onboarding-backend FOUNDATION (slice 1 of 2): the GitHub App Setup
    // URL handler + the install-redirect kickoff that mints its CSRF nonce.
    if (request.method === "GET" && url.pathname === "/auth/install-redirect") {
      return handleInstallRedirect(request, env, ctx)
    }
    if (request.method === "GET" && url.pathname === "/setup") {
      return handleSetupRoute(request, env, ctx)
    }
    // #155 onboarding-backend slice 3 (portal endpoints): the portal
    // (a DIFFERENT ORIGIN — app.sigilix.ai / localhost:3300 dev) drives
    // these session-authed routes over `fetch(..., { credentials: "include" })`,
    // so they're CORS'd via portal-cors.ts. OPTIONS is handled once, up
    // front, for every path in this set; every actual response is wrapped
    // with withPortalCors so credentials-mode responses never carry `*`.
    // sig-workspace-prs: /v1/workspace/prs is dual-authed (session cookie OR
    // bearer api key — see workspace-prs-route.ts), but the portal's browser
    // session path still needs the same credentialed-CORS treatment as the
    // other session-authed portal routes above.
    const isPortalCorsPath =
      url.pathname === "/v1/keys" ||
      url.pathname.startsWith("/v1/keys/") ||
      url.pathname === "/v1/onboarding" ||
      url.pathname === "/v1/onboarding/context" ||
      url.pathname === "/v1/research" ||
      url.pathname.startsWith("/v1/research/") ||
      url.pathname === "/v1/workspace/prs" ||
      // sig-org-overview: GET /v1/org/overview — the portal's Organization page
      // (seats + per-seat billing). Dual-authed (session OR api key); see
      // org-overview-route.ts.
      url.pathname === "/v1/org/overview" ||
      url.pathname === "/v1/metrics/dashboard" || // sig-metrics-dashboard (see metrics-dashboard-route.ts)
      // sig-memory-crud: GET /v1/memory (list) + DELETE /v1/memory/:id (delete)
      // are portal-facing (dual-authed session OR api key — see
      // agent-memory-crud-route.ts). The earlier PUT/POST /v1/memory* routes
      // (write/query/extract, api-key-only) return before this block, so
      // adding /v1/memory here only affects the new GET/DELETE + their OPTIONS.
      url.pathname === "/v1/memory" ||
      url.pathname.startsWith("/v1/memory/")
    if (request.method === "OPTIONS" && isPortalCorsPath) {
      return handlePortalPreflight(request, env)
    }

    // SIG-298: deep web research engine. Auth = session OR API key (handled in
    // the route). CORS'd via portal-cors (the SSE stream body passes through).
    //   POST /v1/research            → { id }
    //   GET  /v1/research/:id/stream → SSE transcript (replay-from-start + live)
    //   POST /v1/research/:id/cancel → cooperative cancel
    if (request.method === "POST" && url.pathname === "/v1/research") {
      return withPortalCors(request, await handleResearchCreate(request, env, ctx), env)
    }
    if (url.pathname.startsWith("/v1/research/")) {
      const rest = url.pathname.slice("/v1/research/".length)
      const streamMatch = /^([^/]+)\/stream$/.exec(rest)
      if (request.method === "GET" && streamMatch) {
        const id = decodeURIComponent(streamMatch[1]!)
        return withPortalCors(request, await handleResearchStream(request, env, ctx, id), env)
      }
      const cancelMatch = /^([^/]+)\/cancel$/.exec(rest)
      if (request.method === "POST" && cancelMatch) {
        const id = decodeURIComponent(cancelMatch[1]!)
        return withPortalCors(request, await handleResearchCancel(request, env, ctx, id), env)
      }
    }

    const mcpResponse = await tryHandleMcpRoute(request, env, ctx, url)
    if (mcpResponse) return mcpResponse
    // #155 onboarding-backend FOUNDATION (slice 1 of 2): key management —
    // mint/revoke per-installation API keys.
    if (request.method === "POST" && url.pathname === "/v1/keys") {
      return withPortalCors(request, await handleCreateApiKeyRoute(request, env, ctx), env)
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/keys/")) {
      const keyId = decodeURIComponent(url.pathname.slice("/v1/keys/".length))
      if (!keyId) {
        return withPortalCors(
          request,
          new Response(JSON.stringify({ error: "missing key id" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
          env,
        )
      }
      return withPortalCors(request, await handleRevokeApiKeyRoute(request, env, keyId, ctx), env)
    }
    // #155 onboarding-backend slice 3 (portal endpoints): the setup
    // wizard's repo/installation picker context + the wizard-answers sink.
    if (request.method === "GET" && url.pathname === "/v1/onboarding/context") {
      return withPortalCors(request, await handleOnboardingContextRoute(request, env, ctx), env)
    }
    if (request.method === "POST" && url.pathname === "/v1/onboarding") {
      return withPortalCors(request, await handleOnboardingSubmitRoute(request, env, ctx), env)
    }
    // sig-workspace-prs: the portal's Pull-requests workspace page — org-wide
    // + mine PR sections from D1 usage_ledger. Dual-authed (session OR api
    // key); see workspace-prs-route.ts.
    if (request.method === "GET" && url.pathname === "/v1/workspace/prs") {
      return withPortalCors(request, await handleWorkspacePrsRoute(request, env, ctx), env)
    }
    // sig-org-overview: the portal's Organization page — org headline, billable
    // seats (distinct usage_ledger authors scoped to the caller's installation),
    // and per-seat billing. Dual-authed (session OR api key); see
    // org-overview-route.ts.
    if (request.method === "GET" && url.pathname === "/v1/org/overview") {
      return withPortalCors(request, await handleOrgOverviewRoute(request, env, ctx), env)
    }
    if (request.method === "GET" && url.pathname === "/v1/metrics/dashboard") {
      return withPortalCors(request, await handleMetricsDashboardRoute(request, env, ctx), env)
    }
    // sig-memory-crud: the portal's memory-management surface. GET lists the
    // caller's saved memories (paginated); DELETE removes one by id. Dual-authed
    // (session cookie OR bearer api key — see agent-memory-crud-route.ts) and
    // CORS'd for the portal origins. Registered AFTER the PUT/POST /v1/memory*
    // write/query/extract routes above, so the HTTP method disambiguates them.
    if (request.method === "GET" && url.pathname === "/v1/memory") {
      return withPortalCors(request, await handleMemoryListRoute(request, env, ctx), env)
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/memory/")) {
      const memoryId = decodeURIComponent(url.pathname.slice("/v1/memory/".length))
      return withPortalCors(request, await handleMemoryDeleteRoute(request, env, memoryId, ctx), env)
    }
    // ARC-190: GET /reviews/<owner>/<repo>/<prNumber> — public status
    // route for DO-tracked PR review runs. v1 unauth (read-only
    // metadata only). The route handler validates segments + decodes
    // before fetching the DO.
    if (request.method === "GET" && url.pathname.startsWith("/reviews/")) {
      const segments = url.pathname.slice("/reviews/".length).split("/")
      if (segments.length !== 3) {
        return new Response(JSON.stringify({ error: "expected /reviews/<owner>/<repo>/<prNumber>" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      let owner: string, repo: string, prNumberRaw: string
      try {
        owner = decodeURIComponent(segments[0]!)
        repo = decodeURIComponent(segments[1]!)
        prNumberRaw = decodeURIComponent(segments[2]!)
      } catch {
        return new Response(JSON.stringify({ error: "malformed percent-encoding in path" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      // CR PR #70: strict-positive-integer check. `Number.parseInt`
      // accepts trailing garbage (`"12foo"` → 12), the unary `+`
      // operator returns 0 on `""`, and `Number.isInteger(NaN)` is
      // false but several string forms (e.g. `" 12 "`) would still
      // parse. Anchor on `^\d+$` and reject anything else with 400.
      if (!/^\d+$/.test(prNumberRaw)) {
        return new Response(JSON.stringify({ error: "prNumber must be a positive integer" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      const prNumber = Number.parseInt(prNumberRaw, 10)
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return new Response(JSON.stringify({ error: "prNumber must be a positive integer" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      return handleReviewStatusRoute(env, owner, repo, prNumber)
    }
    // Stubs for deferred providers — return 501 with a plain message
    // so the marketing site's "Soon"-labeled buttons don't 404.
    if (
      request.method === "GET" &&
      (url.pathname === "/auth/google" ||
        url.pathname === "/auth/email" ||
        url.pathname === "/auth/gitlab" ||
        url.pathname === "/auth/bitbucket" ||
        url.pathname === "/auth/azure")
    ) {
      return new Response("provider not implemented yet — see /\n", {
        status: 501,
        headers: { "content-type": "text/plain" },
      })
    }

    return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain" } })
  },

  /**
   * Queue consumer. Cloudflare invokes this for each JobMessage we
   * `.send()` from the fetch handlers. Each invocation gets up to 15
   * minutes of wall-clock time — enough for any Ollama call.
   *
   * One message per invocation (`max_batch_size = 1` in wrangler.toml).
   * On success we ack; on failure we retry (Cloudflare backs off
   * automatically up to `max_retries = 3`). After max_retries the
   * message is dropped — we log a final-attempt error explicitly so
   * the failure is visible in Workers Logs as `dropped` instead of
   * blending into the regular retry chatter.
   */
  async queue(batch: MessageBatch<JobMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    const MAX_RETRIES = 3
    // SIG-455: per-tenant fairness mode. "off" disables admission entirely;
    // "shadow" measures the desired decision but always proceeds; "enforce"
    // actually defers denied jobs. Default off (the binding/flags ship dark).
    const { mode } = resolveFairnessConfig(env)
    const quotaMode = resolveQuotaMode(env)
    for (const message of batch.messages) {
      const job = message.body
      // SIG-455 Task 6 (PR B): provider-cooldown read-before-fire. For eligible
      // pr-review runs, check the provider backpressure cooldown BEFORE the fairness
      // gate so a cooling-down provider short-circuits cheaply (no lease acquired).
      // shadow/off → skip entirely. Fail-open: remaining=0 on any fault → fall through.
      if (job.type === "pr-review" && typeof job.installationId === "number" && typeof job.runId === "string") {
        const cooldownMode = resolveCooldownMode(env)
        if (cooldownMode === "enforce") {
          let remaining = 0
          try {
            remaining = await getProviderCooldownRemainingMs(env) // fail-open → 0
          } catch {
            // fail-open: treat as no cooldown
          }
          if (remaining > 0) {
            // Anti-permanent-block: once a job has been deferred MAX_DEFERS times, let it run.
            const bypass = typeof job.deferCount === "number" && job.deferCount >= MAX_DEFERS
            if (!bypass) {
              const backoffMs = remaining + decorrelatedJitterMs(JITTER_BASE_MS, JITTER_CAP_MS, Math.random())
              try {
                const id = env.PR_REVIEW_RUN.idFromName(`${job.owner}/${job.repo}#${job.prNumber}`)
                const deferRes = await env.PR_REVIEW_RUN.get(id).fetch("https://do.internal/defer", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ runId: job.runId, backoffMs }),
                })
                if (deferRes.ok) {
                  console.log(
                    JSON.stringify({
                      event: "provider-cooldown-honored",
                      surface: "queue",
                      remainingMs: remaining,
                      backoffMs,
                    }),
                  )
                  message.ack()
                  continue
                }
                // non-2xx → FAIL-OPEN: fall through, run now
              } catch {
                // defer threw → FAIL-OPEN: fall through
              }
            }
          }
        }
      }
      // Fairness only applies to DO-routed pr-review runs: a string runId is
      // required (slash reruns omit it and bypass fairness — don't even
      // acquire) and installationId is the tenant key.
      const fairnessEligible =
        mode !== "off" &&
        job.type === "pr-review" &&
        typeof job.installationId === "number" &&
        typeof job.runId === "string"
      let lease: { tenantId: string; leaseId: string } | undefined
      if (fairnessEligible && job.type === "pr-review" && job.runId !== undefined) {
        // Anti-starvation: once a job has been deferred MAX_DEFERS times, skip
        // admission entirely and let it run.
        const bypass = typeof job.deferCount === "number" && job.deferCount >= MAX_DEFERS
        if (!bypass) {
          const tenantId = String(job.installationId)
          const leaseId = crypto.randomUUID()
          const res = await admitTenant({
            env,
            tenantId,
            leaseId,
            cap: await resolveTenantCap(env, job.installationId),
          })
          console.log(
            JSON.stringify({
              event: "fairness-decision",
              tenantId,
              leaseId,
              desired: res.granted ? "GRANT" : "DENY",
              mode,
            }),
          )
          if (!res.granted && mode === "enforce") {
            // Re-arm the per-PR DO + schedule a fresh re-send. NEVER
            // message.retry() — that burns the Cloudflare retry budget so the
            // review is dropped. runId is guaranteed by fairnessEligible.
            try {
              const id = env.PR_REVIEW_RUN.idFromName(`${job.owner}/${job.repo}#${job.prNumber}`)
              const deferRes = await env.PR_REVIEW_RUN.get(id).fetch("https://do.internal/defer", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ runId: job.runId, backoffMs: res.retryAfterMs }),
              })
              if (deferRes.ok) {
                message.ack()
                continue
              }
              // /defer non-2xx → FAIL-OPEN: fall through and run the review.
            } catch {
              // /defer threw → FAIL-OPEN: fall through and run the review.
            }
          }
          if (res.granted) lease = { tenantId, leaseId }
        }
      }
      // SIG-543: shadow quota measurement. Independent of fairness (own gate, no
      // runId requirement). Awaited directly per the queue-consumer rule: a Queue
      // consumer's ctx.waitUntil does NOT reliably extend the isolate lifetime
      // (see reference_cloudflare_queue_consumer_waituntil) — use await instead.
      // checkShadowQuota is fail-open (never throws) and does fast indexed D1
      // reads; awaiting it adds negligible latency to a background job.
      // Phase 1 never refuses — checkShadowQuota only logs.
      if (job.type === "pr-review" && typeof job.installationId === "number" && quotaMode !== "off") {
        await checkShadowQuota(env, job.installationId)
      }
      try {
        await dispatchJob(job, env, (promise) => ctx.waitUntil(promise))
        message.ack()
      } catch (error) {
        const isFinalAttempt = message.attempts > MAX_RETRIES
        console.error(isFinalAttempt ? "queue job dropped (max retries)" : "queue job failed (will retry)", {
          type: job.type,
          attempts: message.attempts,
          maxRetries: MAX_RETRIES,
          error: String(error),
        })
        if (isFinalAttempt) {
          message.ack()
        } else {
          message.retry()
        }
      } finally {
        if (lease) await releaseTenant(env, lease.tenantId, lease.leaseId)
      }
    }
  },

  /**
   * SIG-156 PR3: Cloudflare Workers Cron — index reconciliation tick.
   * Schedule lives in wrangler.toml `[triggers].crons`. Each tick walks
   * every installation + every repo and enqueues an index-repo job for
   * any repo whose manifest is missing from KV. Self-heals dropped
   * install / repos-added webhooks. Idempotent (consumer freshness-skips
   * if the manifest landed between the cron's read and pickup).
   *
   * Failures are swallowed — a transient GitHub/API error must not poison
   * the cron; the next tick retries.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // SIG-287/SIG-114 recall alarm — runs EVERY tick, independent of the
    // indexer gate. Read-only + log-only: scans recent review telemetry for a
    // silently-degraded reviewer (logic missing / synth shutout) and emits a
    // loud `review-recall-alarm`. This is the smoke detector whose absence let
    // the bare-approve regression run 12 PRs unnoticed; it can never affect a
    // review (no writes, no posting).
    ctx.waitUntil(
      runRecallAlarmCheck(env).catch((err) => {
        console.error(
          JSON.stringify({
            event: "review-recall-check-error",
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }),
    )
    // Memory Gardener — activity-aware decay tick (Phase-1 dynamic-memory moat).
    // Independent of the indexer gate below: it runs EVERY tick and self-gates
    // on OPENCLAW_MEMORY_DECAY_MODE (unset → "off" → returns instantly with zero
    // side effects, so prod is unaffected until an operator opts in). Own
    // try/catch + own error-event name so a decay failure can never poison the
    // reconciliation tick, and vice-versa.
    ctx.waitUntil(
      (async () => {
        try {
          await runMemoryDecayPass(env)
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "memory-decay-tick-error",
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      })(),
    )
    // CodeRabbit C1: gate the auto-fire on OPENCLAW_INDEXER_ENABLED. The
    // manual routes (index-repo / index-backfill / index-reconcile) stay
    // ungated — those are operator-triggered and the operator already
    // knows what flag state they're in. The cron is the only auto-trigger;
    // a flag flip-off should immediately halt automatic fan-out.
    if (!isIndexerEnabled(env)) {
      console.log(JSON.stringify({ event: "index-reconcile-tick-skip-disabled" }))
      return
    }
    ctx.waitUntil(
      (async () => {
        try {
          await runIndexReconciliation(env, { dryRun: false })
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "index-reconcile-tick-error",
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      })(),
    )
  },
}

/**
 * SIG-287/SIG-114 recall alarm. Scans recent `ensemble-review-telemetry`
 * (newest-first, deduped to one entry per PR) and emits a loud
 * `review-recall-alarm` when the reviewer looks silently degraded — `logic`
 * missing or a synth-finding shutout across consecutive PRs. Read-only +
 * log-only; never touches a review. Best-effort: a single unreadable record
 * is skipped, and the whole check is wrapped in `.catch` at the call site.
 */
async function runRecallAlarmCheck(env: Env): Promise<void> {
  const SCAN_LIMIT = 80
  const WINDOW = 15
  const listed = await env.OPENCLAW_STATE.list({
    prefix: "ensemble-review-telemetry:",
    limit: SCAN_LIMIT,
  })
  // Reverse-timestamped keys sort newest-first lexicographically.
  const outcomes: RecallReviewOutcome[] = []
  const seenPrs = new Set<number>()
  for (const key of listed.keys) {
    if (outcomes.length >= WINDOW) break
    const rec = await env.OPENCLAW_STATE.get<RawReviewTelemetry>(key.name, "json").catch(() => null)
    if (!rec) continue
    const outcome = recallOutcomeFromTelemetry(rec)
    if (!outcome) continue
    if (seenPrs.has(outcome.prNumber)) continue // dedup re-reviews → one entry per PR
    seenPrs.add(outcome.prNumber)
    outcomes.push(outcome)
  }
  const result = detectRecallAlarm(outcomes)
  for (const alarm of result.alarms) {
    console.error(
      JSON.stringify({
        event: "review-recall-alarm",
        kind: alarm.kind,
        streak: alarm.streak,
        threshold: alarm.threshold,
        prNumbers: alarm.prNumbers,
        sampleSize: outcomes.length,
      }),
    )
  }
  console.log(
    JSON.stringify({
      event: "review-recall-check",
      logicDegradedStreak: result.logicDegradedStreak,
      synthZeroFindingStreak: result.synthZeroFindingStreak,
      sampleSize: outcomes.length,
      alarmCount: result.alarms.length,
    }),
  )
}

// ARC-190: Durable Object class export. Cloudflare's worker runtime
// requires DO classes to be exported by the entry module so the
// `[[durable_objects.bindings]]` block in wrangler.toml can find them.
export { PrReviewRunDO } from "./do/pr-review-run"

// SIG-138: RepoGraphDO — per-repo code/dependency graph (SQLite).
// Flag-gated behind OPENCLAW_GRAPH_INDEX / OPENCLAW_GRAPH_RETRIEVAL.
// The class must be exported from the entry module for the
// [[durable_objects.bindings]] REPO_GRAPH_DO entry in wrangler.toml
// to resolve at deploy time.
export { RepoGraphDO } from "./do/repo-graph"

// SIG-119: ValidationMetricsDO — rolling validator shadow telemetry (SQLite).
// Registered via the [[durable_objects.bindings]] VALIDATION_METRICS_DO entry
// + the sig-119-v1 new_sqlite_classes migration in wrangler.toml.
export { ValidationMetricsDO } from "./do/validation-metrics"

// SIG-184 PR 5b: RunnerEvidenceMetricsDO — rolling runner-evidence presence
// telemetry (SQLite). Registered via the [[durable_objects.bindings]]
// RUNNER_EVIDENCE_METRICS_DO entry + the sig-184-metrics-v1 new_sqlite_classes
// migration in wrangler.toml.
export { RunnerEvidenceMetricsDO } from "./do/runner-evidence-metrics"

// SIG-107: RunnerToolMetricsDO — rolling accepted scan-manifest telemetry
// (SQLite). Registered via the [[durable_objects.bindings]]
// RUNNER_TOOL_METRICS_DO entry + the sig-107-tool-metrics-v1 migration.
export { RunnerToolMetricsDO } from "./do/runner-tool-metrics"

// SIG-285 PR 2: VerificationMetricsDO — rolling verification verdict telemetry
// (SQLite). Registered via the [[durable_objects.bindings]]
// VERIFICATION_METRICS_DO entry + the sig-285-metrics-v1 new_sqlite_classes
// migration in wrangler.toml.
export { VerificationMetricsDO } from "./do/verification-metrics"

// SIG-152: GraphMetricsDO — rolling SIG-138 graph-retrieval shadow telemetry
// (SQLite). Registered via the [[durable_objects.bindings]] GRAPH_METRICS_DO
// entry + the sig-152-v1 new_sqlite_classes migration in wrangler.toml.
export { GraphMetricsDO } from "./do/graph-metrics"

// SIG-286 PR2.5: GraphExpansionMetricsDO — rolling graph-context-expansion
// shadow telemetry (SQLite). Registered via the [[durable_objects.bindings]]
// GRAPH_EXPANSION_METRICS_DO entry + the sig-286-metrics-v1 new_sqlite_classes
// migration in wrangler.toml.
export { GraphExpansionMetricsDO } from "./do/graph-expansion-metrics"

// SIG-184: RunnerReceiptDO — atomic single-use guard + defensible runner-evidence
// receipt (SQLite). Registered via the [[durable_objects.bindings]]
// RUNNER_RECEIPT_DO entry + the sig-184-v1 new_sqlite_classes migration.
export { RunnerReceiptDO } from "./do/runner-receipt"

// SIG-455: TenantConcurrencyDO — per-tenant concurrency gate (KV-backed DO
// storage). Registered via the [[durable_objects.bindings]] TENANT_CONCURRENCY
// entry + the sig-455-tenant-concurrency-v1 new_classes migration.
export { TenantConcurrencyDO } from "@/src/do/tenant-concurrency"

// SIG-455 PR B: ProviderCooldownDO — per-provider backpressure cooldown (SQLite
// DO storage). Registered via the [[durable_objects.bindings]] PROVIDER_COOLDOWN
// entry + the sig-455-provider-cooldown-v1 new_sqlite_classes migration.
export { ProviderCooldownDO } from "@/src/do/provider-cooldown"

// SIG-545 B1: AgentRunnerContainer — Cloudflare Container (dark; gated by
// OPENCLAW_AGENT_RUNNER_MODE). Registered via [[containers]] (class_name
// AgentRunnerContainer) + [[durable_objects.bindings]] (AGENT_RUNNER) +
// the sig-545-agent-runner-v1 new_sqlite_classes migration in wrangler.toml.
export { AgentRunnerContainer } from "@/src/do/agent-runner-container"

// SIG-144 (Linear unification slice 1): LinearTokenBroker — owns the Linear agent
// token lifecycle + serializes refresh across isolates. Registered via the
// [[durable_objects.bindings]] LINEAR_TOKEN_BROKER entry + the
// sig-144-linear-token-broker-v1 new_sqlite_classes migration in wrangler.toml.
// INERT — no caller in this slice.
export { LinearTokenBroker } from "@/src/do/linear-token-broker"

// SIG-298: DeepResearchDO — deep web research engine (one instance per run).
export { DeepResearchDO } from "@/src/do/deep-research/deep-research-do"
// sig-mcp-connections-p1: McpConnectionsAgent — one instance per seat/tenant.
export { McpConnectionsAgent } from "@/src/do/mcp/mcp-connections-do"
