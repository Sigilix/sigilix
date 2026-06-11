// ARC-190 Task 9 — end-to-end acceptance scenarios.
//
// Wires the webhook enqueue (`enqueuePrReviewJob`) → real
// `PrReviewRunDO` (over fake storage) → consumer wrapper
// (`runPrReviewWithDoCallback`) → status route
// (`handleReviewStatusRoute`) so each scenario exercises the spec §2
// AC + §4.6 retry orchestration as a single flow.
//
// The DO stub routes back into the in-process `PrReviewRunDO` instance
// (no real Cloudflare runtime). Alarms are fired manually via
// `harness.fireAlarm()` since vitest fake timers don't replicate
// Cloudflare's setAlarm runtime.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PrReviewRunDO } from "@/src/do/pr-review-run"
import { enqueuePrReviewJob } from "@/src/do/webhook-enqueue"
import { runPrReviewWithDoCallback } from "@/src/do/consumer-wrapper"
import { handleReviewStatusRoute } from "@/src/do/status-route"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { RunState, StatusResponse } from "@/src/do/types"
import { GitHubHttpError } from "@/src/shared/adapters/github"

const SAMPLE_HEAD_SHA = "a".repeat(40)
const SAMPLE_BASE_SHA = "b".repeat(40)
const DELIVERY_ID = "delivery-acceptance-1"
const OWNER = "Sigilix"
const REPO = "sigilix"
const PR_NUMBER = 7
const INSTALLATION_ID = 99

interface AlarmState {
  alarmAt: number | null
}
interface QueueState {
  sent: JobMessage[]
}
interface Harness {
  env: Env
  store: Map<string, unknown>
  alarms: AlarmState
  queue: QueueState
  doInstance: PrReviewRunDO
  fireAlarm: () => Promise<void>
  /** Drain whatever the DO has queued and run the consumer wrapper on
   * each, with the supplied ensemble behavior. Returns the runIds that
   * were processed. */
  drainQueue: (runEnsemble: () => Promise<void>) => Promise<string[]>
  status: () => Promise<{ status: number; body: StatusResponse | { error: string } }>
}

function buildHarness(opts: { maxRetries?: number } = {}): Harness {
  const store = new Map<string, unknown>()
  const alarms: AlarmState = { alarmAt: null }
  const queue: QueueState = { sent: [] }
  const ctx = {
    storage: {
      async get<T>(k: string): Promise<T | undefined> {
        return store.get(k) as T | undefined
      },
      async put<T>(k: string, v: T): Promise<void> {
        store.set(k, v)
      },
      async delete(k: string): Promise<boolean> {
        return store.delete(k)
      },
      async setAlarm(t: number): Promise<void> {
        alarms.alarmAt = t
      },
      async getAlarm(): Promise<number | null> {
        return alarms.alarmAt
      },
      async deleteAlarm(): Promise<void> {
        alarms.alarmAt = null
      },
    },
    id: { toString: () => `${OWNER}/${REPO}#${PR_NUMBER}`, name: `${OWNER}/${REPO}#${PR_NUMBER}` },
  } as unknown as DurableObjectState

  // The DO's env references the same DO namespace stub (round-trip):
  // in real Cloudflare, the DO can call env.PR_REVIEW_RUN to fetch
  // other instances. We don't exercise that here, but the binding
  // must exist on the env. `stubFetch` closes over `doInstance` which
  // is declared below; the closure is fine because JS hoists function
  // bodies and `stubFetch` only fires after `doInstance` exists.
  const stubFetch = async (input: string | Request, init?: RequestInit): Promise<Response> => {
    const req =
      typeof input === "string" ? new Request(input, init as RequestInit) : new Request(input, init as RequestInit)
    return doInstance.fetch(req)
  }
  const stub = { fetch: stubFetch } as unknown as DurableObjectStub
  const idFromName = (name: string) => ({ name }) as unknown as DurableObjectId
  const get = (() => stub) as unknown as DurableObjectNamespace["get"]

  const env: Env = {
    OPENCLAW_JOBS: {
      send: async (message: JobMessage) => {
        queue.sent.push(message)
      },
    } as unknown as Queue<JobMessage>,
    PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
    OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: String(opts.maxRetries ?? 3),
    OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "1200000",
    OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "10",
    // SIG-98: pause/ignore gate reads from KV at the top of
    // `enqueuePrReviewJob`. Returning null from both keys keeps the
    // gate inert so these DO acceptance tests still exercise the
    // post-gate flow they were written for.
    OPENCLAW_STATE: {
      get: async (): Promise<string | null> => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace,
  } as unknown as Env

  const doInstance = new PrReviewRunDO(ctx, env)

  const fireAlarm = async () => {
    await doInstance.alarm()
  }

  const drainQueue = async (runEnsemble: () => Promise<void>): Promise<string[]> => {
    const runIds: string[] = []
    while (queue.sent.length > 0) {
      const msg = queue.sent.shift()
      if (!msg) break
      if (msg.type !== "pr-review") continue
      if (typeof msg.runId === "string") runIds.push(msg.runId)
      await runPrReviewWithDoCallback(msg, env, runEnsemble)
    }
    return runIds
  }

  const status = async () => {
    const res = await handleReviewStatusRoute(env, OWNER, REPO, PR_NUMBER)
    const body = (await res.json()) as StatusResponse | { error: string }
    return { status: res.status, body }
  }

  return { env, store, alarms, queue, doInstance, fireAlarm, drainQueue, status }
}

const baseEnqueueArgs = {
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  headSha: SAMPLE_HEAD_SHA,
  baseSha: SAMPLE_BASE_SHA,
  installationId: INSTALLATION_ID,
  deliveryId: DELIVERY_ID,
}

let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let logged: string[]

beforeEach(() => {
  logged = []
  logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    for (const a of args) logged.push(typeof a === "string" ? a : JSON.stringify(a))
  })
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
})

function eventCount(name: string): number {
  return logged.filter((l) => l.includes(`"event":"${name}"`)).length
}

// ─── Scenario 1 — 3-replay dedupe ─────────────────────────────────

describe("ARC-190 acceptance — 3-replay dedupe (spec §2 AC)", () => {
  it("synchronize webhook replayed 3 times → exactly 1 running run (post-pickup) + 2 do-review-deduped events; status=done attempts=1", async () => {
    const h = buildHarness()

    // 3 replays of the same webhook delivery (same headSha + deliveryId).
    for (let i = 0; i < 3; i++) {
      const result = await enqueuePrReviewJob(h.env, baseEnqueueArgs)
      expect(result.ok).toBe(true)
    }

    // The DO dispatched exactly ONE queue message (the
    // first /enqueue call); subsequent calls deduped.
    expect(h.queue.sent).toHaveLength(1)
    expect(eventCount("do-review-deduped")).toBe(2)
    expect(eventCount("do-review-enqueued")).toBe(1)

    // Drain the queue, but step the run state machine so we can assert
    // the queued → running transition the spec calls out (Codex MAJOR
    // T9 review v1 — final-state-only assertion would have let a
    // pickup-skipping regression slip through).
    let observedRunningWithConsumer = false
    await h.drainQueue(async () => {
      const mid = h.store.get("state") as RunState
      if (mid.state === "running" && typeof mid.consumerId === "string") {
        observedRunningWithConsumer = true
      }
    })
    expect(observedRunningWithConsumer).toBe(true)

    // Status route now reports done with attempts=1.
    const { status, body } = await h.status()
    expect(status).toBe(200)
    if (!("kind" in body) || body.kind !== "found") throw new Error("expected found")
    expect(body.current.state).toBe("done")
    expect(body.current.attempts).toBe(1)
  })
})

// ─── Scenario 2 — transient failure → recovery ───────────────────

describe("ARC-190 acceptance — transient failure → recovery (spec §4.6)", () => {
  it("first attempt 5xx → retry alarm fires → second attempt succeeds; status=done attempts=2", async () => {
    const h = buildHarness()

    // Enqueue.
    await enqueuePrReviewJob(h.env, baseEnqueueArgs)
    expect(h.queue.sent).toHaveLength(1)

    // Drain attempt 1: ensemble throws a 502 (transient → /run-result
    // transient → DO schedules retry alarm).
    await h.drainQueue(async () => {
      throw new GitHubHttpError(502, "upstream 502")
    })
    expect(h.queue.sent).toHaveLength(0)

    // DO state is now failed-transient with a retry alarm scheduled.
    const stateAfterTransient = h.store.get("state") as RunState
    expect(stateAfterTransient.state).toBe("failed-transient")
    expect(stateAfterTransient.alarmKind).toBe("retry")
    expect(h.alarms.alarmAt).not.toBeNull()

    // Fire the retry alarm — DO re-enqueues, attempts becomes 2,
    // watchdog rescheduled.
    await h.fireAlarm()
    expect(h.queue.sent).toHaveLength(1)
    const stateAfterRetry = h.store.get("state") as RunState
    expect(stateAfterRetry.state).toBe("queued")
    expect(stateAfterRetry.attempts).toBe(2)

    // Drain attempt 2: success.
    await h.drainQueue(async () => {
      /* success */
    })

    // Status: done, attempts=2.
    const { status, body } = await h.status()
    expect(status).toBe(200)
    if (!("kind" in body) || body.kind !== "found") throw new Error("expected found")
    expect(body.current.state).toBe("done")
    expect(body.current.attempts).toBe(2)
  })
})

// ─── Scenario 3 — watchdog exhaustion ────────────────────────────

describe("ARC-190 acceptance — watchdog exhaustion (spec §4.6a)", () => {
  it("/run-result never arrives from queued state → watchdog cycles fire until attempts exhausted; status=failed lastError.stage='watchdog'", async () => {
    const h = buildHarness({ maxRetries: 3 })

    // Enqueue.
    await enqueuePrReviewJob(h.env, baseEnqueueArgs)
    expect(h.queue.sent).toHaveLength(1)
    // Discard the queued message — the consumer never picks it up,
    // simulating a stuck or crashed worker.
    h.queue.sent.length = 0

    // attempts=1, state=queued, watchdog alarm scheduled.
    let state = h.store.get("state") as RunState
    expect(state.attempts).toBe(1)
    expect(state.state).toBe("queued")
    expect(state.alarmKind).toBe("watchdog")

    // Fire watchdog #1 → state=failed-transient, retry alarm scheduled.
    expect((h.store.get("state") as RunState).alarmKind).toBe("watchdog")
    await h.fireAlarm()
    state = h.store.get("state") as RunState
    expect(state.state).toBe("failed-transient")
    expect(state.alarmKind).toBe("retry")

    // Fire retry alarm #1 → attempts=2, state=queued, watchdog scheduled.
    await h.fireAlarm()
    state = h.store.get("state") as RunState
    expect(state.attempts).toBe(2)
    expect(state.state).toBe("queued")
    expect(state.alarmKind).toBe("watchdog")
    // Discard the requeued message — still no consumer.
    h.queue.sent.length = 0

    // Fire watchdog #2 → state=failed-transient, retry alarm scheduled.
    await h.fireAlarm()
    state = h.store.get("state") as RunState
    expect(state.state).toBe("failed-transient")
    expect(state.alarmKind).toBe("retry")

    // Fire retry alarm #2 → attempts=3, state=queued.
    await h.fireAlarm()
    state = h.store.get("state") as RunState
    expect(state.attempts).toBe(3)
    expect(state.state).toBe("queued")
    expect(state.alarmKind).toBe("watchdog")
    h.queue.sent.length = 0

    // Fire watchdog #3 → attempts=3 >= maxRetries → terminal.
    await h.fireAlarm()
    state = h.store.get("state") as RunState
    expect(state.state).toBe("failed")
    expect(state.lastError?.stage).toBe("watchdog")

    // Status route reflects terminal failure.
    const { body } = await h.status()
    if (!("kind" in body) || body.kind !== "found") throw new Error("expected found")
    expect(body.current.state).toBe("failed")
    expect(body.current.lastError?.stage).toBe("watchdog")
    expect(eventCount("do-review-watchdog-terminal")).toBe(1)
  })

  it("/run-result never arrives from running state (consumer crashed mid-run) → liveness catches it (SIG-329; was Codex MAJOR T9 v1)", async () => {
    // SIG-329: a claimed-then-crashed consumer is now caught by the
    // `liveness` alarm (heartbeat-gap detector) rather than the long
    // watchdog. The consumer claimed the run via /pickup but stopped
    // heartbeating; once the gap exceeds livenessMs the DO declares the
    // attempt dead and schedules a retry — in seconds, not the full
    // watchdog window. (The queued-never-picked-up case above still uses
    // the watchdog backstop.)
    const h = buildHarness({ maxRetries: 3 })
    await enqueuePrReviewJob(h.env, baseEnqueueArgs)
    expect(h.queue.sent).toHaveLength(1)

    // We bypass the wrapper here and post /pickup directly so we can
    // freeze the run in `running` without triggering the wrapper's
    // /run-result emit.
    const stub = h.env.PR_REVIEW_RUN.get(h.env.PR_REVIEW_RUN.idFromName("ignored"))
    const consumerId = "frozen-consumer-id"
    const pickupRes = await stub.fetch("https://do.internal/pickup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: (h.store.get("state") as RunState).runId, consumerId }),
    })
    expect(pickupRes.status).toBe(200)
    let state = h.store.get("state") as RunState
    expect(state.state).toBe("running")
    expect(state.consumerId).toBe(consumerId)
    // SIG-329: pickup arms liveness (not watchdog); the absolute backstop
    // rides on watchdogDeadlineAt.
    expect(state.alarmKind).toBe("liveness")

    // Simulate the consumer going silent: no heartbeat past the gap
    // (pickup seeded lastHeartbeatAt to ~now; default livenessMs is 90s).
    const silent = h.store.get("state") as RunState
    silent.lastHeartbeatAt = new Date(Date.now() - 200_000).toISOString()
    h.store.set("state", silent)

    // Fire liveness from running state → gap exceeded → attempts=1 < 3 → retry.
    await h.fireAlarm()
    state = h.store.get("state") as RunState
    expect(state.state).toBe("failed-transient")
    expect(state.alarmKind).toBe("retry")
    expect(state.lastError?.stage).toBe("liveness")
  })
})

// ─── Bonus — telemetry tags split DO-routed work ─────────────────

describe("ARC-190 acceptance — telemetry tags on enqueue + dedupe + completion path", () => {
  it("the events emitted on a 2x replay + drain (enqueued, deduped, picked-up, completed) all carry dedupe_system: 'do'", async () => {
    // Narrower than the spec §5 inventory — this scenario does NOT
    // exercise pickup-skipped, retry-fired, watchdog-*, supersede,
    // or result-superseded paths. Those events are tagged at their
    // emission sites in pr-review-run.ts and individually covered by
    // the alarm + routes test files.
    const h = buildHarness()
    for (let i = 0; i < 2; i++) {
      await enqueuePrReviewJob(h.env, baseEnqueueArgs)
    }
    await h.drainQueue(async () => {
      /* success */
    })

    const doLines = logged.filter((l) => /"event":"do-review-/.test(l))
    expect(doLines.length).toBeGreaterThan(0)
    for (const line of doLines) {
      expect(line).toContain('"dedupe_system":"do"')
    }
  })
})
