// SIG-318 / SIG-376 (Tier-1 8/8): Linear-webhook leaf of the Cloudflare
// Workers entry module. Holds the Linear webhook payload shape + the
// Linear webhook handler + the dev/admin manual triage trigger.
// Relocated VERBATIM from the pre-split src/index.ts (modulo the added
// `export` keyword + imports). Imports nothing from the entry module.

import type { Env } from "@/src/shared/types/env"
import { verifyLinearWebhook } from "@/src/lib/webhook-verify"
import { buildLinearClient, buildLinearAgentClient } from "@/src/lib/linear"
import { commentHasSigilixAncestor } from "@/src/lib/linear-thread-ancestor"
import { isBotAuthoredComment } from "@/src/lib/bot-authored-comments"
import { bodyMentionsBot, getMentionTriggers, isBotHandle } from "@/src/lib/mention"
import { resolveLinearAgentRunMode } from "@/src/lib/agent-runner/mode"
import { markAgentSessionCancelled, clearAgentSessionCancelled } from "@/src/lib/linear-agent-cancel"
import {
  claimLinearDelivery,
  completeLinearDelivery,
  getLinearConfig,
  getLinearConnectionByOrganization,
  releaseLinearDelivery,
  resolveLinearTeamBinding,
  teamIsSelected,
  type LinearConnection,
  type LinearTenantContext,
} from "@/src/features/linear-integration"
import type { JobMessage } from "@/src/shared/types/job"

export interface LinearWebhookPayload {
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
    /** SIG-545 B3: the issue's CURRENT assignee user id (null when
     *  unassigned). On an Issue.update assigning the Sigilix agent user,
     *  this equals OPENCLAW_LINEAR_AGENT_USER_ID — the assignment trigger. */
    assigneeId?: string | null
    /** SIG-545 B3: Linear sends `updatedFrom` on `update` actions with the
     *  PREVIOUS values of the fields that changed this update. We only treat
     *  an assignment as a trigger when `assigneeId` actually changed this
     *  update (its own key is present here) so the run doesn't re-fire on
     *  unrelated updates while the issue is already assigned to the agent. */
    updatedFrom?: { assigneeId?: string | null; [k: string]: unknown }
  }
  webhookTimestamp: number
  /** Immutable organization id Linear includes on every OAuth-app webhook. */
  organizationId?: string
}

/**
 * Linear `AgentSessionEvent` webhook — the CANONICAL agent trigger. Once Sigilix is a
 * real Linear agent, delegating an issue to it (or @-mentioning it) sets the agent as
 * DELEGATE and fires this event; the legacy `Issue.update` assignee diff is the interim
 * fallback only. Distinct payload shape from `LinearWebhookPayload` (no `data`).
 *
 *   - action "created":  the session was opened (delegation / @-mention). The agent
 *     must ACK within ~10s, then do the work.
 *   - action "prompted": the user added a follow-up prompt to an existing session.
 *
 * `agentSession.issue.id` is the issue the session is anchored to (used to resolve the
 * repo + dispatch the run). Fields beyond what we read are intentionally omitted.
 */
export interface LinearAgentSessionWebhook {
  type: "AgentSessionEvent"
  action: "created" | "prompted" | string
  agentSession?: {
    id?: string
    issue?: { id?: string; team?: { id?: string } | null } | null
  } | null
  /**
   * SIG-145 (stop): present on `prompted` events. A user STOP is delivered as a
   * `prompted` event whose `agentActivity.signal` is `"stop"` (NOT an `action:
   * "stopped"`) — the agent must halt + post a terminal activity. `body` carries the
   * follow-up prompt text on a normal (non-stop) prompted turn. Modeled loosely (the
   * fields beyond signal/body aren't read here) and treated as a control signal that is
   * checked BEFORE the ACK + the run dedupe/enqueue.
   */
  agentActivity?: {
    signal?: string
    body?: string
  } | null
  webhookTimestamp?: number
  organizationId?: string
}

/** Narrow a parsed Linear webhook body to the AgentSessionEvent shape. */
function isAgentSessionWebhook(raw: unknown): raw is LinearAgentSessionWebhook {
  return typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "AgentSessionEvent"
}

async function runLinearDeliveryOnce(
  env: Env,
  tenant: LinearTenantContext | undefined,
  eventType: string,
  work: () => Promise<void>,
): Promise<Response> {
  // Explicit compatibility for pre-SIG-242 tests/manual deployments with no
  // platform DB binding. Production has SIGILIX_PLATFORM_DB and always takes
  // the strict timestamp/org/delivery path below.
  if (!tenant) {
    try {
      await work()
      return new Response("queued\n", { status: 202 })
    } catch {
      return new Response("enqueue failed\n", { status: 500 })
    }
  }
  const deliveryId = tenant.deliveryId
  if (!deliveryId) return new Response("missing Linear-Delivery\n", { status: 400 })
  const nowMs = Date.now()
  let claim: Awaited<ReturnType<typeof claimLinearDelivery>>
  try {
    claim = await claimLinearDelivery(env, {
      deliveryId,
      organizationId: tenant.organizationId,
      eventType,
      nowMs,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "linear-delivery-claim-failed",
        deliveryId,
        organizationId: tenant.organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return new Response("delivery claim failed\n", { status: 500 })
  }
  if (claim === "duplicate") return new Response("ok\n", { status: 200 })
  try {
    await work()
    await completeLinearDelivery(env, { deliveryId, organizationId: tenant.organizationId, nowMs: Date.now() })
    return new Response("ok\n", { status: 200 })
  } catch (error) {
    try {
      await releaseLinearDelivery(env, { deliveryId, organizationId: tenant.organizationId, nowMs: Date.now() })
    } catch {
      // The 500 still makes Linear retry. A short lease bounds a failed release.
    }
    console.error(
      JSON.stringify({
        event: "linear-delivery-work-failed",
        deliveryId,
        organizationId: tenant.organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return new Response("enqueue failed\n", { status: 500 })
  }
}

function sendLinearJob(env: Env, job: JobMessage): Promise<void> {
  return env.OPENCLAW_JOBS.send(job).then(() => undefined)
}

export async function handleLinearWebhook(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get("linear-signature") ?? ""

  const verified = await verifyLinearWebhook(
    rawBody,
    signature,
    env.LINEAR_WEBHOOK_SECRET,
    env.OPENCLAW_LINEAR_AGENT_WEBHOOK_SECRET,
  )
  if (!verified) {
    return new Response("invalid signature\n", { status: 401 })
  }

  let raw: unknown
  try {
    raw = JSON.parse(rawBody)
  } catch {
    return new Response("invalid json\n", { status: 400 })
  }

  // Replay-window checks are part of webhook authentication, not D1 tenancy.
  // Enforce them even in a migration/manual environment where the platform DB
  // binding is absent.
  const envelope = raw as { webhookTimestamp?: unknown; organizationId?: unknown; type?: unknown }
  const timestamp = Number(envelope.webhookTimestamp)
  const timestampMs = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) {
    return new Response("stale webhook\n", { status: 401 })
  }
  const deliveryId = request.headers.get("linear-delivery")
  if (!deliveryId) return new Response("missing Linear-Delivery\n", { status: 400 })

  let tenant: LinearTenantContext | undefined
  if (env.SIGILIX_PLATFORM_DB) {
    const organizationId = typeof envelope.organizationId === "string" ? envelope.organizationId : ""
    if (!organizationId) return new Response("ok\n", { status: 200 })
    let connection: LinearConnection | null
    try {
      connection = await getLinearConnectionByOrganization(env, organizationId)
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "linear-webhook-org-resolve-failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return new Response("linear tenant lookup failed\n", { status: 500 })
    }
    if (!connection || connection.status !== "active") return new Response("ok\n", { status: 200 })
    const teamId = isAgentSessionWebhook(raw)
      ? raw.agentSession?.issue?.team?.id
      : (raw as LinearWebhookPayload).data?.team?.id
    if (teamId) {
      const [binding, config] = await Promise.all([
        resolveLinearTeamBinding(env, organizationId, teamId),
        getLinearConfig(env, connection.installationId),
      ])
      if (!binding || binding.accessState !== "allowed" || !config || !teamIsSelected(config, teamId)) {
        console.warn(
          JSON.stringify({
            event: "linear-webhook-team-out-of-scope",
            organizationId,
            installationId: connection.installationId,
            teamId,
            bindingPresent: !!binding,
          }),
        )
        return new Response("ok\n", { status: 200 })
      }
    }
    tenant = {
      organizationId,
      installationId: connection.installationId,
      ...(teamId ? { teamId } : {}),
      deliveryId,
    }
  }

  // SIG-545 (agent): AgentSessionEvent is the CANONICAL agent trigger — once Sigilix
  // is a real Linear agent, delegating/@-mentioning it fires this event (not an
  // Issue.update assignee diff). Handled BEFORE the legacy Issue/Comment dispatch
  // because it carries a different payload shape (no `data`).
  if (isAgentSessionWebhook(raw)) {
    return handleAgentSessionEvent(raw, env, tenant)
  }

  const payload = raw as LinearWebhookPayload

  // SIG-545 B3: Issue.update assigning the issue to the Sigilix agent user →
  // dispatch the agent-runner (on the SAFE minimal engine) to implement it.
  // DARK + fail-closed: fires ONLY when ALL hold —
  //   (1) OPENCLAW_LINEAR_AGENT_RUN_MODE === "on",
  //   (2) OPENCLAW_LINEAR_AGENT_USER_ID is set,
  //   (3) the NEW assignee equals that user id, AND
  //   (4) the assignee actually CHANGED this update (Linear includes
  //       `updatedFrom.assigneeId` only when assignee was among the changed
  //       fields) — so it doesn't re-fire on unrelated updates while the issue
  //       is already assigned to the agent.
  // Placed after the corpus-upsert block (which fire-and-forgets on any Issue
  // update) and independent of the Issue.create branch below.
  if (payload.type === "Issue" && payload.action === "update") {
    const agentUserId = env.OPENCLAW_LINEAR_AGENT_USER_ID
    const updatedFrom = payload.data.updatedFrom
    if (
      resolveLinearAgentRunMode(env) === "on" &&
      agentUserId &&
      payload.data.assigneeId === agentUserId &&
      updatedFrom !== undefined &&
      Object.prototype.hasOwnProperty.call(updatedFrom, "assigneeId")
    ) {
      return runLinearDeliveryOnce(env, tenant, "Issue.update.agent-run", () =>
        sendLinearJob(env, { type: "linear-agent-run", issueId: payload.data.id, ...tenant }),
      )
    }
  }

  // Issue.create → enqueue full triage pipeline.
  if (payload.type === "Issue" && payload.action === "create") {
    return runLinearDeliveryOnce(env, tenant, "Issue.create", () =>
      sendLinearJob(env, { type: "linear-triage", issueId: payload.data.id, ...tenant }),
    )
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
    const author = payload.data.user?.displayName ?? payload.data.user?.name ?? null

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
        const linear = await buildLinearClient(env, tenant)
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
            const parentLogin = parent?.user?.displayName ?? parent?.user?.name ?? null
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
    return runLinearDeliveryOnce(env, tenant, "Comment.create", () =>
      sendLinearJob(env, {
        type: "linear-mention",
        commentId: payload.data.id,
        triggerReason,
        ...tenant,
      }),
    )
  }

  return new Response("skipped\n", { status: 200 })
}

/**
 * Handle a Linear `AgentSessionEvent` — the real agent trigger.
 *
 * Gated on `resolveLinearAgentRunMode(env) === "on"` (same flag as the interim
 * assignee path) so the agent runtime ships dark until flipped.
 *
 *   - "created":  delegation / @-mention. ACK immediately (a Linear agent `thought`
 *     activity, expected within ~10s) then enqueue the existing `linear-agent-run`
 *     job (carrying the sessionId so the run posts its `response` into the session).
 *   - "prompted": a follow-up turn on an existing session — ACK + re-enqueue.
 *
 * The ack is best-effort and awaited (a single fast GraphQL call, well within the ack
 * window); a failed ack never blocks the enqueue. Returns 202 once the run is queued.
 */
async function handleAgentSessionEvent(
  payload: LinearAgentSessionWebhook,
  env: Env,
  tenant: LinearTenantContext | undefined,
): Promise<Response> {
  if (resolveLinearAgentRunMode(env) !== "on") {
    return new Response("ok\n", { status: 200 })
  }

  const sessionId = payload.agentSession?.id
  if (!sessionId) {
    console.warn(JSON.stringify({ event: "linear-agent-session-no-session-id", action: payload.action }))
    return new Response("ok\n", { status: 200 })
  }

  if (payload.action !== "created" && payload.action !== "prompted") {
    return new Response("ok\n", { status: 200 })
  }
  if (!tenant) {
    if (payload.agentActivity?.signal === "stop") {
      await handleAgentSessionStop(env, undefined, sessionId)
      return new Response("stopped\n", { status: 200 })
    }
    await ackAgentSession(env, undefined, sessionId)
    const issueId = payload.agentSession?.issue?.id
    if (!issueId) return new Response("no issue\n", { status: 200 })
    await clearAgentSessionCancelled(env, sessionId)
    await sendLinearJob(env, { type: "linear-agent-run", issueId, sessionId })
    return new Response("queued\n", { status: 202 })
  }
  return runLinearDeliveryOnce(env, tenant, `AgentSessionEvent.${payload.action}`, async () => {
    // Stop is a protocol control, not a model/writeback setting. It always stays
    // active even when optional comments/status/labels are disabled.
    if (payload.agentActivity?.signal === "stop") {
      await handleAgentSessionStop(env, tenant, sessionId)
      console.log(JSON.stringify({ event: "linear-agent-session-stopped", action: payload.action }))
      return
    }

    // Protocol ACK is likewise not optional writeback.
    await ackAgentSession(env, tenant, sessionId)
    const issueId = payload.agentSession?.issue?.id
    if (!issueId) {
      console.warn(JSON.stringify({ event: "linear-agent-session-no-issue", action: payload.action }))
      return
    }
    await clearAgentSessionCancelled(env, sessionId)
    await sendLinearJob(env, { type: "linear-agent-run", issueId, sessionId, ...tenant })
    console.log(JSON.stringify({ event: "linear-agent-session-queued", action: payload.action }))
  })
}

/**
 * Post the immediate ACK `thought` activity into an AgentSession. Best-effort — a
 * missing agent token or a Linear API fault is logged + swallowed (the run is still
 * enqueued; a missing ack must never lose the work).
 *
 * The GraphQL call is bounded with a ~2s `AbortSignal.timeout` (the SIG-225 pattern)
 * so it can never block past Linear's webhook ack window — an indefinite hang would
 * miss the ack deadline and cause Linear to redeliver, fanning out duplicate runs. An
 * AbortError lands in the catch below and falls into the same best-effort path.
 *
 * SIG-145: the client is built with `allowRefresh: false` so a stale-token 401 on
 * this hot path can NOT trigger a blocking broker `forceRefresh` (a DO RPC that the
 * `AbortSignal.timeout(2000)` does NOT bound) — which would overrun the ack window.
 * The token read stays on the cached `readOnly` path (one DO read, no refresh POST).
 * The ACK is best-effort: a genuine miss just skips here; the background run still
 * posts the real terminal completion into the session.
 */
async function ackAgentSession(env: Env, tenant: LinearTenantContext | undefined, sessionId: string): Promise<void> {
  try {
    const agent = tenant
      ? await buildLinearAgentClient(env, tenant, { allowRefresh: false })
      : await buildLinearAgentClient(env, { allowRefresh: false })
    if (!agent) {
      console.warn(JSON.stringify({ event: "linear-agent-ack-no-token", sessionId }))
      return
    }
    await agent.createAgentActivity(sessionId, "On it — Sigilix is picking this up.", "thought", {
      signal: AbortSignal.timeout(2000),
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-agent-ack-failed",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/**
 * Handle a user STOP on an AgentSession (SIG-145). Ordered so the session NEVER hangs:
 *
 *  1. Post a TERMINAL `response` "stopped" activity so the session resolves to "stopped"
 *     immediately instead of hanging on "Working" — even when no run is in flight (a stop
 *     on an idle or already-finished session). Same hot-path constraints as the ACK:
 *     bounded `AbortSignal.timeout(2000)` + `allowRefresh: false` so it can't overrun the
 *     webhook ack window. A `null` agent client (no token) SKIPS — never the human key.
 *  2. ONLY IF that "stopped" post SUCCEEDED, mark the session cancelled in KV so an
 *     in-flight run aborts its remaining worker-side steps (`runLinearAgentRun` checkpoints)
 *     and DEFERS its own terminal to this one. Gating the mark on a confirmed post is what
 *     avoids a hang: if the "stopped" post fails, we do NOT set the cancel flag, so the run
 *     completes normally and posts its OWN terminal (resolving as "done") rather than
 *     deferring to a "stopped" that never landed. The cost is that a failed stop-post means
 *     the run isn't aborted (it may open the PR) — an acceptable rare degradation vs a hang.
 *     Marking cannot interrupt an already-running container, only the steps around it.
 *
 * Both steps are best-effort (logged + swallowed) — a failure never blocks the webhook
 * response. NEVER falls back to the human key, NEVER logs token material.
 */
async function handleAgentSessionStop(
  env: Env,
  tenant: LinearTenantContext | undefined,
  sessionId: string,
): Promise<void> {
  let stoppedPosted = false
  try {
    const agent = tenant
      ? await buildLinearAgentClient(env, tenant, { allowRefresh: false })
      : await buildLinearAgentClient(env, { allowRefresh: false })
    if (!agent) {
      console.warn(JSON.stringify({ event: "linear-agent-stop-no-token", sessionId }))
    } else {
      await agent.createAgentActivity(sessionId, "🛑 Stopped — Sigilix halted this run at your request.", "response", {
        signal: AbortSignal.timeout(2000),
      })
      stoppedPosted = true
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-agent-stop-failed",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  // Only cancel the run once the session is provably resolved as "stopped" — see the
  // header. A failed post leaves the flag unset so the run resolves the session itself.
  if (!stoppedPosted) return
  try {
    await markAgentSessionCancelled(env, sessionId)
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-agent-cancel-mark-failed",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

export async function handleManualTrigger(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
