// SIG-318 / SIG-376 (Tier-1 8/8): Linear-webhook leaf of the Cloudflare
// Workers entry module. Holds the Linear webhook payload shape + the
// Linear webhook handler + the dev/admin manual triage trigger.
// Relocated VERBATIM from the pre-split src/index.ts (modulo the added
// `export` keyword + imports). Imports nothing from the entry module.

import type { Env } from "@/src/shared/types/env"
import { verifyLinearWebhook } from "@/src/lib/webhook-verify"
import { LinearClient, buildLinearAuth } from "@/src/lib/linear"
import { commentHasSigilixAncestor } from "@/src/lib/linear-thread-ancestor"
import { isBotAuthoredComment } from "@/src/lib/bot-authored-comments"
import { bodyMentionsBot, getMentionTriggers, isBotHandle } from "@/src/lib/mention"
import { multiCorpusEnabled } from "@/src/lib/multi-corpus"

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
  }
  webhookTimestamp: number
}

export async function handleLinearWebhook(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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

  // SIG-44: any Issue create/update refreshes the issue: multi-corpus
  // namespace (flag-gated, fire-and-forget). Placed before the create→triage
  // return below so BOTH actions are covered. The consumer maps the issue's
  // Linear team → GitHub repo via OPENCLAW_TEAM_GITHUB_REPO_MAP; an unmapped
  // team no-ops, so this is inert for non-Linear-linked repos.
  if (
    multiCorpusEnabled(env) &&
    payload.type === "Issue" &&
    (payload.action === "create" || payload.action === "update")
  ) {
    _ctx.waitUntil(
      env.OPENCLAW_JOBS.send({ type: "corpus-issue-upsert", linearIssueId: payload.data.id }).catch((err) => {
        console.warn(
          JSON.stringify({
            event: "corpus-issue-upsert-enqueue-failed",
            issueId: payload.data.id,
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }),
    )
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
    await env.OPENCLAW_JOBS.send({
      type: "linear-mention",
      commentId: payload.data.id,
      triggerReason,
    })
    return new Response("queued\n", { status: 202 })
  }

  return new Response("skipped\n", { status: 200 })
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
