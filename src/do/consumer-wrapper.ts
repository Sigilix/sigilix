// ARC-190 Task 7: queue consumer wrapper for DO-routed pr-review jobs.
//
// The wrapper is invoked ONLY when a `pr-review` JobMessage carries a
// string `runId` (DO-routed signal — Codex BLOCKING B2 on plan v1).
// Legacy direct-path messages bypass; the existing pr-review pipeline
// runs unchanged.
//
// Flow (spec §4.4):
//   1. Mint a per-attempt consumerId (UUIDv4).
//   2. POST /pickup → 200 (claim) | 409/410 (ack + exit) |
//      5xx / transport throw (queue redelivers) | other 4xx (ack + log;
//      bug-shaped, redelivery wouldn't fix it — DO watchdog catches).
//   3. Run the ensemble callback.
//   4. POST /run-result with success / transient / terminal verdict
//      (classified by `classifyEnsembleError`). Swallow post failures —
//      the DO's watchdog alarm is the safety net.
//
// The wrapper does NOT re-throw ensemble errors. The DO is now the
// retry source-of-truth: a `transient` /run-result tells the DO to
// schedule a retry alarm; the queue acks regardless. Only pickup-5xx
// / pickup-transport failures throw, so Cloudflare Queue redelivers
// the message back to a fresh /pickup attempt.

import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { classifyEnsembleError, classifyEnsembleStage } from "./classify-error"
import type { RunResultRequest, RunResultStatus } from "./types"
import { createPrReviewStatusReporter, type ReviewStatusReporter } from "@/src/lib/pr-review-status-reporter"

type PrReviewJob = Extract<JobMessage, { type: "pr-review" }>

const DO_BASE_URL = "https://do.internal"

function instanceName(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`
}

interface PickupOutcome {
  /** "claim" lets the wrapper run the ensemble; "blocked" means ack + exit. */
  kind: "claim" | "blocked"
  status: number
  reason?: string
}

async function readPickupReason(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { reason?: unknown }
    if (typeof body?.reason === "string") return body.reason
  } catch {
    // ignore — non-JSON body is non-fatal
  }
  return undefined
}

/**
 * Wrap the queue consumer's pr-review work with /pickup → run →
 * /run-result. Bypasses cleanly when `job.runId` is not a string
 * (for example, user-triggered reruns or older queued messages).
 */
export async function runPrReviewWithDoCallback(
  job: PrReviewJob,
  env: Env,
  runEnsemble: (statusReporter?: ReviewStatusReporter) => Promise<void>,
  waitUntil?: (promise: Promise<void>) => void,
): Promise<void> {
  // Codex BLOCKING B2 on plan v1: string-typed runId is the DO-routed
  // signal. ci-triage's separate numeric runId would falsely match a
  // looser `if (job.runId)` guard.
  if (typeof job.runId !== "string") {
    return runEnsemble()
  }

  const runId = job.runId
  const consumerId = crypto.randomUUID()
  const id = env.PR_REVIEW_RUN.idFromName(instanceName(job.owner, job.repo, job.prNumber))
  const stub = env.PR_REVIEW_RUN.get(id)
  // ARC-284: queue → DO → ensemble → result wall-clock. Captured here
  // so we can correlate the orchestrator's `startMs` with the queue
  // consumer's pickup time (queueLagMs = pickup - queue arrival is
  // not knowable from inside the consumer, but pickup-to-finish IS).
  const pickedUpAtMs = Date.now()

  const pickup = await postPickup(stub, runId, consumerId)
  if (pickup.kind === "blocked") {
    // The DO emits `do-review-pickup-skipped` from inside /pickup at
    // the 409/410 decision point (see pr-review-run.ts handlePickup),
    // so the wrapper does NOT double-emit a sibling event. Unexpected-
    // 4xx ack paths still log a one-liner so the bug is observable.
    if (pickup.status !== 409 && pickup.status !== 410) {
      console.error(
        JSON.stringify({
          event: "do-review-consumer-pickup-unexpected-status",
          dedupe_system: "do",
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          runId,
          consumerId,
          status: pickup.status,
          reason: pickup.reason,
        }),
      )
    }
    return
  }

  // SIG-329: keep the DO's liveness alarm armed while the ensemble runs.
  // If this isolate is evicted (e.g. a production redeploy on the bot's
  // own repo) the heartbeat stops and the DO detects the dead attempt
  // within one `livenessMs` gap instead of waiting out the watchdog.
  const stopHeartbeat = startHeartbeat(stub, runId, consumerId, job)
  const statusReporter = createPrReviewStatusReporter({
    env,
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha: job.headSha,
    runId,
    installationId: job.installationId,
    doStub: stub,
    ...(waitUntil !== undefined ? { waitUntil } : {}),
  })
  let caught: unknown = undefined
  try {
    await runEnsemble(statusReporter)
  } catch (err) {
    caught = err
  } finally {
    stopHeartbeat()
  }

  const payload = buildRunResultPayload(runId, consumerId, caught)
  await postRunResult(stub, payload, job)

  // ARC-284: do-review-run-timing. Emit AFTER /run-result resolves so
  // the wall-clock includes the round-trip back to the DO. Final
  // state is derived from `caught` since we don't have a structured
  // return from runEnsemble — it's the queue-handler closure that
  // owns the EnsembleResult.
  const finishedAtMs = Date.now()
  console.log(
    JSON.stringify({
      event: "do-review-run-timing",
      // ARC-190 contract: every DO-emitted log line carries
      // dedupe_system=do so the acceptance test can filter all DO
      // surface output by tag.
      dedupe_system: "do",
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: job.headSha.slice(0, 7),
      runId,
      pickedUpAtMs,
      finishedAtMs,
      consumerWallMs: finishedAtMs - pickedUpAtMs,
      finalState: caught !== undefined ? "errored" : "completed",
      // SIG-374: queue wait + attempt attribution. Both fields are
      // optional on JobMessage (absent on in-flight pre-deploy
      // messages and slash-command raw-sends) — typeof-guarded so a
      // missing field reports null instead of NaN. queueWaitMs crosses
      // isolates (DO Date.now() vs consumer Date.now(), and CF advances
      // clocks on IO only) — sub-10ms or slightly negative samples are
      // clock noise; consume as p50/p95 aggregates, never row-by-row.
      enqueuedAtMs: typeof job.enqueuedAtMs === "number" ? job.enqueuedAtMs : null,
      queueWaitMs: typeof job.enqueuedAtMs === "number" ? pickedUpAtMs - job.enqueuedAtMs : null,
      attempt: typeof job.attempt === "number" ? job.attempt : null,
    }),
  )
}

// SIG-329: how often the running consumer pings the DO `/heartbeat`
// route. Comfortably inside DEFAULT_LIVENESS_MS (90s) so a healthy
// consumer always re-arms the liveness alarm before it fires, while an
// evicted isolate stops pinging and is detected within one gap.
// INVARIANT: must stay below LIVENESS_MS_RANGE's floor (45s, see
// `config.ts`) so the first beat always lands before the first liveness
// alarm — even when livenessMs is configured at the floor.
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Start a periodic `/heartbeat` loop for the in-flight attempt. Returns
 * a stop function the caller MUST invoke (in a `finally`) once the
 * ensemble settles. A 410 response means the run was superseded /
 * cancelled / already terminal — the loop stops itself (the DO no
 * longer wants this consumer's results; `/run-result` routes to
 * history). Transient errors are swallowed: the DO's liveness + watchdog
 * alarms are the safety net. Uses chained `setTimeout` (not
 * `setInterval`) so a slow round-trip never overlaps the next ping.
 */
function startHeartbeat(stub: DurableObjectStub, runId: string, consumerId: string, job: PrReviewJob): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const res = await stub.fetch(`${DO_BASE_URL}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, consumerId }),
      })
      try {
        await res.json()
      } catch {
        /* ignore body */
      }
      if (res.status === 410) {
        // Superseded / cancelled / terminal — stop pinging.
        stopped = true
        console.log(
          JSON.stringify({
            event: "do-review-consumer-heartbeat-stopped",
            dedupe_system: "do",
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            runId,
            consumerId,
            reason: "410",
          }),
        )
        return
      }
    } catch {
      // Transient DO blip — keep beating; liveness/watchdog is the net.
    }
    if (!stopped)
      timer = setTimeout(() => {
        void tick()
      }, HEARTBEAT_INTERVAL_MS)
  }

  timer = setTimeout(() => {
    void tick()
  }, HEARTBEAT_INTERVAL_MS)
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function postPickup(stub: DurableObjectStub, runId: string, consumerId: string): Promise<PickupOutcome> {
  const res = await stub.fetch(`${DO_BASE_URL}/pickup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, consumerId }),
  })
  if (res.status === 200) {
    // Drain the body so the stub doesn't leak.
    try {
      await res.json()
    } catch {
      /* ignore */
    }
    return { kind: "claim", status: 200 }
  }
  if (res.status === 409 || res.status === 410) {
    const reason = await readPickupReason(res)
    return reason === undefined
      ? { kind: "blocked", status: res.status }
      : { kind: "blocked", status: res.status, reason }
  }
  if (res.status >= 500) {
    // Transient infrastructure / DO-side failure. Queue redelivery
    // will hit a fresh /pickup attempt and either succeed or get a
    // proper 410 if the run was superseded in the meantime.
    throw new Error(`pr-review-do-pickup-failed status=${res.status}`)
  }
  // 4xx-other (400 / 404 etc.) — the DO route only returns 200/409/410
  // by spec §4.3, so any other 4xx indicates a deploy mismatch or
  // schema bug. Redelivery wouldn't fix a deterministic 4xx, so we
  // ack + log and let the DO's watchdog alarm catch the missing
  // /run-result.
  return { kind: "blocked", status: res.status, reason: "unexpected-status" }
}

function buildRunResultPayload(runId: string, consumerId: string, caught: unknown): RunResultRequest {
  if (caught === undefined) {
    return { runId, consumerId, status: "success" }
  }
  const status: RunResultStatus = classifyEnsembleError(caught)
  const stage = classifyEnsembleStage(caught)
  const message = caught instanceof Error ? caught.message : String(caught)
  return { runId, consumerId, status, error: { stage, message } }
}

/**
 * Bounded retry on `/run-result` POST (CR PR #70 catch). A single
 * failed POST on the success path lets the DO stay non-terminal:
 * the watchdog later schedules a retry alarm and a second consumer
 * picks up the same runId. For v1 the legacy KV dedupe in
 * `handlePrReview` (`pr-review:<owner>/<repo>#<pr>@<sha>` 7-day TTL)
 * still catches double-posts, but we want the retry rate low enough
 * that operators don't see watchdog-driven re-runs in the dashboard
 * for a transient DO blip. Three attempts with 100ms / 400ms backoff
 * covers the common DO-isolate-handoff case.
 *
 * Same-`(runId, consumerId)` POSTs are idempotent server-side: the
 * DO's `decideRunResultAction` returns the same transition for the
 * same payload, so a retry that lands after a successful first try
 * just re-applies the terminal state (no-op).
 */
const RUN_RESULT_RETRY_DELAYS_MS = [100, 400] as const

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postRunResult(stub: DurableObjectStub, payload: RunResultRequest, job: PrReviewJob): Promise<void> {
  // Best-effort with bounded retry. The DO's watchdog alarm remains
  // the ultimate safety net (spec §4.6a); the retry just shrinks the
  // window where transient DO failures cause unnecessary watchdog-
  // driven re-runs.
  let attempt = 0
  let lastErr: unknown = undefined
  let lastNonOk: number | undefined
  const maxAttempts = RUN_RESULT_RETRY_DELAYS_MS.length + 1
  while (attempt < maxAttempts) {
    if (attempt > 0) {
      await sleep(RUN_RESULT_RETRY_DELAYS_MS[attempt - 1] ?? 0)
    }
    attempt++
    try {
      const res = await stub.fetch(`${DO_BASE_URL}/run-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (res.ok) return
      lastNonOk = res.status
      lastErr = undefined
    } catch (err) {
      lastErr = err
      lastNonOk = undefined
    }
  }

  // All retries exhausted — log + return. Watchdog catches the run.
  if (lastErr !== undefined) {
    console.error(
      JSON.stringify({
        event: "do-review-consumer-run-result-failed",
        dedupe_system: "do",
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        runId: payload.runId,
        consumerId: payload.consumerId,
        status: payload.status,
        attempts: attempt,
        err: lastErr instanceof Error ? lastErr.message : String(lastErr),
      }),
    )
  } else {
    console.error(
      JSON.stringify({
        event: "do-review-consumer-run-result-non-ok",
        dedupe_system: "do",
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        runId: payload.runId,
        consumerId: payload.consumerId,
        status: payload.status,
        attempts: attempt,
        doStatus: lastNonOk,
      }),
    )
  }
}
