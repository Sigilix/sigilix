// ARC-190: PrReviewRunDO class + pure decision helpers + route
// dispatch.
//
// Spec: docs/superpowers/specs/2026-05-07-arc-190-durable-objects-webhook-ingest-design.md
// Plan: docs/superpowers/plans/2026-05-07-arc-190-durable-objects-webhook-ingest.md
//
// Task 5 lands the route handlers (/enqueue, /pickup, /run-result,
// /status). Task 6 lands the alarm() handler.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"
import type {
  EnqueueAction,
  EnqueueRequest,
  EnqueueResponse,
  RunRecord,
  RunResultRequest,
  RunState,
  StatusResponse,
} from "./types"
import { resolveDoConfig } from "./config"
import {
  attachExistingCheckRun,
  completeCheckRun,
  startInProgressCheckRun,
} from "../lib/pr-review-check-run"

// ─── Class ────────────────────────────────────────────────────

const STATE_KEY = "state"

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, dedupe_system: "do", ...fields }))
}

function nowIso(): string {
  return new Date().toISOString()
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export class PrReviewRunDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/enqueue") {
      return this.handleEnqueue(request)
    }
    if (request.method === "POST" && url.pathname === "/pickup") {
      return this.handlePickup(request)
    }
    if (request.method === "POST" && url.pathname === "/run-result") {
      return this.handleRunResult(request)
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return this.handleStatus()
    }
    return jsonResponse(404, { error: "unknown route" })
  }

  // ── /enqueue ────────────────────────────────────────────────

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = (await request.json()) as EnqueueRequest
    const config = resolveDoConfig(this.env)
    const existing = await this.ctx.storage.get<RunState>(STATE_KEY)
    const decision = decideEnqueueAction(existing ?? null, body)

    if (decision.action === "dedupe-active" || decision.action === "dedupe-terminal") {
      const state = existing!
      emit("do-review-deduped", {
        owner: body.owner, repo: body.repo, prNumber: body.prNumber,
        runId: state.runId,
        action: decision.action,
        reason: decision.reason,
      })
      const resp: EnqueueResponse = {
        deduped: true,
        runId: state.runId,
        action: decision.action,
      }
      return jsonResponse(200, resp)
    }

    // create | supersede — both create a new RunState. supersede
    // archives the old one to history first.
    if (decision.action === "supersede" && existing) {
      // Archive only if existing was non-idle; idle state has no
      // material history to keep.
      if (existing.state !== "idle") {
        const record: RunRecord = {
          runId: existing.runId,
          headSha: existing.headSha,
          finalState: existing.state === "done" ? "done" : "failed",
          attempts: existing.attempts,
          startedAt: existing.startedAt,
          finishedAt: existing.finishedAt ?? nowIso(),
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        }
        await this.ctx.storage.put(`run:${existing.runId}`, record)
      }
      emit("do-review-superseded", {
        owner: body.owner, repo: body.repo, prNumber: body.prNumber,
        oldRunId: existing.runId,
        oldHeadSha: existing.headSha,
        newHeadSha: body.headSha,
      })
    }

    // SIG-220: create the customer-visible "Sigilix · In progress"
    // check synchronously, BEFORE persisting RunState + enqueueing.
    // Pre-SIG-220 the dispatcher did this after the consumer dequeued
    // → check appeared in the GitHub UI 5–30s after push. Now it
    // appears within the webhook-ack window (~1–2s).
    //
    // Codex architecture review on PR #178 follow-up:
    //   - Creating HERE (post-decideEnqueueAction = create | supersede)
    //     is strictly better than creating in the worker fetch handler:
    //     dedupe paths never produce orphan checks, pause/ignore
    //     never produce orphan checks (those branches don't reach
    //     this code path).
    //   - sensitive-repo skip is dispatcher-side — the dispatcher's
    //     skip branch now closes the check it doesn't own. Watchdog
    //     terminal failure also closes via `attachExistingCheckRun`.
    //
    // Best-effort: a null result (creds missing, GitHub 5xx, etc.)
    // leaves `checkRunId` undefined on RunState; the dispatcher
    // falls back to its own `startInProgressCheckRun` exactly like
    // legacy queue messages.
    const checkRun = await startInProgressCheckRun({
      env: this.env,
      owner: body.owner,
      repo: body.repo,
      headSha: body.headSha,
      installationId: body.installationId,
    })

    const runId = crypto.randomUUID()
    const newState: RunState = {
      schemaVersion: 1,
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
      runId,
      headSha: body.headSha,
      baseSha: body.baseSha,
      installationId: body.installationId,
      state: "queued",
      attempts: 1,
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      // ARC-251 Codex BLOCKER #2: persist requeue depth on RunState so
      // it survives retry-alarm-generated queue messages. Without this,
      // the retry-alarm rebuilds the pr-review message from RunState
      // and the depth silently resets to 0 — bypassing the cap.
      ...(body.staleHeadRequeueDepth !== undefined
        ? { staleHeadRequeueDepth: body.staleHeadRequeueDepth }
        : {}),
      // SIG-220: persist the upstream-created check id so the
      // consumer + watchdog can close it. Undefined if creation
      // failed (best-effort dispatcher fallback applies).
      ...(checkRun !== null ? { checkRunId: checkRun.id } : {}),
    }

    // CR PR #70 catch: arm the watchdog BEFORE OPENCLAW_JOBS.send.
    // setAlarm is first so a persisted queued state never exists
    // without a scheduled watchdog. queue.send remains last; if it
    // throws, the armed watchdog resends on schedule.
    const watchdogAt = Date.now() + config.watchdogMs
    newState.alarmTargetRunId = runId
    newState.alarmKind = "watchdog"
    await this.ctx.storage.setAlarm(watchdogAt)
    await this.ctx.storage.put(STATE_KEY, newState)
    await this.env.OPENCLAW_JOBS.send({
      type: "pr-review",
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
      headSha: body.headSha,
      installationId: body.installationId,
      runId,
      // ARC-251: forward requeue depth so the consumer side keeps
      // the cap accurate across the initial enqueue path too.
      ...(body.staleHeadRequeueDepth !== undefined
        ? { staleHeadRequeueDepth: body.staleHeadRequeueDepth }
        : {}),
      // SIG-220: forward the upstream-created check id so the
      // dispatcher attaches instead of creating a duplicate.
      ...(checkRun !== null ? { checkRunId: checkRun.id } : {}),
    })

    emit("do-review-enqueued", {
      owner: body.owner, repo: body.repo, prNumber: body.prNumber,
      runId, headSha: body.headSha, action: decision.action,
    })

    const resp: EnqueueResponse = {
      deduped: false,
      runId,
      action: decision.action,
    }
    return jsonResponse(200, resp)
  }

  // ── /pickup ─────────────────────────────────────────────────

  private async handlePickup(request: Request): Promise<Response> {
    const body = (await request.json()) as { runId: string; consumerId: string }
    const existing = await this.ctx.storage.get<RunState>(STATE_KEY)
    const decision = decidePickupAction(existing ?? null, body.runId, body.consumerId)

    if (decision.action === "stale-runId-410" || decision.action === "terminal-410") {
      emit("do-review-pickup-skipped", {
        owner: existing?.owner, repo: existing?.repo, prNumber: existing?.prNumber,
        runId: body.runId, consumerId: body.consumerId, reason: decision.action,
      })
      return jsonResponse(410, { reason: decision.action })
    }
    if (decision.action === "duplicate-409") {
      emit("do-review-pickup-skipped", {
        owner: existing?.owner, repo: existing?.repo, prNumber: existing?.prNumber,
        runId: body.runId, consumerId: body.consumerId, reason: decision.action,
      })
      return jsonResponse(409, { reason: decision.action })
    }
    if (existing!.state === "running" && existing!.consumerId === body.consumerId) {
      return jsonResponse(200, { picked: true })
    }

    // claim
    const config = resolveDoConfig(this.env)
    const updated: RunState = {
      ...existing!,
      state: "running",
      consumerId: body.consumerId,
      pickedUpAt: existing!.pickedUpAt ?? nowIso(),
      lastActivityAt: nowIso(),
      alarmTargetRunId: existing!.runId,
      alarmKind: "watchdog",
    }
    // Refresh watchdog: measure from pickup-time, not enqueue-time.
    // A queue backlog could otherwise burn most of the budget
    // before the consumer even starts.
    const pickupWatchdogAt = Date.now() + config.watchdogMs
    await this.ctx.storage.setAlarm(pickupWatchdogAt)
    await this.ctx.storage.put(STATE_KEY, updated)

    emit("do-review-picked-up", {
      owner: updated.owner, repo: updated.repo, prNumber: updated.prNumber,
      runId: updated.runId, consumerId: body.consumerId,
    })
    return jsonResponse(200, { picked: true })
  }

  // ── /run-result ─────────────────────────────────────────────

  private async handleRunResult(request: Request): Promise<Response> {
    const body = (await request.json()) as RunResultRequest
    const existing = await this.ctx.storage.get<RunState>(STATE_KEY)
    if (!existing) {
      // No state at all — write a history record from the payload
      // alone so we don't lose telemetry, and return 200.
      emit("do-review-result-superseded", {
        runId: body.runId, reason: "no-state",
      })
      return jsonResponse(200, { recorded: "history" })
    }
    const config = resolveDoConfig(this.env)
    const decision = decideRunResultAction(existing, body, config.maxRetries)

    if (decision.transition === "history") {
      // Superseded consumer / superseded runId / late terminal —
      // record telemetry without touching current state.
      //
      // We only write a `run:<runId>` history record when the
      // posted runId differs from the current state's runId. For
      // same-runId late posts (e.g. consumerId-mismatch on a
      // running run, or late result after watchdog-terminal), the
      // record at `run:<existing.runId>` is either already the
      // canonical terminal record or is being managed by the live
      // run — overwriting it here would corrupt history.
      //
      // CR PR #70 catch: when `body.runId !== existing.runId`, that
      // older runId was almost certainly archived by `/enqueue` at
      // supersede time with the original headSha / attempts /
      // startedAt. Synthesizing a fresh record from `existing.*`
      // (which is the NEW run's state, not the old one's) and
      // putting it back at the same key would clobber the correct
      // archive with garbage. The cross-instance edge case where a
      // late /run-result arrives for a runId never seen by
      // /enqueue on this DO instance is rare (DOs are sticky per
      // PR), and the `do-review-result-superseded` telemetry event
      // emitted unconditionally below is the durable record of the
      // late post — so we skip the put entirely rather than
      // synthesize a low-fidelity `RunRecord` (per spec §4.2 the
      // record is meant to be a frozen snapshot, not a sentinel).
      // No history put for cross-runId late results.
      emit("do-review-result-superseded", {
        owner: existing.owner, repo: existing.repo, prNumber: existing.prNumber,
        runId: body.runId, currentRunId: existing.runId,
        sameRunId: body.runId === existing.runId,
      })
      return jsonResponse(200, { recorded: "history" })
    }

    // done | failed | failed-transient
    const updated: RunState = {
      ...existing,
      state: decision.transition,
      lastActivityAt: nowIso(),
    }
    if (body.error) updated.lastError = body.error
    if (decision.transition === "done" || decision.transition === "failed") {
      updated.finishedAt = nowIso()
      // Cancel any pending retry/watchdog alarm — the run has
      // reached a terminal state, so no further alarm should fire.
      delete (updated as { alarmKind?: string }).alarmKind
      delete (updated as { alarmTargetRunId?: string }).alarmTargetRunId
      delete (updated as { nextRetryAt?: string }).nextRetryAt
      await this.ctx.storage.deleteAlarm()
    }
    if (decision.transition === "failed-transient" && decision.nextAlarmAt !== undefined) {
      updated.alarmTargetRunId = existing.runId
      updated.alarmKind = "retry"
      updated.nextRetryAt = new Date(decision.nextAlarmAt).toISOString()
      await this.ctx.storage.setAlarm(decision.nextAlarmAt)
    }
    await this.ctx.storage.put(STATE_KEY, updated)

    if (decision.transition === "done" || decision.transition === "failed") {
      // Append to history.
      const record: RunRecord = {
        runId: existing.runId,
        headSha: existing.headSha,
        finalState: decision.transition,
        attempts: existing.attempts,
        startedAt: existing.startedAt,
        finishedAt: updated.finishedAt!,
        ...(body.error ? { lastError: body.error } : {}),
      }
      await this.ctx.storage.put(`run:${existing.runId}`, record)
      // Prune history to limit.
      const allHistory = await this.collectHistory()
      const pruned = pruneHistoryRecords(allHistory, config.historyLimit)
      if (pruned.evicted > 0) {
        // Rewrite kept records + remove evicted.
        for (const key of Object.keys(allHistory)) {
          if (!(key in pruned.kept)) {
            await this.ctx.storage.delete(key)
          }
        }
      }
      emit("do-review-completed", {
        owner: existing.owner, repo: existing.repo, prNumber: existing.prNumber,
        runId: existing.runId, finalState: decision.transition, attempts: existing.attempts,
      })
    } else {
      // failed-transient
      emit("do-review-retry-scheduled", {
        owner: existing.owner, repo: existing.repo, prNumber: existing.prNumber,
        runId: existing.runId, attempt: existing.attempts,
        nextRetryAt: updated.nextRetryAt,
      })
    }

    return jsonResponse(200, { transition: decision.transition })
  }

  // ── /status ─────────────────────────────────────────────────

  private async handleStatus(): Promise<Response> {
    const state = await this.ctx.storage.get<RunState>(STATE_KEY)
    if (!state) {
      const empty: StatusResponse = { kind: "no-state" }
      return jsonResponse(200, empty)
    }
    const history = await this.collectHistory()
    const historyRecords = Object.values(history).sort(
      (a, b) => b.finishedAt.localeCompare(a.finishedAt),
    )
    const found: StatusResponse = {
      kind: "found",
      current: {
        runId: state.runId,
        headSha: state.headSha,
        state: state.state,
        attempts: state.attempts,
        startedAt: state.startedAt,
        ...(state.pickedUpAt ? { pickedUpAt: state.pickedUpAt } : {}),
        ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
        ...(state.lastError ? { lastError: state.lastError } : {}),
      },
      history: historyRecords,
    }
    return jsonResponse(200, found)
  }

  // ── alarm() — retry + watchdog (Task 6) ─────────────────────
  //
  // DO setAlarm carries no payload; the kind + target runId are
  // persisted on RunState so alarm() can route correctly. Stale
  // alarms (state.runId !== alarmTargetRunId) become no-ops with
  // telemetry — this happens when /enqueue superseded the run before
  // the alarm fired.

  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunState>(STATE_KEY)
    if (!state) {
      emit("do-review-alarm-no-state", {})
      return
    }
    const kind = state.alarmKind
    if (!kind) {
      emit("do-review-alarm-no-kind", {
        owner: state.owner, repo: state.repo, prNumber: state.prNumber,
        runId: state.runId,
      })
      return
    }
    if (state.alarmTargetRunId && state.alarmTargetRunId !== state.runId) {
      emit("do-review-alarm-stale", {
        owner: state.owner, repo: state.repo, prNumber: state.prNumber,
        runId: state.runId, alarmTargetRunId: state.alarmTargetRunId, kind,
      })
      return
    }
    if (kind === "retry") {
      await this.handleRetryAlarm(state)
    } else if (kind === "watchdog") {
      await this.handleWatchdogAlarm(state)
    }
  }

  private async handleRetryAlarm(state: RunState): Promise<void> {
    // Guard: a retry alarm that fires after the run has already
    // reached a terminal state must NOT resurrect it. Race window:
    // /run-result success/terminal lands after watchdog scheduled
    // the retry alarm but before that alarm fired.
    if (state.state === "done" || state.state === "failed") {
      emit("do-review-retry-noop", {
        owner: state.owner, repo: state.repo, prNumber: state.prNumber,
        runId: state.runId, currentState: state.state,
      })
      return
    }
    // SINGLE-INCREMENT-POINT (spec §4.6a): retry-alarm fire is the
    // only place attempts is incremented. /run-result schedules but
    // does not increment; alarm-fire is what actually consumes a
    // retry slot.
    const config = resolveDoConfig(this.env)
    const newAttempts = state.attempts + 1
    await this.env.OPENCLAW_JOBS.send({
      type: "pr-review",
      owner: state.owner,
      repo: state.repo,
      prNumber: state.prNumber,
      headSha: state.headSha,
      installationId: state.installationId,
      runId: state.runId,
      // ARC-251 Codex BLOCKER #2: rebuild the message from RunState
      // INCLUDING the stale-head requeue depth. Without this the cap
      // resets to 0 every time the watchdog/retry alarm fires.
      ...(state.staleHeadRequeueDepth !== undefined
        ? { staleHeadRequeueDepth: state.staleHeadRequeueDepth }
        : {}),
      // SIG-220: forward the upstream-created check id on retries too
      // so the retry consumer attaches to the same check the original
      // attempt set up (`startInProgressCheckRun` cancels stale checks
      // by head_sha so a duplicate-create on retry would be idempotent,
      // but attaching is one fewer GitHub call).
      ...(state.checkRunId !== undefined
        ? { checkRunId: state.checkRunId }
        : {}),
    })
    const watchdogAt = Date.now() + config.watchdogMs
    const updated: RunState = {
      ...state,
      state: "queued",
      attempts: newAttempts,
      lastActivityAt: nowIso(),
      alarmTargetRunId: state.runId,
      alarmKind: "watchdog",
    }
    delete (updated as { nextRetryAt?: string }).nextRetryAt
    delete (updated as { consumerId?: string }).consumerId
    // Clear stale pickedUpAt so the next attempt's /pickup records
    // its own timestamp rather than reusing the prior attempt's.
    delete (updated as { pickedUpAt?: string }).pickedUpAt
    await this.ctx.storage.put(STATE_KEY, updated)
    await this.ctx.storage.setAlarm(watchdogAt)
    emit("do-review-retry-fired", {
      owner: state.owner, repo: state.repo, prNumber: state.prNumber,
      runId: state.runId, attempt: newAttempts,
    })
  }

  private async handleWatchdogAlarm(state: RunState): Promise<void> {
    if (state.state === "done" || state.state === "failed") {
      emit("do-review-watchdog-noop", {
        owner: state.owner, repo: state.repo, prNumber: state.prNumber,
        runId: state.runId, currentState: state.state,
      })
      return
    }
    const config = resolveDoConfig(this.env)
    const lastError = {
      stage: "watchdog",
      message: `consumer did not report run-result within ${config.watchdogMs}ms`,
    }
    if (state.attempts >= config.maxRetries) {
      const finishedAt = nowIso()
      const updated: RunState = {
        ...state,
        state: "failed",
        lastActivityAt: nowIso(),
        finishedAt,
        lastError,
      }
      await this.ctx.storage.put(STATE_KEY, updated)
      const record: RunRecord = {
        runId: state.runId,
        headSha: state.headSha,
        finalState: "failed",
        attempts: state.attempts,
        startedAt: state.startedAt,
        finishedAt,
        lastError,
      }
      await this.ctx.storage.put(`run:${state.runId}`, record)
      // Prune history to limit (mirrors /run-result terminal path).
      const allHistory = await this.collectHistory()
      const pruned = pruneHistoryRecords(allHistory, config.historyLimit)
      if (pruned.evicted > 0) {
        for (const key of Object.keys(allHistory)) {
          if (!(key in pruned.kept)) {
            await this.ctx.storage.delete(key)
          }
        }
      }
      // SIG-220: terminal watchdog failure ⇒ the consumer never
      // reported result, so the upstream-created check is still
      // `in_progress`. Close it as `failure` (wire-mapped to
      // `neutral` per the SIG-216 advisory-bot convention in
      // `completeCheckRun`). Best-effort; null handle on token
      // failure is a no-op. If `checkRunId` is undefined (creation
      // failed at enqueue time), nothing to close.
      if (state.checkRunId !== undefined) {
        const handle = await attachExistingCheckRun({
          env: this.env,
          owner: state.owner,
          repo: state.repo,
          installationId: state.installationId,
          checkRunId: state.checkRunId,
        })
        await completeCheckRun({ handle, conclusion: "failure" })
      }
      emit("do-review-watchdog-terminal", {
        owner: state.owner, repo: state.repo, prNumber: state.prNumber,
        runId: state.runId, attempts: state.attempts,
        ...(state.checkRunId !== undefined ? { checkRunId: state.checkRunId } : {}),
      })
      return
    }
    const nextAlarmAt = Date.now() + nextBackoffMs(state.attempts)
    const updated: RunState = {
      ...state,
      state: "failed-transient",
      lastActivityAt: nowIso(),
      lastError,
      alarmTargetRunId: state.runId,
      alarmKind: "retry",
      nextRetryAt: new Date(nextAlarmAt).toISOString(),
    }
    await this.ctx.storage.put(STATE_KEY, updated)
    await this.ctx.storage.setAlarm(nextAlarmAt)
    emit("do-review-watchdog-transient", {
      owner: state.owner, repo: state.repo, prNumber: state.prNumber,
      runId: state.runId, attempts: state.attempts,
      nextRetryAt: updated.nextRetryAt,
    })
  }

  // ── helpers ─────────────────────────────────────────────────

  private async collectHistory(): Promise<Record<string, RunRecord>> {
    // Workers DO doesn't expose a `list()` method on storage in all
    // runtimes. Iterate by enumerating known prefixes via a stored
    // index — but we don't maintain one. As a v1 simplification,
    // tests provide a shim that exposes `store: Map<string, unknown>`
    // for direct enumeration. Production runtime: each `run:<runId>`
    // record is small, and we keep at most `historyLimit` of them
    // (default 10), so a transactional scan during prune is
    // affordable. v1: rely on the test stub's direct Map access; in
    // production the prune step uses storage.list({ prefix: "run:" }).
    const out: Record<string, RunRecord> = {}
    const storage = this.ctx.storage as {
      list?: (opts: { prefix: string }) => Promise<Map<string, unknown>>
    }
    if (typeof storage.list === "function") {
      const items = await storage.list({ prefix: "run:" })
      for (const [key, value] of items.entries()) {
        out[key] = value as RunRecord
      }
      return out
    }
    // Test-only fallback: read the Map directly via the stub's
    // exposed `store` property.
    const stub = this.ctx as unknown as { store?: Map<string, unknown> }
    if (stub.store instanceof Map) {
      for (const [key, value] of stub.store.entries()) {
        if (key.startsWith("run:")) {
          out[key] = value as RunRecord
        }
      }
    }
    return out
  }
}

// ─── Pure decision helpers ────────────────────────────────────

/** Spec §4.5 — same SHA = same logical run. */
export function isSupersededByNewSha(state: RunState, incomingHeadSha: string): boolean {
  return state.headSha !== incomingHeadSha
}

/**
 * Spec §4.5 enqueue decision tree (pure).
 * - null state → first run for this PR → create
 * - same SHA + active state (queued | running | failed-transient) → dedupe-active
 * - same SHA + terminal (done | failed | idle) → dedupe-terminal
 * - different SHA → supersede
 */
export function decideEnqueueAction(
  state: RunState | null,
  incoming: EnqueueRequest,
): { action: EnqueueAction; reason: string } {
  if (!state) {
    return { action: "create", reason: "no-existing-state" }
  }
  if (isSupersededByNewSha(state, incoming.headSha)) {
    return { action: "supersede", reason: "different-headSha" }
  }
  if (state.state === "queued" || state.state === "running" || state.state === "failed-transient") {
    return { action: "dedupe-active", reason: `same-sha-active-${state.state}` }
  }
  return { action: "dedupe-terminal", reason: `same-sha-terminal-${state.state}` }
}

export type PickupActionKind =
  | "claim"
  | "stale-runId-410"
  | "terminal-410"
  | "duplicate-409"

/**
 * Spec §4.3 + §4.5 pickup decision tree (pure).
 * - null state OR runId mismatch → 410 stale-runId
 * - state running + same consumerId → 200 claim (idempotent re-pickup)
 * - state running + different consumerId → 409 duplicate-consumer
 * - state done | failed → 410 terminal
 * - state queued | failed-transient + matching runId → 200 claim
 */
export function decidePickupAction(
  state: RunState | null,
  runId: string,
  consumerId: string,
): { action: PickupActionKind } {
  if (!state) return { action: "stale-runId-410" }
  if (state.runId !== runId) return { action: "stale-runId-410" }
  if (state.state === "done" || state.state === "failed") {
    return { action: "terminal-410" }
  }
  if (state.state === "running") {
    if (state.consumerId === consumerId) return { action: "claim" }
    return { action: "duplicate-409" }
  }
  return { action: "claim" }
}

/**
 * Spec §4.6 backoff schedule. attempts is 1-indexed.
 */
const BACKOFF_TABLE = [30000, 90000, 270000] as const

export function nextBackoffMs(attempts: number): number {
  if (attempts <= 1) return BACKOFF_TABLE[0]
  if (attempts === 2) return BACKOFF_TABLE[1]
  return BACKOFF_TABLE[2]
}

/**
 * Spec §4.6 /run-result decision tree (pure).
 */
export function decideRunResultAction(
  state: RunState,
  payload: RunResultRequest,
  maxRetries: number,
  nowMs: number = Date.now(),
): {
  transition: "done" | "failed" | "failed-transient" | "history"
  nextAlarmAt?: number
} {
  if (state.runId !== payload.runId) {
    return { transition: "history" }
  }
  if (state.consumerId && state.consumerId !== payload.consumerId) {
    return { transition: "history" }
  }
  // Only an actively-running attempt can submit /run-result. If the
  // current state is anything else (idle | queued | failed-transient
  // | done | failed), the caller is a late post from an abandoned
  // attempt — its watchdog already classified it as transient and
  // either scheduled a retry (queued | failed-transient) or
  // finalized the run (done | failed). Accepting the late result
  // here would either cancel a scheduled retry, reset backoff, or
  // overwrite a terminal verdict.
  if (state.state !== "running") {
    return { transition: "history" }
  }
  if (payload.status === "success") {
    return { transition: "done" }
  }
  if (payload.status === "terminal") {
    return { transition: "failed" }
  }
  if (state.attempts >= maxRetries) {
    return { transition: "failed" }
  }
  return {
    transition: "failed-transient",
    nextAlarmAt: nowMs + nextBackoffMs(state.attempts),
  }
}

/**
 * Spec §4.10 — FIFO history eviction. Pure.
 */
export function pruneHistoryRecords(
  records: Record<string, RunRecord>,
  limit: number,
): { kept: Record<string, RunRecord>; evicted: number } {
  const all = Object.entries(records)
  if (all.length <= limit) {
    return { kept: { ...records }, evicted: 0 }
  }
  all.sort((a, b) => a[1].finishedAt.localeCompare(b[1].finishedAt))
  const keep = all.slice(all.length - Math.max(0, limit))
  const kept: Record<string, RunRecord> = {}
  for (const [k, v] of keep) kept[k] = v
  return { kept, evicted: all.length - keep.length }
}
