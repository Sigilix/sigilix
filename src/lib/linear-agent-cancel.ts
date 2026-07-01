// SIG-145 (stop/cancel): a user STOP on a Linear AgentSession arrives as an
// `AgentSessionEvent` with `action: "prompted"` carrying `agentActivity.signal: "stop"`
// — NOT an `action: "stopped"`. Linear's contract (see the Signals guide): on a stop the
// agent must halt work and emit a TERMINAL activity (`response`/`error`) to confirm.
//
// This module is the cross-isolate signal between the WEBHOOK (which receives the stop
// and marks the session cancelled) and the in-flight RUN (which checks the flag at its
// worker-side checkpoints and aborts): a short-TTL KV marker keyed by sessionId. It is a
// CONTROL signal, deliberately kept independent of the per-ticket run-dedupe marker so a
// stop is honored even for a run that would otherwise dedupe.
//
// KV is eventually consistent (~60s cross-POP), so the run-side read is BEST-EFFORT — a
// stop may not be visible to a run on another POP for a short window. That is acceptable
// for RESOLUTION: the webhook posts the terminal "stopped" activity immediately (and only
// marks cancelled once that post succeeded — see handleAgentSessionStop), so the session
// is already resolved before the marker matters; the run-side check is an optimization
// that aborts the remaining worker-side work when the signal is visible (it cannot
// interrupt an already-running container — see runLinearAgentRun).
//
// RESIDUAL WINDOWS (accepted; both need a strongly-consistent primitive — a DO — rather
// than KV to fully close, tracked as a follow-up before this ships un-dark):
//   1. STALE-ABSENT (safe): if a stop lands within ~KV-propagation of a container run
//      finishing, the run's post-dispatch checkpoint may read the marker as absent and post
//      its OWN terminal completion after the webhook's "stopped". Whether that "done" is
//      shown or rejected depends on Linear's terminal-activity semantics for an already-
//      resolved session; either way the session is resolved — this direction never hangs.
//   2. STALE-PRESENT after a re-prompt (can hang): the marker is cleared on a non-stop
//      turn (see clearAgentSessionCancelled), but Cloudflare KV does not proactively
//      invalidate edge caches on delete — a consumer POP that cached "1" during a prior
//      stopped turn can keep serving it for up to the get cache TTL (~60s). If the SAME POP
//      then runs the re-prompt turn's run inside that window, a checkpoint reads a stale
//      "1", aborts, and posts no terminal (a non-stop turn has no webhook "stopped") → that
//      session can hang until the cache expires. Narrow (needs POP co-location + a re-prompt
//      inside the window), but it fails toward a hang, so it is NOT fully closed here — the
//      per-turn-token fix (distinguish a current-turn stop from a stale prior-turn marker)
//      is the follow-up. This is why the run-side check below is described as best-effort.
//
// NEVER stores or logs token material.

import type { Env } from "@/src/shared/types/env"

/** Minimal env slice — only the KV binding the markers live in. */
type CancelEnv = Pick<Env, "OPENCLAW_STATE">

/** KV key prefix for the per-session cancel marker. */
export const AGENT_CANCEL_KV_PREFIX = "linear-agent-cancel"

/** TTL for the cancel marker — comfortably longer than the max run (the agent-run cap is
 *  timeoutMs 600s) so an in-flight run's later checkpoint still sees it, short enough to
 *  self-expire so a stale flag never suppresses a genuinely-new future session. */
export const AGENT_CANCEL_TTL_SECONDS = 60 * 60 // 1 hour

function keyFor(sessionId: string): string {
  return `${AGENT_CANCEL_KV_PREFIX}:${sessionId}`
}

/**
 * Mark an AgentSession cancelled so an in-flight run aborts at its next checkpoint.
 * Thin KV put — the caller (the webhook stop handler) wraps this best-effort so a KV
 * blip never fails the webhook. NEVER logs token material.
 */
export async function markAgentSessionCancelled(env: CancelEnv, sessionId: string): Promise<void> {
  if (!sessionId || !sessionId.trim()) return
  await env.OPENCLAW_STATE.put(keyFor(sessionId), "1", { expirationTtl: AGENT_CANCEL_TTL_SECONDS })
}

/**
 * Clear the cancel marker for a session. A Linear AgentSession is PERSISTENT — a
 * follow-up prompt reuses the same sessionId — so a stop marker left in place would make
 * the NEXT (non-stop) turn's run abort at its first checkpoint and hang the session. The
 * webhook clears the marker on every non-stop `created`/`prompted` turn before enqueuing
 * the run, so a fresh turn always starts un-cancelled (a mid-run stop simply re-marks it).
 * Best-effort: a KV fault is logged + swallowed (a stale marker self-expires via TTL).
 * NEVER logs token material.
 */
export async function clearAgentSessionCancelled(env: CancelEnv, sessionId: string): Promise<void> {
  if (!sessionId || !sessionId.trim()) return
  try {
    await env.OPENCLAW_STATE.delete(keyFor(sessionId))
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-agent-cancel-clear-failed",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/**
 * True when the session has been marked cancelled. FAILS OPEN (returns false) on a KV
 * fault — the webhook's own terminal "stopped" post is the reliable resolution, so a
 * missed read here only means the run does some extra work, never a hang or a wrong
 * cancel. NEVER logs token material.
 */
export async function isAgentSessionCancelled(env: CancelEnv, sessionId: string): Promise<boolean> {
  if (!sessionId || !sessionId.trim()) return false
  try {
    return (await env.OPENCLAW_STATE.get(keyFor(sessionId))) !== null
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-agent-cancel-read-failed",
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return false
  }
}
