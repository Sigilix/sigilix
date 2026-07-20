// SIG-196: /slack/events webhook route — verify, ack, event_id idempotency, dispatch.
//
// This module is wiring-only. All logic lives in the slack/slack-* helpers.
// Kept deliberately thin (no business logic) to stay within the file-size budget
// and keep the boundary between routing and orchestration clean.

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { resolveSlackMode } from "@/src/lib/slack/slack-mode"
import { verifySlackSignature } from "@/src/lib/slack/slack-verify"
import { resolveSlackScope } from "@/src/lib/slack/slack-scope"
import { getSlackBotToken } from "@/src/lib/slack/slack-install"
import { postSlackMessage, fetchSlackThread, capAndRedactThread } from "@/src/lib/slack/slack-api"
import { checkSlackRateLimit, recordSlackAction } from "@/src/lib/slack/slack-rate-limit"
import { runSlackAgent } from "@/src/lib/slack/slack-agent"
import { resolveEntitlement, upsellFor } from "@/src/features/entitlements"

type SlackMentionJob = Extract<JobMessage, { type: "slack-mention" }>

const SLACK_EVENT_TTL_SECONDS = 24 * 60 * 60
// Slack retries immediately, after one minute, and finally after five. Expire
// an abandoned pending hand-off before that final retry can recover it.
const SLACK_PENDING_TTL_SECONDS = 4 * 60
const SLACK_CLAIM_FINALIZE_ATTEMPTS = 3

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function slackTimestamp(value: unknown): string | null {
  const parsed = nonEmptyString(value)
  return parsed && /^\d+\.\d+$/.test(parsed) ? parsed : null
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Handle POST /slack/events.
 *
 * Flow:
 *   1. url_verification → echo challenge immediately (no auth required).
 *   2. mode=off → 200 empty (inert).
 *   3. SLACK_SIGNING_SECRET missing → 503.
 *   4. Signature verification → 401 on failure.
 *   5. app_mention idempotency via KV (TTL 24 h).
 *   6. Enqueue a secrets-free job and ack 200.
 *   7. The Queue consumer runs scope → token → rate-limit → agent → post/log.
 */
export async function handleSlackRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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

  // ── app_mention validation + idempotency ─────────────────────────────────────
  // Claim a KV key for each unique event_id before scheduling work. A duplicate
  // event_id returns 200 immediately without scheduling anything (Slack retry-safe).
  //
  // NOTE (accepted race / SIG follow-up): Cloudflare KV has no compare-and-set,
  // so a true-concurrent double-delivery could theoretically race past the GET
  // before either PUT lands. In practice the threat is bounded: we ack <3 s, so
  // Slack's retry queue is sequential and the existing claim catches it. An
  // atomic D1 unique-constraint claim is the tracked hardening before `on` GA.
  if (body?.type !== "event_callback") {
    return new Response("", { status: 200 })
  }

  const event = body.event as Record<string, unknown> | undefined
  if (event?.type !== "app_mention") {
    return new Response("", { status: 200 })
  }

  const eventId = nonEmptyString(body.event_id)
  const teamId = nonEmptyString(body.team_id)
  const channelId = nonEmptyString(event.channel)
  const slackUserId = nonEmptyString(event.user)
  const rawText = nonEmptyString(event.text)
  const threadTs = event.thread_ts == null ? slackTimestamp(event.ts) : slackTimestamp(event.thread_ts)
  if (!eventId || !teamId || !channelId || !slackUserId || !rawText || !threadTs) {
    console.log(JSON.stringify({ event: "slack-app-mention-invalid" }))
    return new Response("", { status: 200 })
  }

  const claimKey = slackClaimKey(teamId, eventId)
  const existing = await env.OPENCLAW_STATE.get(claimKey)
  if (existing !== null) {
    // A pending claim means another delivery has not yet proven its durable
    // queue hand-off. Return 503 so Slack keeps retrying instead of accepting
    // an event that the first delivery may still fail to enqueue. Any other
    // value includes legacy "1" claims and confirmed queued work.
    return new Response("", { status: existing === "pending" ? 503 : 200 })
  }
  // Claim pending BEFORE enqueueing so a retry cannot receive a false success
  // until this request has completed the durable hand-off.
  await env.OPENCLAW_STATE.put(claimKey, "pending", { expirationTtl: SLACK_PENDING_TTL_SECONDS })

  const job: SlackMentionJob = {
    type: "slack-mention",
    eventId,
    teamId,
    channelId,
    slackUserId,
    rawText,
    threadTs,
  }
  try {
    // Queue.send is deliberately awaited: only acknowledge Slack after the
    // durable hand-off succeeds. The payload contains no bot/signing secrets.
    await env.OPENCLAW_JOBS.send(job)
  } catch (error) {
    try {
      await env.OPENCLAW_STATE.delete(claimKey)
    } catch {
      // The pending claim expires after four minutes; never mask the enqueue failure.
    }
    console.error(
      JSON.stringify({
        event: "slack-mention-enqueue-failed",
        eventId,
        teamId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return new Response("", { status: 503 })
  }
  for (let attempt = 1; attempt <= SLACK_CLAIM_FINALIZE_ATTEMPTS; attempt += 1) {
    try {
      await env.OPENCLAW_STATE.put(claimKey, "queued", { expirationTtl: SLACK_EVENT_TTL_SECONDS })
      break
    } catch {
      if (attempt === SLACK_CLAIM_FINALIZE_ATTEMPTS) {
        // The queue already owns the job. Never ask Slack to retry a durably
        // accepted event just because this advisory state transition failed.
        console.error(JSON.stringify({ event: "slack-mention-claim-finalize-failed", eventId, teamId }))
      }
    }
  }

  return new Response("", { status: 200 })
}

// ─── Queue consumer ───────────────────────────────────────────────────────────

function slackClaimKey(teamId: string, eventId: string): string {
  return `slack-event:${teamId}:${eventId}`
}

function slackCompletionKey(teamId: string, eventId: string): string {
  return `slack-event-posted:${teamId}:${eventId}`
}

async function slackMentionIsComplete(env: Env, teamId: string, eventId: string): Promise<boolean> {
  // Cloudflare Queue delivery and KV claims are at-least-once/best-effort. This
  // removes sequential redeliveries; the acknowledged residual is a concurrent
  // delivery or process death between Slack acceptance and this marker write.
  try {
    return (await env.OPENCLAW_STATE.get(slackCompletionKey(teamId, eventId))) !== null
  } catch {
    // Completion dedupe is best-effort. A KV read outage must not permanently
    // discard a user request that has not yet produced a confirmed reply.
    return false
  }
}

async function markSlackMentionComplete(env: Env, teamId: string, eventId: string): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(slackCompletionKey(teamId, eventId), "1", {
      expirationTtl: SLACK_EVENT_TTL_SECONDS,
    })
  } catch {
    // A confirmed Slack post must not become a retry loop merely because the
    // best-effort completion marker is unavailable.
    console.error(JSON.stringify({ event: "slack-completion-marker-write-failed", eventId }))
  }
}

async function postSlackMentionReply(
  env: Env,
  job: SlackMentionJob,
  args: { botToken: string; text: string },
): Promise<void> {
  const posted = await postSlackMessage({
    botToken: args.botToken,
    channel: job.channelId,
    threadTs: job.threadTs,
    text: args.text,
  })
  if (!posted.ok) {
    console.error(
      JSON.stringify({
        event: "slack-post-rejected",
        eventId: job.eventId,
        teamId: job.teamId,
        channelId: job.channelId,
      }),
    )
    throw new Error("Slack reply was not accepted")
  }
  console.log(JSON.stringify({ event: "slack-post-confirmed", eventId: job.eventId, teamId: job.teamId }))
  await markSlackMentionComplete(env, job.teamId, job.eventId)
}

export async function runSlackMentionJob(env: Env, job: SlackMentionJob): Promise<void> {
  if (await slackMentionIsComplete(env, job.teamId, job.eventId)) return

  const mode = resolveSlackMode(env)
  if (mode === "off") {
    await markSlackMentionComplete(env, job.teamId, job.eventId)
    return
  }
  const { teamId, channelId, slackUserId, rawText, threadTs } = job
  // Strip the leading <@BOTID> mention so the agent sees the clean ask.
  const mentionText = rawText.replace(/^<@[A-Z0-9]+>\s*/i, "")

  // ── Scope check ─────────────────────────────────────────────────────────────
  const scopeResult = await resolveSlackScope(env, { teamId, channelId })
  if (!scopeResult.ok) {
    if (mode === "on") {
      // Best-effort: try to post a "not connected" message via the bot token.
      const botToken = await getSlackBotToken(env, teamId)
      if (botToken && channelId) {
        await postSlackMentionReply(env, job, {
          botToken,
          text: "Sigilix is not connected to a repo for this channel — ask an admin to configure access.",
        })
      } else {
        await markSlackMentionComplete(env, job.teamId, job.eventId)
      }
    } else {
      await markSlackMentionComplete(env, job.teamId, job.eventId)
    }
    console.log(JSON.stringify({ event: "slack-scope-denied", teamId, channelId, reason: scopeResult.reason, mode }))
    return
  }

  // ── Bot token ────────────────────────────────────────────────────────────────
  const botToken = await getSlackBotToken(env, teamId)
  if (!botToken) {
    console.log(JSON.stringify({ event: "slack-no-bot-token", teamId, channelId, mode }))
    await markSlackMentionComplete(env, job.teamId, job.eventId)
    return
  }

  // ── Entitlement gate (sig-free-tier-entitlements) ────────────────────────────
  // The Slack assistant is Pro/Teams/Max/Ultra/Enterprise only. Resolve the plan from THIS team's
  // mapped installation (scope isolation — never another team's). If not entitled,
  // reply with a brief upsell rather than silently ignoring or answering.
  // off/shadow are non-blocking; only enforce blocks.
  const slackEntitlement = await resolveEntitlement(env, {
    installationId: scopeResult.scope.installationId,
    feature: "slack",
  })
  if (slackEntitlement.blocked) {
    const upsell = upsellFor("slack")
    if (upsell) {
      await postSlackMentionReply(env, job, { botToken, text: upsell })
    } else {
      await markSlackMentionComplete(env, job.teamId, job.eventId)
    }
    console.log(JSON.stringify({ event: "slack-not-entitled", teamId, channelId, plan: slackEntitlement.plan }))
    return
  }

  // ── Rate-limit check ─────────────────────────────────────────────────────────
  const nowMs = Date.now()
  const dec = await checkSlackRateLimit(env, { teamId, slackUserId, nowMs })

  if (mode === "on" && !dec.allowed) {
    await postSlackMentionReply(env, job, {
      botToken,
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
    threadTs,
    threadText,
    mentionText,
    // Passed through ONLY for the org-teach admin check (users.info) before an
    // ORG-scope learning is captured. Never logged.
    botToken,
  })

  // ── Post / record (on) or just log (shadow) ──────────────────────────────────
  if (mode === "on") {
    await postSlackMentionReply(env, job, { botToken, text: result.reply })
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
    await markSlackMentionComplete(env, job.teamId, job.eventId)
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
