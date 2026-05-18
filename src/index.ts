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
import { verifyGitHubWebhook } from "./lib/github-webhook-verify"
import { handlePrOverview } from "./lib/triage-pr-overview"
import { handlePrLabels } from "./lib/triage-pr-labels"
import { handleCiTriage } from "./lib/triage-ci"
import { handlePrReview, buildPrReviewDedupeKey } from "./lib/triage-pr-review"
import { handlePrImprove } from "./lib/triage-pr-improve"
import { handlePrDescribe } from "./lib/triage-pr-describe"
import { handlePrStaleMark } from "./lib/triage-pr-stale-mark"
import { readReviewManifest, type ReviewManifestV1 } from "./lib/review-manifest"
import { PROMPT_VERSION } from "./prompts/pr-review"
import { handlePrReviewEnsemble, routeReview } from "./lib/triage-pr-review-ensemble"
import { handleGithubMention, type GhMentionSurface } from "./lib/github-mention"
import { captureReviewFeedback } from "./lib/review-memory/capture"
import { loadSigilixConfig, resolveReviewMemoryConfig } from "./lib/sigilix-config"
import { handleReviewStatusRoute } from "./do/status-route"
import { runPrReviewWithDoCallback } from "./do/consumer-wrapper"
import { enqueuePrReviewJob } from "./do/webhook-enqueue"
import { postSlashCommandEyesAck } from "./lib/slash-command-eyes-ack"
import { parseValidateMode, validateEnv } from "./lib/env-validate"
import {
  enqueueIndexJobsForRepos,
  isIndexerEnabled,
  maybeEnqueuePushIndexJob,
  type IndexJobReason,
} from "./lib/index-producer"
import { handleIndexRepoJob } from "./lib/indexer"
import {
  startInProgressCheckRun,
  completeCheckRun,
  type SigilixCheckConclusion,
} from "./lib/pr-review-check-run"
import {
  handleInstallReposRemoved,
  handleInstallationDeleted,
} from "./lib/index-delete"
import {
  handleGitHubAuthCallback,
  handleGitHubAuthKickoff,
  handleLogout,
} from "./lib/auth-oauth-github"
import { requireSession } from "./lib/auth-middleware"
import { renderWelcomePage } from "./lib/auth-welcome"
import { readCookie, SESSION_COOKIE_NAME } from "./lib/auth-session"

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
  OPENCLAW_AGENTIC_LINEAR_MODE?: string
  OPENCLAW_AGENTIC_GITHUB_MODE?: string
  // Provider kill-switch for the /api/chat path. Independent of the
  // per-surface agentic flags — flipping this off disables the chat
  // endpoint without redeploying. Both runAgentLoop AND ad-hoc chat()
  // callers honor it.
  OLLAMA_CHAT_ENABLE?: string

  // Phase 4 — multi-agent ensemble PR review (kill-switched off by
  // default). See .claude/handoff/arc-phase4-spec-v3.1-LOCKED.md.
  //
  // Mode gate: "off" | "shadow" | "post". When "off" (default), Phase
  // 3 single-agent path remains in production. "shadow" runs Phase 3
  // as customer-facing review AND runs ensemble in parallel for
  // telemetry only. "post" submits ensemble verdict to GitHub.
  OPENCLAW_ENSEMBLE_REVIEW_MODE?: string
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

  // ARC-189 cross-PR review-memory feature gates (default OFF for
  // both — opposite polarity from every other scanner). Retrieval
  // requires both the env flag AND `sigilix.json`
  // `reviewMemory.enabled === true`. Capture requires the env flag
  // AND (`enabled === true` OR `captureOnly === true`). See spec
  // §5.2 truth table.
  OPENCLAW_REVIEW_MEMORY_ENABLED?: string
  OPENCLAW_REVIEW_MEMORY_CAPTURE?: string

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

  // ARC-190: DO-orchestrated PR-review run state. Spec §4.9 + §4.4.
  // `OPENCLAW_PR_REVIEW_MODE` defaults to "off" (existing direct path);
  // "shadow" runs both paths with DO observation-only; "post" makes
  // the DO authoritative. resolveDoConfig (src/do/config.ts) handles
  // validation + numeric clamping. Default OFF — feature opt-in.
  PR_REVIEW_RUN: DurableObjectNamespace
  OPENCLAW_PR_REVIEW_MODE?: string
  OPENCLAW_PR_REVIEW_DO_MAX_RETRIES?: string
  OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS?: string
  OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT?: string

  // ARC-234: customer-ready indexing pipeline feature flag. Default
  // "off" preserves the legacy `app-level event ignored` drop so the
  // producer ships dark. Operator flips to "on" via
  // `wrangler secret put OPENCLAW_INDEXER_ENABLED on` AFTER both the
  // producer (ARC-234) AND consumer (ARC-235) deploy. Any other value
  // (including unset) keeps indexing disabled.
  OPENCLAW_INDEXER_ENABLED?: string
}

/**
 * Discriminated union of all job kinds the queue handler dispatches.
 * `env` is intentionally NOT serialized — the queue consumer receives
 * its own `env` argument from Cloudflare and re-injects it before
 * calling the per-job handler.
 */
export type JobMessage =
  | { type: "linear-triage"; issueId: string }
  | { type: "linear-mention"; commentId: string }
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
      // `sigilix.json::customLabels` is empty — zero behavior change
      // for repos without label config.
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
       * generated by `PrReviewRunDO`. Legacy direct-path messages
       * (mode === "off") and shadow-mode messages MAY omit it. The
       * consumer wrapper guards on
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
      installationId: number
      reason: "install" | "install-repos-added" | "manual" | "push"
      shard?: {
        /** Inclusive lower bound into the filtered indexable-file list. */
        lo: number
        /** Exclusive upper bound. */
        hi: number
        /** Commit SHA — Contents-API fetches, freshness check, runId. */
        headSha: string
        /** Tree SHA — `getRepoTree` argument. Distinct from headSha per Codex v2 B1. */
        treeSha: string
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

/**
 * Pure decision: given a `pull_request` webhook action + draft flag,
 * which jobs should we enqueue? Extracted so the gating intent is
 * directly testable without simulating the full webhook handler.
 *
 * Rules (matches the routing in handleGitHubWebhook):
 *   - Drafts and unsupported actions get nothing.
 *   - pr-overview always fires for opened/synchronize/reopened/ready_for_review.
 *   - pr-review fires the same EXCEPT `reopened` (closing+reopening
 *     a PR doesn't change the diff, so re-reviewing would be noise).
 *   - When OPENCLAW_PR_REVIEW_SKIP_RELEASE_BRANCHES=on, PRs from a
 *     dev/develop/staging branch into main/master/release skip the
 *     pr-review job entirely (dev→main is a release-promotion of
 *     already-reviewed code; re-reviewing doubles spend + adds noise).
 *     pr-overview still fires so the release PR gets a summary blurb.
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
    team?: { key?: string }
    user?: { displayName?: string; name?: string }
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
    name?: string
    owner?: { login?: string }
  }
  pull_request?: {
    number?: number
    head?: { sha?: string; ref?: string }
    base?: { sha?: string; ref?: string }
    draft?: boolean
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
  repositories?: Array<{ name?: string; full_name?: string }>
  repositories_added?: Array<{ name?: string; full_name?: string }>
  // ARC-238: `installation_repositories.removed` carries the delta;
  // `installation.deleted` does NOT carry a repo list (repos are
  // already gone) — the delete handler discovers affected repos by
  // walking `repo-index-manifest:` records and filtering by owner.
  repositories_removed?: Array<{ name?: string; full_name?: string }>
  // ARC-237: `push` event fields. Default-branch pushes trigger
  // incremental re-index via `maybeEnqueuePushIndexJob`. The handler
  // ignores non-branch refs, branch deletes (`after === "000…"`), and
  // pushes on non-default branches.
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
    // route for DO-tracked PR review runs. Spec §4.7. Returns 404
    // when the feature is off (mode === "off"). v1 unauth (read-only
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

/**
 * ARC-258: map a Phase 3 result status to the right check-run
 * conclusion. Used by the `pr-review` dispatcher to finalize the
 * customer-visible "Sigilix" check.
 *
 *   - `posted`     → `success`. Review went out (green ✓ in Checks).
 *   - `stale_head` → `skipped`. New commit pushed before we reviewed
 *                    the old one; re-review will fire for the new SHA.
 *   - `skipped`    → `success`. The skip here is a dedupe-hit on the
 *                    per-(PR, headSha) lock — a prior run already
 *                    posted a review for this exact head, so from
 *                    the customer's perspective the review IS done.
 *                    A `skipped` conclusion would mislead them into
 *                    thinking nothing was reviewed.
 *   - `errored`    → `failure`. Phase 3 reached submit + verify and
 *                    the verify-after-submit caught a silent reject
 *                    (PENDING / missing from the public list).
 *                    Previously this case returned `skipped` and
 *                    therefore showed `success` "Review posted" with
 *                    no review behind it — the silent-success bug
 *                    reproduced on PRs #84 / #86 / #87. The
 *                    distinct `errored` status now lets the Check
 *                    Run reflect the truth.
 */
function mapPhase3StatusToCheckConclusion(
  status: "posted" | "skipped" | "stale_head" | "errored",
): SigilixCheckConclusion {
  switch (status) {
    case "posted":
      return "success"
    case "skipped":
      return "success"
    case "stale_head":
      return "skipped"
    case "errored":
      return "failure"
  }
}

export async function dispatchJob(job: JobMessage, env: Env): Promise<void> {
  switch (job.type) {
    case "linear-triage":
      return triageIssue(job.issueId, env)
    case "linear-mention":
      return handleMention(job.commentId, env)
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
      // ARC-265: auto-label picker. Short-circuits if
      // `sigilix.json::customLabels` is empty/absent — zero behavior
      // change for repos without label config.
      return handlePrLabels({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
      })
    case "pr-review": {
      // ARC-190 Task 7: when the message carries a string `runId`, the
      // DO is the dedupe + retry source-of-truth. The wrapper posts
      // /pickup → runs the work → posts /run-result. Legacy direct-path
      // messages (no runId) bypass and run unchanged.
      const baseArgs = {
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
        // ARC-251: thread the requeue depth from the job message into
        // both review pipelines. Webhook-driven messages omit the
        // field (treated as 0); stale-head-driven requeues carry the
        // incremented depth so the helper can cap further retries.
        ...(job.staleHeadRequeueDepth !== undefined
          ? { staleHeadRequeueDepth: job.staleHeadRequeueDepth }
          : {}),
      }
      return runPrReviewWithDoCallback(job, env, async () => {
        // ARC-258 follow-up: warmup signaling now lives inside the
        // pr-overview sticky (a "Sigilix is warming up its index"
        // callout at the top, gated on `repo-index-manifest:<repo>`
        // existence). The pr-review path no longer posts a separate
        // warmup comment. See `src/lib/triage-pr-overview.ts` and
        // `src/lib/warmup.ts::enqueueWarmupRerunsForIndex`.

        // Phase 4 routing: ensemble (shadow/post), Phase 3 agentic, or
        // Phase 3 single-shot legacy. See triage-pr-review-ensemble.ts
        // for the full decision matrix.
        const decision = await routeReview({ env, owner: job.owner, repo: job.repo })
        // ARC-183: sensitive-repo gate. Skip ALL review pipelines —
        // Sigilix never fetches the diff or sends content to any LLM
        // for repos on the OPENCLAW_SENSITIVE_REPOS denylist. Audit log
        // entry contains owner/repo/prNumber/reason but no code or
        // diff content (we never fetched it).
        if (decision.primary === "skipped-sensitive") {
          console.log(JSON.stringify({
            event: "pr-review-skipped",
            reason: decision.reason,
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
          }))
          return
        }
        // ARC-258: customer-visible "Sigilix · In progress"
        // check run. Created here at the dispatcher level (not
        // inside the handlers) so a single owner can pick the right
        // final conclusion across ensemble + Phase 3 fallback
        // combinations. Best-effort: a null handle means no check
        // was created (creds missing, 403 from missing perms, etc.)
        // and the completion calls below become no-ops.
        const checkRun = await startInProgressCheckRun({
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
        let reviewMeta: import("./lib/triage-pr-review").PrReviewMeta | undefined = undefined
        try {
          if (decision.primary === "ensemble-shadow") {
            // Shadow: Phase 3 posts the customer-facing review FIRST,
            // ensemble runs after for telemetry only. Serial per v3.1
            // catch — simpler pairing invariant.
            //
            // ARC-250 (Codex MAJOR on the design review): when Phase 3
            // returns `stale_head` we MUST skip the shadow ensemble run.
            // Otherwise the ensemble's own stale-head guard fires too and
            // we double-handle the same job — duplicate telemetry, and in
            // commit 2 (ARC-251) duplicate auto-requeues. Note: `skipped`
            // (Phase 3 dedupe-hit) still runs the shadow ensemble for
            // telemetry continuity — shadow is observation-only, so a
            // double-skip there is harmless and preserves the paired-run
            // invariant that Phase 4b's shadow analysis depends on.
            const phase3Result = await handlePrReview(baseArgs)
            conclusion = mapPhase3StatusToCheckConclusion(phase3Result.status)
            reviewMeta = phase3Result.reviewMeta
            if (phase3Result.status === "stale_head") return
            await handlePrReviewEnsemble(baseArgs, "shadow")
            return
          }
          if (decision.primary === "ensemble-post") {
            // CR PR #35 catch: ensemble-post can return "skipped"/"errored"
            // for quorum, synth-parse, and internal-error paths. Without
            // this fallback the PR gets no customer-facing review at all.
            // Fall through to Phase 3 single-agent on those non-successes.
            //
            // ARC-250: `stale_head` is the lone exception. Phase 3 would
            // also stale-head, and `handleStaleHead` already emitted the
            // user-visible sticky + telemetry, so the fallback must
            // short-circuit. Other non-posted statuses (router_no_specialists,
            // quorum failure, synth timeout/parse/provenance failure,
            // internal error) still benefit from the Phase 3 attempt.
            const result = await handlePrReviewEnsemble(baseArgs, "post")
            if (result.status === "posted") {
              // ARC-279: when the ensemble had to use the comment
              // fallback (formal review submit was silently rejected),
              // the Check Run should reflect that the normal review
              // pipeline didn't run — even though the synth body is
              // up as a PR comment. `failure` conclusion + a "see PR
              // comment" title (rendered by `renderOutputForConclusion`
              // via the threaded reviewMeta) gives the customer a
              // clear signal without dropping the review signal.
              conclusion = result.reviewMeta?.surface === "comment" ? "failure" : "success"
              reviewMeta = result.reviewMeta
              return
            }
            if (result.status === "stale_head") {
              conclusion = "skipped"
              return
            }
            // Fallback to Phase 3: the ensemble outcome doesn't bind
            // the check run yet — Phase 3 will. If Phase 3 posts the
            // check goes to `success` regardless of why the ensemble
            // bailed (router_no_specialists, quorum, synth, internal).
            const phase3Result = await handlePrReview(baseArgs)
            conclusion = mapPhase3StatusToCheckConclusion(phase3Result.status)
            reviewMeta = phase3Result.reviewMeta
            return
          }
          // Phase 3 paths (agentic or singleshot-legacy) both go through
          // handlePrReview — the agentic toggle is gated inside that
          // function via OPENCLAW_AGENTIC_GITHUB_MODE.
          const phase3Result = await handlePrReview(baseArgs)
          conclusion = mapPhase3StatusToCheckConclusion(phase3Result.status)
          reviewMeta = phase3Result.reviewMeta
        } catch (err) {
          conclusion = "failure"
          throw err
        } finally {
          // Best-effort completion. `null` conclusion means we
          // returned before assigning one (shouldn't happen with the
          // current branches, but defensive). Map it to `failure` so
          // the check doesn't hang in_progress.
          await completeCheckRun({
            handle: checkRun,
            conclusion: conclusion ?? "failure",
            ...(reviewMeta !== undefined ? { reviewMeta } : {}),
          })
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
        // Post ack comment so the user knows the request was received.
        // Best-effort: a failed ack doesn't block the re-review.
        //
        // ARC-236 (code-reviewer M1 catch on PR #80): when the rerun
        // is fired automatically by `enqueueWarmupRerunsForIndex`
        // after indexing completes, the customer didn't type a slash
        // command — the ack would be unsolicited noise on every
        // open PR. Skip the ack when `silent` is set.
        if (!job.silent) {
          try {
            await client.createIssueComment(
              job.owner, job.repo, job.prNumber,
              renderSlashCommandAck({ cmd: "review" }),
            )
          } catch (err) {
            console.error(JSON.stringify({
              event: "slash-command-ack-failed",
              err: err instanceof Error ? err.message : String(err),
              cmd: "review",
              ...tag,
            }))
          }
        }
        // Clear the legacy single-shot dedupe lock so handlePrReview
        // doesn't no-op when invoked on the same head SHA. Without
        // this, the slash command's whole purpose (re-run after a
        // prior review already posted) would be silently swallowed
        // by the 7-day TTL set in triage-pr-review.ts.
        const dedupeKey = buildPrReviewDedupeKey({
          owner: job.owner, repo: job.repo, prNumber: job.prNumber, headSha,
        })
        await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})

        const reviewMessage: JobMessage = {
          type: "pr-review",
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha,
          installationId: job.installationId,
        }
        await env.OPENCLAW_JOBS.send(reviewMessage)
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

  // Comment.create with @-mention → enqueue mention-reply pipeline.
  // Pre-check the body before queueing — most comments don't @ us, and
  // we don't want to spend Queue messages on no-op invocations.
  if (payload.type === "Comment" && payload.action === "create") {
    const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
    const body = payload.data.body ?? ""
    if (!bodyMentionsBot(body, triggers)) {
      return new Response("no mention\n", { status: 200 })
    }
    const author =
      payload.data.user?.displayName ?? payload.data.user?.name ?? null
    // Self-author guard. Shared isBotHandle() helper (src/lib/mention.ts)
    // is the single source of truth for the strict pattern — same check
    // runs again inside handleMention() for defense in depth.
    if (isBotHandle(author)) {
      return new Response("skip self\n", { status: 200 })
    }
    await env.OPENCLAW_JOBS.send({ type: "linear-mention", commentId: payload.data.id })
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
    if (pr.draft) return new Response("skip draft\n", { status: 200 })
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

    if (decision.overview) {
      await env.OPENCLAW_JOBS.send({
        type: "pr-overview",
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
      })
      // ARC-265: auto-label picker fires alongside pr-overview (same
      // webhook events: opened / synchronize / reopened / ready_for_review).
      // The handler short-circuits if `sigilix.json::customLabels` is
      // empty/absent, so this is free for repos without label config.
      await env.OPENCLAW_JOBS.send({
        type: "pr-labels",
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
      // ARC-190 Task 8: gate the pr-review enqueue on
      // OPENCLAW_PR_REVIEW_MODE. Off = legacy queue send only; shadow
      // = DO observation + legacy send; post = DO only (DO emits the
      // queue message itself with runId attached). Awaited (NOT
      // ctx.waitUntil) so a post-mode DO failure surfaces as 503 to
      // GitHub for redelivery. See spec §4.4.
      const enq = await enqueuePrReviewJob(env, {
        owner,
        repo,
        prNumber,
        headSha,
        baseSha,
        installationId,
        deliveryId: request.headers.get("x-github-delivery"),
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
      // KV read and the enqueue. This is independent of the DO mode —
      // pr-stale-mark is KV-routed and shipped before ARC-190.
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

  // ARC-237: push-driven re-index. Fires on every push to a branch
  // ref; the producer helper filters to default-branch pushes on
  // already-indexed repos (bootstrap stays install-driven). Push
  // storm coalescing falls out of ARC-235's freshness check — 10
  // pushes in 60s become 1 actual re-walk + 9 cheap skips.
  if (event === "push") {
    if (!isIndexerEnabled(env)) {
      return new Response("push event ignored (indexer off)\n", { status: 200 })
    }
    const outcome = await maybeEnqueuePushIndexJob({
      env,
      owner,
      repo,
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
}): Promise<void> {
  const { env, owner, repo, prNumber, installationId, comment } = args
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
// `[[durable_objects.bindings]]` block in wrangler.toml can find
// them. Stub fetch() behavior until Task 2 lands real route
// dispatch — the env gate (OPENCLAW_PR_REVIEW_MODE === "off")
// guarantees this class never receives traffic until Task 8 wires
// the webhook integration.
export { PrReviewRunDO } from "./do/pr-review-run"
