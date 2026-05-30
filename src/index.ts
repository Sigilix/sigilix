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

import { triageIssue } from "./lib/triage"
import {
  detectRecallAlarm,
  recallOutcomeFromTelemetry,
  type RecallReviewOutcome,
  type RawReviewTelemetry,
} from "./lib/recall-alarm"
import { handleMention } from "./lib/mention-reply"
import {
  bodyMentionsBot,
  getMentionTriggers,
  isArcGithubLogin,
  isBotHandle,
  stripQuotesAndCode,
} from "./lib/mention"
import {
  parseSlashCommand,
  renderSlashCommandAck,
  isAuthorAllowedForSlashCommand,
  type SlashCommand,
} from "./lib/slash-commands"
import { shouldQueueReviewThreadReply } from "./lib/review-thread-reply"
import { getInstallationToken } from "./lib/github-app"
import { GitHubClient } from "./lib/github"
import { verifyLinearWebhook } from "./lib/webhook-verify"
import { LinearClient, buildLinearAuth } from "./lib/linear"
import { commentHasSigilixAncestor } from "./lib/linear-thread-ancestor"
import { isBotAuthoredComment } from "./lib/bot-authored-comments"
import { verifyGitHubWebhook } from "./lib/github-webhook-verify"
import { handlePrOverview } from "./lib/triage-pr-overview"
import { handlePrLabels } from "./lib/triage-pr-labels"
import { handleCiTriage } from "./lib/triage-ci"
import { handlePrImprove } from "./lib/triage-pr-improve"
import { handlePrDescribe } from "./lib/triage-pr-describe"
import {
  handlePrPause,
  handlePrResume,
  handlePrIgnore,
  handlePrResolveThreads,
} from "./lib/pr-lifecycle-commands"
import { handlePrStaleMark } from "./lib/triage-pr-stale-mark"
import { readReviewManifest, type ReviewManifestV1 } from "./lib/review-manifest"
import { PROMPT_VERSION } from "./prompts/pr-review"
import { handlePrReviewEnsemble } from "./lib/triage-pr-review-ensemble"
import { handleValidationMetricsRoute } from "./lib/metrics-validation-route"
import { handleRunnerEvidenceMetricsRoute } from "./lib/metrics-runner-evidence-route"
import { handleDismissalMetricsRoute } from "./lib/metrics-dismissals-route"
import { recordValidationMetrics } from "./lib/validation-metrics-client"
import type { ValidationRejectionEvent } from "./do/validation-metrics"
import { handleGraphMetricsRoute } from "./lib/metrics-graph-route"
import { handleFpRateMetricsRoute } from "./lib/metrics-fp-rate-route"
import { handleRunnerIngestRoute } from "./lib/runner-ingest-route"
import { recordGraphMetrics } from "./lib/graph-metrics-client"
import type { GraphRetrievalSample } from "./do/graph-metrics"
import {
  handleAdminIndexRoute,
  handleAdminBackfillRoute,
  handleAdminReconcileRoute,
  handleAdminMigrateToRepoIdRoute,
  handleAdminMigrateReviewMemoryToRepoIdRoute,
} from "./lib/admin-index-route"
import { runIndexReconciliation } from "./lib/index-reconciliation"
import { isRepoSensitive } from "./lib/repo-policy"
import { handleGithubMention, type GhMentionSurface } from "./lib/github-mention"
import { captureReviewFeedback } from "./lib/review-memory/capture"
import { isPrOverviewEnabled, loadSigilixConfig, resolveReviewMemoryConfig } from "./lib/sigilix-config"
import {
  postDraftPrSkipNotice,
  supersedeDraftPrSkipNotice,
} from "./lib/pr-draft-skip-notice"
import { handleReviewStatusRoute } from "./do/status-route"
import { runPrReviewWithDoCallback } from "./do/consumer-wrapper"
import { enqueuePrReviewJob } from "./do/webhook-enqueue"
import {
  computeDiffHash,
  readPriorReviewDiffHash,
} from "./lib/noop-merge-detect"
import { postSlashCommandEyesAck } from "./lib/slash-command-eyes-ack"
import { parseValidateMode, validateEnv } from "./lib/env-validate"
import {
  enqueueIndexJobsForRepos,
  isIndexerEnabled,
  maybeEnqueuePullRequestBranchIndexJobs,
  maybeEnqueuePushIndexJob,
  type IndexJobReason,
} from "./lib/index-producer"
import { handleIndexRepoJob } from "./lib/indexer"
import {
  attachExistingCheckRun,
  startInProgressCheckRun,
  completeCheckRun,
  type SigilixCheckConclusion,
} from "./lib/pr-review-check-run"
import { postPrOverviewStubIfNeeded } from "./lib/pr-overview-stub"
import {
  deleteRepoIndex,
  handleInstallReposRemoved,
  handleInstallationDeleted,
} from "./lib/index-delete"
import { branchStateRepo } from "./lib/index-branch"
import {
  handleGitHubAuthCallback,
  handleGitHubAuthKickoff,
  handleLogout,
} from "./lib/auth-oauth-github"
import { requireSession } from "./lib/auth-middleware"
import { renderWelcomePage } from "./lib/auth-welcome"
import { readCookie, SESSION_COOKIE_NAME } from "./lib/auth-session"
import { handleBadgeAssetRoute } from "./lib/badge-assets"

export interface Env {
  OPENCLAW_STATE: KVNamespace
  // Vectorize index storing 768-dim embeddings of code chunks per repo.
  OPENCLAW_CODE_INDEX: VectorizeIndex
  // Workers AI binding for embedding queries at retrieval time.
  AI: Ai
  // Cloudflare Queue producer binding. Webhook handlers enqueue
  // JobMessages here; the queue() handler below consumes them. The
  // Queue exists separately on Cloudflare and was created via
  // `wrangler queues create openclaw-jobs` before first deploy.
  OPENCLAW_JOBS: Queue<JobMessage>
  LINEAR_API_KEY: string
  LINEAR_WEBHOOK_SECRET: string
  OLLAMA_API_KEY: string
  LINEAR_OAUTH_CLIENT_ID?: string
  LINEAR_OAUTH_CLIENT_SECRET?: string
  GITHUB_APP_ID?: string
  GITHUB_PRIVATE_KEY?: string
  GITHUB_WEBHOOK_SECRET?: string

  // Phase 5 user-OAuth (ARC-163). Same GitHub App as GITHUB_APP_ID — its
  // OAuth credentials live on the App settings page next to the JWT
  // private key. Only used to authenticate human users into the Sigilix
  // dashboard at app.sigilix.ai; repo access still goes through the
  // server-to-server JWT path in github-app.ts.
  GITHUB_OAUTH_CLIENT_ID?: string
  GITHUB_OAUTH_CLIENT_SECRET?: string
  // 32 random bytes, base64url-encoded. Used to AES-GCM-encrypt user
  // access tokens at rest in OPENCLAW_STATE. Rotating this invalidates
  // every active session.
  OPENCLAW_SESSION_ENCRYPTION_KEY?: string
  // Public origin for OAuth callbacks (must match the GitHub App's
  // configured callback URL). Defaults to https://app.sigilix.ai.
  OPENCLAW_BASE_URL?: string
  // SIG-132: VALUES are `<owner>/<repo>` lowercased (the Vectorize
  // namespace), e.g. {"ARC":"arc-and-anchor/rubberfit"}.
  OPENCLAW_TEAM_REPO_MAP?: string
  OPENCLAW_MODEL?: string
  OPENCLAW_TEAM_KEY?: string
  OPENCLAW_MENTION_TRIGGERS?: string
  // Phase 1 — Linear PR-aware @-mentions.
  // OPENCLAW_TEAM_GITHUB_REPO_MAP carries owner+repo identity per team
  // (separate from OPENCLAW_TEAM_REPO_MAP which is namespace-only).
  // Schema: {"ARC":{"owner":"Arc-and-Anchor","repo":"rema-portal"}}
  OPENCLAW_TEAM_GITHUB_REPO_MAP?: string
  // Schema: {"<owner>/<repo>":"<id>","<owner>":"<id>"}
  // Lookup order: exact owner/repo, then owner-only fallback.
  OPENCLAW_GITHUB_INSTALLATION_MAP?: string
  // ARC-239 (2026-05-16): the `OPENCLAW_INDEXED_REPOS` env-var
  // allowlist was deleted. The agent loop's `retrieve_codebase` tool
  // now derives the indexed-repo universe from `repo-index-manifest:*`
  // KV records — ARC-235's bootstrap writer + ARC-238's uninstall
  // cleanup make that the live source of truth. Same anti-pattern as
  // ARC-232's allowlist removal.
  // "strict" → return 500 when team/installation maps are inconsistent.
  // Anything else (including unset, "warn", "STRICT", typos) → warn only.
  OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS?: string
  // Phase 3 — agent loop (tool-using) per-surface flags + provider
  // kill-switch. All "on"|"off" strings (case-sensitive); unset or
  // anything other than "on" defaults to off.
  //
  // ARC-280: `OPENCLAW_AGENTIC_GITHUB_MODE` only gates the @-mention
  // reply agent loop now (`github-mention.ts`). The Phase 3 PR
  // reviewer that used to read this flag was deleted. Kept on the
  // Env type so the mention path still type-checks.
  OPENCLAW_AGENTIC_LINEAR_MODE?: string
  OPENCLAW_AGENTIC_GITHUB_MODE?: string
  // Provider kill-switch for the /api/chat path. Independent of the
  // per-surface agentic flags — flipping this off disables the chat
  // endpoint without redeploying. Both runAgentLoop AND ad-hoc chat()
  // callers honor it.
  OLLAMA_CHAT_ENABLE?: string

  // ARC-280: `OPENCLAW_ENSEMBLE_REVIEW_MODE` deleted. The ensemble is
  // the only review pipeline now; the shadow / post / off
  // discriminator served the dual-path era and has no remaining
  // routing role.
  // ARC-183: comma-separated owner/repo DENYlist. When a repo is
  // listed here, Sigilix never fetches its diff or sends content to
  // any LLM. Use for compliance / customer-data / secrets-heavy
  // repos. Empty/unset = no sensitive repos. Match is
  // case-insensitive on `owner/repo`.
  OPENCLAW_SENSITIVE_REPOS?: string
  // Per-PR cap on total model invocations (counts retries). Default 8
  // (4 specialists + 1 synth + 3 headroom).
  OPENCLAW_ENSEMBLE_MAX_MODEL_CALLS_PER_PR?: string
  // Per-PR cap on retrieve_codebase calls (covers pre-flight + every
  // specialist follow-up + synth conflict-verification). Default 3.
  OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR?: string
  // Daily ensemble call budget (best-effort via KV; 1-2 call overshoot
  // under concurrent webhooks accepted). Default 200.
  OPENCLAW_ENSEMBLE_DAILY_BUDGET?: string
  // Emergency-only: re-enables specialist-verdict fallback when synth
  // fails in `post` mode. Default off — synth failure falls back to
  // Phase 3, not raw specialist output.
  OPENCLAW_ENSEMBLE_ALLOW_SPECIALIST_FALLBACK?: string
  // Phase 4 router (Option C consolidation): when "on", router decides
  // which specialists fire based on static signals from the diff
  // (lockfile→security, auth-path→security, docs-only→none, etc.).
  // Default "off" = always-fire all four specialists, which is the
  // baseline-data-collection mode reviewers wanted for Phase 4a.
  // Phase 4b activation = flag-flip, no code change.
  OPENCLAW_ENSEMBLE_ROUTER_ENABLED?: string

  // SIG-226 (SIG-224 Phase 1) — dynamic specialist dispatcher mode.
  //   - "off"           (default): dispatcher disabled, no telemetry,
  //                      no LLM call.
  //   - "shadow":        dispatcher runs rules + LLM + emits telemetry,
  //                      but the orchestrator still uses the legacy
  //                      `decideSpecialists` result for fan-out. Used
  //                      to collect false-negative ground truth on
  //                      protected roles (security + logic) before
  //                      Phase 2b / 3 graduates to LLM enforcement.
  //   - "enforce_rules": SIG-227a. Dispatcher runs the RULE LAYER only
  //                      (no LLM call, ~0ms overhead) and its picks
  //                      REPLACE `router.specialists` for fan-out.
  //                      Activates the new safe-skip rules
  //                      (lockfile-only, .d.ts-only, test-files-only)
  //                      that the legacy router doesn't have. Strict
  //                      superset of the legacy router's safe-skip
  //                      coverage; fan-out only shrinks or stays equal.
  //   - "enforce" (Phase 2b/3+): full LLM enforcement. Logged but not
  //                      honored in Phase 1 / 227a.
  // See `docs/specs/2026-05-26-sig-224-dispatcher-architecture.md`.
  OPENCLAW_DYNAMIC_DISPATCHER_MODE?: string

  // When "on", PRs from a dev-style branch (dev/develop/staging/...)
  // into a release-style branch (main/master/release/...) skip the
  // pr-review job. The diff was already reviewed when the feature
  // branches went into dev; re-running on the dev→main promotion is
  // duplicate noise + duplicate API spend. pr-overview still fires
  // so the release PR still gets a summary blurb.
  OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES?: string

  // ARC-184 kill-switch for the review-provenance + stale-marker
  // pipeline. When set to "off", manifest writes and stale-mark
  // enqueues short-circuit. Default (unset / any other value) = on.
  // Single-flag rollback if a bug surfaces post-deploy.
  OPENCLAW_REVIEW_MANIFEST_ENABLED?: string

  // SIG-89 kill-switch for the no-op-merge skip on `synchronize`.
  // When set to "off", the webhook skips the diff-hash compare and
  // always dispatches the ensemble (the prior behavior). Default
  // (unset / any other value) = on. Lets us disable without redeploy
  // if the diff-fetch latency tax or a false-skip regression
  // surfaces. The KV writes at submit time continue regardless; the
  // skip-on-read is the only thing the kill-switch gates.
  OPENCLAW_NOOP_MERGE_SKIP_ENABLED?: string

  // ARC-189 cross-PR review-memory feature gates (default OFF for
  // both — opposite polarity from every other scanner). Retrieval
  // requires both the env flag AND `sigilix.json`
  // `reviewMemory.enabled === true`. Capture requires the env flag
  // AND (`enabled === true` OR `captureOnly === true`). See spec
  // §5.2 truth table.
  OPENCLAW_REVIEW_MEMORY_ENABLED?: string
  OPENCLAW_REVIEW_MEMORY_CAPTURE?: string
  // SIG-276 Phase 2: gates the write-time claim extractor (an extra
  // per-PR classifier round-trip). Default off; `"on"` opts in. When
  // off, findings emit markers with no `:claims:` segment (unchanged
  // pre-Phase-2 behavior) and no model call is made.
  OPENCLAW_REVIEW_MEMORY_CLAIMS?: string
  // SIG-276 Phase 3: gates the SHADOW-ONLY claim-match telemetry pass.
  // Default off; `"on"` opts in. A no-op unless OPENCLAW_REVIEW_MEMORY_ENABLED
  // AND OPENCLAW_REVIEW_MEMORY_CLAIMS are also on. NEVER changes softening —
  // it only attaches telemetry `shadowClaims` in lookup and emits the
  // `review-memory-claim-shadow` corpus the Phase-4 calibration consumes.
  OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW?: string

  // ARC-189 one-shot deploy aid for the PROMPT_VERSION="1" → "2"
  // bump (Task 10b). When `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE`
  // is "on", `triage-pr-stale-mark` filters the `"prompt-version"`
  // reason out of the StaleResult.reasons[] array — it does NOT skip
  // stale-marking entirely. Other drift reasons (head/base/file-list)
  // continue to fire. The companion `_SET_AT` env (UNIX seconds at
  // suppression-flag set time) drives the 24h heartbeat /
  // 72h-fail-safe ladder per spec §4.8.
  OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE?: string
  OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT?: string

  // ARC-190 + SIG-174: DO-orchestrated PR-review run state is now the
  // only automatic webhook path. resolveDoConfig (src/do/config.ts)
  // handles numeric retry/watchdog/history clamping.
  PR_REVIEW_RUN: DurableObjectNamespace

  // SIG-138: per-repo code/dependency graph stored in SQLite DO storage.
  // One DO instance per repo, keyed by indexNamespace(owner, repo).
  // Flag-gated: OPENCLAW_GRAPH_INDEX (write path) and
  // OPENCLAW_GRAPH_RETRIEVAL (read/expansion path). Both default off.
  REPO_GRAPH_DO: DurableObjectNamespace
  OPENCLAW_GRAPH_INDEX?: string
  OPENCLAW_GRAPH_RETRIEVAL?: string

  // SIG-161: confidence-threshold verdict gate. Three-state rollout
  //   "off"     — bypassed; legacy `chooseReviewEvent` decides (default).
  //   "shadow"  — `chooseReviewEventWithGate` runs but legacy verdict ships;
  //               divergence logged to ValidationMetricsDO.
  //   "enforce" — `chooseReviewEventWithGate` decides the posted verdict.
  // The threshold + model artifact live in KV (config:gate-threshold:v1 /
  // config:gate-model:v1) so retunes don't require a redeploy. See
  // .claude/research/sig-161-labeling/DESIGN.md §9.
  OPENCLAW_GATE?: string

  // SIG-119: single global DO holding rolling per-gate validator shadow
  // telemetry (would-drop / kept counts, daily buckets). Read via the
  // authenticated GET /metrics/validation endpoint.
  VALIDATION_METRICS_DO: DurableObjectNamespace
  // Shared-secret bearer token guarding /metrics/validation AND /metrics/graph.
  // Unset → both endpoints return 503. Set via
  // `wrangler secret put OPENCLAW_VALIDATION_METRICS_TOKEN <token>`.
  OPENCLAW_VALIDATION_METRICS_TOKEN?: string

  // SIG-152: single global DO holding rolling daily aggregates of the SIG-138
  // `pr-review-graph-retrieval` shadow sample. Read via GET /metrics/graph.
  GRAPH_METRICS_DO: DurableObjectNamespace

  // SIG-184 PR 5b: single global DO holding rolling runner-evidence presence
  // counters (verified / evidence-pending / runner-absent × reason, + per-repo
  // latest state). Read via the authenticated GET /metrics/runner-evidence
  // endpoint (shares OPENCLAW_VALIDATION_METRICS_TOKEN).
  RUNNER_EVIDENCE_METRICS_DO: DurableObjectNamespace

  // SIG-184: runner-evidence ingest (POST /runner/ingest). The GitHub OIDC token
  // IS the auth; these pin what a valid token must attest. Both come from the
  // Sigilix runner repo — until set, the ingest route returns 503.
  //   OPENCLAW_RUNNER_OIDC_AUDIENCE — the `aud` the runner mints its token with.
  //   OPENCLAW_RUNNER_WORKFLOW_REF  — Sigilix's pinned reusable-workflow
  //                                   `owner/repo/path` (no `@ref`).
  OPENCLAW_RUNNER_OIDC_AUDIENCE?: string
  OPENCLAW_RUNNER_WORKFLOW_REF?: string
  // SIG-184 PR 3: consumption rollout posture — "off" (default) | "shadow"
  // (look up + telemetry, review unchanged) | "post" (use the verified receipt's
  // SARIF + render the verified/pending/absent state).
  OPENCLAW_RUNNER_EVIDENCE_MODE?: string
  // SIG-285 PR 1: verification-by-execution rollout posture — "off" (default) |
  // "shadow" (worker-native line-anchored re-check of score>=4 logic/security
  // findings + verdict telemetry, review UNCHANGED) | "enforce" (reserved; PR 1
  // treats it as shadow — the REFUTED-only demotion lands in PR 4).
  OPENCLAW_VERIFICATION_MODE?: string
  // SIG-184: per-repo-sharded SQLite DO enforcing single-use of a runner receipt
  // (repository_id, sha, run_id, run_attempt) + holding the defensible record.
  RUNNER_RECEIPT_DO: DurableObjectNamespace

  // SIG-156: shared-secret bearer token for the privileged admin endpoints
  // (POST /admin/index-repo manual (re)index trigger / backfill). Unset → those
  // routes return 503. Set via `wrangler secret put OPENCLAW_ADMIN_TOKEN`.
  OPENCLAW_ADMIN_TOKEN?: string
  OPENCLAW_GRAPH_RPC_TIMEOUT_MS?: string
  OPENCLAW_PR_REVIEW_DO_MAX_RETRIES?: string
  OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS?: string
  OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT?: string

  // SIG-108: security-finding evidence gate mode. "shadow" (default;
  // any value other than "enforce") counts + telemeters what the gate
  // WOULD drop without dropping; "enforce" actually drops sev>=4
  // security findings whose evidence is fabricated / non-linking /
  // absent (after auto-enrich fails). Default OFF-by-effect (shadow)
  // so the gate ships dark and the drop rate is observable before
  // enforcement. Operator flips via
  // `wrangler secret put OPENCLAW_SECURITY_VALIDATOR_MODE enforce`.
  OPENCLAW_SECURITY_VALIDATOR_MODE?: string

  // SIG-111: tests-finding specificity gate mode. "shadow" (default;
  // any value other than "enforce") counts + telemeters what the gate
  // WOULD drop without dropping; "enforce" actually drops sev>=4
  // `category: "testing"` findings whose missing-coverage claim is
  // uncited or whose insufficient-test claim names no concrete
  // source/API/branch. Default OFF-by-effect (shadow) so the gate ships
  // dark — this gate is false-negative-sensitive, so the would-drop
  // rate is observed before enforcement. Operator flips via
  // `wrangler secret put OPENCLAW_TESTS_VALIDATOR_MODE enforce`.
  OPENCLAW_TESTS_VALIDATOR_MODE?: string

  // SIG-109: logic-finding evidence gate mode. "shadow" (default; any
  // value other than "enforce") counts + telemeters what the gate WOULD
  // drop without dropping; "enforce" actually drops sev>=4 logic findings
  // that are unanchored (not on a changed path, or quoting no concrete
  // code token on an added line, and unbacked by any co-located AST hit).
  // Default OFF-by-effect (shadow) so the gate ships dark — this gate is
  // false-negative-sensitive (logic bugs are LLM-found with no
  // deterministic backing), so the would-drop rate is observed before
  // enforcement. Operator flips via
  // `wrangler secret put OPENCLAW_LOGIC_VALIDATOR_MODE enforce`.
  OPENCLAW_LOGIC_VALIDATOR_MODE?: string

  // SIG-110: perf-finding evidence gate mode. "shadow" (default) counts +
  // telemeters the would-drop; "enforce" drops unanchored sev>=4 perf
  // findings. Operator flips via
  // `wrangler secret put OPENCLAW_PERF_VALIDATOR_MODE enforce`.
  OPENCLAW_PERF_VALIDATOR_MODE?: string

  // SIG-281 PR C (Rec 4): inline-grounding gate mode. "shadow" (default)
  // counts + telemeters the would-demote; "enforce" demotes ungrounded
  // score 2-3 findings to the review body (never hard-drops). Operator
  // flips via
  // `wrangler secret put OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE enforce`.
  OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE?: string

  // SIG-121 (SIG-109 PR B): symbol-based retrieval for the logic
  // specialist. "on" fires a second, AST-symbol-derived retrieval pass
  // that AUGMENTS the logic role's shared snapshot; any other value
  // (including unset) keeps it off so the feature ships dark. Operator
  // flips via `wrangler secret put OPENCLAW_SYMBOL_RETRIEVAL on`.
  OPENCLAW_SYMBOL_RETRIEVAL?: string

  // SIG-129: branch-aware retrieval. When "on", the PR-review ensemble
  // overlays the changed-file HEAD content onto the main-index retrieval
  // results (head wins on path collision) so a PR's new/changed code is
  // retrievable. Default off; flip via
  // `wrangler secret put OPENCLAW_BRANCH_AWARE_RETRIEVAL on`.
  OPENCLAW_BRANCH_AWARE_RETRIEVAL?: string

  // Dynamic review evidence cards. "shadow" computes/logs card coverage only;
  // "post" injects the precomputed changed-symbol/context cards into
  // specialist + synth prompts. Any other value keeps it off.
  OPENCLAW_DYNAMIC_REVIEW_EVIDENCE?: string

  // SIG-228 Phase 3c — synth-bypass single-specialist hot path. When "on",
  // skip the synthesizer LLM call entirely if the dispatcher returned
  // exactly 1 specialist AND none of that specialist's findings have
  // `score >= 4` (major/critical). The specialist's verdict becomes the
  // submission directly. Saves ~15-25s on the hot path; safe by
  // construction (no cross-specialist consensus to compute, no
  // major-severity findings that benefit from synth-level rewriting).
  // Any other value (including unset) keeps the legacy always-synth
  // behavior.
  OPENCLAW_SYNTH_BYPASS_ENABLED?: string

  // SIG-235 — min-specialists early exit. Three-state rollout:
  //   "off"     — default; fan-out waits for ALL dispatched specialists
  //               to settle (legacy `Promise.allSettled` semantics).
  //   "shadow"  — fan-out STILL waits for all, but emits
  //               `ensemble-min-specialists-early-exit-would-fire`
  //               telemetry the moment `N-1` of `N` specialists return
  //               successfully + `savedMsIfEnforced` so we can size the
  //               win before enforcing.
  //   "on"      — fires synth as soon as `N-1` of `N` specialists return
  //               successfully; aborts the laggard role's outstanding
  //               attempts via per-role AbortController. Synth runs on
  //               the partial input with the existing `[DEGRADED COVERAGE]`
  //               block. Late verdicts from the cancelled role are logged
  //               (`ensemble-late-verdict-discarded`) but discarded.
  OPENCLAW_MIN_SPECIALISTS_EARLY_EXIT?: string

  // SIG-236 — surgical prompt-budget for the logic specialist. Three-
  // state rollout:
  //   "off"     — default; no telemetry, no truncation.
  //   "shadow"  — measure the constructed logic prompt's per-section
  //               size + emit `logic-prompt-budget` telemetry; the
  //               prompt passes through untouched. Used to size the
  //               enforce-mode cuts before flipping.
  //   "enforce" — NOT YET IMPLEMENTED. Behaves like "shadow" but
  //               records `mode: "enforce-pending"` in the event so
  //               dashboards can flag a premature flip. The actual
  //               truncation lands in a follow-up PR informed by
  //               shadow data.
  OPENCLAW_LOGIC_PROMPT_BUDGET?: string

  // ARC-234: customer-ready indexing pipeline feature flag. Default
  // "off" preserves the legacy `app-level event ignored` drop so the
  // producer ships dark. Operator flips to "on" via
  // `wrangler secret put OPENCLAW_INDEXER_ENABLED on` AFTER both the
  // producer (ARC-234) AND consumer (ARC-235) deploy. Any other value
  // (including unset) keeps indexing disabled.
  OPENCLAW_INDEXER_ENABLED?: string

  // SIG-35: comma-separated long-lived non-default branches to persistently
  // index in addition to the repo default branch. Defaults in code cover
  // dev/develop/development/staging/stage; this var lets customers add
  // names like "qa,release-candidate" without a deploy.
  OPENCLAW_INDEX_BRANCHES?: string

  // SIG-131: AST-aware chunking. When "on", JS/TS files chunk on AST
  // boundaries (effective CHUNKER_VERSION 3) and repos re-index under the new
  // scheme; default off (line-window, version 2). Flip via
  // `wrangler secret put OPENCLAW_AST_CHUNKING on`.
  OPENCLAW_AST_CHUNKING?: string

  // ARC-283 Phase B1b — shadow-mode model bake-off. CSV of role names
  // whose CANDIDATE lineup (per `SHADOW_BAKEOFF_LINEUP` in
  // `lib/shadow-bakeoff-config.ts`) should fire in parallel with prod
  // on every PR review. Unset/empty = shadow off everywhere (the prod
  // path takes ZERO added code branches). Shadow verdicts are NEVER
  // posted; comparison telemetry emits via `shadow-verdict-comparison`
  // events. Valid roles: logic, security, performance, tests, synth.
  // Recommended rollout order: "synth" first, then "security,tests",
  // then "performance", then "logic". See docs/ops/shadow-bakeoff.md.
  SHADOW_BAKEOFF_ROLES?: string
}

/**
 * Discriminated union of all job kinds the queue handler dispatches.
 * `env` is intentionally NOT serialized — the queue consumer receives
 * its own `env` argument from Cloudflare and re-injects it before
 * calling the per-job handler.
 */
export type JobMessage =
  | { type: "linear-triage"; issueId: string }
  | {
      type: "linear-mention"
      commentId: string
      /** SIG-225 follow-up: the consumer (`handleMention`) has its own
       *  `bodyMentionsBot` gate as defense-in-depth that fails closed
       *  on any comment without an `@-mention` — including the new
       *  thread-followup trigger added by SIG-225 round 1. Producers
       *  tag jobs with the reason the webhook decided to enqueue so
       *  the consumer can route correctly. Absent (undefined) on any
       *  pre-SIG-225 in-flight jobs that get redelivered — the consumer
       *  treats absent as `"mention"` to preserve the legacy behavior
       *  on those messages. */
      triggerReason?: "mention" | "thread-followup"
    }
  | {
      type: "pr-overview"
      owner: string
      repo: string
      prNumber: number
      headSha: string
      installationId: number
      /**
       * ARC-258 follow-up: when set, the pr-overview handler skips
       * its per-(PR, headSha) dedupe check and re-runs unconditionally.
       * Used by the pr-review success path to refresh the overview
       * after a review completes — without `force`, the per-headSha
       * dedupe (5-min TTL set by the initial run on this headSha)
       * would suppress the refresh. Webhook-driven enqueues omit
       * this flag and keep the dedupe semantics intact.
       */
      force?: boolean
    }
  | {
      // ARC-265: auto-label picker. Fires per `pull_request` webhook
      // alongside pr-overview / pr-review. Handler short-circuits if
      // `sigilix.json::labels.enabled` is false. Without customLabels,
      // it derives candidates from the repo's existing label set.
      type: "pr-labels"
      owner: string
      repo: string
      prNumber: number
      headSha: string
      installationId: number
    }
  | {
      type: "pr-review"
      owner: string
      repo: string
      prNumber: number
      headSha: string
      installationId: number
      /**
       * ARC-190: DO-routed pr-review messages carry a UUIDv4 runId
       * generated by `PrReviewRunDO`. Slash-command reruns and older
       * queued messages may omit it. The consumer wrapper guards on
       * `job.type === "pr-review" && typeof job.runId === "string"`
       * to dispatch DO-aware logic only on DO-routed runs (Codex
       * BLOCKING B2 on plan v1 — must be string-checked because
       * `ci-triage`'s separate `runId: number` field is unrelated).
       */
      runId?: string
      /**
       * ARC-251: number of times this job was re-enqueued by the
       * stale-head guard. Webhook-originated jobs omit the field
       * (treated as 0). Capped at `MAX_STALE_HEAD_REQUEUES` (=2)
       * before the helper falls through to the sticky comment.
       * Persisted on DO RunState so retry-alarm-generated messages
       * preserve the count and don't bypass the cap.
       */
      staleHeadRequeueDepth?: number
      /**
       * SIG-220: GitHub check-run id created upstream in
       * `PrReviewRunDO.handleEnqueue` so the "Sigilix · In progress"
       * row appears in the GitHub UI within ~1–2s of webhook
       * receipt instead of waiting for the queue consumer to
       * dequeue (5–30s).
       *
       * When set, the dispatcher calls `attachExistingCheckRun` to
       * rebuild the handle off the installation id. When absent
       * (legacy queue messages pre-deploy, slash-command reruns
       * that raw-send without going through the DO, stale-head
       * helper paths that haven't been updated yet), the
       * dispatcher falls back to its own `startInProgressCheckRun`
       * exactly like the pre-SIG-220 behavior.
       */
      checkRunId?: number
      /**
       * SIG-247 Phase 1: GitHub's immutable `repo.id`. Threaded from
       * webhook payload → enqueuePrReviewJob → DO RunState → queue
       * sends so the consumer can pass it to the review-memory lookup
       * for dual-write/read-union semantics. Absent on legacy queue
       * messages and slash-command raw-sends that pre-date Phase 1;
       * the dispatcher then falls back to a `getRepository` lookup
       * before invoking the review pipeline.
       */
      repoId?: number
    }
  // ARC-178: slash-command-driven re-review. Same shape as pr-review
  // but headSha is resolved at handler time (the comment that
  // triggered it doesn't carry the PR's current head SHA in all
  // surfaces). Handler fetches PR meta, then enqueues a regular
  // pr-review job. Posts an ack comment so the user knows the
  // request was received.
  | {
      type: "pr-review-rerun"
      owner: string
      repo: string
      prNumber: number
      installationId: number
      /**
       * ARC-236: warmup-fired reruns skip the slash-command ack
       * (the customer didn't type `/sigilix review`; the rerun is
       * automatic post-indexing). Slash-command-driven reruns leave
       * this unset/false and keep the existing ack behavior.
       */
      silent?: boolean
      /**
       * SIG-98: `/sigilix full review` sets this. Functionally
       * equivalent to `/sigilix review` today (both bypass the
       * webhook-side noop-merge cumulative-diff guard because they
       * route through the rerun path, not the webhook
       * `synchronize` path). Kept as a distinct flag so a future
       * dedup layer that DOES apply to rerun jobs has an obvious
       * bypass switch + so telemetry can distinguish the two CTAs.
       */
      forceFresh?: boolean
    }
  // SIG-98 — per-PR lifecycle commands. Each is a thin handler that
  // flips a KV flag (pause/ignore) or walks the PR's review threads
  // (resolve), then posts an ack comment. No LLM call, no diff fetch.
  | {
      type: "pr-pause"
      owner: string
      repo: string
      prNumber: number
      installationId: number
    }
  | {
      type: "pr-resume"
      owner: string
      repo: string
      prNumber: number
      installationId: number
    }
  | {
      type: "pr-ignore"
      owner: string
      repo: string
      prNumber: number
      installationId: number
    }
  | {
      type: "pr-resolve-threads"
      owner: string
      repo: string
      prNumber: number
      installationId: number
    }
  // ARC-179: `/sigilix improve` — single-shot LLM call producing
  // apply-able suggested-change comments. Independent of the
  // ensemble; does NOT consume the ensemble daily budget. headSha
  // is resolved at handler time (same rationale as pr-review-rerun).
  | {
      type: "pr-improve"
      owner: string
      repo: string
      prNumber: number
      installationId: number
    }
  // `/sigilix help` — post a static help comment listing the slash
  // commands. No model call, no diff fetch; the queue handler is just
  // an authenticated comment-poster. Routed through the queue (rather
  // than handled inline in the webhook) so the same ACL + coalesce
  // gates apply uniformly across slash commands.
  | {
      type: "pr-help"
      owner: string
      repo: string
      prNumber: number
      installationId: number
    }
  // ARC-191 / ARC-264: `/sigilix describe [apply] [mode]` — single-
  // shot LLM draft of a PR description / internal changelog /
  // external changelog. Mode is resolved at parse time (one of three
  // canonical names). headSha is resolved at handler time (same
  // rationale as pr-improve). `apply: true` writes the draft into
  // the PR body in place between marker fences; `apply: false`
  // posts as a top-level comment.
  | {
      type: "pr-describe"
      owner: string
      repo: string
      prNumber: number
      installationId: number
      mode: import("./lib/slash-commands").DescribeMode
      apply: boolean
    }
  // ARC-184: review provenance + stale markers. Enqueued from the
  // webhook handler alongside `pr-review` on `synchronize` / `edited`
  // when a prior review-manifest exists. The consumer reads the live
  // manifest, computes drift against current PR state, and PATCHes
  // the prior review/issue-comment body with a stale notice block.
  // No model call; no ensemble budget consumption.
  | {
      type: "pr-stale-mark"
      owner: string
      repo: string
      prNumber: number
      installationId: number
      manifestSnapshot: ReviewManifestV1
      newHeadSha: string
      newBaseSha: string
      // Pinned at enqueue time so a concurrent prompt deploy between
      // enqueue and consume doesn't change drift detection.
      currentPromptVersion: string
    }
  | {
      type: "ci-triage"
      owner: string
      repo: string
      prNumber: number
      runId: number
      headSha: string
      installationId: number
    }
  | {
      type: "github-mention"
      owner: string
      repo: string
      prNumber: number
      installationId: number
      surface: GhMentionSurface
      commentId: number
      threadRootId?: number
    }
  // ARC-234 + ARC-235: customer-ready indexing pipeline. Bootstrap jobs
  // (from the install / repos-added webhook) carry only the {owner,
  // repo, installationId, reason} producer payload. The ARC-235
  // consumer walks the tree, processes up to MAX_FILES_PER_JOB files,
  // then enqueues the next continuation-token shard with the `shard`
  // field populated. Strict single-writer chain; no fan-out parallelism.
  | {
      type: "index-repo"
      owner: string
      repo: string
      /**
       * SIG-243 Phase 1: GitHub's immutable integer repository ID,
       * captured at the webhook handler and threaded through the
       * producer + consumer. Optional during Phase 1 + Phase 2 so
       * legacy in-flight messages (and message types not yet on the
       * new path) still dispatch cleanly; consumers persist it on
       * the manifest when present. Becomes the canonical key in
       * Phase 4 (`repo-tenant:{githubRepoId}`).
       */
      githubRepoId?: number
      installationId: number
      reason:
        | "install"
        | "install-repos-added"
        | "manual"
        | "push"
        | "pull-request"
        | "merged-pr"
      /**
       * SIG-35: when set, index this Git branch into branch-scoped
       * state instead of the default-branch compatibility namespace.
       * Shards copy this root field so the consumer can derive the same
       * Vectorize namespace / KV keys throughout the chain.
       */
      branch?: string
      shard?: {
        /** Inclusive lower bound into the filtered indexable-file list. */
        lo: number
        /** Exclusive upper bound. */
        hi: number
        /** Commit SHA — Contents-API fetches, freshness check, runId. */
        headSha: string
        /** Tree SHA — `getRepoTree` argument. Distinct from headSha per Codex v2 B1. */
        treeSha: string
        /** Default branch observed when the bootstrap job started. */
        defaultBranch?: string
        /** Total filtered indexable file count from the bootstrap walk. */
        totalFiles: number
        /** Accumulated count of files processed so far in this run (chain). */
        filesDone: number
        /** Accumulated count of chunks upserted so far in this run. */
        chunksDone: number
        /** Stable run id: sha256(owner|repo|headSha|modelId|chunkerVersion).slice(0,16). */
        runId: string
      }
    }
  | {
      type: "delete-repo-index"
      owner: string
      repo: string
      reason: "branch-deleted" | "pr-branch-closed"
      branch?: string
    }

/**
 * Pure decision: given a `pull_request` webhook action + draft flag,
 * which jobs should we enqueue? Extracted so the gating intent is
 * directly testable without simulating the full webhook handler.
 *
 * Rules (matches the routing in handleGitHubWebhook):
 *   - Drafts and unsupported actions get nothing.
 *   - SIG-216: the `overview` boolean NO LONGER controls when the
 *     pr-overview comment renders. The overview comment is now posted
 *     inline by `handlePrReviewEnsemble` immediately before the review
 *     submit (CodeRabbit-style Walkthrough-then-Review). The boolean
 *     gates only the legacy `loadSigilixConfig` warmup + the
 *     `pr-labels` enqueue path that consumes it. Treat it as "fire the
 *     opt-in / labelling side effects" rather than "render the
 *     overview" — true for opened/synchronize/reopened/ready_for_review.
 *   - pr-review fires for the same actions EXCEPT `reopened` (closing
 *     + reopening a PR doesn't change the diff, so re-reviewing would
 *     be noise). The inline overview rides along with each review, so
 *     `reopened` PRs intentionally get neither.
 *   - When OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES=on, PRs from a
 *     dev/develop/staging branch into main/master/release skip the
 *     pr-review job entirely (dev→main is a release-promotion of
 *     already-reviewed code; re-reviewing doubles spend + adds noise).
 *     The `overview: true` flag still fires so the release PR still
 *     gets its side-effect pass (labels + warmup).
 */
export function decidePullRequestJobs(args: {
  action: string
  draft: boolean
  baseRef?: string
  headRef?: string
  skipReleasePromotions?: boolean
}): { overview: boolean; review: boolean } {
  if (args.draft) return { overview: false, review: false }
  const supported = ["opened", "synchronize", "reopened", "ready_for_review"]
  if (!supported.includes(args.action)) return { overview: false, review: false }
  let review = args.action !== "reopened"
  if (review && args.skipReleasePromotions && isReleasePromotion(args.baseRef, args.headRef)) {
    review = false
  }
  return { overview: true, review }
}

const RELEASE_BASE_BRANCHES = new Set(["main", "master", "release", "production", "prod"])
const PROMOTION_HEAD_BRANCHES = new Set(["dev", "develop", "development", "staging", "stage"])

function isReleasePromotion(baseRef: string | undefined, headRef: string | undefined): boolean {
  if (!baseRef || !headRef) return false
  const base = baseRef.toLowerCase()
  const head = headRef.toLowerCase()
  return RELEASE_BASE_BRANCHES.has(base) && PROMOTION_HEAD_BRANCHES.has(head)
}

interface LinearWebhookPayload {
  action: "create" | "update" | "remove"
  type: "Issue" | "Comment" | string
  data: {
    id: string
    title?: string
    description?: string
    body?: string
    /** SIG-243: `team.id` is Linear's immutable UUID for the team. Stable
     *  across team-key renames + team-name changes — unlike `team.key`
     *  above, which Linear admins can change at will. Captured in every
     *  Linear webhook handler so Phase 4 can replace the global static
     *  `OPENCLAW_TEAM_GITHUB_REPO_MAP` JSON keyed by mutable team prefix
     *  with a per-tenant KV binding (`linear-binding:{linearTeamUuid}`)
     *  keyed by this UUID. The `key` field stays as cached display state
     *  during the transition (Phase 1+2 still reads through the legacy
     *  env-var path). */
    team?: { id?: string; key?: string }
    /** SIG-225: `user.id` is included so the trigger log can emit a
     *  presence-only `userIdPresent: !!payload.data.user?.id` flag
     *  without exposing raw identity values. The leading hypothesis
     *  for the double-post bug is that Linear sets `data.user` to
     *  the OAuth app OWNER's identity for bot-authored comments,
     *  not the bot's own. A presence flag is enough to decide if
     *  an Option-A `user.id === bot_viewer_id` filter would be the
     *  right follow-up on top of the deterministic commentId
     *  tracker; the raw value would be a PII leak in production
     *  logs (Sigilix bot + CodeRabbit flagged this on PR #201). */
    user?: { id?: string; displayName?: string; name?: string }
    /** SIG-225: when a Comment.create event is a thread reply, Linear
     *  populates `parentId` with the parent comment's id. Used by the
     *  in-thread-reply trigger path so users don't need to re-@-mention
     *  Sigilix on every back-and-forth inside a thread Sigilix has
     *  already commented in. Absent on top-level comments. */
    parentId?: string
    /** SIG-225: issue id the comment belongs to. Needed to look up the
     *  issue's recent comments + walk the parent chain to verify the
     *  ancestor is Sigilix-authored. Linear's Comment.create webhook
     *  populates `issueId` directly. */
    issueId?: string
  }
  webhookTimestamp: number
}

interface GitHubWebhookPayload {
  action?: string
  installation?: {
    id?: number
    /** ARC-238: account.login is the owner identifier for the
     *  `installation.deleted` repo-discovery scan. */
    account?: { login?: string; type?: string }
  }
  repository?: {
    /** SIG-243: GitHub's immutable integer ID for the repository. Stable
     *  across rename, transfer, and ownership changes — unlike `name` +
     *  `owner.login` above, both of which mutate. Captured in every
     *  webhook handler so Phase 2+ can key by this instead of the
     *  mutable string pair. */
    id?: number
    name?: string
    owner?: {
      login?: string
      /** SIG-243: owner ID is also immutable across rename. Less load-
       *  bearing than `repository.id` (one repo can't move between
       *  orgs without the App being re-installed) but captured for
       *  observability + future tenant-scoping. */
      id?: number
    }
  }
  pull_request?: {
    number?: number
    head?: { sha?: string; ref?: string; repo?: { full_name?: string | null } | null }
    base?: { sha?: string; ref?: string }
    draft?: boolean
    merged?: boolean
  }
  workflow_run?: {
    id?: number
    conclusion?: string | null
    head_sha?: string
    pull_requests?: Array<{ number?: number; head?: { sha?: string } }>
    event?: string
  }
  review?: {
    state?: string
    user?: { login?: string }
  }
  comment?: {
    id?: number
    path?: string
    line?: number | null
    original_line?: number | null
    in_reply_to_id?: number
    body?: string
    user?: { login?: string }
    commit_id?: string
    original_commit_id?: string
    pull_request_review_id?: number | null
    // GitHub's relationship between the comment author and the
    // repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIMER,
    // FIRST_TIME_CONTRIBUTOR, MANNEQUIN, NONE. Used by ARC-178 to gate
    // slash commands that trigger expensive review re-runs.
    author_association?: string
  }
  // `issue_comment` events deliver an `issue` block. When the issue
  // is a PR, `issue.pull_request` is present (otherwise it's a plain
  // issue and we ignore the event).
  issue?: {
    number?: number
    pull_request?: { url?: string } | null
  }
  // ARC-234: installation-scoped events carry no repository field;
  // instead they ship one or both of these arrays. `repositories[]`
  // is the initial set on `installation.created`. `repositories_added[]`
  // is the delta on `installation_repositories.added`. Both share the
  // same entry shape (we only consume `full_name`, formatted "owner/repo").
  // SIG-243 Phase 1: GitHub's installation / installation_repositories
  // webhook payloads include an `id` (immutable integer) per repo
  // alongside `name` + `full_name`. Captured so the bootstrap queue
  // message carries the canonical ID from its first write.
  repositories?: Array<{ id?: number; name?: string; full_name?: string }>
  repositories_added?: Array<{ id?: number; name?: string; full_name?: string }>
  // ARC-238: `installation_repositories.removed` carries the delta;
  // `installation.deleted` does NOT carry a repo list (repos are
  // already gone) — the delete handler discovers affected repos by
  // walking `repo-index-manifest:` records and filtering by owner.
  repositories_removed?: Array<{ id?: number; name?: string; full_name?: string }>
  // ARC-237 / SIG-35: `push` event fields. Default-branch pushes refresh
  // the compatibility index. Tracked long-lived branches and active PR
  // head branches refresh isolated branch-scoped indexes. Branch deletes
  // enqueue branch-index cleanup.
  ref?: string
  after?: string
  before?: string
}

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

    // SIG-173: authenticated read of rolling per-reason dismissal rollup.
    if (request.method === "GET" && url.pathname === "/metrics/dismissals") {
      return handleDismissalMetricsRoute(request, env)
    }

    // SIG-152: authenticated read of rolling SIG-138 graph shadow telemetry.
    if (request.method === "GET" && url.pathname === "/metrics/graph") {
      return handleGraphMetricsRoute(request, env)
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

/**
 * Post the slash-command ack comment for `cmd` on the given PR.
 * Used by pr-review-rerun and pr-improve queue handlers so the user
 * gets fast feedback that the command was received before the
 * (potentially 30-90s) LLM call completes. Throws on auth/comment
 * failure so callers can decide whether to swallow.
 */
async function postSlashCommandAck(
  env: Env,
  cmd: SlashCommand,
  args: { owner: string; repo: string; prNumber: number; installationId: number },
): Promise<void> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId: args.installationId,
  })
  const client = new GitHubClient({ token })
  await client.createIssueComment(
    args.owner, args.repo, args.prNumber,
    renderSlashCommandAck(cmd),
  )
}

export async function dispatchJob(job: JobMessage, env: Env): Promise<void> {
  switch (job.type) {
    case "linear-triage":
      return triageIssue(job.issueId, env)
    case "linear-mention":
      return handleMention(job.commentId, env, {
        // Defaults to "mention" when triggerReason is absent — covers
        // any pre-SIG-225 in-flight job that gets redelivered after a
        // deploy and never carried the field.
        triggerReason: job.triggerReason ?? "mention",
      })
    case "pr-overview":
      return handlePrOverview({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
        ...(job.force ? { force: true } : {}),
      })
    case "pr-labels":
      // ARC-265/SIG-135: auto-label picker. Short-circuits only when
      // `sigilix.json::labels.enabled` is false; otherwise it uses
      // customLabels or falls back to existing repo labels.
      return handlePrLabels({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
      })
    case "pr-review": {
      // ARC-289 diagnostic logging — emit on EVERY queue-handler entry
      // into the pr-review case so we can correlate duplicate
      // dispatches (PR #96 saw 2× ensemble runs against the same
      // commit `8ad306a`, 51s apart, no commits between). The fields
      // surface which dispatch path produced the message:
      //   - `runId` present → DO-routed (the dedupe path)
      //   - `runId` absent → user-triggered rerun or older queued message
      //   - `staleHeadRequeueDepth > 0` → ARC-251 requeue
      // If duplicates have a common (runId, headSha) tuple, hypothesis
      // is queue redelivery (DO should have deduped); if distinct
      // runIds, hypothesis is webhook double-fire OR warmup-induced
      // re-review. The `queue.attempts` counter lives at the queue
      // handler level (not dispatchJob's scope) so add it back here
      // in a follow-up if duplicates persist after the obvious causes
      // are ruled out.
      console.log(JSON.stringify({
        event: "pr-review-dispatch-received",
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha.slice(0, 7),
        runId: typeof job.runId === "string" ? job.runId : null,
        staleHeadRequeueDepth: job.staleHeadRequeueDepth ?? 0,
        dispatchedAt: Date.now(),
      }))
      // ARC-190 Task 7: when the message carries a string `runId`, the
      // DO is the dedupe + retry source-of-truth. The wrapper posts
      // /pickup → runs the work → posts /run-result. Legacy direct-path
      // messages (no runId) bypass and run unchanged.
      // SIG-119: the ensemble's validator callbacks push rejection events
      // into this sink; the dispatcher flushes it once to ValidationMetricsDO
      // in the finally below (off the review hot path, non-fatal).
      const validationSink: ValidationRejectionEvent[] = []
      // SIG-152: the ensemble's graph block pushes its one per-review
      // graph-retrieval sample here (0 or 1 element); flushed alongside the
      // validation sink in the finally below.
      const graphMetricsSink: GraphRetrievalSample[] = []
      const baseArgs = {
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
        validationSink,
        graphMetricsSink,
        // ARC-251: thread the requeue depth from the job message into
        // both review pipelines. Webhook-driven messages omit the
        // field (treated as 0); stale-head-driven requeues carry the
        // incremented depth so the helper can cap further retries.
        ...(job.staleHeadRequeueDepth !== undefined
          ? { staleHeadRequeueDepth: job.staleHeadRequeueDepth }
          : {}),
        // SIG-247 Phase 1: thread the immutable repo.id into the
        // review pipeline so the review-memory lookup hits BOTH the
        // legacy and repo-id keyspaces. Webhook-driven jobs carry it
        // when payload.repository.id is a positive integer; legacy
        // queue messages and slash-command raw-sends omit it, in
        // which case the ensemble falls back to a getRepository
        // lookup at the lookup call site.
        ...(job.repoId !== undefined ? { repoId: job.repoId } : {}),
      }
      return runPrReviewWithDoCallback(job, env, async () => {
        // ARC-258 follow-up: warmup signaling now lives inside the
        // pr-overview sticky (a "Sigilix is warming up its index"
        // callout at the top, gated on `repo-index-manifest:<repo>`
        // existence). The pr-review path no longer posts a separate
        // warmup comment. See `src/lib/triage-pr-overview.ts` and
        // `src/lib/warmup.ts::enqueueWarmupRerunsForIndex`.

        // ARC-280: routing collapsed. The pre-ARC-275 decision matrix
        // (ensemble-shadow vs ensemble-post vs phase3-agentic vs
        // phase3-singleshot-legacy) is gone — there's exactly one
        // review pipeline now (`handlePrReviewEnsemble`) plus the
        // intentional sensitive-repo skip. Phase 3 single-shot
        // reviewer + the `routeReview` decision layer are deleted in
        // this ticket; the ensemble owns submit, verify, retry, and
        // comment-fallback end-to-end (ARC-277 / ARC-278 / ARC-279).
        if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, job.owner, job.repo)) {
          console.log(JSON.stringify({
            event: "pr-review-skipped",
            reason: "repo_in_sensitive_denylist",
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
          }))
          // SIG-220: when the DO created the check upstream (so the
          // user already sees "Sigilix · In progress" in the GitHub
          // UI) and the dispatcher then skips for a sensitive-repo
          // policy, we must close the check ourselves — otherwise
          // it hangs `in_progress` forever. Map to `skipped` (wire
          // `neutral`) per the existing advisory-bot convention.
          // No-op when `checkRunId` is absent (legacy messages or
          // upstream create failed → no orphan to close).
          if (job.checkRunId !== undefined) {
            const handle = await attachExistingCheckRun({
              env,
              owner: job.owner,
              repo: job.repo,
              installationId: job.installationId,
              checkRunId: job.checkRunId,
            })
            await completeCheckRun({ handle, conclusion: "skipped" })
          }
          return
        }
        // SIG-220: when the upstream `PrReviewRunDO.handleEnqueue`
        // created the customer-visible check (the new fast path —
        // visible to the user within ~1–2s of push), the dispatcher
        // ATTACHES to that existing row instead of creating a new
        // one. Fallback (legacy queue messages without `checkRunId`,
        // slash-command reruns, stale-head helper requeues) keeps
        // the pre-SIG-220 dispatcher-time create path — best-effort
        // throughout; a null handle means the completion below is
        // a no-op.
        const checkRun = job.checkRunId !== undefined
          ? await attachExistingCheckRun({
              env,
              owner: job.owner,
              repo: job.repo,
              installationId: job.installationId,
              checkRunId: job.checkRunId,
            })
          : await startInProgressCheckRun({
              env,
              owner: job.owner,
              repo: job.repo,
              headSha: job.headSha,
              installationId: job.installationId,
            })
        let conclusion: SigilixCheckConclusion | null = null
        // ARC-276: capture the customer-visible review verdict +
        // findings count on the posted path so the Check Run title
        // can reflect `Approved — no issues found` vs `N findings
        // posted`. Threaded out via `completeCheckRun`.
        let reviewMeta: import("./lib/triage-pr-review-ensemble").ReviewMeta | undefined = undefined
        try {
          const result = await handlePrReviewEnsemble(baseArgs)
          if (result.status === "posted") {
            // ARC-279: when the ensemble used the comment fallback
            // (formal review submit was silently rejected), the
            // Check Run should reflect that the normal pipeline
            // didn't run — even though the synth body posted as a
            // PR comment. `failure` + reviewMeta.surface === "comment"
            // routes to the "see PR comment" title.
            conclusion = result.reviewMeta?.surface === "comment" ? "failure" : "success"
            reviewMeta = result.reviewMeta
            return
          }
          if (result.status === "stale_head") {
            conclusion = "skipped"
            return
          }
          // ARC-280 + follow-up: ARC-279 handles "synth ran but
          // submit didn't persist" via comment-fallback. The
          // remaining `skipped`/`errored` paths split into:
          //   - sensitive-repo: handled above, never reaches here
          //   - label gate: legitimate user-config skip → success
          //   - errored + skip-notice posted (router_no_specialists,
          //     specialists_all_failed, synth retry exhausted,
          //     internal_error): map to failure + thread reviewMeta
          //     so the Check Run title says "Couldn't review — see
          //     PR comment"
          //   - errored without skip-notice (rare; the helper
          //     itself failed to post): generic "Review failed"
          conclusion = result.status === "errored" ? "failure" : "success"
          reviewMeta = result.reviewMeta
        } catch (err) {
          conclusion = "failure"
          throw err
        } finally {
          // Best-effort completion. `null` conclusion means we
          // returned before assigning one (shouldn't happen with the
          // current branches, but defensive). Map it to `failure` so
          // the check doesn't hang in_progress.
          // SIG-216: thread prNumber into reviewMeta so the check-run
          // summary can render the `[View review](pr-url)` link. When
          // the ensemble didn't return a reviewMeta (degraded paths),
          // the summary degrades to the link-less fallback — that's
          // intentional, not worth scaffolding a synthetic reviewMeta.
          const reviewMetaForComplete = reviewMeta !== undefined
            ? { ...reviewMeta, prNumber: job.prNumber }
            : undefined
          await completeCheckRun({
            handle: checkRun,
            conclusion: conclusion ?? "failure",
            ...(reviewMetaForComplete !== undefined ? { reviewMeta: reviewMetaForComplete } : {}),
          })
          // SIG-119: flush collected validator-rejection telemetry once.
          // Non-fatal — a metrics failure must never affect the review.
          if (validationSink.length > 0) {
            try {
              await recordValidationMetrics(env, {
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
                headSha: job.headSha,
                events: validationSink,
              })
            } catch (err) {
              console.log(JSON.stringify({
                event: "validation-metrics-record-error",
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
                error: err instanceof Error ? err.message : String(err),
              }))
            }
          }
          // SIG-152: flush the per-review graph-retrieval sample once.
          // Non-fatal — same guarantees as the validation flush above.
          const graphSample = graphMetricsSink[0]
          if (graphSample) {
            try {
              await recordGraphMetrics(env, {
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
                headSha: job.headSha,
                sample: graphSample,
              })
            } catch (err) {
              console.log(JSON.stringify({
                event: "graph-metrics-record-error",
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
                error: err instanceof Error ? err.message : String(err),
              }))
            }
          }
        }
      })
    }
    case "pr-review-rerun": {
      // ARC-178: `/sigilix review` slash command. Resolve the current
      // head SHA from PR meta, post an ack comment, clear the per-
      // (PR, headSha) dedupe lock the previous run installed, then
      // re-enqueue a regular pr-review job (which goes through the
      // standard routing: sensitive gate, ensemble vs Phase 3, etc.).
      const tag = { owner: job.owner, repo: job.repo, prNumber: job.prNumber }
      try {
        if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
          console.error(JSON.stringify({
            event: "pr-review-rerun-misconfigured",
            reason: "missing_github_app_credentials",
            ...tag,
          }))
          return
        }
        const token = await getInstallationToken({
          kv: env.OPENCLAW_STATE,
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_PRIVATE_KEY,
          installationId: job.installationId,
        })
        const client = new GitHubClient({ token })
        const meta = await client.getPullRequest(job.owner, job.repo, job.prNumber)
        const headSha = meta.head.sha
        if (!headSha) {
          console.error(JSON.stringify({
            event: "pr-review-rerun-skipped",
            reason: "no_head_sha",
            ...tag,
          }))
          return
        }
        // SIG-247 Phase 1: resolve the immutable repo.id before
        // enqueuing so both silent warmup reruns AND user-typed slash
        // reruns carry it through to the consumer. Without this, both
        // rerun paths would fall back to legacy-only review-memory
        // reads — defeating the transfer-proof property of Phase 1.
        // Best-effort: a failed/null lookup falls back to undefined.
        let rerunRepoId: number | undefined
        try {
          const repoMeta = await client.getRepository(job.owner, job.repo)
          if (
            repoMeta &&
            typeof repoMeta.id === "number" &&
            Number.isInteger(repoMeta.id) &&
            repoMeta.id > 0
          ) {
            rerunRepoId = repoMeta.id
          }
        } catch (err) {
          console.warn(JSON.stringify({
            event: "pr-review-rerun-repo-id-fetch-failed",
            err: err instanceof Error ? err.message : String(err),
            ...tag,
          }))
        }
        // Post ack comment so the user knows the request was received.
        // Best-effort: a failed ack doesn't block the re-review.
        //
        // ARC-236 (code-reviewer M1 catch on PR #80): when the rerun
        // is fired automatically by `enqueueWarmupRerunsForIndex`
        // after indexing completes, the customer didn't type a slash
        // command — the ack would be unsolicited noise on every
        // open PR. Skip the ack when `silent` is set.
        if (!job.silent) {
          // SIG-98 (CodeRabbit catch on PR #110): use the
          // `full-review` ack text when the rerun originated from a
          // `/sigilix full review` slash command (forceFresh: true).
          // The two acks differ — "...with cumulative-diff dedup
          // bypass..." vs the plain rerun copy — and rendering the
          // wrong one on the dedup-bypass path was misleading.
          const ackCmd: SlashCommand = job.forceFresh === true
            ? { cmd: "full-review" }
            : { cmd: "review" }
          try {
            await client.createIssueComment(
              job.owner, job.repo, job.prNumber,
              renderSlashCommandAck(ackCmd),
            )
          } catch (err) {
            console.error(JSON.stringify({
              event: "slash-command-ack-failed",
              err: err instanceof Error ? err.message : String(err),
              cmd: ackCmd.cmd,
              ...tag,
            }))
          }
        }
        // ARC-280: Phase 3's legacy single-shot dedupe lock is gone
        // (handlePrReview deleted). The ensemble uses its own per-
        // (PR, headSha) coalesce + lastReviewedSha guard inside
        // `handlePrReviewEnsemble`; the slash command's rerun
        // intent is preserved by the ensemble's own re-run logic
        // (the user-triggered enqueue bypasses the per-headSha
        // dedupe because each rerun is treated as a fresh job).

        // SIG-11: silent reruns (warmup fan-out from
        // `enqueueWarmupRerunsForIndex`) MUST route through
        // `enqueuePrReviewJob` so DO `/enqueue` dedup catches the
        // case where a normal webhook-driven review just ran on the
        // same headSha. Before this, the raw `OPENCLAW_JOBS.send`
        // bypassed both the DO and the consumer-wrapper's runId
        // check (consumer-wrapper.ts:66-68 short-circuits when
        // runId is absent), producing a duplicate full-ensemble run
        // — evidenced on PR #96 (`8ad306a` ran twice, ~46s + ~115s).
        //
        // Note (code-reviewer MINOR on PR review): DO's
        // `decideEnqueueAction` returns `dedupe-terminal` for
        // `done | failed | idle` runs. Warmup reruns after a FAILED
        // prior run will silently no-op too — intentional. Warmup is
        // opportunistic post-indexing fan-out; a real failure won't
        // be fixed by an automatic retry, and the customer can
        // always `/sigilix review` to force a fresh run.
        //
        // Slash-command reruns (silent !== true) keep the raw send:
        // a user who typed `/sigilix review` is explicitly asking
        // for a fresh review, and the existing comment above
        // documents that intentional bypass.
        if (job.silent === true) {
          const enq = await enqueuePrReviewJob(env, {
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            headSha,
            baseSha: meta.base?.sha ?? null,
            installationId: job.installationId,
            // No webhook delivery — this is queue-internal.
            deliveryId: null,
            // SIG-247 Phase 1: thread the repo.id so silent warmup
            // reruns carry it into RunState + the consumer's
            // review-memory lookup.
            ...(rerunRepoId !== undefined ? { repoId: rerunRepoId } : {}),
          })
          if (!enq.ok) {
            // Codex MEDIUM on PR review: silent warmup reruns are
            // best-effort optimization, NOT customer-facing. The
            // surrounding try/catch swallows + logs the throw and
            // returns — so re-throwing here would NOT trigger a
            // queue retry. Log explicitly and continue.
            console.error(JSON.stringify({
              event: "pr-review-rerun-enqueue-failed",
              reason: `do-${enq.reason}`,
              silent: true,
              ...tag,
            }))
          } else {
            // Codex LOW on PR review: emit rerun-context telemetry
            // so we can count how often warmup reruns are being
            // suppressed by DO dedup vs newly enqueued. The DO's
            // own `do-review-deduped` log carries (owner, repo,
            // prNumber, runId, action) — correlate by timestamp +
            // (owner, repo, prNumber).
            console.log(JSON.stringify({
              event: "pr-review-rerun-silent-routed",
              route: enq.route,
              ...tag,
            }))
          }
        } else {
          const reviewMessage: JobMessage = {
            type: "pr-review",
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            headSha,
            installationId: job.installationId,
            // SIG-247 Phase 1: slash-command raw-sends bypass the DO
            // path, so they thread repoId directly into the JobMessage
            // here. Consumer reads it into `baseArgs` and on into the
            // ensemble's review-memory lookup.
            ...(rerunRepoId !== undefined ? { repoId: rerunRepoId } : {}),
          }
          await env.OPENCLAW_JOBS.send(reviewMessage)
          // SIG-98 — telemetry so we can tell `/sigilix review` apart
          // from `/sigilix full review` in the future. Both paths
          // already bypass the noop-merge cumulative-diff guard (which
          // only runs on the webhook `synchronize` path); `forceFresh`
          // is the explicit bypass switch for any future dedup layer
          // that DOES apply to rerun jobs.
          console.log(JSON.stringify({
            event: "pr-review-rerun-dispatched",
            forceFresh: job.forceFresh === true,
            ...tag,
          }))
        }
      } catch (err) {
        console.error(JSON.stringify({
          event: "pr-review-rerun-error",
          err: err instanceof Error ? err.message : String(err),
          ...tag,
        }))
      }
      return
    }
    case "pr-improve":
      // ARC-179: `/sigilix improve` slash command. Single-shot LLM
      // call producing apply-able GitHub suggested-change comments.
      // Independent of the ensemble; fail-soft on ack but re-throws
      // on the actual run so queue retries get a chance.
      try {
        await postSlashCommandAck(env, { cmd: "improve" }, {
          owner: job.owner, repo: job.repo, prNumber: job.prNumber,
          installationId: job.installationId,
        })
      } catch (err) {
        console.error(JSON.stringify({
          event: "slash-command-ack-failed",
          err: err instanceof Error ? err.message : String(err),
          owner: job.owner, repo: job.repo, prNumber: job.prNumber,
          cmd: "improve",
        }))
      }
      return handlePrImprove({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
        env,
      })
    case "pr-help": {
      // `/sigilix help` — post a static command-list comment. No model
      // call. `renderSlashCommandAck("help")` returns the full
      // help-body markdown (the body IS the response), so the same
      // ack helper used by other slash commands does the entire job.
      try {
        await postSlashCommandAck(env, { cmd: "help" }, {
          owner: job.owner, repo: job.repo, prNumber: job.prNumber,
          installationId: job.installationId,
        })
      } catch (err) {
        console.error(JSON.stringify({
          event: "pr-help-error",
          err: err instanceof Error ? err.message : String(err),
          owner: job.owner, repo: job.repo, prNumber: job.prNumber,
        }))
      }
      return
    }
    case "pr-describe":
      // ARC-191 / ARC-264: `/sigilix describe [apply] [mode]`.
      // Single-shot LLM call producing a PR description / changelog
      // draft. With `apply: false` (default) it posts a top-level
      // comment with marker-wrapped body. With `apply: true` it
      // writes the same draft into the PR body in place. Both paths
      // share the same model call + verdict; only the post step
      // differs. Independent of the ensemble; does NOT consume the
      // ensemble daily budget.
      try {
        await postSlashCommandAck(env, { cmd: "describe", mode: job.mode, apply: job.apply }, {
          owner: job.owner, repo: job.repo, prNumber: job.prNumber,
          installationId: job.installationId,
        })
      } catch (err) {
        console.error(JSON.stringify({
          event: "slash-command-ack-failed",
          err: err instanceof Error ? err.message : String(err),
          owner: job.owner, repo: job.repo, prNumber: job.prNumber,
          cmd: "describe",
          mode: job.mode,
          apply: job.apply,
        }))
      }
      return handlePrDescribe({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
        mode: job.mode,
        apply: job.apply,
        env,
      })
    case "pr-stale-mark":
      // ARC-184: review-provenance stale marker. Independent of any
      // model call; consumes only GitHub-side metadata + a single
      // PATCH per drift. Wrapped in try/catch so a failure here never
      // blocks the queue dispatch loop — the handler itself emits
      // structured telemetry on every branch.
      try {
        await handlePrStaleMark({
          env,
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          installationId: job.installationId,
          manifestSnapshot: job.manifestSnapshot,
          newHeadSha: job.newHeadSha,
          newBaseSha: job.newBaseSha,
          currentPromptVersion: job.currentPromptVersion,
        })
      } catch (err) {
        console.error(JSON.stringify({
          event: "pr-stale-mark-bubbled",
          err: err instanceof Error ? err.message : String(err),
          owner: job.owner, repo: job.repo, prNumber: job.prNumber,
        }))
        throw err
      }
      return
    case "ci-triage":
      return handleCiTriage({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        runId: job.runId,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
      })
    case "github-mention":
      return handleGithubMention({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
        surface: job.surface,
        commentId: job.commentId,
        ...(job.threadRootId !== undefined ? { threadRootId: job.threadRootId } : {}),
        env,
      })
    case "index-repo":
      // ARC-235: customer-ready indexing consumer. Bootstrap jobs walk
      // the default-branch tree + filter to indexable files + process
      // up to MAX_FILES_PER_JOB. Shard jobs continue the chain via
      // continuation tokens. See src/lib/indexer.ts for the full
      // state machine.
      return handleIndexRepoJob({ job, env })
    case "delete-repo-index": {
      const repoState = job.branch ? await branchStateRepo(job.repo, job.branch) : job.repo
      const result = await deleteRepoIndex({
        env,
        owner: job.owner,
        repo: repoState,
        reason: job.reason,
      })
      if (result.status === "partial") {
        throw new Error(`delete-repo-index partial for ${job.owner}/${repoState}`)
      }
      return
    }
    case "pr-pause":
      // SIG-98: `/sigilix pause` — 24h auto-review pause.
      return handlePrPause({
        env, owner: job.owner, repo: job.repo, prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "pr-resume":
      // SIG-98: `/sigilix resume` — clears pause + ignore flags.
      return handlePrResume({
        env, owner: job.owner, repo: job.repo, prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "pr-ignore":
      // SIG-98: `/sigilix ignore` — permanent auto-review opt-out.
      return handlePrIgnore({
        env, owner: job.owner, repo: job.repo, prNumber: job.prNumber,
        installationId: job.installationId,
      })
    case "pr-resolve-threads":
      // SIG-98: `/sigilix resolve` — mark Sigilix-rooted threads
      // resolved via the GraphQL `resolveReviewThread` mutation.
      return handlePrResolveThreads({
        env, owner: job.owner, repo: job.repo, prNumber: job.prNumber,
        installationId: job.installationId,
      })
    default: {
      // Exhaustiveness check — if a new JobMessage variant is added but
      // not handled here, TypeScript flags it via the `never` type at
      // compile time, AND we throw at runtime so a stale producer/
      // consumer pairing surfaces loudly instead of silently acking.
      const exhaustive: never = job
      throw new Error(
        `unknown queue job type: ${JSON.stringify(exhaustive).slice(0, 200)}`
      )
    }
  }
}

async function handleLinearWebhook(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get("linear-signature") ?? ""

  const verified = await verifyLinearWebhook(rawBody, signature, env.LINEAR_WEBHOOK_SECRET)
  if (!verified) {
    return new Response("invalid signature\n", { status: 401 })
  }

  let payload: LinearWebhookPayload
  try {
    payload = JSON.parse(rawBody) as LinearWebhookPayload
  } catch {
    return new Response("invalid json\n", { status: 400 })
  }

  // Issue.create → enqueue full triage pipeline.
  if (payload.type === "Issue" && payload.action === "create") {
    if (env.OPENCLAW_TEAM_KEY && payload.data.team?.key !== env.OPENCLAW_TEAM_KEY) {
      console.warn("team scope mismatch", {
        got: payload.data.team?.key ?? null,
        want: env.OPENCLAW_TEAM_KEY,
      })
      return new Response("team scope mismatch\n", { status: 200 })
    }
    await env.OPENCLAW_JOBS.send({ type: "linear-triage", issueId: payload.data.id })
    return new Response("queued\n", { status: 202 })
  }

  // Comment.create → enqueue mention-reply pipeline if EITHER:
  //   (a) body explicitly @-mentions Sigilix (legacy "fresh thread" path), or
  //   (b) SIG-225: the comment is a reply inside a thread Sigilix has
  //       already posted in — implicit follow-up trigger, no @ needed.
  //
  // (b) lifts the conversational friction founders hit when they reply
  // multiple times to a Sigilix answer in the same thread and have to
  // re-type `@sigilix` on every turn. Top-level (no parent) comments
  // still require explicit @-mention — we don't fire on every new
  // comment in any Sigilix-touched issue.
  if (payload.type === "Comment" && payload.action === "create") {
    const author =
      payload.data.user?.displayName ?? payload.data.user?.name ?? null

    // SIG-225 — primary self-filter: the bot stamps every commentId
    // it creates in KV at post-time (see markBotAuthoredComment in
    // triage.ts + mention-reply.ts). If Linear's Comment.create
    // webhook for THIS comment arrives, we recognize the id and skip.
    // Deterministic — no dependency on what Linear puts in data.user.
    //
    // Why this layer exists: PR #196/#198/#200 shipped the thread-
    // followup trigger, and the bot started looping in prod because
    // the displayName-based isBotHandle() filter missed when Linear
    // populated data.user with the OAuth app owner's identity instead
    // of the bot's. The legacy filter stays as the cold-cache backstop
    // (Cloudflare KV is eventually consistent — a put from the queue
    // worker may not be visible on a different POP for ~60s).
    if (await isBotAuthoredComment(env.OPENCLAW_STATE, payload.data.id)) {
      console.log("linear comment skip self", {
        reason: "bot-authored-tracker",
        commentId: payload.data.id,
      })
      return new Response("skip self\n", { status: 200 })
    }

    // Self-author guard runs FIRST — regardless of trigger path, Sigilix
    // must never reply to its own comments (would loop). Moved above the
    // mention check (was below in legacy code) so the SIG-225 thread-walk
    // path also gets it without duplication. Shared isBotHandle() helper
    // is the single source of truth; defense-in-depth same check runs
    // again inside handleMention().
    if (isBotHandle(author)) {
      console.log("linear comment skip self", {
        reason: "is-bot-handle",
        commentId: payload.data.id,
      })
      return new Response("skip self\n", { status: 200 })
    }

    const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
    const body = payload.data.body ?? ""

    let triggerReason: "mention" | "thread-followup" | null = null
    if (bodyMentionsBot(body, triggers)) {
      triggerReason = "mention"
    } else if (payload.data.parentId && payload.data.issueId) {
      // SIG-225 thread-walk path. Top-level comments without @ skip this
      // entirely — no `parentId`. Two-pass to defeat the two failure
      // modes the snapshot can hit:
      //
      //   PASS 1 (cheap):  `getCommentParents(issueId)` returns up to
      //     100 most-recently-updated comments; helper walks the chain.
      //     Covers ~all real-world threads in one GraphQL call.
      //
      //   PASS 2 (backstop, only on pass-1 miss): direct
      //     `getCommentAuthor(parentId)` lookup of just the parent.
      //     Defeats (a) deep threads where the chain reaches past 100
      //     comments, and (b) replica-lag races where the user replies
      //     within ~1s of Sigilix's post and the snapshot hasn't caught
      //     up. Code-reviewer P1 catches on PR #196.
      //
      // Any thrown error in EITHER pass falls through to "no mention"
      // so the legacy @-mention path is unaffected. We accept the
      // miss — a missed thread-followup is better than a queue spend
      // on every webhook in a Linear API outage.
      const parentId = payload.data.parentId
      const issueId = payload.data.issueId
      // Hard 2s timeout per GraphQL call so the webhook never blocks
      // longer than Linear's webhook ack window. Sigilix bot + CodeRabbit
      // both flagged P1 on PR #196: an indefinite hang would miss the
      // ack deadline and cause Linear to redeliver, fanning out
      // duplicate work through the queue. AbortError is caught by the
      // existing try-blocks and falls closed to "no mention" — same
      // path as any other GraphQL error.
      try {
        const linear = new LinearClient(await buildLinearAuth(env))
        const comments = await linear.getCommentParents(issueId, {
          signal: AbortSignal.timeout(2000),
        })
        if (commentHasSigilixAncestor({ startParentId: parentId, comments })) {
          triggerReason = "thread-followup"
        } else {
          // Pass-1 miss → direct parent lookup. Cheap (single comment).
          try {
            const parent = await linear.getCommentAuthor(parentId, {
              signal: AbortSignal.timeout(2000),
            })
            const parentLogin =
              parent?.user?.displayName ?? parent?.user?.name ?? null
            if (isBotHandle(parentLogin)) {
              triggerReason = "thread-followup"
            }
          } catch (err) {
            console.warn("sig-225 parent-lookup failed", {
              commentId: payload.data.id,
              parentId,
              err: String(err),
            })
          }
        }
      } catch (err) {
        console.warn("sig-225 thread-walk failed", {
          commentId: payload.data.id,
          issueId,
          err: String(err),
        })
      }
    }

    if (!triggerReason) {
      return new Response("no mention\n", { status: 200 })
    }

    console.log("linear comment trigger", {
      reason: triggerReason,
      commentId: payload.data.id,
      // SIG-225 diagnostics — presence-only, NO raw identity values.
      // Sigilix bot + CodeRabbit flagged the prior `user:
      // payload.data.user` log on PR #201 as a PII leak into
      // Cloudflare Logs. Boolean shape flags + the isBotHandle
      // verdict are enough to confirm or rule out the "data.user =
      // OAuth app owner" hypothesis without exposing the actual
      // displayName/name/id values. If the tracker misses a self-
      // re-fire, we'll see `reason: triggerReason` with
      // `userIdPresent: true` + `isBotHandleMatch: false` and know
      // Option A (`user.id === bot_viewer_id`) is the right Layer 2.
      userIdPresent: !!payload.data.user?.id,
      userDisplayNamePresent: !!payload.data.user?.displayName,
      userNamePresent: !!payload.data.user?.name,
      isBotHandleMatch: isBotHandle(author),
    })
    await env.OPENCLAW_JOBS.send({
      type: "linear-mention",
      commentId: payload.data.id,
      triggerReason,
    })
    return new Response("queued\n", { status: 202 })
  }

  return new Response("skipped\n", { status: 200 })
}

async function handleManualTrigger(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  // Manual trigger is gated by a static API key. Auth is intentionally
  // shared with LINEAR_API_KEY so there's no extra secret to manage;
  // the route exists for ad-hoc re-triage during dev.
  const auth = request.headers.get("authorization") ?? ""
  const expected = `Bearer ${env.LINEAR_API_KEY}`
  if (auth !== expected) {
    return new Response("unauthorized\n", { status: 401 })
  }

  let body: { issueId?: string }
  try {
    body = (await request.json()) as { issueId?: string }
  } catch {
    return new Response("invalid json\n", { status: 400 })
  }
  if (!body.issueId || typeof body.issueId !== "string") {
    return new Response("missing issueId\n", { status: 400 })
  }

  await env.OPENCLAW_JOBS.send({ type: "linear-triage", issueId: body.issueId })
  return new Response("queued\n", { status: 202 })
}

async function handleGitHubWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !env.GITHUB_WEBHOOK_SECRET) {
    return new Response("github app not configured\n", { status: 503 })
  }

  const rawBody = await request.text()
  const sig = request.headers.get("x-hub-signature-256") ?? ""
  const event = request.headers.get("x-github-event") ?? ""

  const verified = await verifyGitHubWebhook(rawBody, sig, env.GITHUB_WEBHOOK_SECRET)
  if (!verified) {
    return new Response("invalid signature\n", { status: 401 })
  }

  let payload: GitHubWebhookPayload
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload
  } catch {
    return new Response("invalid json\n", { status: 400 })
  }

  // GitHub fires `ping` when a webhook URL is set or updated. Ack and
  // move on — no installation/repo context, nothing to enqueue.
  if (event === "ping") {
    return new Response("pong\n", { status: 200 })
  }

  // App-level events have no repository field. ARC-234 intercepts the
  // two install-onboarding events that drive the customer-ready
  // indexing pipeline (`installation.created` initial set +
  // `installation_repositories.added` deltas). ARC-238 intercepts the
  // two deletion events. The rest stay dropped.
  if (
    event === "installation" ||
    event === "installation_repositories" ||
    event === "installation_target" ||
    event === "github_app_authorization"
  ) {
    const installationId = payload.installation?.id
    // ARC-238 (Codex v1 B6): uninstall + repos-removed delete fires
    // REGARDLESS of `OPENCLAW_INDEXER_ENABLED`. If the operator turns
    // the indexer off for cost reasons, prior customer data must
    // still be deletable on uninstall (GDPR / SOC 2).
    if (
      event === "installation_repositories" &&
      payload.action === "removed" &&
      typeof installationId === "number"
    ) {
      const removed = payload.repositories_removed ?? []
      try {
        const { results, anyError } = await handleInstallReposRemoved({
          env, installationId, repositories: removed,
        })
        if (anyError) {
          console.error(JSON.stringify({
            event: "index-delete-fanout-partial",
            installation_id: installationId,
            reason: "install-repos-removed",
            count: results.length,
          }))
          return new Response("delete fanout partial\n", { status: 503 })
        }
        return new Response("repos-removed deleted\n", { status: 202 })
      } catch (err) {
        console.error(JSON.stringify({
          event: "index-delete-fanout-threw",
          installation_id: installationId,
          reason: "install-repos-removed",
          err: err instanceof Error ? err.message : String(err),
        }))
        return new Response("delete fanout threw\n", { status: 503 })
      }
    }
    if (
      event === "installation" &&
      payload.action === "deleted" &&
      typeof installationId === "number"
    ) {
      const ownerLogin = payload.installation?.account?.login
      if (typeof ownerLogin !== "string" || ownerLogin.length === 0) {
        // No account.login means we can't disambiguate which repos to
        // delete. Log + return 200 so GitHub doesn't redeliver — there's
        // no actionable retry from our side.
        console.error(JSON.stringify({
          event: "index-delete-missing-account-login",
          installation_id: installationId,
        }))
        return new Response("missing account.login\n", { status: 200 })
      }
      try {
        const { results, anyError } = await handleInstallationDeleted({
          env, installationId, ownerLogin,
          // code-reviewer HIGH-1: GitHub ships `repositories[]` on
          // `installation.deleted`. Use it as the authoritative
          // discovery source so we clean up indexer-disabled installs
          // (no repo-index-manifest to find) too. KV scan still runs
          // as a backup for orphans.
          ...(Array.isArray(payload.repositories)
            ? { repositoriesFromPayload: payload.repositories }
            : {}),
        })
        if (anyError) {
          console.error(JSON.stringify({
            event: "index-delete-fanout-partial",
            installation_id: installationId,
            reason: "install-deleted",
            count: results.length,
          }))
          return new Response("delete fanout partial\n", { status: 503 })
        }
        return new Response("installation deleted\n", { status: 202 })
      } catch (err) {
        console.error(JSON.stringify({
          event: "index-delete-fanout-threw",
          installation_id: installationId,
          reason: "install-deleted",
          err: err instanceof Error ? err.message : String(err),
        }))
        return new Response("delete fanout threw\n", { status: 503 })
      }
    }

    if (
      isIndexerEnabled(env) &&
      typeof installationId === "number" &&
      (
        (event === "installation" && payload.action === "created") ||
        (event === "installation_repositories" && payload.action === "added")
      )
    ) {
      const repositories =
        event === "installation"
          ? payload.repositories ?? []
          : payload.repositories_added ?? []
      const reason: IndexJobReason =
        event === "installation" ? "install" : "install-repos-added"
      try {
        const result = await enqueueIndexJobsForRepos({
          env,
          installationId,
          repositories,
          reason,
        })
        // Codex v2 N5: when EVERY non-sensitive enqueue failed (e.g.
        // the OPENCLAW_JOBS binding is broken), surface 503 so GitHub
        // redelivers. Partial successes return 202 — per-repo failures
        // are already logged and redelivery would double-enqueue the
        // successful ones.
        //
        // CodeRabbit catch on PR #76: subtract `sensitiveSkipped` from
        // the denominator. An install where every repo is on the
        // sensitive denylist has `attempted > 0 && succeeded === 0`
        // but is NOT a fanout failure — it's a deliberate no-op, and
        // 503'ing would trigger an infinite GitHub redelivery loop
        // (each redelivery would hit the same denylist and 503 again).
        const nonSensitiveAttempts = result.attempted - result.sensitiveSkipped
        if (nonSensitiveAttempts > 0 && result.succeeded === 0) {
          console.error(JSON.stringify({
            event: "index-job-fanout-total-failure",
            installation_id: installationId,
            attempted: result.attempted,
            per_repo_failed: result.perRepoFailed,
            sensitive_skipped: result.sensitiveSkipped,
            reason,
          }))
          return new Response("index fanout failed\n", { status: 503 })
        }
        console.log(JSON.stringify({
          event: "index-job-fanout-done",
          installation_id: installationId,
          reason,
          ...result,
        }))
        return new Response("indexed\n", { status: 202 })
      } catch (err) {
        // Defensive: enqueueIndexJobsForRepos has per-repo try/catch
        // internally so this branch is for unexpected throws (env
        // shape mismatch, etc.). Surface 503 so GitHub redelivers.
        console.error(JSON.stringify({
          event: "index-job-fanout-threw",
          installation_id: installationId,
          reason,
          err: err instanceof Error ? err.message : String(err),
        }))
        return new Response("index fanout threw\n", { status: 503 })
      }
    }
    return new Response("app-level event ignored\n", { status: 200 })
  }

  const installationId = payload.installation?.id
  const owner = payload.repository?.owner?.login
  const repo = payload.repository?.name
  if (!installationId || !owner || !repo) {
    return new Response("missing installation / repo\n", { status: 400 })
  }

  if (event === "pull_request") {
    const action = payload.action
    const pr = payload.pull_request
    if (!pr || typeof pr.number !== "number") {
      return new Response("missing pr\n", { status: 400 })
    }
    const headRepoFullName = pr.head?.repo?.full_name
    const headIsSameRepo =
      typeof headRepoFullName === "string" &&
      headRepoFullName.toLowerCase() === `${owner}/${repo}`.toLowerCase()
    if (headIsSameRepo) {
      ctx.waitUntil(
        maybeEnqueuePullRequestBranchIndexJobs({
          env,
          owner,
          repo,
          installationId,
          action,
          draft: pr.draft,
          headRef: pr.head?.ref,
          baseRef: pr.base?.ref,
          merged: pr.merged,
        }).catch((err) => {
          console.warn(JSON.stringify({
            event: "index-pr-branch-enqueue-failed",
            owner, repo, prNumber: pr.number,
            action,
            err: err instanceof Error ? err.message : String(err),
          }))
        }),
      )
    } else {
      console.log(JSON.stringify({
        event: "index-pr-branch-skip-fork",
        owner, repo, prNumber: pr.number,
        head_repo: headRepoFullName,
      }))
    }
    if (pr.draft) {
      const headSha = pr.head?.sha ?? ""
      const supportedDraftActions = new Set([
        "opened",
        "synchronize",
        "reopened",
        "converted_to_draft",
      ])
      if (headSha && supportedDraftActions.has(action ?? "")) {
        try {
          const token = await getInstallationToken({
            kv: env.OPENCLAW_STATE,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_PRIVATE_KEY,
            installationId,
          })
          const client = new GitHubClient({ token })
          await postDraftPrSkipNotice({
            env,
            client,
            owner,
            repo,
            prNumber: pr.number,
            headSha,
          })
        } catch (err) {
          console.warn(JSON.stringify({
            event: "pr-draft-skip-notice-auth-failed",
            owner, repo, prNumber: pr.number,
            headSha: headSha.slice(0, 7),
            err: err instanceof Error ? err.message : String(err),
          }))
        }
      }
      return new Response("skip draft\n", { status: 200 })
    }
    const decideArgs: Parameters<typeof decidePullRequestJobs>[0] = {
      action: action ?? "",
      draft: false,
      skipReleasePromotions: env.OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES === "on",
    }
    if (pr.base?.ref) decideArgs.baseRef = pr.base.ref
    if (pr.head?.ref) decideArgs.headRef = pr.head.ref
    const decision = decidePullRequestJobs(decideArgs)
    if (!decision.overview && !decision.review) {
      return new Response("skip pr action\n", { status: 200 })
    }
    const prNumber = pr.number
    const headSha = pr.head?.sha ?? ""
    if (!headSha) return new Response("missing head sha\n", { status: 400 })

    // SIG-219 restoration of the pre-review "Reviewing…" sticky:
    //
    // SIG-216 originally dropped the stub-post entirely under the
    // theory that the inline overview render inside the ensemble
    // (immediately before `submitReview`) would land both comments
    // in the same time window — CodeRabbit-style Walkthrough +
    // Review.
    //
    // Founder feedback (2026-05-26): the WANTED UX is closer to
    // CodeRabbit's actual behavior — a sticky "Reviewing…" comment
    // appears immediately on push and MORPHS into the overview when
    // the models finish, rather than appearing only at the end.
    // SIG-216 lost that "reviewing" affordance entirely. Restore
    // the stub-post here so:
    //
    //   1. The "Reviewing…" sticky lands within the webhook ack
    //      window (~sub-second).
    //   2. The inline overview path inside `handlePrReviewEnsemble`
    //      finds the stub via its existing `scanComments` + PATCH
    //      logic and rewrites the body in place — no second
    //      comment is created, no ordering wait is needed.
    //   3. The SIG-216 win (no separate `pr-overview` queue job
    //      stretching wall-clock by ~30s) is preserved: we only
    //      dispatch the standalone pr-overview job for the
    //      review-skipped branch below, exactly as before.
    //
    // We still load sigilix.json + build the GitHub client here for
    // the `ready_for_review` draft-skip supersede call below, the
    // stub-post itself, and future webhook-time gates. Best-effort:
    // `loadSigilixConfig` never throws — missing/invalid config
    // resolves to `EMPTY_CONFIG`, which has `overview === undefined`,
    // which `isPrOverviewEnabled` treats as enabled (default-on per
    // Codex Q5). The pr-review ensemble re-loads the config at the
    // head SHA itself, so a failure here is non-blocking.
    let webhookSigilixConfig: Awaited<ReturnType<typeof loadSigilixConfig>> | null = null
    let webhookClient: GitHubClient | null = null
    if (decision.overview || decision.review) {
      try {
        const token = await getInstallationToken({
          kv: env.OPENCLAW_STATE,
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_PRIVATE_KEY,
          installationId,
        })
        webhookClient = new GitHubClient({ token })
        webhookSigilixConfig = await loadSigilixConfig(webhookClient, owner, repo, headSha)
      } catch (err) {
        // Auth + config-load failures here are non-blocking: the
        // ensemble re-loads config at the head SHA and gates the
        // inline overview render itself; the draft-skip supersede
        // is best-effort.
        console.warn(JSON.stringify({
          event: "pr-overview-webhook-config-load-failed",
          owner, repo, prNumber, head_sha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    const overviewEnabled = isPrOverviewEnabled(webhookSigilixConfig)

    if (action === "ready_for_review" && webhookClient !== null) {
      try {
        await supersedeDraftPrSkipNotice({
          client: webhookClient,
          owner,
          repo,
          prNumber,
          headSha,
        })
      } catch (err) {
        console.warn(JSON.stringify({
          event: "pr-draft-skip-notice-supersede-unexpected-failed",
          owner, repo, prNumber,
          headSha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
        }))
      }
    }

    if (decision.overview && !overviewEnabled) {
      // SIG-216: customer opted out of pr-overview via
      // `sigilix.overview.enabled = false`. The ensemble's inline
      // overview render is gated on the same flag — log here so the
      // disable signal stays visible at webhook time.
      //
      // SIG-90: pr-labels is ENQUEUED INDEPENDENTLY below (founder
      // direction "labels should exist"). It is NOT gated by
      // overview.enabled.
      console.log(JSON.stringify({
        event: "pr-overview-skipped-disabled",
        owner, repo, prNumber, head_sha: headSha.slice(0, 7),
      }))
    }
    // ARC-265 + SIG-90: auto-label picker fires alongside pr-overview
    // (same webhook events: opened / synchronize / reopened /
    // ready_for_review). Independent of `overview.enabled` per
    // founder direction — labels are a separate product capability
    // and should be available even when overview is opted out.
    // The handler short-circuits only if `labels.enabled:false`.
    if (decision.overview) {
      await env.OPENCLAW_JOBS.send({
        type: "pr-labels",
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
      })
    }
    // SIG-216 + this fix-up — overview normally runs inline inside the
    // review handler (drop-the-stub pattern: the two comments land in
    // the same window). But when the review is skipped
    // (`decision.overview && !decision.review`, e.g. release-branch
    // gate via OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES), the ensemble
    // never fires, so the inline overview never lands. Restore the
    // legacy standalone `pr-overview` queue dispatch for that branch
    // ONLY — when both decisions are true, the inline path remains
    // the single source of truth.
    //
    // Skipped when the config disables overview (`overviewEnabled`
    // is the result of `isPrOverviewEnabled` against the head-SHA
    // config loaded above). The corresponding telemetry event
    // `pr-overview-skipped-disabled` already fired up the file.
    if (decision.overview && !decision.review && overviewEnabled) {
      await env.OPENCLAW_JOBS.send({
        type: "pr-overview",
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
      })
    }
    // pr-review fires on `opened`, `ready_for_review`, AND `synchronize`
    // so the bot keeps verifying after each fix push (and can flip to
    // APPROVE when the diff is clean). The consumer carries a per-
    // (prNumber, headSha) dedupe key + a stale-head guard, so retries
    // and out-of-order delivery don't produce duplicate or wrong-diff
    // reviews. `ready_for_review` catches drafts that were skipped on
    // `opened`. See decidePullRequestJobs() for the gating contract.
    if (decision.review) {
      const baseSha: string | null = pr.base?.sha ?? null
      // SIG-89: skip pr-review dispatch on byte-identical `synchronize`
      // pushes (Update-branch button, rebase-on-main no-op force push,
      // empty commit, merge-from-main without resolution drift). The
      // prior review still applies — re-running the ensemble would
      // burn budget + post a redundant timeline entry. CodeRabbit
      // demonstrates this UX; SIG-89 brings Sigilix to parity.
      //
      // First-review pushes (no prior hash stashed) and `opened` /
      // `reopened` / `ready_for_review` actions are unaffected — only
      // `synchronize` triggers the diff-hash compare. The pr-overview
      // path above is intentionally unaffected.
      //
      // Best-effort: any failure (KV miss, diff-fetch error, hash
      // mismatch) falls through to the existing dispatch path so the
      // worst case is a wasted review run, never a missed review.
      //
      // Kill-switch: set `OPENCLAW_NOOP_MERGE_SKIP_ENABLED=off` to
      // disable the entire compare path without redeploying — useful
      // if the diff-fetch latency tax or a false-skip regression
      // surfaces in prod. `webhookClient` is non-null whenever
      // decision.overview or decision.review is true and auth
      // succeeded above (line 1531-1552); we check it here so the
      // fall-through-on-auth-failure path stays safe.
      //
      // Diff fetch is capped at 2s via `AbortSignal.timeout(2000)`
      // so a slow GitHub response can't stall the webhook past
      // GitHub's ~10s redelivery threshold. On timeout/abort the
      // catch falls through to the normal dispatch path (fail-open).
      let skipNoopMerge = false
      if (
        env.OPENCLAW_NOOP_MERGE_SKIP_ENABLED !== "off" &&
        action === "synchronize" &&
        webhookClient !== null
      ) {
        try {
          const prior = await readPriorReviewDiffHash(env, owner, repo, prNumber)
          if (prior !== null) {
            const currentDiff = await webhookClient.getPullRequestDiff(
              owner, repo, prNumber,
              { signal: AbortSignal.timeout(2000) },
            )
            const currentHash = await computeDiffHash(currentDiff)
            if (currentHash === prior.diffHash) {
              skipNoopMerge = true
              console.log(JSON.stringify({
                event: "pr-review-skipped-noop-merge",
                owner, repo, prNumber,
                priorHeadSha: prior.reviewedHeadSha,
                newHeadSha: headSha,
                diffHashSha7: currentHash.slice(0, 7),
              }))
            }
          }
        } catch (err) {
          console.warn(JSON.stringify({
            event: "pr-review-noop-merge-detect-failed",
            owner, repo, prNumber,
            err: err instanceof Error ? err.message : String(err),
          }))
        }
      }
      if (skipNoopMerge) {
        return new Response("queued\n", { status: 202 })
      }
      // SIG-219: post the "Reviewing…" sticky in the background so it
      // lands on the PR timeline within ~1s of the webhook ack
      // without blocking the ack itself. The inline overview path
      // inside `handlePrReviewEnsemble` will find the marker comment
      // via its `scanComments` + PATCH logic when the ensemble
      // completes (minutes later) and morph the body in place — no
      // second comment is created, no ordering barrier is required.
      //
      // Sigilix bot P2 PERF catch on PR #180: the original
      // implementation was `await postPrOverviewStubIfNeeded(...)`
      // on the webhook response path. That call does 2–4 sequential
      // network round-trips (KV idempotency read, GitHub
      // `listComments` marker scan, GitHub POST on first delivery,
      // KV flag write) for ~400–1500ms typical and multi-second
      // under API spikes. The repo's perf rules target ~50ms for the
      // webhook ack — `ctx.waitUntil` lets the work continue after
      // the 202 returns. There's no race with the inline overview's
      // own `scanComments`: the review handler doesn't run that
      // scan until after specialist fan-out + synth (minutes), long
      // after the stub-post has landed.
      //
      // Placement: AFTER the noop-merge skip-short-circuit (so a
      // diff-identical synchronize push doesn't flash an orphan
      // "Reviewing…" sticky that never updates), BEFORE the queue
      // enqueue (so the stub-post is queued first; ordering doesn't
      // matter for correctness but reads better in logs).
      //
      // Best-effort throughout: `postPrOverviewStubIfNeeded` returns
      // a structured outcome but never throws. The KV flag + marker
      // scan make a second webhook delivery for the same
      // (owner, repo, prNumber, headSha) idempotent — webhook
      // redelivery, an internal 5xx with retry, and rapid double
      // pushes all converge on a single sticky.
      //
      // Gates:
      //   - `overviewEnabled` — opt-out customers don't get a stub.
      //   - `webhookClient !== null` — auth succeeded; otherwise
      //     skip the stub-post and let the inline overview path
      //     POST a fresh comment from scratch when the ensemble
      //     runs.
      if (overviewEnabled && webhookClient !== null) {
        ctx.waitUntil(
          postPrOverviewStubIfNeeded({
            env,
            owner,
            repo,
            prNumber,
            headSha,
            installationId,
            client: webhookClient,
          }).then((stubOutcome) => {
            console.log(JSON.stringify({
              event: "pr-overview-stub-outcome",
              owner, repo, prNumber, head_sha: headSha.slice(0, 7),
              outcome: stubOutcome.kind,
              ...("commentId" in stubOutcome ? { comment_id: stubOutcome.commentId } : {}),
              ...("reason" in stubOutcome ? { reason: stubOutcome.reason } : {}),
              ...("phase" in stubOutcome ? { phase: stubOutcome.phase } : {}),
            }))
          }).catch((err) => {
            // `postPrOverviewStubIfNeeded` is structured-outcome
            // (never throws), but the `.then` callback above could
            // technically throw (JSON.stringify on a circular object,
            // etc.). Catch + log so a deferred error can't propagate
            // up to the runtime and surface as an unhandled rejection.
            console.warn(JSON.stringify({
              event: "pr-overview-stub-deferred-failed",
              owner, repo, prNumber, head_sha: headSha.slice(0, 7),
              err: err instanceof Error ? err.message : String(err),
            }))
          }),
        )
      }
      // SIG-174: automatic webhook reviews always route through the
      // DO-backed post path. Awaited (NOT ctx.waitUntil) so a DO
      // failure surfaces as 503 to GitHub for redelivery.
      //
      // SIG-247 Phase 1: extract the immutable repo.id from the
      // webhook payload with the same positive-integer guard the
      // push-indexer uses (line 2827-2832). Threads through to
      // RunState + JobMessage so the consumer's review-memory lookup
      // hits the dual-write keyspace.
      const prReviewRepoId =
        typeof payload.repository?.id === "number" &&
        Number.isInteger(payload.repository.id) &&
        payload.repository.id > 0
          ? payload.repository.id
          : undefined
      const enq = await enqueuePrReviewJob(env, {
        owner,
        repo,
        prNumber,
        headSha,
        baseSha,
        installationId,
        deliveryId: request.headers.get("x-github-delivery"),
        ...(prReviewRepoId !== undefined ? { repoId: prReviewRepoId } : {}),
      })
      if (!enq.ok) {
        return new Response("do enqueue failed\n", { status: 503 })
      }
      // ARC-184: when the action is `synchronize` or `edited` AND a
      // prior review-manifest exists, enqueue a parallel `pr-stale-mark`
      // job. The stale-mark consumer detects drift and PATCHes the
      // prior review's body with a stale notice — this gives the user
      // an immediate "old verdict no longer applies" signal while the
      // fresh review is in flight (~30-90s).
      //
      // No manifest = no prior review to mark stale (first-review or
      // pre-ARC-184 PR). Skip silently. Kill-switch via
      // OPENCLAW_REVIEW_MANIFEST_ENABLED=off short-circuits both the
      // KV read and the enqueue.
      if (
        env.OPENCLAW_REVIEW_MANIFEST_ENABLED !== "off" &&
        (action === "synchronize" || action === "edited") &&
        baseSha
      ) {
        try {
          const result = await readReviewManifest(env, owner, repo, prNumber)
          if (result.kind === "ok") {
            await env.OPENCLAW_JOBS.send({
              type: "pr-stale-mark",
              owner,
              repo,
              prNumber,
              installationId,
              manifestSnapshot: result.manifest,
              newHeadSha: headSha,
              newBaseSha: baseSha,
              currentPromptVersion: PROMPT_VERSION,
            })
          }
        } catch (err) {
          console.error(JSON.stringify({
            event: "pr-stale-mark-enqueue-failed",
            err: err instanceof Error ? err.message : String(err),
            owner, repo, prNumber,
          }))
        }
      }
    }
    return new Response("queued\n", { status: 202 })
  }

  if (event === "workflow_run") {
    const action = payload.action
    const run = payload.workflow_run
    if (action !== "completed" || !run) {
      return new Response("skip workflow_run action\n", { status: 200 })
    }
    if (run.conclusion !== "failure") {
      return new Response("skip non-failure\n", { status: 200 })
    }
    const prRef = run.pull_requests?.[0]
    if (!prRef || typeof prRef.number !== "number") {
      return new Response("workflow_run not on a PR\n", { status: 200 })
    }
    const headSha = run.head_sha ?? prRef.head?.sha ?? ""
    if (!headSha) return new Response("missing head sha\n", { status: 400 })
    if (typeof run.id !== "number") return new Response("missing run id\n", { status: 400 })

    await env.OPENCLAW_JOBS.send({
      type: "ci-triage",
      owner,
      repo,
      prNumber: prRef.number,
      runId: run.id,
      headSha,
      installationId,
    })
    return new Response("queued\n", { status: 202 })
  }

  // GitHub @-mention reply — top-level PR conversation thread.
  // `issue_comment` fires for both issues and PR conversation comments;
  // we only care when the issue is actually a PR (`issue.pull_request`
  // is present) and the body @-mentions Arc.
  if (event === "issue_comment") {
    if (payload.action !== "created") {
      return new Response("skip issue_comment action\n", { status: 200 })
    }
    if (!payload.issue?.pull_request) {
      return new Response("skip non-PR issue_comment\n", { status: 200 })
    }
    return queueGithubMention({
      env,
      ctx,
      payload,
      owner,
      repo,
      installationId,
      surface: "issue",
      prNumber: payload.issue.number,
    })
  }

  // GitHub @-mention reply — inline PR review comment thread.
  if (event === "pull_request_review_comment") {
    if (payload.action !== "created") {
      return new Response("skip review_comment action\n", { status: 200 })
    }

    // ARC-189: cross-PR review-memory capture. Fires alongside (NOT in
    // place of) the existing mention-trigger pipeline. Runs in
    // ctx.waitUntil(...) so KV reads + GH API parent fetch never
    // block the webhook response. The capture pipeline does its own
    // gate-check (env CAPTURE on AND sigilix.json enabled||captureOnly)
    // and best-effort error swallowing — failure here cannot affect
    // the queueGithubMention path.
    const reviewMemoryComment = payload.comment
    const reviewMemoryPrNumber = payload.pull_request?.number
    if (
      reviewMemoryComment &&
      typeof reviewMemoryComment.id === "number" &&
      typeof reviewMemoryComment.body === "string" &&
      typeof reviewMemoryComment.path === "string" &&
      typeof reviewMemoryPrNumber === "number"
    ) {
      // SIG-247 Phase 1: capture the immutable repo ID from the webhook
      // payload so review-memory writes land at both the legacy and
      // repo-id keyspaces. Mirrors the push-indexer guard at
      // line 2827-2832 — strictly positive integers only; any spoofed
      // or malformed payload falls back to legacy-only via
      // `captureReviewFeedback`'s `getRepository` fallback.
      const reviewMemoryRepoId =
        typeof payload.repository?.id === "number" &&
        Number.isInteger(payload.repository.id) &&
        payload.repository.id > 0
          ? payload.repository.id
          : undefined
      ctx.waitUntil(
        dispatchReviewMemoryCapture({
          env,
          owner,
          repo,
          prNumber: reviewMemoryPrNumber,
          installationId,
          comment: {
            id: reviewMemoryComment.id,
            body: reviewMemoryComment.body,
            path: reviewMemoryComment.path,
            ...(typeof reviewMemoryComment.in_reply_to_id === "number"
              ? { in_reply_to_id: reviewMemoryComment.in_reply_to_id }
              : {}),
          },
          ...(reviewMemoryRepoId !== undefined
            ? { repoId: reviewMemoryRepoId }
            : {}),
        }),
      )
    }

    return queueGithubMention({
      env,
      ctx,
      payload,
      owner,
      repo,
      installationId,
      surface: "review-comment",
      prNumber: payload.pull_request?.number,
    })
  }

  // ARC-237 / SIG-35: push-driven re-index. Fires on every push to a branch
  // ref. The producer refreshes the default branch, configured long-lived
  // branches, and active same-repo PR branches on already-indexed repos
  // (bootstrap stays install-driven). Push storm coalescing falls out of
  // ARC-235's freshness check — 10 pushes in 60s become 1 actual re-walk
  // + 9 cheap skips.
  if (event === "push") {
    if (!isIndexerEnabled(env)) {
      return new Response("push event ignored (indexer off)\n", { status: 200 })
    }
    const outcome = await maybeEnqueuePushIndexJob({
      env,
      owner,
      repo,
      // SIG-243 Phase 1: capture the immutable repo ID from the push
      // payload and thread it to the producer. The producer attaches
      // it to the queue message; the consumer persists it on the
      // manifest. Falls back to `undefined` (treated as legacy) if a
      // webhook arrives without the field. GitHub repo IDs are strictly
      // positive integers; the guard rejects 0 / negative / non-integer
      // / NaN / Infinity at the entry point so a spoofed or malformed
      // payload can't land an invalid `repo-tenant:0` key downstream.
      repoId:
        typeof payload.repository?.id === "number" &&
        Number.isInteger(payload.repository.id) &&
        payload.repository.id > 0
          ? payload.repository.id
          : undefined,
      installationId,
      ref: typeof payload.ref === "string" ? payload.ref : undefined,
      after: typeof payload.after === "string" ? payload.after : undefined,
    })
    if ("enqueued" in outcome && outcome.enqueued) {
      return new Response("push indexed\n", { status: 202 })
    }
    if ("failed" in outcome) {
      // Producer threw on OPENCLAW_JOBS.send (binding broken /
      // backpressure). Surface 503 so GitHub redelivers — the
      // enqueue is the only side-effect, idempotent on the consumer
      // side because chunk ids are content-addressed.
      return new Response("push enqueue failed\n", { status: 503 })
    }
    // Any other `{skipped: ...}` outcome is a deliberate no-op (the
    // producer logged the specific reason).
    return new Response("push skipped\n", { status: 200 })
  }

  return new Response("skipped\n", { status: 200 })
}

/**
 * ARC-189: ctx.waitUntil-side capture-feedback dispatch. Builds an
 * authenticated GitHubClient + loads sigilix.json + invokes
 * captureReviewFeedback. Best-effort end-to-end: errors logged-and-
 * swallowed so the webhook response never depends on KV/GH I/O here.
 *
 * Called from the `pull_request_review_comment.created` webhook
 * branch alongside (NOT in place of) the existing mention pipeline.
 */
async function dispatchReviewMemoryCapture(args: {
  env: Env
  owner: string
  repo: string
  prNumber: number
  installationId: number
  comment: { id: number; body: string; path: string; in_reply_to_id?: number }
  /**
   * SIG-247 Phase 1: GitHub's immutable repo.id from the webhook
   * payload. When present and positive-integer, threads through to
   * `appendSignal` for the dual-write keyspace. Absent on legacy /
   * spoofed / malformed payloads; the capture path then falls back to
   * a `getRepository` lookup before going legacy-only.
   */
  repoId?: number
}): Promise<void> {
  const { env, owner, repo, prNumber, installationId, comment, repoId } = args
  try {
    if (env.OPENCLAW_REVIEW_MEMORY_CAPTURE !== "on") {
      // Cheap pre-flight: env-gate fails fast without paying the
      // installation-token + sigilix.json fetch costs.
      return
    }
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    // sigilix.json is fetched at the PR head sha. The webhook
    // payload doesn't carry headSha for the review-comment event;
    // fall back to the default branch via getFileContent's null
    // semantics — loadSigilixConfig accepts any ref string.
    const sigilixConfig = await loadSigilixConfig(client, owner, repo, "HEAD")
    const config = resolveReviewMemoryConfig(sigilixConfig)
    await captureReviewFeedback({
      env, client, owner, repo, prNumber,
      replyComment: comment,
      config,
      ...(repoId !== undefined ? { repoId } : {}),
    })
  } catch (err) {
    console.log(JSON.stringify({
      event: "review-memory-capture-dispatch-failed",
      owner, repo, prNumber, commentId: comment.id,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

interface QueueGithubMentionArgs {
  env: Env
  /**
   * ARC-190 Task 10: passed through so the slash-command 👀 ack can
   * run via `ctx.waitUntil(...)` — the reaction POST happens in the
   * background without blocking the webhook's 202 response.
   */
  ctx: ExecutionContext
  payload: GitHubWebhookPayload
  owner: string
  repo: string
  installationId: number
  surface: GhMentionSurface
  prNumber: number | undefined
}

/**
 * Common gating for both `issue_comment.created` and
 * `pull_request_review_comment.created`:
 *
 *   1. PR number + comment id are present
 *   2. comment author is NOT Arc itself (prevents reply loops)
 *   3. EITHER body @-mentions Arc, OR (review-comment surface AND has
 *      `in_reply_to_id`) — the second branch is the cheap webhook
 *      signal for "this might be a reply in Arc's thread"; the
 *      handler does the actual chain walk to confirm Arc was above.
 *      Wasted-queue cost is tiny (Cloudflare Queues are ~$0.40/M
 *      messages); the upside is users don't have to retype @arc on
 *      every reply.
 *
 * On pass, enqueues a `github-mention` JobMessage. The body itself is
 * re-fetched from GitHub at handler time so an edit between webhook
 * delivery and processing doesn't reply to stale text.
 */
export async function queueGithubMention(args: QueueGithubMentionArgs): Promise<Response> {
  const { env, ctx, payload, owner, repo, installationId, surface, prNumber } = args
  const comment = payload.comment
  if (!comment || typeof comment.id !== "number") {
    return new Response("missing comment\n", { status: 400 })
  }
  if (typeof prNumber !== "number") {
    return new Response("missing pr number\n", { status: 400 })
  }
  // Self-author guard runs BEFORE the mention check so Arc's own
  // replies (which obviously have `in_reply_to_id` on review-comment)
  // can't open a feedback loop via the implicit-thread path.
  if (isArcGithubLogin(comment.user?.login ?? null)) {
    return new Response("skip self\n", { status: 200 })
  }

  const body = comment.body ?? ""

  // Slash-command dispatch. Recognize `/sigilix <cmd>` at a line
  // start and route to a dedicated job type instead of the generic
  // mention-reply pipeline. Handles `review`, `improve`, `help`, and
  // `describe`. Other commands (e.g. future `ask`) fall silently
  // through to the @-mention pipeline (which means they're ignored
  // unless the same comment also @-mentions Sigilix); README
  // documents this.
  const cleaned = stripQuotesAndCode(body)
  const slashCmd = parseSlashCommand(cleaned)
  if (slashCmd) {
    // ACL gate: slash commands either trigger an LLM call (review,
    // improve) or post a comment (help) — on public repos any
    // commenter could otherwise spam them. Restrict to authors
    // GitHub considers trusted. CONTRIBUTOR is intentionally
    // excluded — anyone whose PR has merged becomes CONTRIBUTOR
    // forever, which is too broad a circle for a privileged channel.
    if (!isAuthorAllowedForSlashCommand(comment.author_association)) {
      const association = (comment.author_association ?? "").toUpperCase()
      console.log(JSON.stringify({
        event: "slash-command-rejected",
        reason: "untrusted_author_association",
        cmd: slashCmd.cmd,
        author_association: association || null,
        login: comment.user?.login ?? null,
        owner, repo, prNumber,
      }))
      return new Response("forbidden\n", { status: 403 })
    }

    // ARC-191 unknown-arg fast path: post the usage comment and
    // return, BEFORE coalesce / dedupe / enqueue. The user's typo
    // shouldn't enter the queue and consume budget; the response is
    // synchronous and tells them how to re-invoke.
    if (slashCmd.cmd === "describe" && slashCmd.mode === "unknown") {
      try {
        const token = await getInstallationToken({
          kv: env.OPENCLAW_STATE,
          appId: env.GITHUB_APP_ID!,
          privateKey: env.GITHUB_PRIVATE_KEY!,
          installationId,
        })
        const client = new GitHubClient({ token })
        await client.createIssueComment(
          owner, repo, prNumber,
          renderSlashCommandAck(slashCmd),
        )
      } catch (err) {
        console.error(JSON.stringify({
          event: "slash-command-usage-post-failed",
          err: err instanceof Error ? err.message : String(err),
          cmd: "describe", rawArg: slashCmd.rawArg,
          owner, repo, prNumber,
        }))
      }
      return new Response("usage posted\n", { status: 200 })
    }

    // Per-command coalesce lock: if the same (PR, command) is in
    // flight, drop subsequent invocations within 60s. Collapses N
    // concurrent posts into 1 ack + 1 LLM run. Keying includes the
    // command name so different commands on the same PR don't
    // accidentally suppress each other.
    // Coalesce key: mode-keyed for describe so `internal` and
    // `external` on the same PR don't suppress each other within
    // the 60s window. ARC-264: also apply-keyed so a `describe pr`
    // and `describe apply pr` on the same PR can both run — one
    // posts a comment, the other writes the body. Other commands
    // keep the existing key shape. (The `unknown` describe variant
    // returned via the fast path above, so here describe.mode is
    // always a canonical DescribeMode.)
    const coalesceKey = slashCmd.cmd === "describe"
      ? `slash-cmd:describe:${slashCmd.mode}${slashCmd.apply ? ":apply" : ""}:${owner}/${repo}#${prNumber}`
      : `slash-cmd:${slashCmd.cmd}:${owner}/${repo}#${prNumber}`
    const existing = await env.OPENCLAW_STATE.get(coalesceKey)
    if (existing) {
      console.log(JSON.stringify({
        event: "slash-command-coalesced",
        coalesceKey, owner, repo, prNumber, cmd: slashCmd.cmd,
      }))
      return new Response("coalesced\n", { status: 202 })
    }
    await env.OPENCLAW_STATE.put(coalesceKey, String(Date.now()), {
      expirationTtl: 60, // 60s — long enough to swallow comment bursts
    })

    // ARC-190 Task 10: 👀 ack on the source comment so the user sees
    // visible feedback within ~1s. Mirrors the @-mention path
    // (github-mention.ts:131-147). Best-effort; runs via
    // ctx.waitUntil so the webhook can return 202 immediately. Fires
    // ONLY when the slash command parsed AND ACL passed AND coalesce
    // didn't hit — earlier branches return without touching this.
    ctx.waitUntil(postSlashCommandEyesAck({
      env, owner, repo,
      commentId: comment.id,
      surface,
      installationId,
    }))

    let message: JobMessage
    switch (slashCmd.cmd) {
      case "review":
        message = {
          type: "pr-review-rerun",
          owner, repo, prNumber, installationId,
        }
        break
      case "full-review":
        // SIG-98: same handler as `review`, with a `forceFresh` flag
        // attached so future dedup layers on the rerun path have an
        // explicit bypass + telemetry can distinguish the two CTAs.
        message = {
          type: "pr-review-rerun",
          owner, repo, prNumber, installationId,
          forceFresh: true,
        }
        break
      case "improve":
        message = {
          type: "pr-improve",
          owner, repo, prNumber, installationId,
        }
        break
      case "help":
        message = {
          type: "pr-help",
          owner, repo, prNumber, installationId,
        }
        break
      case "describe":
        // mode === "unknown" was handled above by the fast path;
        // TypeScript narrows slashCmd here to the canonical-mode
        // variant of the describe union.
        message = {
          type: "pr-describe",
          owner, repo, prNumber, installationId,
          mode: slashCmd.mode,
          // ARC-264: thread the apply flag through to the queue
          // consumer. False (post a comment) is the describe v1
          // behavior; true (write the PR body) is the new path.
          apply: slashCmd.apply,
        }
        break
      case "pause":
        message = { type: "pr-pause", owner, repo, prNumber, installationId }
        break
      case "resume":
        message = { type: "pr-resume", owner, repo, prNumber, installationId }
        break
      case "ignore":
        message = { type: "pr-ignore", owner, repo, prNumber, installationId }
        break
      case "resolve":
        message = { type: "pr-resolve-threads", owner, repo, prNumber, installationId }
        break
      default: {
        const _exhaustive: never = slashCmd
        return _exhaustive
      }
    }
    // CR PR #61 catch: roll back the coalesce key if enqueue fails.
    // Otherwise GitHub redelivers the webhook, sees the key, and
    // returns "coalesced" without ever queueing the command — the
    // original invocation gets silently dropped.
    try {
      await env.OPENCLAW_JOBS.send(message)
    } catch (err) {
      await env.OPENCLAW_STATE.delete(coalesceKey).catch(() => {})
      throw err
    }
    return new Response("queued slash-command\n", { status: 202 })
  }

  const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
  const hasMention = bodyMentionsBot(body, triggers)

  // ARC-269: gate the implicit-thread-reply path. An explicit
  // @-mention always queues (the user typed our handle, intent is
  // clear). An inline review-comment reply WITHOUT a mention only
  // queues when the body looks like a real ask — empty / single-
  // ack / no-signal bodies were burning queue + LLM budget on
  // "fixed" / "thanks" / 👍 replies. The shape gate lives in
  // `shouldQueueReviewThreadReply`; the thread-root-owner gate
  // (was the root authored by Sigilix?) is the consumer's job.
  //
  // Note: this branch fires on ALL review-comment-without-mention
  // payloads, including top-level review comments. The gate's
  // `not-a-reply` reason filters those out. Prior to ARC-269 those
  // returned 200 "no mention"; they now return 200 "skip review-
  // reply: not-a-reply" with a structured telemetry event. Net
  // queue count is unchanged.
  const isReviewCommentWithoutMention = surface === "review-comment" && !hasMention
  // Pre-compute these so both the skip event and the dispatch
  // event carry the same payload-shape facts for post-rollout
  // tuning (code-review M4 catch).
  const bodyLength = body.length
  const bodyEndsWithQ = body.trim().endsWith("?")
  const hadInReplyToId = typeof comment.in_reply_to_id === "number"
  if (isReviewCommentWithoutMention) {
    const gate = shouldQueueReviewThreadReply({
      body,
      authorLogin: comment.user?.login ?? null,
      inReplyToId: comment.in_reply_to_id ?? null,
    })
    if (!gate.ok) {
      console.log(JSON.stringify({
        event: "review-reply-skipped",
        reason: gate.reason,
        owner, repo, prNumber,
        comment_id: comment.id,
        body_length: bodyLength,
        body_ends_with_q: bodyEndsWithQ,
        had_in_reply_to_id: hadInReplyToId,
      }))
      // 200 not 202: we explicitly chose not to queue. The webhook
      // is acknowledged but no work is created.
      return new Response(`skip review-reply: ${gate.reason}\n`, { status: 200 })
    }
  } else if (!hasMention) {
    // Non-review-comment surface (issue comment) with no mention:
    // existing behavior, just drop. The implicit-thread path
    // doesn't apply here.
    return new Response("no mention\n", { status: 200 })
  }

  const message: JobMessage = {
    type: "github-mention",
    owner,
    repo,
    prNumber,
    installationId,
    surface,
    commentId: comment.id,
    ...(typeof comment.in_reply_to_id === "number"
      ? { threadRootId: comment.in_reply_to_id }
      : {}),
  }
  await env.OPENCLAW_JOBS.send(message)
  console.log(JSON.stringify({
    event: isReviewCommentWithoutMention ? "review-reply-dispatched" : "github-mention-dispatched",
    surface,
    owner, repo, prNumber,
    comment_id: comment.id,
    has_mention: hasMention,
    is_review_thread_reply: isReviewCommentWithoutMention,
    body_length: bodyLength,
    body_ends_with_q: bodyEndsWithQ,
    had_in_reply_to_id: hadInReplyToId,
  }))
  return new Response("queued\n", { status: 202 })
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

// SIG-152: GraphMetricsDO — rolling SIG-138 graph-retrieval shadow telemetry
// (SQLite). Registered via the [[durable_objects.bindings]] GRAPH_METRICS_DO
// entry + the sig-152-v1 new_sqlite_classes migration in wrangler.toml.
export { GraphMetricsDO } from "./do/graph-metrics"

// SIG-184: RunnerReceiptDO — atomic single-use guard + defensible runner-evidence
// receipt (SQLite). Registered via the [[durable_objects.bindings]]
// RUNNER_RECEIPT_DO entry + the sig-184-v1 new_sqlite_classes migration.
export { RunnerReceiptDO } from "./do/runner-receipt"
