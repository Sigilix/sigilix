// SIG-196: /slack/events webhook route — verify, ack, event_id idempotency, dispatch.
//
// This module is wiring-only. All logic lives in the slack/slack-* helpers.
// Kept deliberately thin (no business logic) to stay within the file-size budget
// and keep the boundary between routing and orchestration clean.

import type { Env } from "@/src/shared/types/env"
import { resolveSlackMode } from "@/src/lib/slack/slack-mode"
import { verifySlackSignature } from "@/src/lib/slack/slack-verify"
import { resolveSlackScope } from "@/src/lib/slack/slack-scope"
import { getSlackBotToken } from "@/src/lib/slack/slack-install"
import { postSlackMessage, fetchSlackThread, capAndRedactThread } from "@/src/lib/slack/slack-api"
import { checkSlackRateLimit, recordSlackAction } from "@/src/lib/slack/slack-rate-limit"
import { runSlackAgent } from "@/src/lib/slack/slack-agent"

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Handle POST /slack/events.
 *
 * Flow:
 *   1. url_verification → echo challenge immediately (no auth required).
 *   2. mode=off → 200 empty (inert).
 *   3. SLACK_SIGNING_SECRET missing → 503.
 *   4. Signature verification → 401 on failure.
 *   5. app_mention idempotency via KV (TTL 10 min).
 *   6. Ack 200 immediately.
 *   7. Deferred work in ctx.waitUntil (scope → token → rate-limit → agent → post/log).
 */
export async function handleSlackRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const mode = resolveSlackMode(env)
  const rawBody = await request.text()

  // Parse body once; treat malformed JSON as null (handled per-check below).
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    // Malformed — url_verification won't match, non-app_mention events proceed normally.
  }

  // ── url_verification: must respond before any auth (Slack app setup step) ──
  if (body?.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { "content-type": "application/json" },
    })
  }

  // ── Mode gate ────────────────────────────────────────────────────────────────
  if (mode === "off") {
    return new Response("", { status: 200 })
  }

  // ── Signing secret required ──────────────────────────────────────────────────
  if (!env.SLACK_SIGNING_SECRET) {
    return new Response("", { status: 503 })
  }

  // ── Signature verification ────────────────────────────────────────────────────
  const sigOk = await verifySlackSignature({
    rawBody,
    signature: request.headers.get("x-slack-signature"),
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signingSecret: env.SLACK_SIGNING_SECRET,
    nowMs: Date.now(),
  })
  if (!sigOk) {
    return new Response("", { status: 401 })
  }

  // ── app_mention idempotency ───────────────────────────────────────────────────
  // Claim a KV key for each unique event_id before scheduling work. A duplicate
  // event_id returns 200 immediately without scheduling anything (Slack retry-safe).
  if (body?.type === "event_callback") {
    const ev = body.event as Record<string, unknown> | undefined
    if (ev?.type === "app_mention") {
      const eventId = typeof body.event_id === "string" ? body.event_id : null
      if (eventId) {
        const existing = await env.OPENCLAW_STATE.get(`slack-event:${eventId}`)
        if (existing !== null) {
          // Already processed — ack and stop.
          return new Response("", { status: 200 })
        }
        // Claim the key BEFORE scheduling work so a concurrent delivery sees it.
        await env.OPENCLAW_STATE.put(`slack-event:${eventId}`, "1", { expirationTtl: 600 })
      }
    }
  }

  // ── Ack 200 immediately; run the rest deferred ────────────────────────────────
  const teamId = typeof body?.team_id === "string" ? body.team_id : ""
  const event = body?.type === "event_callback" ? (body.event as Record<string, unknown> | undefined) : undefined

  ctx.waitUntil(
    runDeferredWork(env, mode, teamId, event).catch((err) => {
      console.error(
        JSON.stringify({
          event: "slack-agent-unhandled-error",
          teamId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }),
  )

  return new Response("", { status: 200 })
}

// ─── Deferred work ────────────────────────────────────────────────────────────

async function runDeferredWork(
  env: Env,
  mode: "shadow" | "on",
  teamId: string,
  event: Record<string, unknown> | undefined,
): Promise<void> {
  if (!event) return

  const channelId = typeof event.channel === "string" ? event.channel : ""
  const slackUserId = typeof event.user === "string" ? event.user : ""
  const rawText = typeof event.text === "string" ? event.text : ""
  // Strip the leading <@BOTID> mention so the agent sees the clean ask.
  const mentionText = rawText.replace(/^<@[A-Z0-9]+>\s*/i, "")
  const threadTs =
    typeof event.thread_ts === "string"
      ? event.thread_ts
      : typeof event.ts === "string"
        ? event.ts
        : ""

  // ── Scope check ─────────────────────────────────────────────────────────────
  const scopeResult = resolveSlackScope(env, { teamId, channelId })
  if (!scopeResult.ok) {
    // Best-effort: try to post a "not connected" message via the bot token.
    const botToken = await getSlackBotToken(env, teamId)
    if (botToken && channelId) {
      await postSlackMessage({
        botToken,
        channel: channelId,
        threadTs,
        text: "Sigilix is not connected to a repo for this channel — ask an admin to configure access.",
      })
    }
    console.log(
      JSON.stringify({ event: "slack-scope-denied", teamId, channelId, reason: scopeResult.reason, mode }),
    )
    return
  }

  // ── Bot token ────────────────────────────────────────────────────────────────
  const botToken = await getSlackBotToken(env, teamId)
  if (!botToken) {
    console.log(JSON.stringify({ event: "slack-no-bot-token", teamId, channelId, mode }))
    return
  }

  // ── Rate-limit check ─────────────────────────────────────────────────────────
  const nowMs = Date.now()
  const dec = await checkSlackRateLimit(env, { teamId, slackUserId, nowMs })

  if (mode === "on" && !dec.allowed) {
    await postSlackMessage({
      botToken,
      channel: channelId,
      threadTs,
      text: `You've reached the Sigilix request limit (${dec.cap} per 5 hours). Try again later.`,
    })
    return
  }

  if (mode === "shadow" && !dec.allowed) {
    // Log the would-deny but continue — shadow never blocks.
    console.log(
      JSON.stringify({ event: "slack-rate-limit-would-deny", teamId, slackUserId, used: dec.used, cap: dec.cap }),
    )
  }

  // ── Fetch and redact thread ──────────────────────────────────────────────────
  const threadMessages = await fetchSlackThread({ botToken, channel: channelId, threadTs })
  const threadText = capAndRedactThread(threadMessages)

  // ── Run agent ────────────────────────────────────────────────────────────────
  const result = await runSlackAgent(env, {
    scope: scopeResult.scope,
    slackUserId,
    channelId,
    threadText,
    mentionText,
  })

  // ── Post / record (on) or just log (shadow) ──────────────────────────────────
  if (mode === "on") {
    await postSlackMessage({ botToken, channel: channelId, threadTs, text: result.reply })
    await recordSlackAction(env, { teamId, slackUserId, nowMs })
  } else {
    // shadow — structured log only; no text/secrets emitted.
    console.log(
      JSON.stringify({
        event: "slack-would-post",
        teamId,
        channelId,
        slackUserId,
        intent: result.action.kind,
        mode,
      }),
    )
  }

  // ── Audit log (no content / no secrets) ─────────────────────────────────────
  console.log(
    JSON.stringify({
      event: "slack-agent-action",
      teamId,
      channelId,
      slackUserId,
      intent: result.action.kind,
      mode,
      allowed: dec.allowed,
      repo: scopeResult.scope.repos[0]
        ? `${scopeResult.scope.repos[0].owner}/${scopeResult.scope.repos[0].repo}`
        : null,
    }),
  )
}
