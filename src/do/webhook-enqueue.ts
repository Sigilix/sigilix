// ARC-190 Task 8: webhook-side gating between the DO and the legacy
// `OPENCLAW_JOBS.send` path.
//
// Contract (spec §4.4):
//   off    → existing direct OPENCLAW_JOBS.send only. No DO call.
//   shadow → DO /enqueue (observation-only — the DO does NOT enqueue
//            its own queue message in shadow) + existing direct send.
//   post   → DO /enqueue only. Webhook does NOT call OPENCLAW_JOBS.send
//            directly (Codex MAJOR on plan v1). The DO emits the queue
//            message internally with `runId` populated.
//
// The DO call is `await stub.fetch(...)`-ed (NOT `ctx.waitUntil`) so a
// transport / non-OK failure in `post` mode bubbles up as a 503 to
// GitHub for redelivery (spec §4.4 awaited semantics). In `shadow` we
// swallow + log; the existing-path send remains the source of truth.

import type { Env } from "../index"
import { resolveDoConfig } from "./config"
import type { EnqueueRequest, PrReviewMode } from "./types"
import { buildPausedKey, buildIgnoredKey } from "../lib/pr-lifecycle-commands"

const DO_BASE_URL = "https://do.internal"

export interface PrReviewEnqueueArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  /** PR base.sha when available; null when the webhook payload omits it. */
  baseSha: string | null
  installationId: number
  /** GitHub `x-github-delivery` header captured at webhook time. */
  deliveryId: string | null
  /**
   * ARC-251: stale-head requeue depth carried through to the DO and/or
   * legacy queue message. Webhook callers omit this; the stale-head
   * helper sets `prevDepth + 1` when re-enqueuing.
   */
  staleHeadRequeueDepth?: number
  /**
   * SIG-98: skip the pause/ignore KV gate. The slash-command `/sigilix
   * review` and `/sigilix full review` handlers set this so an
   * explicit user request always re-runs even on a paused PR — the
   * gate is for automatic (webhook-driven) triggers only.
   *
   * Webhook + warmup + stale-head callers omit this (defaults to
   * false → gate applies).
   */
  bypassPauseGate?: boolean
}

export type PrReviewEnqueueResult =
  | { ok: true; mode: PrReviewMode }
  | { ok: true; mode: "skipped-paused" }
  | { ok: true; mode: "skipped-ignored" }
  | {
      ok: false
      mode: "post"
      reason: "do-transport" | "do-status"
      /** Set when reason === "do-status". */
      status?: number
    }

function instanceName(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`
}

/**
 * Mode-gated enqueue used by `handleGitHubWebhook` on the
 * `pull_request` branch. Returns `{ok: false, mode: "post", ...}` only
 * when post-mode DO call fails (caller should respond 503). All other
 * branches return `{ok: true, mode}`.
 */
export async function enqueuePrReviewJob(
  env: Env,
  args: PrReviewEnqueueArgs,
): Promise<PrReviewEnqueueResult> {
  // SIG-98 — pause/ignore gate. Skip the enqueue entirely when a
  // per-PR pause (24h TTL) or ignore (no TTL) flag is set in KV.
  // The bypass flag exists for explicit user re-runs (`/sigilix
  // review` / `/sigilix full review`) — automatic webhook triggers
  // honor the gate.
  //
  // Read both keys in parallel: KV.get is cheap, this is webhook-hot
  // path, and we always want to log which flag won.
  if (!args.bypassPauseGate) {
    const [pausedAt, ignoredAt] = await Promise.all([
      env.OPENCLAW_STATE.get(buildPausedKey(args.owner, args.repo, args.prNumber)),
      env.OPENCLAW_STATE.get(buildIgnoredKey(args.owner, args.repo, args.prNumber)),
    ])
    if (ignoredAt !== null) {
      console.log(JSON.stringify({
        event: "pr-review-skipped",
        reason: "ignored",
        owner: args.owner, repo: args.repo, prNumber: args.prNumber,
        ignoredAt,
      }))
      return { ok: true, mode: "skipped-ignored" }
    }
    if (pausedAt !== null) {
      console.log(JSON.stringify({
        event: "pr-review-skipped",
        reason: "paused",
        owner: args.owner, repo: args.repo, prNumber: args.prNumber,
        pausedAt,
      }))
      return { ok: true, mode: "skipped-paused" }
    }
  }

  const { mode } = resolveDoConfig(env)

  // Phase 1 — DO /enqueue (post + shadow). The entire DO phase
  // (including stub acquisition via idFromName / get) lives inside the
  // try-catch so a misbound binding or any thrown stub-resolution
  // error in shadow mode falls through to the legacy send below
  // (Codex MAJOR on Task 8 review v1 — spec §4.4 invariant 5: shadow
  // DO failures must never reject GitHub).
  if (mode === "post" || mode === "shadow") {
    const body: EnqueueRequest = {
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha,
      baseSha: args.baseSha,
      installationId: args.installationId,
      deliveryId: args.deliveryId,
      mode,
      ...(args.staleHeadRequeueDepth !== undefined
        ? { staleHeadRequeueDepth: args.staleHeadRequeueDepth }
        : {}),
    }
    let response: Response | null = null
    try {
      const id = env.PR_REVIEW_RUN.idFromName(instanceName(args.owner, args.repo, args.prNumber))
      const stub = env.PR_REVIEW_RUN.get(id)
      response = await stub.fetch(`${DO_BASE_URL}/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (err) {
      console.error(JSON.stringify({
        event: "do-review-enqueue-failed",
        dedupe_system: "do",
        owner: args.owner, repo: args.repo, prNumber: args.prNumber, mode,
        err: err instanceof Error ? err.message : String(err),
      }))
      if (mode === "post") {
        return { ok: false, mode: "post", reason: "do-transport" }
      }
      // shadow: continue to existing-path send.
    }
    if (response && !response.ok) {
      console.error(JSON.stringify({
        event: "do-review-enqueue-non-ok",
        dedupe_system: "do",
        owner: args.owner, repo: args.repo, prNumber: args.prNumber, mode,
        doStatus: response.status,
      }))
      if (mode === "post") {
        return { ok: false, mode: "post", reason: "do-status", status: response.status }
      }
      // shadow: continue.
    }
  }

  // Phase 2 — existing-path queue send (off + shadow). Post mode skips
  // because the DO's /enqueue handler dispatches the queue message
  // itself (with runId populated).
  if (mode === "off" || mode === "shadow") {
    await env.OPENCLAW_JOBS.send({
      type: "pr-review",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha,
      installationId: args.installationId,
      // ARC-251: thread the requeue depth through the legacy queue
      // path. Webhook callers omit this; the stale-head helper sets
      // it when re-enqueuing against the current head SHA.
      ...(args.staleHeadRequeueDepth !== undefined
        ? { staleHeadRequeueDepth: args.staleHeadRequeueDepth }
        : {}),
    })
  }

  return { ok: true, mode }
}
