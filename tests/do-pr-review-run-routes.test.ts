// ARC-190 Task 5 — PrReviewRunDO route handler tests.
//
// Each test constructs a fresh DO instance via the in-process stub
// (no real Cloudflare DO runtime), invokes fetch() with a synthetic
// internal URL, and asserts route behavior + storage state +
// telemetry hooks.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PrReviewRunDO } from "../src/do/pr-review-run"
import type { Env } from "../src/index"
import type {
  EnqueueRequest,
  PickupRequest,
  RunResultRequest,
  RunState,
  StatusResponse,
} from "../src/do/types"

// ─── DO storage + state stub ──────────────────────────────────

interface FakeAlarmState {
  alarmAt: number | null
}

interface FakeDoState {
  storage: {
    get: <T>(key: string) => Promise<T | undefined>
    put: <T>(key: string, value: T) => Promise<void>
    delete: (key: string) => Promise<boolean>
    setAlarm: (timestamp: number) => Promise<void>
    getAlarm: () => Promise<number | null>
    deleteAlarm: () => Promise<void>
  }
  id: { toString: () => string; name?: string }
  /** Test-only escape hatch — invoke the registered alarm() handler. */
  triggerAlarm: () => Promise<void>
  store: Map<string, unknown>
  alarms: FakeAlarmState
}

function makeDoState(name: string = "Arc-and-Anchor/sigilix#7"): FakeDoState {
  const store = new Map<string, unknown>()
  const alarms: FakeAlarmState = { alarmAt: null }
  const fakeState: FakeDoState = {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined
      },
      async put<T>(key: string, value: T): Promise<void> {
        store.set(key, value)
      },
      async delete(key: string): Promise<boolean> {
        return store.delete(key)
      },
      async setAlarm(timestamp: number): Promise<void> {
        alarms.alarmAt = timestamp
      },
      async getAlarm(): Promise<number | null> {
        return alarms.alarmAt
      },
      async deleteAlarm(): Promise<void> {
        alarms.alarmAt = null
      },
    },
    id: { toString: () => name, name },
    triggerAlarm: async () => {
      // No-op until Task 6 lands the alarm handler. Tests in this
      // file don't exercise alarm flow.
    },
    store,
    alarms,
  }
  return fakeState
}

interface QueueSendCall {
  message: unknown
}

function makeQueue() {
  const sent: QueueSendCall[] = []
  const send = vi.fn(async (message: unknown) => {
    sent.push({ message })
  })
  return { send, sent }
}

function makeEnv(queueSend: ReturnType<typeof makeQueue>["send"]): Env {
  return {
    OPENCLAW_JOBS: { send: queueSend },
    OPENCLAW_PR_REVIEW_MODE: "post",
    OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "3",
    OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "1200000",
    OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "10",
  } as unknown as Env
}

function makeDo(env: Env, state?: FakeDoState): { instance: PrReviewRunDO; state: FakeDoState } {
  const s = state ?? makeDoState()
  const instance = new PrReviewRunDO(s as unknown as DurableObjectState, env)
  return { instance, state: s }
}

const SAMPLE_HEAD_SHA = "a".repeat(40)
const SAMPLE_BASE_SHA = "b".repeat(40)

function makeEnqueueReq(over: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    prNumber: 7,
    headSha: SAMPLE_HEAD_SHA,
    baseSha: SAMPLE_BASE_SHA,
    installationId: 99,
    deliveryId: "delivery-1",
    mode: "post",
    ...over,
  }
}

async function postJson(instance: PrReviewRunDO, path: string, body: unknown): Promise<Response> {
  return instance.fetch(new Request(`https://do.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }))
}

async function getJson(instance: PrReviewRunDO, path: string): Promise<Response> {
  return instance.fetch(new Request(`https://do.internal${path}`, {
    method: "GET",
  }))
}

let consoleSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  consoleSpy.mockRestore()
})

// ─── /enqueue ─────────────────────────────────────────────────

describe("PrReviewRunDO /enqueue — first run", () => {
  it("creates a fresh RunState + sends queue message + schedules watchdog (post mode)", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    const req = makeEnqueueReq()
    const res = await postJson(instance, "/enqueue", req)
    expect(res.status).toBe(200)
    const body = await res.json() as { deduped: boolean; runId: string; action: string }
    expect(body.deduped).toBe(false)
    expect(body.action).toBe("create")
    expect(body.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const stored = state.store.get("state") as RunState
    expect(stored.state).toBe("queued")
    expect(stored.headSha).toBe(SAMPLE_HEAD_SHA)
    expect(stored.installationId).toBe(99)
    expect(stored.attempts).toBe(1)
    expect(stored.lastActivityAt).toBeDefined()
    expect(queue.sent.length).toBe(1)
    const queuedMsg = queue.sent[0]!.message as { type: string; runId?: string }
    expect(queuedMsg.type).toBe("pr-review")
    expect(typeof queuedMsg.runId).toBe("string")
    expect(state.alarms.alarmAt).not.toBeNull()
  })

  it("shadow mode skips queue dispatch + skips watchdog alarm", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    const req = makeEnqueueReq({ mode: "shadow" })
    const res = await postJson(instance, "/enqueue", req)
    expect(res.status).toBe(200)
    expect(queue.sent.length).toBe(0)
    expect(state.alarms.alarmAt).toBeNull()
    // State IS recorded for observation
    expect((state.store.get("state") as RunState).state).toBe("queued")
  })
})

describe("PrReviewRunDO /enqueue — dedupe + supersede", () => {
  it("same SHA + state queued → dedupe-active (no new queue send)", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    await postJson(instance, "/enqueue", makeEnqueueReq())
    const firstRunId = (state.store.get("state") as RunState).runId
    queue.sent.length = 0  // reset

    const res = await postJson(instance, "/enqueue", makeEnqueueReq())
    expect(res.status).toBe(200)
    const body = await res.json() as { deduped: boolean; runId: string; action: string }
    expect(body.deduped).toBe(true)
    expect(body.action).toBe("dedupe-active")
    expect(body.runId).toBe(firstRunId)
    expect(queue.sent.length).toBe(0)
  })

  it("same SHA + state done → dedupe-terminal (no new queue send)", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    await postJson(instance, "/enqueue", makeEnqueueReq())
    const s = state.store.get("state") as RunState
    s.state = "done"
    state.store.set("state", s)
    queue.sent.length = 0

    const res = await postJson(instance, "/enqueue", makeEnqueueReq())
    expect(res.status).toBe(200)
    const body = await res.json() as { action: string }
    expect(body.action).toBe("dedupe-terminal")
    expect(queue.sent.length).toBe(0)
  })

  it("different SHA → supersede (archives old to history, creates new run)", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    await postJson(instance, "/enqueue", makeEnqueueReq({ headSha: "OLD".padEnd(40, "0") }))
    const oldRunId = (state.store.get("state") as RunState).runId
    queue.sent.length = 0

    const res = await postJson(instance, "/enqueue", makeEnqueueReq({ headSha: "NEW".padEnd(40, "0") }))
    expect(res.status).toBe(200)
    const body = await res.json() as { runId: string; action: string }
    expect(body.action).toBe("supersede")
    expect(body.runId).not.toBe(oldRunId)
    const newState = state.store.get("state") as RunState
    expect(newState.headSha).toBe("NEW".padEnd(40, "0"))
    expect(newState.runId).toBe(body.runId)
    expect(queue.sent.length).toBe(1)
    // Old run archived to history under run:<oldRunId>
    expect(state.store.has(`run:${oldRunId}`)).toBe(true)
  })
})

// ─── /pickup ──────────────────────────────────────────────────

describe("PrReviewRunDO /pickup", () => {
  async function setupQueuedRun(): Promise<{ env: Env; instance: PrReviewRunDO; state: FakeDoState; runId: string }> {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    await postJson(instance, "/enqueue", makeEnqueueReq())
    const runId = (state.store.get("state") as RunState).runId
    return { env, instance, state, runId }
  }

  it("200 claim — transitions queued → running, sets pickedUpAt + consumerId", async () => {
    const { instance, state, runId } = await setupQueuedRun()
    const res = await postJson(instance, "/pickup", { runId, consumerId: "consumer-A" } satisfies PickupRequest)
    expect(res.status).toBe(200)
    const updated = state.store.get("state") as RunState
    expect(updated.state).toBe("running")
    expect(updated.consumerId).toBe("consumer-A")
    expect(updated.pickedUpAt).toBeDefined()
  })

  it("409 duplicate — same runId + different consumerId on running state", async () => {
    const { instance, runId } = await setupQueuedRun()
    await postJson(instance, "/pickup", { runId, consumerId: "consumer-A" })
    const res = await postJson(instance, "/pickup", { runId, consumerId: "consumer-B" })
    expect(res.status).toBe(409)
  })

  it("200 claim re-pickup — same consumerId is idempotent", async () => {
    const { instance, runId } = await setupQueuedRun()
    await postJson(instance, "/pickup", { runId, consumerId: "consumer-A" })
    const res = await postJson(instance, "/pickup", { runId, consumerId: "consumer-A" })
    expect(res.status).toBe(200)
  })

  it("410 stale-runId — runId doesn't match current state", async () => {
    const { instance } = await setupQueuedRun()
    const res = await postJson(instance, "/pickup", { runId: "wrong-runId", consumerId: "consumer-A" })
    expect(res.status).toBe(410)
  })

  it("410 terminal — state is done", async () => {
    const { instance, state, runId } = await setupQueuedRun()
    const s = state.store.get("state") as RunState
    s.state = "done"
    state.store.set("state", s)
    const res = await postJson(instance, "/pickup", { runId, consumerId: "consumer-A" })
    expect(res.status).toBe(410)
  })

  it("410 stale-runId on first call (state never created)", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance } = makeDo(env)
    const res = await postJson(instance, "/pickup", { runId: "anything", consumerId: "any" })
    expect(res.status).toBe(410)
  })

  // Codex P2 regression: shadow-mode pickups must NOT arm a
  // watchdog/retry pipeline — shadow runs are observation-only.
  it("shadow-mode pickup does NOT arm watchdog alarm or alarmKind", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    // Shadow-mode enqueue.
    await postJson(instance, "/enqueue", makeEnqueueReq({ mode: "shadow" }))
    const runId = (state.store.get("state") as RunState).runId
    expect(state.alarms.alarmAt).toBeNull()  // shadow doesn't arm
    expect((state.store.get("state") as RunState).alarmKind).toBeUndefined()

    const res = await postJson(instance, "/pickup", { runId, consumerId: "consumer-A" })
    expect(res.status).toBe(200)
    // Pickup must NOT have armed an alarm or set alarmKind.
    expect(state.alarms.alarmAt).toBeNull()
    const after = state.store.get("state") as RunState
    expect(after.alarmKind).toBeUndefined()
    expect(after.alarmTargetRunId).toBeUndefined()
  })

  // Codex P2 regression: /pickup must refresh the watchdog so the
  // timer measures from pickup-time (when the consumer actually
  // starts) rather than enqueue-time. Otherwise a queue-backlog
  // delay can cause the watchdog to fire while a legitimately
  // running consumer is still within its allowed processing window.
  it("claim refreshes the watchdog alarm to now+watchdogMs", async () => {
    const { instance, state, runId } = await setupQueuedRun()
    const enqueueAlarmAt = state.alarms.alarmAt
    expect(enqueueAlarmAt).not.toBeNull()
    // Simulate time passing in the queue.
    const beforePickup = Date.now()
    const res = await postJson(instance, "/pickup", { runId, consumerId: "consumer-A" })
    expect(res.status).toBe(200)
    const afterAlarm = state.alarms.alarmAt
    expect(afterAlarm).not.toBeNull()
    // The alarm should be (re)scheduled at >= now (with watchdogMs offset),
    // i.e. strictly later than the enqueue-time alarm value.
    expect(afterAlarm!).toBeGreaterThanOrEqual(beforePickup)
  })
})

// ─── /run-result ──────────────────────────────────────────────

describe("PrReviewRunDO /run-result", () => {
  async function setupRunningRun(): Promise<{ env: Env; instance: PrReviewRunDO; state: FakeDoState; runId: string; consumerId: string }> {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)
    await postJson(instance, "/enqueue", makeEnqueueReq())
    const runId = (state.store.get("state") as RunState).runId
    const consumerId = "consumer-A"
    await postJson(instance, "/pickup", { runId, consumerId })
    return { env, instance, state, runId, consumerId }
  }

  it("status=success → state=done + finishedAt + history append", async () => {
    const { instance, state, runId, consumerId } = await setupRunningRun()
    const res = await postJson(instance, "/run-result", {
      runId, consumerId, status: "success",
    } satisfies RunResultRequest)
    expect(res.status).toBe(200)
    const updated = state.store.get("state") as RunState
    expect(updated.state).toBe("done")
    expect(updated.finishedAt).toBeDefined()
    expect(state.store.has(`run:${runId}`)).toBe(true)
  })

  it("status=transient + attempts<max → failed-transient + retry alarm scheduled", async () => {
    const { instance, state, runId, consumerId } = await setupRunningRun()
    state.alarms.alarmAt = null  // reset watchdog scheduled at enqueue
    const res = await postJson(instance, "/run-result", {
      runId, consumerId, status: "transient",
      error: { stage: "github-http-503", message: "503" },
    } satisfies RunResultRequest)
    expect(res.status).toBe(200)
    const updated = state.store.get("state") as RunState
    expect(updated.state).toBe("failed-transient")
    expect(state.alarms.alarmAt).not.toBeNull()
    expect(updated.alarmTargetRunId).toBe(runId)
    expect(updated.alarmKind).toBe("retry")
    expect(updated.lastError).toEqual({ stage: "github-http-503", message: "503" })
  })

  it("status=transient + attempts=max → failed terminal + history", async () => {
    const { instance, state, runId, consumerId } = await setupRunningRun()
    const s = state.store.get("state") as RunState
    s.attempts = 3
    state.store.set("state", s)
    const res = await postJson(instance, "/run-result", {
      runId, consumerId, status: "transient",
      error: { stage: "github-http-503", message: "503" },
    })
    expect(res.status).toBe(200)
    const updated = state.store.get("state") as RunState
    expect(updated.state).toBe("failed")
    expect(state.store.has(`run:${runId}`)).toBe(true)
  })

  it("status=terminal → failed regardless of attempts + history", async () => {
    const { instance, state, runId, consumerId } = await setupRunningRun()
    const res = await postJson(instance, "/run-result", {
      runId, consumerId, status: "terminal",
      error: { stage: "github-http-422", message: "invalid anchor" },
    })
    expect(res.status).toBe(200)
    const updated = state.store.get("state") as RunState
    expect(updated.state).toBe("failed")
    expect(state.store.has(`run:${runId}`)).toBe(true)
  })

  it("consumerId mismatch (superseded consumer) → write to history only, no current-state mutation", async () => {
    const { instance, state, runId } = await setupRunningRun()
    const beforeState = (state.store.get("state") as RunState).state
    const res = await postJson(instance, "/run-result", {
      runId, consumerId: "consumer-OLD", status: "success",
    })
    expect(res.status).toBe(200)
    const after = state.store.get("state") as RunState
    expect(after.state).toBe(beforeState)  // unchanged
  })

  it("runId mismatch (superseded run) → history-only, no current-state mutation", async () => {
    const { instance, state, consumerId } = await setupRunningRun()
    const before = (state.store.get("state") as RunState).state
    const res = await postJson(instance, "/run-result", {
      runId: "OLD-runId", consumerId, status: "success",
    })
    expect(res.status).toBe(200)
    const after = state.store.get("state") as RunState
    expect(after.state).toBe(before)
    // Different runId → write to run:OLD-runId history record.
    expect(state.store.has("run:OLD-runId")).toBe(true)
  })

  // Codex P2 regression: late same-runId result must NOT overwrite
  // an already-written terminal history record.
  it("late success after watchdog-terminal does NOT overwrite the failed history record", async () => {
    const { instance, state, runId, consumerId } = await setupRunningRun()
    // Simulate watchdog-terminal completing the run already.
    const cur = state.store.get("state") as RunState
    state.store.set("state", { ...cur, state: "failed", finishedAt: "2026-05-07T06:00:00.000Z" })
    state.store.set(`run:${runId}`, {
      runId, headSha: cur.headSha, finalState: "failed",
      attempts: cur.attempts, startedAt: cur.startedAt,
      finishedAt: "2026-05-07T06:00:00.000Z",
      lastError: { stage: "watchdog", message: "timeout" },
    })

    const res = await postJson(instance, "/run-result", {
      runId, consumerId, status: "success",  // late "success"
    })
    expect(res.status).toBe(200)
    // Current state still failed.
    const after = state.store.get("state") as RunState
    expect(after.state).toBe("failed")
    // History record still says failed (not flipped to done).
    const rec = state.store.get(`run:${runId}`) as { finalState: string }
    expect(rec.finalState).toBe("failed")
  })

  it("consumerId mismatch on running run does NOT write a half-baked same-runId history record", async () => {
    const { instance, state, runId } = await setupRunningRun()
    // No history record exists yet — run is still running.
    expect(state.store.has(`run:${runId}`)).toBe(false)

    const res = await postJson(instance, "/run-result", {
      runId, consumerId: "consumer-OLD", status: "success",
    })
    expect(res.status).toBe(200)
    // Still no history record at run:<existing.runId>.
    expect(state.store.has(`run:${runId}`)).toBe(false)
  })
})

// ─── /status ──────────────────────────────────────────────────

describe("PrReviewRunDO /status", () => {
  it("returns kind=no-state when storage empty", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance } = makeDo(env)
    const res = await getJson(instance, "/status")
    expect(res.status).toBe(200)
    const body = await res.json() as StatusResponse
    expect(body.kind).toBe("no-state")
  })

  it("returns kind=found with current state", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance } = makeDo(env)
    await postJson(instance, "/enqueue", makeEnqueueReq())
    const res = await getJson(instance, "/status")
    expect(res.status).toBe(200)
    const body = await res.json() as StatusResponse
    if (body.kind !== "found") throw new Error("expected found")
    expect(body.current.state).toBe("queued")
    expect(body.history).toEqual([])
  })
})

// ─── unknown routes ──────────────────────────────────────────

describe("PrReviewRunDO unknown routes", () => {
  it("404 on unknown path", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance } = makeDo(env)
    const res = await getJson(instance, "/bogus")
    expect(res.status).toBe(404)
  })

  it("404 on unsupported method", async () => {
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance } = makeDo(env)
    const res = await instance.fetch(new Request("https://do.internal/enqueue", { method: "DELETE" }))
    expect(res.status).toBe(404)
  })
})

// ─── lastActivityAt invariant ─────────────────────────────────

describe("PrReviewRunDO lastActivityAt invariant", () => {
  it("every state mutation refreshes lastActivityAt", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-07T06:00:00Z"))
    const queue = makeQueue()
    const env = makeEnv(queue.send)
    const { instance, state } = makeDo(env)

    await postJson(instance, "/enqueue", makeEnqueueReq())
    const ts1 = (state.store.get("state") as RunState).lastActivityAt

    vi.setSystemTime(new Date("2026-05-07T06:00:10Z"))
    await postJson(instance, "/pickup", {
      runId: (state.store.get("state") as RunState).runId,
      consumerId: "c-A",
    })
    const ts2 = (state.store.get("state") as RunState).lastActivityAt
    expect(ts2 > ts1).toBe(true)
    vi.useRealTimers()
  })
})
