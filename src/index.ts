// Arc Worker — Linear webhooks → triage; GitHub webhooks → PR review.
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
} from "@/lib/recall-alarm"
import { handleValidationMetricsRoute } from "@/lib/metrics-validation-route"
import { handleTestSuppressionsMetricsRoute } from "@/lib/metrics-test-suppressions-route"
import { handleRunnerEvidenceMetricsRoute } from "@/lib/metrics-runner-evidence-route"
import { handleVerificationMetricsRoute } from "@/lib/metrics-verification-route"
import { handleDismissalMetricsRoute } from "@/lib/metrics-dismissals-route"
import { handlePrecisionMetricsRoute } from "@/lib/metrics-precision-route"
import { handleRepeatFpsMetricsRoute } from "@/lib/metrics-repeat-fps-route"
import { handleGraphMetricsRoute } from "@/lib/metrics-graph-route"
import { handleGraphExpansionMetricsRoute } from "@/lib/metrics-graph-expansion-route"
import { handleGraphExpansionAbMetricsRoute } from "@/lib/metrics-graph-expansion-ab-route"
import { handleFpRateMetricsRoute } from "@/lib/metrics-fp-rate-route"
import { handleRunnerIngestRoute } from "@/lib/runner-ingest-route"
import {
  handleAdminIndexRoute,
  handleAdminBackfillRoute,
  handleAdminReconcileRoute,
  handleAdminMigrateToRepoIdRoute,
  handleAdminMigrateReviewMemoryToRepoIdRoute,
} from "@/lib/admin-index-route"
import { runIndexReconciliation } from "@/lib/index-reconciliation"
import { handleReviewStatusRoute } from "@/do/status-route"
import {
  handleGitHubAuthCallback,
  handleGitHubAuthKickoff,
  handleLogout,
} from "@/lib/auth-oauth-github"
import { requireSession } from "@/lib/auth-middleware"
import { renderWelcomePage } from "@/lib/auth-welcome"
import { readCookie, SESSION_COOKIE_NAME } from "@/lib/auth-session"
import { handleBadgeAssetRoute } from "@/lib/badge-assets"
import { parseValidateMode, validateEnv } from "@/lib/env-validate"
import { isIndexerEnabled } from "@/lib/index-producer"
import type { Env } from "@/shared/types/env"
import type { JobMessage } from "@/shared/types/job"

// SIG-318 / SIG-376 (Tier-1 8/8): entry-module decomposition. The webhook
// handlers + the queue dispatcher + the shared mention/capture layer were
// relocated VERBATIM into sibling leaves; this entry module keeps only the
// default export (fetch/queue/scheduled), the recall-alarm scan it calls,
// the module-level validation cache (mutable state must keep its identity
// here), and the Durable Object class re-exports (wrangler resolves DO
// class names against the entry module). Every previously-public symbol is
// re-exported below so no importer or test path changes.
import { handleGitHubWebhook } from "@/index-github-webhook"
import { handleLinearWebhook, handleManualTrigger } from "@/index-webhooks"
import { dispatchJob } from "@/index-dispatch"

// Re-export the relocated public symbols so the entry module's export
// surface is byte-for-byte unchanged for every importer + test pin.
export { dispatchJob } from "@/index-dispatch"
export { prMetaIsClosedOrMerged } from "@/index-dispatch"
export {
  decidePullRequestJobs,
  queueGithubMention,
  dispatchTopLevelReviewMemoryCapture,
  dispatchDismissedReviewMemoryCapture,
} from "@/index-internals"

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
      validatedKey = key  // SET BEFORE call — prevents retry loop on throw
      validationError = null
      try {
        validateEnv(env, parseValidateMode(env.OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS))
      } catch (e) {
        validationError = e as Error
      }
    }
    if (
      validationError &&
      parseValidateMode(env.OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS) === "strict"
    ) {
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

    // SIG-184 PR 5b: authenticated read of rolling runner-evidence presence
    // telemetry (adoption + the verified/pending/absent breakdown).
    if (request.method === "GET" && url.pathname === "/metrics/runner-evidence") {
      return handleRunnerEvidenceMetricsRoute(request, env)
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
      return handleRunnerIngestRoute(request, env)
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
    if (
      request.method === "POST" &&
      url.pathname === "/admin/migrate-review-memory-to-repo-id"
    ) {
      return handleAdminMigrateReviewMemoryToRepoIdRoute(request, env)
    }

    if (request.method === "POST" && url.pathname === "/linear/webhook") {
      return handleLinearWebhook(request, env, ctx)
    }

    if (request.method === "POST" && url.pathname === "/linear/manual") {
      return handleManualTrigger(request, env, ctx)
    }

    if (request.method === "POST" && url.pathname === "/github/webhook") {
      return handleGitHubWebhook(request, env, ctx)
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
      const authed = await requireSession(request, env, ctx)
      if (!authed) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(
        JSON.stringify({
          login: authed.record.login,
          githubUserId: authed.record.githubUserId,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const sessionId = readCookie(request, SESSION_COOKIE_NAME)
      return handleLogout(request, env, sessionId)
    }
    // ARC-190: GET /reviews/<owner>/<repo>/<prNumber> — public status
    // route for DO-tracked PR review runs. v1 unauth (read-only
    // metadata only). The route handler validates segments + decodes
    // before fetching the DO.
    if (request.method === "GET" && url.pathname.startsWith("/reviews/")) {
      const segments = url.pathname.slice("/reviews/".length).split("/")
      if (segments.length !== 3) {
        return new Response(
          JSON.stringify({ error: "expected /reviews/<owner>/<repo>/<prNumber>" }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
      }
      let owner: string, repo: string, prNumberRaw: string
      try {
        owner = decodeURIComponent(segments[0]!)
        repo = decodeURIComponent(segments[1]!)
        prNumberRaw = decodeURIComponent(segments[2]!)
      } catch {
        return new Response(
          JSON.stringify({ error: "malformed percent-encoding in path" }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
      }
      // CR PR #70: strict-positive-integer check. `Number.parseInt`
      // accepts trailing garbage (`"12foo"` → 12), the unary `+`
      // operator returns 0 on `""`, and `Number.isInteger(NaN)` is
      // false but several string forms (e.g. `" 12 "`) would still
      // parse. Anchor on `^\d+$` and reject anything else with 400.
      if (!/^\d+$/.test(prNumberRaw)) {
        return new Response(
          JSON.stringify({ error: "prNumber must be a positive integer" }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
      }
      const prNumber = Number.parseInt(prNumberRaw, 10)
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return new Response(
          JSON.stringify({ error: "prNumber must be a positive integer" }),
          { status: 400, headers: { "content-type": "application/json" } },
        )
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
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    const MAX_RETRIES = 3
    for (const message of batch.messages) {
      try {
        await dispatchJob(message.body, env)
        message.ack()
      } catch (error) {
        const isFinalAttempt = message.attempts > MAX_RETRIES
        console.error(isFinalAttempt ? "queue job dropped (max retries)" : "queue job failed (will retry)", {
          type: message.body.type,
          attempts: message.attempts,
          maxRetries: MAX_RETRIES,
          error: String(error),
        })
        if (isFinalAttempt) {
          message.ack()
        } else {
          message.retry()
        }
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
        console.error(JSON.stringify({
          event: "review-recall-check-error",
          error: err instanceof Error ? err.message : String(err),
        }))
      }),
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
          console.error(JSON.stringify({
            event: "index-reconcile-tick-error",
            error: err instanceof Error ? err.message : String(err),
          }))
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
    console.error(JSON.stringify({
      event: "review-recall-alarm",
      kind: alarm.kind,
      streak: alarm.streak,
      threshold: alarm.threshold,
      prNumbers: alarm.prNumbers,
      sampleSize: outcomes.length,
    }))
  }
  console.log(JSON.stringify({
    event: "review-recall-check",
    logicDegradedStreak: result.logicDegradedStreak,
    synthZeroFindingStreak: result.synthZeroFindingStreak,
    sampleSize: outcomes.length,
    alarmCount: result.alarms.length,
  }))
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
