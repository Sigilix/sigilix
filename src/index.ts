// OpenClaw Worker — Linear webhook → Ollama Turbo → Linear comment + field updates.
//
// Routes:
//   GET  /                     liveness probe
//   POST /linear/webhook       Linear sends issue.created / issue.updated
//   POST /linear/manual        manual triage trigger (dev/admin) — body: { issueId }
//
// HMAC verification on the webhook route uses LINEAR_WEBHOOK_SECRET. Every
// other route is gated by Cloudflare auth or rejected.

import { triageIssue } from "./lib/triage"
import { handleMention } from "./lib/mention-reply"
import { bodyMentionsBot, getMentionTriggers } from "./lib/mention"
import { verifyLinearWebhook } from "./lib/webhook-verify"

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OpenClaw Worker — alive\n", {
        headers: { "content-type": "text/plain" },
      })
    }

    if (request.method === "POST" && url.pathname === "/linear/webhook") {
      return handleLinearWebhook(request, env, ctx)
    }

    if (request.method === "POST" && url.pathname === "/linear/manual") {
      return handleManualTrigger(request, env, ctx)
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
