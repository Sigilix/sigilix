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
} from "./lib/mention"
import { verifyLinearWebhook } from "./lib/webhook-verify"
import { verifyGitHubWebhook } from "./lib/github-webhook-verify"
import { handlePrOverview } from "./lib/triage-pr-overview"
import { handleCiTriage } from "./lib/triage-ci"
import { handlePrReview } from "./lib/triage-pr-review"
import { handleGithubMention, type GhMentionSurface } from "./lib/github-mention"
import { parseValidateMode, validateEnv } from "./lib/env-validate"

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
  // "strict" → return 500 when team/installation maps are inconsistent.
  // Anything else (including unset, "warn", "STRICT", typos) → warn only.
  OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS?: string
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
    head?: { sha?: string }
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
      return new Response("Arc Worker — alive\n", {
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
    case "pr-review":
      return handlePrReview({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        installationId: job.installationId,
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
    if (action !== "opened" && action !== "synchronize" && action !== "reopened" && action !== "ready_for_review") {
      return new Response("skip pr action\n", { status: 200 })
    }
    const prNumber = pr.number
    const headSha = pr.head?.sha ?? ""
    if (!headSha) return new Response("missing head sha\n", { status: 400 })

    await env.OPENCLAW_JOBS.send({
      type: "pr-overview",
      owner,
      repo,
      prNumber,
      headSha,
      installationId,
    })
    // pr-review fires on `opened` AND `ready_for_review` so we don't
    // re-review on every push. Including `ready_for_review` catches
    // PRs opened as draft — the original `opened` was skipped at the
    // draft check above, so without this branch the PR would only get
    // a pr-overview when it flips to ready, no formal review.
    if (action === "opened" || action === "ready_for_review") {
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
