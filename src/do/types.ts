// ARC-190: Durable-Object PR-review-run state types.
//
// Spec: docs/superpowers/specs/2026-05-07-arc-190-durable-objects-webhook-ingest-design.md
// Plan: docs/superpowers/plans/2026-05-07-arc-190-durable-objects-webhook-ingest.md

export type RunFinalState = "done" | "failed"

export type RunStateLifecycle =
  | "idle"
  | "queued"
  | "running"
  | "done"
  | "failed-transient"
  | "failed"

export type AlarmKind = "retry" | "watchdog"

/** Spec §4.2 — single source of truth for a PR's review-run state. */
export interface RunState {
  schemaVersion: 1
  owner: string
  repo: string
  prNumber: number
  /** UUIDv4 generated when the run is created (spec §4.2). */
  runId: string
  headSha: string
  baseSha: string | null
  /** Required: consumer mints GitHub installation tokens from this. */
  installationId: number
  state: RunStateLifecycle
  /** 1-indexed; incremented at retry-alarm fire time only (single-increment-point rule, spec §4.6). */
  attempts: number
  /** ISO when first set to "queued". */
  startedAt: string
  /** ISO when consumer set to "running" via /pickup. */
  pickedUpAt?: string
  /** ISO on done | failed. */
  finishedAt?: string
  lastError?: { stage: string; message: string }
  /** ISO when retry alarm scheduled. */
  nextRetryAt?: string
  /**
   * The runId an active alarm was scheduled for. `alarm()` reads this
   * to detect stale alarms (spec §4.6 — Workers DO `setAlarm` carries
   * no payload).
   */
  alarmTargetRunId?: string
  alarmKind?: AlarmKind
  /**
   * Set by /pickup; used by /run-result to detect superseded-consumer
   * late posts (spec §4.6).
   */
  consumerId?: string
  /** ISO of last state mutation; used by spec §4.10 v2 GC sweep. */
  lastActivityAt: string
  /**
   * ARC-251: number of times this run was re-enqueued because a
   * stale-head guard fired on a prior attempt. Persisted on RunState
   * so DO retry-alarm-generated queue messages (which rebuild the
   * pr-review message from RunState, not from the original message)
   * preserve the cap — otherwise the watchdog/retry path silently
   * resets depth to 0 and bypasses MAX_STALE_HEAD_REQUEUES.
   * Undefined / absent means depth 0.
   */
  staleHeadRequeueDepth?: number
  /**
   * SIG-220: GitHub check-run id, set by `handleEnqueue` on the
   * `create | supersede` path (the dispatcher-time creation that
   * pre-SIG-220 ran inside `dispatchJob` is now an upstream
   * best-effort call so the "Sigilix · In progress" check appears
   * within ~1–2s of webhook receipt instead of 5–30s).
   *
   * Threaded into the consumer via the queue message and into the
   * retry-alarm-generated queue message via `handleRetryAlarm` —
   * both let the dispatcher / consumer use `attachExistingCheckRun`
   * instead of creating a duplicate. Also used by the watchdog
   * terminal-failure path to close the check on a dead consumer.
   *
   * Undefined when:
   *   - the upstream create failed (best-effort; dispatcher falls
   *     back to creating a check at dispatch time)
   *   - the run pre-dates SIG-220 and was queued without an id
   *     (legacy-message migration path; same fallback applies)
   */
  checkRunId?: number
  /**
   * SIG-247 Phase 1: GitHub's immutable `repo.id`. Persisted on RunState
   * so DO retry-alarm-generated queue messages preserve the id across
   * worker restarts. Threaded from `EnqueueRequest` → RunState → DO
   * queue/retry sends → `JobMessage` → review pipeline → review-memory
   * lookup so dual-write/read-union semantics apply on every PR review.
   * Undefined when the webhook payload omitted `repository.id` or
   * the integer guard rejected it; the lookup degrades to legacy-only
   * reads in that case.
   */
  repoId?: number
}

/** Spec §4.2 — frozen snapshot retained in history (FIFO-capped per `historyLimit`). */
export interface RunRecord {
  runId: string
  headSha: string
  finalState: RunFinalState
  attempts: number
  startedAt: string
  finishedAt: string
  lastError?: { stage: string; message: string }
}

// ─── DO route payloads ────────────────────────────────────────

export interface EnqueueRequest {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  baseSha: string | null
  installationId: number
  /** GitHub `x-github-delivery` header captured at webhook time. */
  deliveryId: string | null
  /**
   * ARC-251: optional requeue depth for stale-head-driven auto-retries.
   * Webhook-originated enqueues omit this field (treated as 0). The
   * stale-head helper sets `depth + 1` when re-enqueuing against the
   * current head SHA. Persisted on RunState so it survives DO retry-
   * alarm-generated queue messages.
   */
  staleHeadRequeueDepth?: number
  /**
   * SIG-247 Phase 1: GitHub's immutable `repo.id`. Webhook-originated
   * enqueues set this when `payload.repository.id` is a positive
   * integer; omitted on legacy / spoofed / malformed payloads. Passed
   * through to RunState + queue message so review-memory dual-write
   * lookups have it.
   */
  repoId?: number
}

export type EnqueueAction = "create" | "supersede" | "dedupe-active" | "dedupe-terminal"

export interface EnqueueResponse {
  deduped: boolean
  runId: string
  action: EnqueueAction
}

export interface PickupRequest {
  runId: string
  consumerId: string
}

/**
 * Reasons the DO returns in the JSON body when /pickup blocks.
 * Aligns with the literals emitted by `decidePickupAction` /
 * `handlePickup` in `pr-review-run.ts` — the HTTP status code
 * (200/409/410) is on the `Response` and is not duplicated in the
 * body (CR PR #70 catch — types previously included a `status`
 * field that the body never carried).
 */
export type PickupBlockedReason =
  | "duplicate-409"
  | "terminal-410"
  | "stale-runId-410"

export interface PickupResponseOk {
  picked: true
}

export interface PickupResponseBlocked {
  reason: PickupBlockedReason
}

export type PickupResponse = PickupResponseOk | PickupResponseBlocked

export type RunResultStatus = "success" | "transient" | "terminal"

export interface RunResultRequest {
  runId: string
  consumerId: string
  status: RunResultStatus
  error?: { stage: string; message: string }
}

export interface StatusResponseFound {
  kind: "found"
  current: {
    runId: string
    headSha: string
    state: RunStateLifecycle
    attempts: number
    startedAt: string
    pickedUpAt?: string
    finishedAt?: string
    lastError?: { stage: string; message: string }
  }
  history: RunRecord[]
}

export interface StatusResponseEmpty {
  kind: "no-state"
}

export type StatusResponse = StatusResponseFound | StatusResponseEmpty

// ─── Resolved config ──────────────────────────────────────────

export interface ResolvedDoConfig {
  /** Clamped [1, 10]; default 3. */
  maxRetries: number
  /** Clamped [60000, 1800000] ms; default 1200000 (20 min). */
  watchdogMs: number
  /** Clamped [1, 100]; default 10. */
  historyLimit: number
}
