// OpenClaw Worker — Linear webhook → triage; GitHub webhook → PR review.
//
// Routes:
//   GET  /                     liveness probe
//   POST /linear/webhook       Linear sends Issue.create / Comment.create (mention)
//   POST /linear/manual        manual triage trigger (dev/admin) — body: { issueId }
//   POST /github/webhook       GitHub sends pull_request, workflow_run,
//                              pull_request_review_comment, pull_request_review
//
// HMAC verification on Linear uses LINEAR_WEBHOOK_SECRET (raw hex).
// HMAC verification on GitHub uses GITHUB_WEBHOOK_SECRET (sha256= prefix).

import { triageIssue } from "./lib/triage"
import { handleMention } from "./lib/mention-reply"
import { bodyMentionsBot, getMentionTriggers } from "./lib/mention"
import { verifyLinearWebhook } from "./lib/webhook-verify"
import { verifyGitHubWebhook } from "./lib/github-webhook-verify"
import { handlePrOverview } from "./lib/triage-pr-overview"
import { handleCiTriage } from "./lib/triage-ci"
import { handleCrEval, isCodeRabbitAuthor } from "./lib/triage-cr"
import { handlePrReview } from "./lib/triage-pr-review"
import type { ReviewComment } from "./lib/github"

type ReviewCommentArg = ReviewComment

export interface Env {
  OPENCLAW_STATE: KVNamespace
  // Vectorize index storing 768-dim embeddings of code chunks per repo.
  // Populated by scripts/index-repo.mjs (or a future GitHub Action).
  // Queries are scoped by namespace == repo name, mapped from the
  // Linear team key on the inbound webhook (see retrieval.ts).
  OPENCLAW_CODE_INDEX: VectorizeIndex
  // Workers AI binding. Used to embed the issue / question text at
  // query time with the same model the indexer used (BGE base v1.5,
  // 768 dims).
  AI: Ai
  // Personal API key. Required at minimum because the manual-trigger route
  // gates on it as a shared bearer secret (see handleManualTrigger). Used
  // for talking to Linear only when LINEAR_OAUTH_CLIENT_ID is unset — once
  // OAuth is configured, the Worker prefers the app-actor token so comments
  // are attributed to the OAuth app instead of the human owner of the key.
  LINEAR_API_KEY: string
  LINEAR_WEBHOOK_SECRET: string
  OLLAMA_API_KEY: string
  // OAuth client_credentials pair for the Linear app actor identity. When
  // both are present, the Worker fetches a 30-day app-actor token (cached
  // in KV) and uses it for every Linear API call. Comments and field
  // updates then appear as the OAuth app (e.g. "OpenClaw"), which is the
  // industry-standard bot pattern Linear supports.
  LINEAR_OAUTH_CLIENT_ID?: string
  LINEAR_OAUTH_CLIENT_SECRET?: string
  // GitHub App credentials. When all three are present the Worker can
  // post comments / submit reviews under the @openclaw[bot] identity.
  // Without them the /github/webhook route returns 503 — we never want
  // to fall back to a developer's PAT for PR-side actions.
  //
  //   GITHUB_APP_ID         numeric App ID
  //   GITHUB_PRIVATE_KEY    PEM-encoded RSA private key (PKCS#1 or PKCS#8)
  //   GITHUB_WEBHOOK_SECRET HMAC secret for inbound webhook verification
  //
  // Installation IDs come from each webhook payload (`installation.id`)
  // so a single Worker can serve every repo where the App is installed.
  GITHUB_APP_ID?: string
  GITHUB_PRIVATE_KEY?: string
  GITHUB_WEBHOOK_SECRET?: string
  // JSON object mapping Linear team keys to Vectorize namespaces.
  // Example: '{"ARC":"rema-portal","RFD":"rubberfit-desktop"}'.
  // Optional — when unset, the team key (lowercased) IS the namespace.
  OPENCLAW_TEAM_REPO_MAP?: string
  OPENCLAW_MODEL?: string
  OPENCLAW_TEAM_KEY?: string
  // Comma-separated list of @-handles that trigger the mention-reply path.
  // Defaults to "openclaw,openclaw[bot],OpenClaw[bot]". Override when the
  // OAuth app's display name differs.
  OPENCLAW_MENTION_TRIGGERS?: string
}

// Linear sends webhooks for the action types we subscribe to. We dispatch
// on (type, action) — Issue.create kicks off triage, Comment.create with a
// bot mention kicks off the mention-reply path. Everything else returns
// 200 "skipped" so Linear doesn't retry.
interface LinearWebhookPayload {
  action: "create" | "update" | "remove"
  type: "Issue" | "Comment" | string
  data: {
    id: string
    title?: string
    description?: string
    body?: string // Comment events
    team?: { key?: string }
    user?: { displayName?: string; name?: string } // Comment author
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
}

async function handleLinearWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
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

  // Issue.create → full triage pipeline.
  if (payload.type === "Issue" && payload.action === "create") {
    if (env.OPENCLAW_TEAM_KEY && payload.data.team?.key !== env.OPENCLAW_TEAM_KEY) {
      console.warn("team scope mismatch", {
        got: payload.data.team?.key ?? null,
        want: env.OPENCLAW_TEAM_KEY,
      })
      return new Response("team scope mismatch\n", { status: 200 })
    }
    ctx.waitUntil(triageIssue(payload.data.id, env).catch((error) => {
      console.error("triage failed", { issueId: payload.data.id, error: String(error) })
    }))
    return new Response("ok\n", { status: 200 })
  }

  // Comment.create with @-mention → mention-reply pipeline.
  // Pre-check the body here before spending a Linear GraphQL roundtrip —
  // most comments don't @ us, and we'd waste a query rebuilding context
  // for a comment we'd skip anyway.
  if (payload.type === "Comment" && payload.action === "create") {
    const triggers = getMentionTriggers(env.OPENCLAW_MENTION_TRIGGERS)
    const body = payload.data.body ?? ""
    if (!bodyMentionsBot(body, triggers)) {
      return new Response("no mention\n", { status: 200 })
    }
    // Skip-self short-circuit using the webhook payload's user field.
    // mention-reply.ts also re-checks via the comment fetch, but cheap
    // to reject self-comments before scheduling the waitUntil.
    const author =
      payload.data.user?.displayName ?? payload.data.user?.name ?? null
    if (author && (/\[bot\]$/i.test(author) || /openclaw/i.test(author))) {
      return new Response("skip self\n", { status: 200 })
    }
    ctx.waitUntil(handleMention(payload.data.id, env).catch((error) => {
      console.error("mention reply failed", { commentId: payload.data.id, error: String(error) })
    }))
    return new Response("ok\n", { status: 200 })
  }

  return new Response("skipped\n", { status: 200 })
}

async function handleManualTrigger(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Manual trigger is gated by a static API key in the request — any client
  // who reaches this route without it gets 401. The auth model is intentionally
  // shared with LINEAR_API_KEY so there's no extra secret to manage; the route
  // exists for ad-hoc re-triage during dev, not for end users.
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

  ctx.waitUntil(triageIssue(body.issueId, env).catch((error) => {
    console.error("manual triage failed", { issueId: body.issueId, error: String(error) })
  }))
  return new Response("queued\n", { status: 202 })
}

async function handleGitHubWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
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

  const installationId = payload.installation?.id
  const owner = payload.repository?.owner?.login
  const repo = payload.repository?.name
  if (!installationId || !owner || !repo) {
    return new Response("missing installation / repo\n", { status: 400 })
  }

  // pull_request — overview + (on first open / push) primary review.
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

    ctx.waitUntil(
      handlePrOverview({ owner, repo, prNumber, headSha, installationId, env }).catch((error) => {
        console.error("pr-overview failed", { owner, repo, prNumber, error: String(error) })
      })
    )
    // pr-review is the "what did CR miss?" pass — fire it ONLY on the
    // initial PR `opened` (so PRs in repos without CR still get a
    // proactive review) and on `pull_request_review.submitted` from CR
    // (handled in the dedicated branch below). On `synchronize` /
    // `reopened` / `ready_for_review` we skip pr-review and let CR run
    // first — its `pull_request_review.submitted` event will trigger
    // pr-review afterwards. Without this guard, pr-review races CR and
    // re-flags what CR was about to flag itself.
    if (action === "opened") {
      ctx.waitUntil(
        handlePrReview({ owner, repo, prNumber, headSha, installationId, env }).catch((error) => {
          console.error("pr-review failed", { owner, repo, prNumber, error: String(error) })
        })
      )
    }
    return new Response("ok\n", { status: 200 })
  }

  // workflow_run.completed (failure) on a PR head commit → CI triage.
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

    const args = {
      owner,
      repo,
      prNumber: prRef.number,
      runId: run.id,
      headSha,
      installationId,
      env,
    }
    ctx.waitUntil(
      handleCiTriage(args).catch((error) => {
        console.error("ci-triage failed", {
          owner,
          repo,
          prNumber: args.prNumber,
          error: String(error),
        })
      })
    )
    return new Response("ok\n", { status: 200 })
  }

  // pull_request_review_comment.created from coderabbitai → CR-eval.
  if (event === "pull_request_review_comment") {
    if (payload.action !== "created" || !payload.comment) {
      return new Response("skip review comment action\n", { status: 200 })
    }
    const c = payload.comment
    if (!isCodeRabbitAuthor(c.user?.login ?? null)) {
      return new Response("skip non-cr author\n", { status: 200 })
    }
    // Ignore CR's own threaded replies — only top-level inline comments.
    if (typeof c.in_reply_to_id === "number") {
      return new Response("skip threaded reply\n", { status: 200 })
    }
    const pr = payload.pull_request
    if (!pr || typeof pr.number !== "number" || typeof c.id !== "number" || !c.path) {
      return new Response("missing review-comment fields\n", { status: 400 })
    }
    const reviewComment: ReviewCommentArg = {
      id: c.id,
      path: c.path,
      line: c.line ?? null,
      original_line: c.original_line ?? null,
      body: c.body ?? "",
      user: c.user ? { login: c.user.login ?? "" } : null,
      pull_request_review_id: c.pull_request_review_id ?? null,
    }
    if (typeof c.commit_id === "string") reviewComment.commit_id = c.commit_id
    if (typeof c.original_commit_id === "string") {
      reviewComment.original_commit_id = c.original_commit_id
    }
    // in_reply_to_id is never set here — the early return at the top of
    // this branch already drops threaded replies, so by the time we get
    // here c.in_reply_to_id is undefined by construction.
    const args = {
      owner,
      repo,
      prNumber: pr.number,
      installationId,
      env,
      comment: reviewComment,
    }
    ctx.waitUntil(
      handleCrEval(args).catch((error) => {
        console.error("cr-eval failed", {
          owner,
          repo,
          prNumber: args.prNumber,
          commentId: c.id,
          error: String(error),
        })
      })
    )
    return new Response("ok\n", { status: 200 })
  }

  // pull_request_review.submitted from coderabbitai → re-run primary
  // review. CR's submitted event fires after all its inline comments
  // are in, so this is the cleanest signal that "CR is done — now
  // OpenClaw can fill in what CR missed."
  if (event === "pull_request_review") {
    if (payload.action !== "submitted" || !payload.review) {
      return new Response("skip review action\n", { status: 200 })
    }
    if (!isCodeRabbitAuthor(payload.review.user?.login ?? null)) {
      return new Response("skip non-cr review\n", { status: 200 })
    }
    const pr = payload.pull_request
    if (!pr || typeof pr.number !== "number") {
      return new Response("missing pr\n", { status: 400 })
    }
    const headSha = pr.head?.sha ?? ""
    if (!headSha) return new Response("missing head sha\n", { status: 400 })
    ctx.waitUntil(
      handlePrReview({
        owner,
        repo,
        prNumber: pr.number,
        headSha,
        installationId,
        env,
      }).catch((error) => {
        console.error("pr-review (post-cr) failed", {
          owner,
          repo,
          prNumber: pr.number,
          error: String(error),
        })
      })
    )
    return new Response("ok\n", { status: 200 })
  }

  return new Response("skipped\n", { status: 200 })
}
