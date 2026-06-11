// ARC-190 Task 8 + SIG-174: webhook-side enqueue into the authoritative
// PR-review DO. The old rollout mode flag has been removed, so automatic
// webhook reviews always call DO /enqueue and the DO emits the queue
// message internally with `runId` populated.
//
// The DO call is `await stub.fetch(...)`-ed (NOT `ctx.waitUntil`) so a
// transport / non-OK failure bubbles up as a 503 to GitHub for redelivery.

import type { Env } from "@/src/shared/types/env"
import type { EnqueueRequest } from "./types"
import { buildPausedKey, buildIgnoredKey } from "@/src/lib/pr-lifecycle-commands"

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
   * SIG-247 Phase 1: GitHub's immutable `repo.id` from
   * `payload.repository.id`. Threaded through to RunState + every
   * downstream queue message so review-memory lookups can use the
   * transfer-proof keyspace.
   */
  repoId?: number
}

// SIG-98 note on slash-command reruns + the pause/ignore gate:
//
// The non-silent `/sigilix review` and `/sigilix full review` reruns
// dispatched from `dispatchJob/pr-review-rerun` post their queue
// message via a raw `env.OPENCLAW_JOBS.send` (see `src/index.ts`
// around the `pr-review-rerun` case) instead of routing through
// `enqueuePrReviewJob`. That raw-send path intentionally bypasses
// BOTH (a) the DO per-(PR, headSha) dedup AND (b) the pause/ignore
// gate below — a user typing `/sigilix review` is an explicit ask
// for a fresh review, regardless of pause state.
//
// All AUTOMATIC enqueue paths (webhook `synchronize`, warmup-fired
// silent reruns, stale-head requeues) DO call `enqueuePrReviewJob`
// and therefore honor the gate. That's the only behavior split:
// automatic = gated, user-typed = not gated.

export type PrReviewEnqueueResult =
  | { ok: true; route: "do" }
  | { ok: true; route: "skipped-paused" }
  | { ok: true; route: "skipped-ignored" }
  | {
      ok: false
      route: "do"
      reason: "do-transport" | "do-status"
      /** Set when reason === "do-status". */
      status?: number
    }

function instanceName(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`
}

/**
 * DO enqueue used by `handleGitHubWebhook` on the `pull_request`
 * branch. Returns `{ok: false, route: "do", ...}` when
 * the DO call fails (caller should respond 503).
 */
export async function enqueuePrReviewJob(env: Env, args: PrReviewEnqueueArgs): Promise<PrReviewEnqueueResult> {
  // SIG-98 — pause/ignore gate. Skip the enqueue entirely when a
  // per-PR pause (24h TTL) or ignore (no TTL) flag is set in KV.
  // Every caller of this function is an AUTOMATIC trigger (webhook
  // synchronize, warmup-fired silent rerun, stale-head requeue) and
  // honors the gate uniformly. User-typed slash-command reruns
  // bypass naturally because they raw-send to `OPENCLAW_JOBS` and
  // never reach this function — see the comment block above.
  //
  // Read both keys in parallel: KV.get is cheap, this is webhook-hot
  // path, and we always want to log which flag won.
  const [pausedAt, ignoredAt] = await Promise.all([
    env.OPENCLAW_STATE.get(buildPausedKey(args.owner, args.repo, args.prNumber)),
    env.OPENCLAW_STATE.get(buildIgnoredKey(args.owner, args.repo, args.prNumber)),
  ])
  if (ignoredAt !== null) {
    console.log(
      JSON.stringify({
        event: "pr-review-skipped",
        reason: "ignored",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        ignoredAt,
      }),
    )
    return { ok: true, route: "skipped-ignored" }
  }
  if (pausedAt !== null) {
    console.log(
      JSON.stringify({
        event: "pr-review-skipped",
        reason: "paused",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        pausedAt,
      }),
    )
    return { ok: true, route: "skipped-paused" }
  }

  const body: EnqueueRequest = {
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: args.headSha,
    baseSha: args.baseSha,
    installationId: args.installationId,
    deliveryId: args.deliveryId,
    ...(args.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: args.staleHeadRequeueDepth } : {}),
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
  }
  let response: Response
  try {
    const id = env.PR_REVIEW_RUN.idFromName(instanceName(args.owner, args.repo, args.prNumber))
    const stub = env.PR_REVIEW_RUN.get(id)
    response = await stub.fetch(`${DO_BASE_URL}/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "do-review-enqueue-failed",
        dedupe_system: "do",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return { ok: false, route: "do", reason: "do-transport" }
  }
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "do-review-enqueue-non-ok",
        dedupe_system: "do",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        doStatus: response.status,
      }),
    )
    return { ok: false, route: "do", reason: "do-status", status: response.status }
  }

  return { ok: true, route: "do" }
}
