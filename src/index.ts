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
import { verifyLinearWebhook } from "./lib/webhook-verify"

export interface Env {
  OPENCLAW_STATE: KVNamespace
  LINEAR_API_KEY: string
  LINEAR_WEBHOOK_SECRET: string
  OLLAMA_API_KEY: string
  OPENCLAW_MODEL?: string
  OPENCLAW_TEAM_KEY?: string
}

// Linear sends webhooks for the action types we subscribe to. We only
// care about Issue create/update — Comment events are noise for triage
// (we'd retrigger on our own bot's comments).
interface LinearWebhookPayload {
  action: "create" | "update" | "remove"
  type: "Issue" | "Comment" | string
  data: {
    id: string
    title?: string
    description?: string
    team?: { key?: string }
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

  // Filter: we only triage Issue.create. Issue.update fires on every field
  // change including our own — would create an infinite loop without a marker
  // check. Skip cleanly to keep the surface narrow.
  if (payload.type !== "Issue" || payload.action !== "create") {
    return new Response("skipped\n", { status: 200 })
  }

  // Optional team scope — if OPENCLAW_TEAM_KEY is set, only triage issues
  // from that team. Useful when one OpenClaw instance serves a workspace
  // with multiple teams and you don't want it firing on all of them.
  if (env.OPENCLAW_TEAM_KEY && payload.data.team?.key !== env.OPENCLAW_TEAM_KEY) {
    return new Response("team scope mismatch\n", { status: 200 })
  }

  // Run triage in the background so the webhook returns 200 immediately.
  // Linear retries on non-2xx; long synchronous work would hammer us.
  ctx.waitUntil(triageIssue(payload.data.id, env).catch((error) => {
    console.error("triage failed", { issueId: payload.data.id, error: String(error) })
  }))

  return new Response("ok\n", { status: 200 })
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
