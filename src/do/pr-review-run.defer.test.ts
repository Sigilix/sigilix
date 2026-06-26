// SIG-455 Task 5 — PrReviewRunDO /defer route + `defer` alarm tests.
//
// Reuses the in-process DO stub harness from do-pr-review-run-routes.test.ts.
// /defer is the fairness escape hatch: when the webhook consumer denies a
// per-tenant slot it calls /defer instead of message.retry(), so the run
// re-arms its watchdog and schedules a `defer` alarm that re-sends a FRESH
// queue message (attempt UNCHANGED — a defer is not a retry).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PrReviewRunDO } from "@/src/do/pr-review-run"
import type { Env } from "@/src/shared/types/env"
import type { EnqueueRequest, RunState } from "@/src/do/types"
import { MAX_DEFERS } from "@/src/features/tenancy"

// ─── DO storage + state stub (mirrors do-pr-review-run-routes.test.ts) ──

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
  store: Map<string, unknown>
  alarms: FakeAlarmState
}

function makeDoState(name: string = "Sigilix/sigilix#7"): FakeDoState {
  const store = new Map<string, unknown>()
  const alarms: FakeAlarmState = { alarmAt: null }
  return {
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
    store,
    alarms,
  }
}

function makeQueue() {
  const sent: { message: unknown }[] = []
  const send = vi.fn(async (message: unknown) => {
    sent.push({ message })
  })
  return { send, sent }
}

function makeEnv(queueSend: ReturnType<typeof makeQueue>["send"]): Env {
  return {
    OPENCLAW_JOBS: { send: queueSend },
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
const WATCHDOG_MS = 1_200_000

function makeEnqueueReq(over: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    headSha: SAMPLE_HEAD_SHA,
    baseSha: SAMPLE_BASE_SHA,
    installationId: 99,
    deliveryId: "delivery-1",
    ...over,
  }
}

async function postJson(instance: PrReviewRunDO, path: string, body: unknown): Promise<Response> {
  return instance.fetch(
    new Request(`https://do.internal${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  )
}

async function setupQueuedRun(): Promise<{
  env: Env
  instance: PrReviewRunDO
  state: FakeDoState
  queue: ReturnType<typeof makeQueue>
  runId: string
}> {
  const queue = makeQueue()
  const env = makeEnv(queue.send)
  const { instance, state } = makeDo(env)
  await postJson(instance, "/enqueue", makeEnqueueReq())
  const runId = (state.store.get("state") as RunState).runId
  queue.sent.length = 0 // drop the /enqueue send so defer sends are isolated
  return { env, instance, state, queue, runId }
}

let consoleSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  consoleSpy.mockRestore()
})

// ─── /defer route ─────────────────────────────────────────────

describe("PrReviewRunDO /defer — queued run", () => {
  it("200, sets alarmKind=defer + deferCount=1 + alarm ~now+backoffMs, no immediate send", async () => {
    const { instance, state, queue, runId } = await setupQueuedRun()
    const before = Date.now()
    const res = await postJson(instance, "/defer", { runId, backoffMs: 30_000 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const stored = state.store.get("state") as RunState
    expect(stored.state).toBe("queued")
    expect(stored.alarmKind).toBe("defer")
    expect(stored.alarmTargetRunId).toBe(runId)
    expect(stored.deferCount).toBe(1)
    // Watchdog ceiling re-armed (deadline pushed out so a deferred run is
    // never failed for waiting).
    expect(stored.watchdogDeadlineAt).toBeDefined()
    // Alarm armed ~30s out (not the watchdog, not immediate), no re-send yet.
    expect(state.alarms.alarmAt).not.toBeNull()
    const offset = state.alarms.alarmAt! - before
    expect(offset).toBeGreaterThanOrEqual(29_000)
    expect(offset).toBeLessThan(60_000)
    expect(queue.sent.length).toBe(0)
  })
})

describe("PrReviewRunDO defer alarm — non-queued state is a no-op", () => {
  // runDeferAlarm now guards on `state.state !== "queued"` — any non-queued state
  // (running/done/failed/idle) causes an immediate return with no queue send and no
  // state mutation. This covers the race where a defer alarm fires after the run was
  // already picked up (state=running).
  it("defer alarm fires on a running state → no OPENCLAW_JOBS.send, no state change", async () => {
    const { instance, state, queue, runId } = await setupQueuedRun()
    // Schedule a defer alarm (sets alarmKind=defer on the stored state).
    await postJson(instance, "/defer", { runId, backoffMs: 30_000 })
    // Race: run is picked up before the alarm fires → transition to running.
    // Keep alarmKind=defer to route the alarm() call to runDeferAlarm.
    const cur = state.store.get("state") as RunState
    const runningState: RunState = { ...cur, state: "running", consumerId: "consumer-A", alarmKind: "defer" }
    state.store.set("state", runningState)

    await instance.alarm()

    expect(queue.sent.length).toBe(0) // no OPENCLAW_JOBS.send
    const after = state.store.get("state") as RunState
    expect(after.state).toBe("running") // no state mutation
  })
})

describe("PrReviewRunDO defer alarm fire", () => {
  it("re-sends ONE pr-review message with deferCount incremented + attempt UNCHANGED, then re-arms watchdog", async () => {
    const { instance, state, queue, runId } = await setupQueuedRun()
    const attemptsBefore = (state.store.get("state") as RunState).attempts
    await postJson(instance, "/defer", { runId, backoffMs: 30_000 })

    const before = Date.now()
    await instance.alarm()

    expect(queue.sent.length).toBe(1)
    const msg = queue.sent[0]!.message as {
      type: string
      runId: string
      attempt: number
      deferCount: number
    }
    expect(msg.type).toBe("pr-review")
    expect(msg.runId).toBe(runId)
    // A defer is NOT a retry — attempts is forwarded unchanged.
    expect(msg.attempt).toBe(attemptsBefore)
    expect(msg.deferCount).toBe(1)

    // Watchdog re-armed for the deferred-then-resent run.
    const stored = state.store.get("state") as RunState
    expect(stored.alarmKind).toBe("watchdog")
    expect(stored.alarmTargetRunId).toBe(runId)
    const offset = state.alarms.alarmAt! - before
    expect(offset).toBeGreaterThan(WATCHDOG_MS - 5_000)
    expect(offset).toBeLessThanOrEqual(WATCHDOG_MS + 5_000)
  })

  it("forwards deferCount >= MAX_DEFERS so the consumer can bypass admission (anti-starvation)", async () => {
    const { instance, state, queue, runId } = await setupQueuedRun()
    // Simulate a run that has already been deferred up to the cap.
    const cur = state.store.get("state") as RunState
    state.store.set("state", { ...cur, deferCount: MAX_DEFERS, alarmKind: "defer", alarmTargetRunId: runId })

    await instance.alarm()
    expect(queue.sent.length).toBe(1)
    const msg = queue.sent[0]!.message as { deferCount: number }
    expect(msg.deferCount).toBeGreaterThanOrEqual(MAX_DEFERS)
  })
})

describe("PrReviewRunDO /defer — request body validation (Fix A)", () => {
  it("400 on non-JSON body", async () => {
    const { instance } = await setupQueuedRun()
    const res = await instance.fetch(
      new Request("https://do.internal/defer", {
        method: "POST",
        body: "not-json{{",
        headers: { "content-type": "application/json" },
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect((body as { error: string }).error).toBe("invalid_json")
  })

  it("400 when backoffMs is missing", async () => {
    const { instance, runId } = await setupQueuedRun()
    const res = await instance.fetch(
      new Request("https://do.internal/defer", {
        method: "POST",
        body: JSON.stringify({ runId }),
        headers: { "content-type": "application/json" },
      }),
    )
    expect(res.status).toBe(400)
  })

  it("400 when backoffMs is NaN (string that doesn't coerce)", async () => {
    const { instance, runId } = await setupQueuedRun()
    const res = await instance.fetch(
      new Request("https://do.internal/defer", {
        method: "POST",
        body: JSON.stringify({ runId, backoffMs: "not-a-number" }),
        headers: { "content-type": "application/json" },
      }),
    )
    expect(res.status).toBe(400)
  })

  it("400 when runId is missing", async () => {
    const { instance } = await setupQueuedRun()
    const res = await instance.fetch(
      new Request("https://do.internal/defer", {
        method: "POST",
        body: JSON.stringify({ backoffMs: 30_000 }),
        headers: { "content-type": "application/json" },
      }),
    )
    expect(res.status).toBe(400)
  })

  it("400 when runId is an empty string", async () => {
    const { instance } = await setupQueuedRun()
    const res = await instance.fetch(
      new Request("https://do.internal/defer", {
        method: "POST",
        body: JSON.stringify({ runId: "", backoffMs: 30_000 }),
        headers: { "content-type": "application/json" },
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe("PrReviewRunDO defer alarm — watchdogDeadlineAt refreshed on re-arm (Fix B)", () => {
  it("re-armed state has watchdogDeadlineAt ~now+watchdogMs, not the stale /defer value", async () => {
    const { instance, state, runId } = await setupQueuedRun()

    // Capture the watchdogDeadlineAt written by /defer (stale value after alarm fires).
    await postJson(instance, "/defer", { runId, backoffMs: 30_000 })
    const staleDeadline = (state.store.get("state") as RunState).watchdogDeadlineAt

    // Simulate time passing so the defer alarm fires well after /defer was called.
    const before = Date.now()
    await instance.alarm()

    const stored = state.store.get("state") as RunState
    // The deadline must have been refreshed — it should be AFTER the stale value.
    expect(stored.watchdogDeadlineAt).toBeDefined()
    expect(new Date(stored.watchdogDeadlineAt!).getTime()).toBeGreaterThan(new Date(staleDeadline!).getTime() - 1)
    // And ~now+watchdogMs (within a 10s window for test execution jitter).
    const deadlineMs = new Date(stored.watchdogDeadlineAt!).getTime()
    expect(deadlineMs).toBeGreaterThan(before + WATCHDOG_MS - 5_000)
    expect(deadlineMs).toBeLessThan(before + WATCHDOG_MS + 5_000)
  })
})

describe("PrReviewRunDO /defer — non-queued run is a 200 no-op", () => {
  it("running state is preserved (a duplicate deny after /pickup must NOT regress to queued)", async () => {
    const { instance, state, queue, runId } = await setupQueuedRun()
    // Move the run to running (post-/pickup).
    const cur = state.store.get("state") as RunState
    const runningState: RunState = { ...cur, state: "running", consumerId: "consumer-A", alarmKind: "liveness" }
    state.store.set("state", runningState)
    const alarmBefore = state.alarms.alarmAt

    const res = await postJson(instance, "/defer", { runId, backoffMs: 30_000 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, noop: true })
    const after = state.store.get("state") as RunState
    expect(after.state).toBe("running") // NOT regressed to queued
    expect(after.alarmKind).toBe("liveness")
    expect(after.deferCount).toBeUndefined()
    expect(state.alarms.alarmAt).toBe(alarmBefore)
    expect(queue.sent.length).toBe(0)
  })

  it("done / failed states are no-ops (no send, no mutation)", async () => {
    for (const terminal of ["done", "failed"] as const) {
      const { instance, state, queue, runId } = await setupQueuedRun()
      const cur = state.store.get("state") as RunState
      state.store.set("state", { ...cur, state: terminal })
      const res = await postJson(instance, "/defer", { runId, backoffMs: 30_000 })
      expect(res.status).toBe(200)
      expect((state.store.get("state") as RunState).state).toBe(terminal)
      expect(queue.sent.length).toBe(0)
    }
  })

  it("runId mismatch is a no-op (stale duplicate for a superseded run)", async () => {
    const { instance, state, queue } = await setupQueuedRun()
    const res = await postJson(instance, "/defer", { runId: "wrong-runId", backoffMs: 30_000 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, noop: true })
    expect((state.store.get("state") as RunState).state).toBe("queued")
    expect((state.store.get("state") as RunState).alarmKind).toBe("watchdog")
    expect(queue.sent.length).toBe(0)
  })
})
