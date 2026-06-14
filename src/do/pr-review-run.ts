// ARC-190: PrReviewRunDO class + route dispatch. The pure decision helpers + the
// IO-free history helpers live in `./pr-review-run-internals` (the class delegates).
//
// Spec: docs/superpowers/specs/2026-05-07-arc-190-durable-objects-webhook-ingest-design.md
// Plan: docs/superpowers/plans/2026-05-07-arc-190-durable-objects-webhook-ingest.md

import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import type {
  EnqueueRequest,
  EnqueueResponse,
  HeartbeatRequest,
  ResolvedDoConfig,
  RunRecord,
  RunResultRequest,
  RunState,
  StatusResponse,
} from "./types"
import { resolveDoConfig } from "./config"
import {
  attachExistingCheckRun,
  closeOrphanedInProgressChecksByHeadSha,
  completeCheckRun,
  startInProgressCheckRun,
} from "@/src/lib/pr-review-check-run"
// SIG-376 (SIG-318 Tier-1 5/8): the DO's pure internals — IO-free
// module-level helpers + the spec §4.5/§4.6/§4.10 decision functions — were
// lifted into the `./pr-review-run-internals` leaf so this file stays under
// the 1,000-line budget. The six previously-public decision functions +
// `PickupActionKind` are re-exported below so every importer of
// `@/do/pr-review-run` — including the co-located helpers test — is unchanged.
// The leaf imports only `./types` (no cycle: it never imports this DO).
import {
  buildRunRecord,
  collectHistoryRecords,
  decideEnqueueAction,
  decidePickupAction,
  decideRunResultAction,
  emit,
  isSupersededByNewSha,
  jsonResponse,
  nextBackoffMs,
  normalizeRepoId,
  nowIso,
  pruneHistoryRecords,
  pruneHistoryStorage,
} from "./pr-review-run-internals"
import { handleStatusProgress } from "./pr-review-status-route"
export {
  decideEnqueueAction,
  decidePickupAction,
  decideRunResultAction,
  isSupersededByNewSha,
  nextBackoffMs,
  pruneHistoryRecords,
}
export type { PickupActionKind } from "./pr-review-run-internals"

// ─── Class ────────────────────────────────────────────────────

const STATE_KEY = "state"

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
    if (request.method === "POST" && url.pathname === "/heartbeat") {
      return this.handleHeartbeat(request)
    }
    if (request.method === "POST" && url.pathname === "/status-progress") {
      return handleStatusProgress(this.ctx.storage, request)
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      return this.handleCancel()
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
        owner: body.owner,
        repo: body.repo,
        prNumber: body.prNumber,
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
        const record = buildRunRecord({
          state: existing,
          finalState: existing.state === "done" ? "done" : "failed",
          finishedAt: existing.finishedAt ?? nowIso(),
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        })
        await this.ctx.storage.put(`run:${existing.runId}`, record)
      }
      emit("do-review-superseded", {
        owner: body.owner,
        repo: body.repo,
        prNumber: body.prNumber,
        oldRunId: existing.runId,
        oldHeadSha: existing.headSha,
        newHeadSha: body.headSha,
      })
    }

    // SIG-220: create the customer-visible "Sigilix · In progress" check
    // synchronously, BEFORE persisting RunState + enqueueing, so it appears in the
    // GitHub UI within the webhook-ack window (~1–2s) rather than 5–30s after push.
    // Reached only on the create | supersede branches (dedupe/pause/ignore don't
    // produce orphan checks). Sigilix bot P2 PERF catch on PR #179: wrap the create
    // in a `Promise.race` with a 3s timeout — the webhook awaits `/enqueue`, so an
    // unbounded GitHub hang could approach the 10s redelivery threshold. Best-effort:
    // a null result (creds missing / 5xx / timeout) leaves `checkRunId` undefined and
    // the dispatcher falls back to its own `startInProgressCheckRun`.
    const CHECK_RUN_CREATE_TIMEOUT_MS = 3_000
    // CodeRabbit catch on PR #179 fixup: capture the timer handle so we
    // can clear it after `startInProgressCheckRun` wins the race.
    // Otherwise the warning fires (and the timer leaks) on every
    // successful create — spurious telemetry + needless resource use.
    let createTimeoutId: ReturnType<typeof setTimeout> | undefined
    const checkRun = await Promise.race([
      startInProgressCheckRun({
        env: this.env,
        owner: body.owner,
        repo: body.repo,
        headSha: body.headSha,
        installationId: body.installationId,
      }),
      new Promise<null>((resolve) => {
        createTimeoutId = setTimeout(() => {
          console.warn(
            JSON.stringify({
              event: "pr-review-check-run-create-timeout",
              owner: body.owner,
              repo: body.repo,
              prNumber: body.prNumber,
              head_sha: body.headSha.slice(0, 7),
              timeout_ms: CHECK_RUN_CREATE_TIMEOUT_MS,
            }),
          )
          resolve(null)
        }, CHECK_RUN_CREATE_TIMEOUT_MS)
      }),
    ])
    if (createTimeoutId !== undefined) clearTimeout(createTimeoutId)

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
      ...(body.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: body.staleHeadRequeueDepth } : {}),
      // SIG-220: persist the upstream-created check id so the
      // consumer + watchdog can close it. Undefined if creation
      // failed (best-effort dispatcher fallback applies).
      ...(checkRun !== null ? { checkRunId: checkRun.id } : {}),
      // SIG-247 Phase 1: persist the immutable repo.id so retry-alarm
      // queue messages preserve the dual-write keyspace target. Without
      // this, retries silently lose the repo-id and fall back to
      // legacy-only review-memory lookups. CR-1: normalize at the DO
      // trust boundary — caller-provided values are not pre-validated.
      ...(normalizeRepoId(body.repoId) !== undefined ? { repoId: normalizeRepoId(body.repoId)! } : {}),
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
    // SIG-374: stamp send time + attempt on every queue send so the
    // consumer can compute queue wait and attribute attempts.
    const enqueuedAtMs = Date.now()
    await this.env.OPENCLAW_JOBS.send({
      type: "pr-review",
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
      headSha: body.headSha,
      installationId: body.installationId,
      runId,
      enqueuedAtMs,
      attempt: newState.attempts,
      // ARC-251: forward requeue depth so the consumer side keeps
      // the cap accurate across the initial enqueue path too.
      ...(body.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: body.staleHeadRequeueDepth } : {}),
      // SIG-220: forward the upstream-created check id so the
      // dispatcher attaches instead of creating a duplicate.
      ...(checkRun !== null ? { checkRunId: checkRun.id } : {}),
      // SIG-247 Phase 1: forward immutable repo.id to the consumer so
      // review-memory dual-write/read-union semantics apply on this run.
      // CR-1: normalize at the DO trust boundary.
      ...(normalizeRepoId(body.repoId) !== undefined ? { repoId: normalizeRepoId(body.repoId)! } : {}),
    })

    emit("do-review-enqueued", {
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
      runId,
      headSha: body.headSha,
      action: decision.action,
      // SIG-374: queue-wait correlation (joins pr-review-webhook-arrived
      // via deliveryId; queueWaitMs lands on do-review-run-timing).
      // staleHeadRequeueDepth reads `body` — the SAME source the queue
      // message forwards — so the logged value can never diverge from
      // the in-flight message.
      enqueuedAtMs,
      deliveryId: body.deliveryId,
      ...(body.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: body.staleHeadRequeueDepth } : {}),
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
        owner: existing?.owner,
        repo: existing?.repo,
        prNumber: existing?.prNumber,
        runId: body.runId,
        consumerId: body.consumerId,
        reason: decision.action,
      })
      return jsonResponse(410, { reason: decision.action })
    }
    if (decision.action === "duplicate-409") {
      emit("do-review-pickup-skipped", {
        owner: existing?.owner,
        repo: existing?.repo,
        prNumber: existing?.prNumber,
        runId: body.runId,
        consumerId: body.consumerId,
        reason: decision.action,
      })
      return jsonResponse(409, { reason: decision.action })
    }
    if (existing!.state === "running" && existing!.consumerId === body.consumerId) {
      return jsonResponse(200, { picked: true })
    }

    // claim
    const config = resolveDoConfig(this.env)
    const nowMs = Date.now()
    // SIG-329: a claimed run switches from the queued-side `watchdog`
    // backstop to the running-side `liveness` model. The liveness alarm
    // re-arms on every /heartbeat; `watchdogDeadlineAt` carries the
    // absolute max-review-duration cap so the single DO alarm slot can
    // enforce both "consumer went silent" and "review ran too long".
    // `lastHeartbeatAt` is seeded to pickup-time so the first liveness
    // window measures from claim (the consumer's first real heartbeat
    // lands within `livenessMs`). It is also reset here so a prior
    // attempt's stale heartbeat can't make this fresh attempt look dead.
    const updated: RunState = {
      ...existing!,
      state: "running",
      consumerId: body.consumerId,
      pickedUpAt: existing!.pickedUpAt ?? nowIso(),
      lastActivityAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      watchdogDeadlineAt: new Date(nowMs + config.watchdogMs).toISOString(),
      alarmTargetRunId: existing!.runId,
      alarmKind: "liveness",
    }
    // Arm liveness from pickup-time (not enqueue-time): a queue backlog
    // could otherwise burn the budget before the consumer even starts.
    const livenessAt = nowMs + config.livenessMs
    await this.ctx.storage.setAlarm(livenessAt)
    await this.ctx.storage.put(STATE_KEY, updated)

    emit("do-review-picked-up", {
      owner: updated.owner,
      repo: updated.repo,
      prNumber: updated.prNumber,
      runId: updated.runId,
      consumerId: body.consumerId,
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
        runId: body.runId,
        reason: "no-state",
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
        owner: existing.owner,
        repo: existing.repo,
        prNumber: existing.prNumber,
        runId: body.runId,
        currentRunId: existing.runId,
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
      const record = buildRunRecord({
        state: existing,
        finalState: decision.transition,
        finishedAt: updated.finishedAt!,
        ...(body.error ? { lastError: body.error } : {}),
      })
      await this.ctx.storage.put(`run:${existing.runId}`, record)
      // Prune history to limit (SIG-366: pruneHistoryRecords + evict-delete loop
      // extracted to `pruneHistoryStorage` in ./pr-review-run-internals).
      await pruneHistoryStorage(this.ctx.storage, await this.collectHistory(), config.historyLimit)
      emit("do-review-completed", {
        owner: existing.owner,
        repo: existing.repo,
        prNumber: existing.prNumber,
        runId: existing.runId,
        finalState: decision.transition,
        attempts: existing.attempts,
      })
    } else {
      // failed-transient
      emit("do-review-retry-scheduled", {
        owner: existing.owner,
        repo: existing.repo,
        prNumber: existing.prNumber,
        runId: existing.runId,
        attempt: existing.attempts,
        nextRetryAt: updated.nextRetryAt,
      })
    }

    return jsonResponse(200, { transition: decision.transition })
  }

  // ── /heartbeat (SIG-329) ────────────────────────────────────
  //
  // The running consumer pings this every ~30s. A valid ping re-arms
  // the liveness alarm to `now + livenessMs` (capped at the absolute
  // watchdog deadline) so a dead consumer is detected within one
  // heartbeat gap instead of waiting out the full watchdog. A ping that
  // doesn't match the current running attempt (superseded / cancelled /
  // already terminal / different consumer) returns 410 so the consumer
  // stops heartbeating.

  private async handleHeartbeat(request: Request): Promise<Response> {
    const body = (await request.json()) as HeartbeatRequest
    const existing = await this.ctx.storage.get<RunState>(STATE_KEY)
    if (
      !existing ||
      existing.runId !== body.runId ||
      existing.state !== "running" ||
      existing.consumerId !== body.consumerId
    ) {
      emit("do-review-heartbeat-stale", {
        owner: existing?.owner,
        repo: existing?.repo,
        prNumber: existing?.prNumber,
        runId: body.runId,
        consumerId: body.consumerId,
        currentRunId: existing?.runId,
        currentState: existing?.state,
      })
      return jsonResponse(410, { reason: "stale-or-terminal" })
    }
    const config = resolveDoConfig(this.env)
    const nowMs = Date.now()
    // Cap the re-arm at the absolute backstop so a perpetually-
    // heartbeating-but-stuck consumer still terminates at the deadline.
    // Guard Date.parse against a corrupted/unparseable persisted ISO so a
    // NaN can never reach setAlarm via Math.min(x, NaN) === NaN.
    const parsedDeadline = existing.watchdogDeadlineAt !== undefined ? Date.parse(existing.watchdogDeadlineAt) : NaN
    const deadlineMs = Number.isFinite(parsedDeadline) ? parsedDeadline : nowMs + config.watchdogMs
    // If the deadline already elapsed, the cap yields an instant (≤ now)
    // alarm — that's intended: it fires immediately and the liveness
    // handler takes the absolute-backstop branch.
    const nextAlarmAt = Math.min(nowMs + config.livenessMs, deadlineMs)
    const updated: RunState = {
      ...existing,
      lastHeartbeatAt: nowIso(),
      lastActivityAt: nowIso(),
      alarmTargetRunId: existing.runId,
      alarmKind: "liveness",
    }
    await this.ctx.storage.setAlarm(nextAlarmAt)
    await this.ctx.storage.put(STATE_KEY, updated)
    emit("do-review-heartbeat", {
      owner: existing.owner,
      repo: existing.repo,
      prNumber: existing.prNumber,
      runId: existing.runId,
      consumerId: body.consumerId,
    })
    return jsonResponse(200, { ok: true })
  }

  // ── /cancel (SIG-329) ───────────────────────────────────────
  //
  // Operator abort for a stuck in-flight review (driven by
  // `/sigilix cancel`). Terminates an active run (queued | running |
  // failed-transient) immediately: cancels the pending alarm, finalizes
  // state as `failed` with a `cancelled` stage marker, archives a
  // history record, and closes the upstream check. A consumer still
  // running the evicted/old attempt learns it was cancelled on its next
  // /heartbeat (410) and stops; its late /run-result routes to history.
  // Cancel of an absent or already-terminal run is a clean 200 no-op.

  private async handleCancel(): Promise<Response> {
    const existing = await this.ctx.storage.get<RunState>(STATE_KEY)
    if (!existing) {
      emit("do-review-cancel-noop", { reason: "no-state" })
      return jsonResponse(200, { cancelled: false, reason: "no-state" })
    }
    if (existing.state === "done" || existing.state === "failed" || existing.state === "idle") {
      emit("do-review-cancel-noop", {
        owner: existing.owner,
        repo: existing.repo,
        prNumber: existing.prNumber,
        runId: existing.runId,
        currentState: existing.state,
        reason: "already-terminal",
      })
      return jsonResponse(200, { cancelled: false, reason: "already-terminal" })
    }

    const config = resolveDoConfig(this.env)
    const finishedAt = nowIso()
    const lastError = {
      stage: "cancelled",
      message: "operator cancelled via /sigilix cancel",
    }
    const updated: RunState = {
      ...existing,
      state: "failed",
      lastActivityAt: nowIso(),
      finishedAt,
      lastError,
    }
    // No further alarm should fire for a cancelled run.
    delete (updated as { alarmKind?: string }).alarmKind
    delete (updated as { alarmTargetRunId?: string }).alarmTargetRunId
    delete (updated as { nextRetryAt?: string }).nextRetryAt
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.put(STATE_KEY, updated)

    // Archive + prune history (mirrors the watchdog-terminal path).
    const record = buildRunRecord({ state: existing, finalState: "failed", finishedAt, lastError })
    await this.ctx.storage.put(`run:${existing.runId}`, record)
    await pruneHistoryStorage(this.ctx.storage, await this.collectHistory(), config.historyLimit)

    // Close the upstream check as `skipped` (wire `neutral`): the bot
    // did not complete a review. `cancelled` is intentionally not a
    // SigilixCheckConclusion. Best-effort; null handle is a no-op.
    if (existing.checkRunId !== undefined) {
      const handle = await attachExistingCheckRun({
        env: this.env,
        owner: existing.owner,
        repo: existing.repo,
        installationId: existing.installationId,
        checkRunId: existing.checkRunId,
      })
      await completeCheckRun({ handle, conclusion: "skipped" })
    } else {
      // SIG-stuck-check: no `checkRunId` means `handleEnqueue`'s
      // synchronous check-create lost its 3s race (GitHub 5xx / timeout
      // under contention) and the CONSUMER created the check via
      // `startInProgressCheckRun` — that id never reached the DO. Without
      // this fallback the cancel would silently skip the close and the
      // check stays `in_progress` forever (observed on PR #402). Close
      // any orphaned in-progress Sigilix check by head_sha instead.
      // Best-effort: the helper swallows all errors, but guard anyway so
      // a GitHub hiccup can never break the cancel state machine.
      try {
        await closeOrphanedInProgressChecksByHeadSha({
          env: this.env,
          owner: existing.owner,
          repo: existing.repo,
          installationId: existing.installationId,
          headSha: existing.headSha,
          title: "Cancelled",
          summary: "This review was cancelled via /sigilix cancel.",
        })
      } catch (err) {
        emit("do-review-cancel-orphan-close-failed", {
          owner: existing.owner,
          repo: existing.repo,
          prNumber: existing.prNumber,
          runId: existing.runId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    emit("do-review-cancelled", {
      owner: existing.owner,
      repo: existing.repo,
      prNumber: existing.prNumber,
      runId: existing.runId,
      attempts: existing.attempts,
      priorState: existing.state,
      ...(existing.checkRunId !== undefined ? { checkRunId: existing.checkRunId } : {}),
    })
    return jsonResponse(200, { cancelled: true, runId: existing.runId })
  }

  // ── /status ─────────────────────────────────────────────────

  private async handleStatus(): Promise<Response> {
    const state = await this.ctx.storage.get<RunState>(STATE_KEY)
    if (!state) {
      const empty: StatusResponse = { kind: "no-state" }
      return jsonResponse(200, empty)
    }
    const history = await this.collectHistory()
    const historyRecords = Object.values(history).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
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
        owner: state.owner,
        repo: state.repo,
        prNumber: state.prNumber,
        runId: state.runId,
      })
      return
    }
    if (state.alarmTargetRunId && state.alarmTargetRunId !== state.runId) {
      emit("do-review-alarm-stale", {
        owner: state.owner,
        repo: state.repo,
        prNumber: state.prNumber,
        runId: state.runId,
        alarmTargetRunId: state.alarmTargetRunId,
        kind,
      })
      return
    }
    if (kind === "retry") {
      await this.handleRetryAlarm(state)
    } else if (kind === "watchdog") {
      await this.handleWatchdogAlarm(state)
    } else if (kind === "liveness") {
      await this.handleLivenessAlarm(state)
    }
  }

  private async handleRetryAlarm(state: RunState): Promise<void> {
    // Guard: a retry alarm that fires after the run has already
    // reached a terminal state must NOT resurrect it. Race window:
    // /run-result success/terminal lands after watchdog scheduled
    // the retry alarm but before that alarm fired.
    if (state.state === "done" || state.state === "failed") {
      emit("do-review-retry-noop", {
        owner: state.owner,
        repo: state.repo,
        prNumber: state.prNumber,
        runId: state.runId,
        currentState: state.state,
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
      // SIG-374: retry-alarm sends get queue timing + attempt
      // attribution too — the >900s e2e tail is exactly these.
      enqueuedAtMs: Date.now(),
      attempt: newAttempts,
      // ARC-251 Codex BLOCKER #2: rebuild the message from RunState
      // INCLUDING the stale-head requeue depth. Without this the cap
      // resets to 0 every time the watchdog/retry alarm fires.
      ...(state.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: state.staleHeadRequeueDepth } : {}),
      // SIG-220: forward the upstream-created check id on retries too
      // so the retry consumer attaches to the same check the original
      // attempt set up (`startInProgressCheckRun` cancels stale checks
      // by head_sha so a duplicate-create on retry would be idempotent,
      // but attaching is one fewer GitHub call).
      ...(state.checkRunId !== undefined ? { checkRunId: state.checkRunId } : {}),
      // SIG-247 Phase 1: rebuild from RunState INCLUDING the immutable
      // repo.id so retry-alarm queue messages preserve dual-write
      // semantics. Mirrors the staleHeadRequeueDepth pattern above.
      // CR-1: re-normalize on read in case a pre-Phase-1-fix RunState
      // persisted an invalid value.
      ...(normalizeRepoId(state.repoId) !== undefined ? { repoId: normalizeRepoId(state.repoId)! } : {}),
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
    // SIG-329: clear per-attempt liveness fields. The requeued run is
    // `queued` again (covered by the watchdog backstop armed below);
    // /pickup re-seeds both when the next consumer claims it. Leaving a
    // stale lastHeartbeatAt would make the fresh attempt look dead on
    // its first liveness alarm.
    delete (updated as { lastHeartbeatAt?: string }).lastHeartbeatAt
    delete (updated as { watchdogDeadlineAt?: string }).watchdogDeadlineAt
    await this.ctx.storage.put(STATE_KEY, updated)
    await this.ctx.storage.setAlarm(watchdogAt)
    emit("do-review-retry-fired", {
      owner: state.owner,
      repo: state.repo,
      prNumber: state.prNumber,
      runId: state.runId,
      attempt: newAttempts,
    })
  }

  private async handleWatchdogAlarm(state: RunState): Promise<void> {
    if (state.state === "done" || state.state === "failed") {
      emit("do-review-watchdog-noop", {
        owner: state.owner,
        repo: state.repo,
        prNumber: state.prNumber,
        runId: state.runId,
        currentState: state.state,
      })
      return
    }
    const config = resolveDoConfig(this.env)
    const lastError = {
      stage: "watchdog",
      message: `consumer did not report run-result within ${config.watchdogMs}ms`,
    }
    await this.failOrRetry(state, lastError, config, "watchdog")
  }

  // ── liveness alarm (SIG-329) ────────────────────────────────
  //
  // Fires for a `running` attempt. One DO alarm slot enforces two
  // independent deadlines, checked in priority order:
  //   1. Absolute backstop (`watchdogDeadlineAt`): the review ran longer
  //      than the watchdog budget even though heartbeats kept arriving →
  //      fail/retry as an exhausted watchdog.
  //   2. Heartbeat gap (`now - lastHeartbeatAt >= livenessMs`): the
  //      consumer went silent (isolate evicted by a deploy, crash, etc.)
  //      → declare the attempt dead and fail/retry IMMEDIATELY. This is
  //      the SIG-329 win: detection in one heartbeat gap (~90s) instead
  //      of the full watchdog (~10–20 min).
  //   3. Otherwise the alarm merely raced a recent heartbeat → re-arm to
  //      `lastHeartbeatAt + livenessMs` (capped at the backstop) and wait.

  private async handleLivenessAlarm(state: RunState): Promise<void> {
    if (state.state === "done" || state.state === "failed") {
      emit("do-review-liveness-noop", {
        owner: state.owner,
        repo: state.repo,
        prNumber: state.prNumber,
        runId: state.runId,
        currentState: state.state,
      })
      return
    }
    const config = resolveDoConfig(this.env)
    const nowMs = Date.now()
    const deadlineMs = state.watchdogDeadlineAt !== undefined ? Date.parse(state.watchdogDeadlineAt) : undefined

    // 1. Absolute backstop.
    if (deadlineMs !== undefined && nowMs >= deadlineMs) {
      const lastError = {
        stage: "watchdog",
        message: `review exceeded absolute watchdog deadline (${config.watchdogMs}ms)`,
      }
      await this.failOrRetry(state, lastError, config, "watchdog")
      return
    }

    // 2. Heartbeat gap → dead consumer. Fall back to pickedUpAt if no
    // heartbeat was ever recorded (defensive; /pickup seeds
    // lastHeartbeatAt, so this only bites a pre-SIG-329 in-flight run).
    // A corrupted/unparseable timestamp collapses to `undefined` → treated
    // as dead (safer than letting NaN reach the re-arm setAlarm below).
    const baselineIso = state.lastHeartbeatAt ?? state.pickedUpAt
    const baselineParsed = baselineIso !== undefined ? Date.parse(baselineIso) : NaN
    const baselineMs = Number.isFinite(baselineParsed) ? baselineParsed : undefined
    if (baselineMs === undefined || nowMs - baselineMs >= config.livenessMs) {
      emit("do-review-liveness-dead", {
        owner: state.owner,
        repo: state.repo,
        prNumber: state.prNumber,
        runId: state.runId,
        attempts: state.attempts,
        gapMs: baselineMs !== undefined ? nowMs - baselineMs : undefined,
        livenessMs: config.livenessMs,
      })
      const lastError = {
        stage: "liveness",
        message: `no consumer heartbeat within ${config.livenessMs}ms`,
      }
      await this.failOrRetry(state, lastError, config, "liveness")
      return
    }

    // 3. Heartbeat fresh, alarm raced → re-arm (capped at the backstop).
    let nextAlarmAt = baselineMs + config.livenessMs
    if (deadlineMs !== undefined && deadlineMs < nextAlarmAt) nextAlarmAt = deadlineMs
    await this.ctx.storage.setAlarm(nextAlarmAt)
    emit("do-review-liveness-rearm", {
      owner: state.owner,
      repo: state.repo,
      prNumber: state.prNumber,
      runId: state.runId,
      nextAlarmAt: new Date(nextAlarmAt).toISOString(),
    })
  }

  /**
   * SIG-329: shared terminal-vs-retry decision for a dead/stuck running
   * attempt, extracted from the original watchdog handler so the
   * watchdog backstop and the liveness gap-detector apply identical
   * semantics (single-increment-point preserved: attempts is bumped
   * only at retry-alarm fire, never here). `trigger` distinguishes the
   * caller in telemetry without forking the event names dashboards
   * already query.
   */
  private async failOrRetry(
    state: RunState,
    lastError: { stage: string; message: string },
    config: ResolvedDoConfig,
    trigger: "watchdog" | "liveness",
  ): Promise<void> {
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
      const record = buildRunRecord({ state, finalState: "failed", finishedAt, lastError })
      await this.ctx.storage.put(`run:${state.runId}`, record)
      // Prune history to limit (mirrors /run-result terminal path; SIG-366: extracted
      // to `pruneHistoryStorage` in ./pr-review-run-internals).
      await pruneHistoryStorage(this.ctx.storage, await this.collectHistory(), config.historyLimit)
      // SIG-220: terminal failure ⇒ the consumer never reported result,
      // so the upstream-created check is still `in_progress`. Close it as
      // `failure` (wire-mapped to `neutral` per the SIG-216 advisory-bot
      // convention in `completeCheckRun`). Best-effort; null handle on
      // token failure is a no-op.
      if (state.checkRunId !== undefined) {
        const handle = await attachExistingCheckRun({
          env: this.env,
          owner: state.owner,
          repo: state.repo,
          installationId: state.installationId,
          checkRunId: state.checkRunId,
        })
        await completeCheckRun({ handle, conclusion: "failure" })
      } else {
        // SIG-stuck-check: `checkRunId` is undefined when `handleEnqueue`'s
        // synchronous check-create lost its 3s race (GitHub 5xx / timeout
        // under contention) and the CONSUMER created the check via
        // `startInProgressCheckRun` — that id never reached the DO. Without
        // this fallback the watchdog terminal close is silently skipped and
        // the check stays `in_progress` forever. Close any orphaned
        // in-progress Sigilix check by head_sha instead. Best-effort: the
        // helper swallows all errors, but guard anyway so a GitHub hiccup
        // can never break the alarm state machine.
        try {
          await closeOrphanedInProgressChecksByHeadSha({
            env: this.env,
            owner: state.owner,
            repo: state.repo,
            installationId: state.installationId,
            headSha: state.headSha,
            title: "Timed out",
            summary: "Sigilix did not finish reviewing this commit in time.",
            conclusion: "timed_out",
          })
        } catch (err) {
          emit("do-review-watchdog-orphan-close-failed", {
            owner: state.owner,
            repo: state.repo,
            prNumber: state.prNumber,
            runId: state.runId,
            trigger,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      emit("do-review-watchdog-terminal", {
        owner: state.owner,
        repo: state.repo,
        prNumber: state.prNumber,
        runId: state.runId,
        attempts: state.attempts,
        trigger,
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
      owner: state.owner,
      repo: state.repo,
      prNumber: state.prNumber,
      runId: state.runId,
      attempts: state.attempts,
      trigger,
      nextRetryAt: updated.nextRetryAt,
    })
  }

  // ── helpers ─────────────────────────────────────────────────

  // SIG-366: the body moved (verbatim) to `collectHistoryRecords` in
  // `./pr-review-run-internals` (the only change: `this.ctx` becomes a param);
  // the method delegates so its signature + every call site is unchanged.
  private async collectHistory(): Promise<Record<string, RunRecord>> {
    return collectHistoryRecords(this.ctx)
  }
}
