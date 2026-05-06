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
import { parseSlashCommand, renderSlashCommandAck, type SlashCommand } from "./lib/slash-commands"
import { getInstallationToken } from "./lib/github-app"
import { GitHubClient } from "./lib/github"
import { verifyLinearWebhook } from "./lib/webhook-verify"
import { verifyGitHubWebhook } from "./lib/github-webhook-verify"
import { handlePrOverview } from "./lib/triage-pr-overview"
import { handleCiTriage } from "./lib/triage-ci"
import { handlePrReview, buildPrReviewDedupeKey } from "./lib/triage-pr-review"
import { handlePrImprove } from "./lib/triage-pr-improve"
import { handlePrDescribe } from "./lib/triage-pr-describe"
import { handlePrReviewEnsemble, routeReview } from "./lib/triage-pr-review-ensemble"
import { handleGithubMention, type GhMentionSurface } from "./lib/github-mention"
import { parseValidateMode, validateEnv } from "./lib/env-validate"
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
  // Comma-separated lowercased Vectorize namespaces the agent loop is
  // allowed to query. Optional — if unset, derived from the values of
  // OPENCLAW_TEAM_GITHUB_REPO_MAP. Set this when there are repos that
  // are indexed but not Linear-team-mapped (e.g. a marketing site that
  // no Linear team owns directly).
  // Example: "rubberfit,arc-and-anchor-website,rubberfit-desktop,openclaw-worker"
  OPENCLAW_INDEXED_REPOS?: string
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
  // Comma-separated owner/repo allowlist. When set, ensemble only
  // fires on these repos. Empty/unset = all repos eligible (use with
  // care during rollout).
  OPENCLAW_ENSEMBLE_REVIEW_ALLOWED_REPOS?: string
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
    }
  | {
      type: "pr-review"
      owner: string
      repo: string
      prNumber: number
      headSha: string
      installationId: number
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
  // ARC-191: `/sigilix describe` — single-shot LLM draft of a PR
  // description / internal changelog / external changelog. Mode is
  // resolved at parse time (one of three canonical names).
  // headSha is resolved at handler time (same rationale as pr-improve).
  | {
      type: "pr-describe"
      owner: string
      repo: string
      prNumber: number
      installationId: number
      mode: import("./lib/slash-commands").DescribeMode
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
  installation?: { id?: number }
  repository?: {
    name?: string
    owner?: { login?: string }
  }
  pull_request?: {
    number?: number
    head?: { sha?: string; ref?: string }
    base?: { ref?: string }
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

async function dispatchJob(job: JobMessage, env: Env): Promise<void> {
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
      })
    case "pr-review": {
      // Phase 4 routing: ensemble (shadow/post), Phase 3 agentic, or
      // Phase 3 single-shot legacy. See triage-pr-review-ensemble.ts
      // for the full decision matrix.
      const decision = await routeReview({ env, owner: job.owner, repo: job.repo })
      const baseArgs = {
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
        env,
      }
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
      if (decision.primary === "ensemble-shadow") {
        // Shadow: Phase 3 posts the customer-facing review FIRST,
        // ensemble runs after for telemetry only. Serial per v3.1
        // catch — simpler pairing invariant.
        await handlePrReview(baseArgs)
        await handlePrReviewEnsemble(baseArgs, "shadow")
        return
      }
      if (decision.primary === "ensemble-post") {
        // CR PR #35 catch: ensemble-post can return "skipped"/"errored"
        // for stale-head, quorum, synth-parse, and internal-error
        // paths. Without this fallback the PR gets no customer-facing
        // review at all (the queue still acks). Fall through to
        // Phase 3 single-agent on any non-success.
        const result = await handlePrReviewEnsemble(baseArgs, "post")
        if (result.status !== "posted") {
          await handlePrReview(baseArgs)
        }
        return
      }
      // Phase 3 paths (agentic or singleshot-legacy) both go through
      // handlePrReview — the agentic toggle is gated inside that
      // function via OPENCLAW_AGENTIC_GITHUB_MODE.
      return handlePrReview(baseArgs)
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
      // ARC-191: `/sigilix describe`. Single-shot LLM call producing
      // a PR description / changelog draft posted as a top-level
      // comment with marker-wrapped body + hidden meta line for
      // future apply parsing. Independent of the ensemble; does
      // NOT consume the ensemble daily budget.
      try {
        await postSlashCommandAck(env, { cmd: "describe", mode: job.mode }, {
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
        }))
      }
      return handlePrDescribe({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        installationId: job.installationId,
        mode: job.mode,
        env,
      })
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
  _ctx: ExecutionContext
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

  // App-level events have no repository field. Ignore with 200.
  if (
    event === "installation" ||
    event === "installation_repositories" ||
    event === "installation_target" ||
    event === "github_app_authorization"
  ) {
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
    }
    // pr-review fires on `opened`, `ready_for_review`, AND `synchronize`
    // so the bot keeps verifying after each fix push (and can flip to
    // APPROVE when the diff is clean). The consumer carries a per-
    // (prNumber, headSha) dedupe key + a stale-head guard, so retries
    // and out-of-order delivery don't produce duplicate or wrong-diff
    // reviews. `ready_for_review` catches drafts that were skipped on
    // `opened`. See decidePullRequestJobs() for the gating contract.
    if (decision.review) {
      await env.OPENCLAW_JOBS.send({
        type: "pr-review",
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
      })
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
    return queueGithubMention({
      env,
      payload,
      owner,
      repo,
      installationId,
      surface: "review-comment",
      prNumber: payload.pull_request?.number,
    })
  }

  return new Response("skipped\n", { status: 200 })
}

interface QueueGithubMentionArgs {
  env: Env
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
async function queueGithubMention(args: QueueGithubMentionArgs): Promise<Response> {
  const { env, payload, owner, repo, installationId, surface, prNumber } = args
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
    const association = (comment.author_association ?? "").toUpperCase()
    const allowed = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
    if (!allowed.has(association)) {
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
    // the 60s window. Other commands keep the existing key shape.
    // (The `unknown` describe variant returned via the fast path
    // above, so here describe.mode is always a canonical DescribeMode.)
    const coalesceKey = slashCmd.cmd === "describe"
      ? `slash-cmd:describe:${slashCmd.mode}:${owner}/${repo}#${prNumber}`
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
  const isReviewCommentReply =
    surface === "review-comment" && typeof comment.in_reply_to_id === "number"
  if (!hasMention && !isReviewCommentReply) {
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
  return new Response("queued\n", { status: 202 })
}
