// SIG-455: PrReviewRunDO /defer route + `defer`-alarm re-send. Lifted out of
// pr-review-run.ts to keep that file under the 1,000-line budget
// (COMPLIANCE.md §4) — the DO's /defer route and the "defer" alarm branch are
// one-line delegations to the two functions exported here.
//
// A defer is the fairness escape hatch on the async path: when the webhook
// consumer is denied a per-tenant slot it calls /defer instead of
// message.retry() (a retry would burn the Cloudflare retry budget and drop the
// review). /defer re-arms the per-PR watchdog ceiling and schedules a `defer`
// alarm; when that alarm fires it re-sends a FRESH pr-review queue message and
// re-arms the watchdog. Critically a defer is NOT a retry — `attempt` is
// forwarded UNCHANGED so the single-increment-point rule (spec §4.6a) holds.

import type { Env } from "@/src/shared/types/env"
import type { RunState } from "./types"
import { resolveDoConfig } from "./config"
import { emit, jsonResponse, normalizeRepoId, nowIso } from "./pr-review-run-internals"

const STATE_KEY = "state"

/**
 * POST /defer — body `{ runId, backoffMs }`. QUEUED-ONLY: if the run is no
 * longer `queued` (already `running` after /pickup, or terminal) this is a 200
 * no-op so a duplicate deny can never regress an active run back to `queued`.
 */
export async function handleDeferRequest(ctx: DurableObjectState, env: Env, request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse(400, { error: "invalid_json" })
  }
  const { runId, backoffMs } = (body ?? {}) as { runId?: unknown; backoffMs?: unknown }
  if (typeof runId !== "string" || runId.length === 0 || typeof backoffMs !== "number" || !Number.isFinite(backoffMs)) {
    return jsonResponse(400, { error: "runId (non-empty string) and backoffMs (finite number) are required" })
  }
  const state = await ctx.storage.get<RunState>(STATE_KEY)
  if (!state || state.runId !== runId || state.state !== "queued") {
    return jsonResponse(200, { ok: true, noop: true })
  }
  const config = resolveDoConfig(env)
  const deferCount = (state.deferCount ?? 0) + 1
  const fireAt = Date.now() + Math.max(0, backoffMs)
  const updated: RunState = {
    ...state,
    state: "queued",
    deferCount,
    lastActivityAt: nowIso(),
    alarmTargetRunId: runId,
    alarmKind: "defer",
    // Re-arm the watchdog ceiling so a deferred run is never failed for waiting.
    watchdogDeadlineAt: new Date(Date.now() + config.watchdogMs).toISOString(),
  }
  await ctx.storage.put(STATE_KEY, updated)
  await ctx.storage.setAlarm(fireAt)
  emit("do-review-deferred", {
    owner: state.owner,
    repo: state.repo,
    prNumber: state.prNumber,
    runId,
    deferCount,
    backoffMs,
  })
  return jsonResponse(200, { ok: true })
}

/**
 * `defer` alarm fire — re-send the pr-review job (attempt UNCHANGED, deferCount
 * forwarded) and re-arm the watchdog. Modelled on `handleRetryAlarm` but does
 * NOT increment attempts: a defer is a fairness wait, not a failure retry.
 * Guard: no-op on any non-queued state (running/done/failed/idle) — a defer alarm
 * should only re-send a still-queued run; a running run has already been picked up.
 */
export async function runDeferAlarm(ctx: DurableObjectState, env: Env, state: RunState): Promise<void> {
  if (state.state !== "queued") return
  const config = resolveDoConfig(env)
  await env.OPENCLAW_JOBS.send({
    type: "pr-review",
    owner: state.owner,
    repo: state.repo,
    prNumber: state.prNumber,
    headSha: state.headSha,
    installationId: state.installationId,
    runId: state.runId,
    enqueuedAtMs: Date.now(),
    attempt: state.attempts, // UNCHANGED — a defer is not a retry
    deferCount: state.deferCount ?? 1,
    ...(state.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: state.staleHeadRequeueDepth } : {}),
    ...(state.checkRunId !== undefined ? { checkRunId: state.checkRunId } : {}),
    ...(normalizeRepoId(state.repoId) !== undefined ? { repoId: normalizeRepoId(state.repoId)! } : {}),
  })
  const updated: RunState = {
    ...state,
    alarmTargetRunId: state.runId,
    alarmKind: "watchdog",
    // Refresh the deadline to match the freshly-armed alarm (was stale /defer-time value).
    watchdogDeadlineAt: new Date(Date.now() + config.watchdogMs).toISOString(),
  }
  await ctx.storage.put(STATE_KEY, updated)
  await ctx.storage.setAlarm(Date.now() + config.watchdogMs)
}
