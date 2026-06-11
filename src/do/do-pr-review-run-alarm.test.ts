// ARC-190 Task 6 — alarm() handler tests.
//
// Spec §4.6 + §4.6a:
//   - alarm() reads alarmTargetRunId / alarmKind from storage (DO
//     setAlarm carries no payload)
//   - kind="retry": re-enqueue same runId, attempts++ (single
//     increment point), reschedule watchdog
//   - kind="watchdog": if state still queued/running and consumer
//     never posted /run-result → treat as transient. Schedule retry
//     if attempts<max, else state=failed (terminal-watchdog).
//   - stale runId (state.runId !== alarmTargetRunId) → no-op + telemetry

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PrReviewRunDO } from "@/src/do/pr-review-run"
import type { Env } from "@/src/shared/types/env"
import type { RunState } from "@/src/do/types"

interface FakeAlarmState {
  alarmAt: number | null
}

function makeDoState(): {
  ctx: DurableObjectState
  store: Map<string, unknown>
  alarms: FakeAlarmState
} {
  const store = new Map<string, unknown>()
  const alarms: FakeAlarmState = { alarmAt: null }
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
    id: { toString: () => "Sigilix/sigilix#7", name: "Sigilix/sigilix#7" },
    store,
    alarms,
  } as unknown as DurableObjectState
  return {
    ctx,
    store: (ctx as unknown as { store: Map<string, unknown> }).store,
    alarms: (ctx as unknown as { alarms: FakeAlarmState }).alarms,
  }
}

interface QueueState {
  sent: unknown[]
}

function makeEnv(queue: QueueState, retries: number = 3): Env {
  return {
    OPENCLAW_JOBS: {
      send: async (m: unknown) => {
        queue.sent.push(m)
      },
    },
    OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: String(retries),
    OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "1200000",
    OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "10",
  } as unknown as Env
}

const SAMPLE_HEAD_SHA = "a".repeat(40)
const SAMPLE_BASE_SHA = "b".repeat(40)
const SAMPLE_RUN_ID = "11111111-1111-4111-8111-111111111111"

function seedState(store: Map<string, unknown>, over: Partial<RunState> = {}): RunState {
  const s: RunState = {
    schemaVersion: 1,
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    runId: SAMPLE_RUN_ID,
    headSha: SAMPLE_HEAD_SHA,
    baseSha: SAMPLE_BASE_SHA,
    installationId: 99,
    state: "failed-transient",
    attempts: 1,
    startedAt: "2026-05-07T06:00:00.000Z",
    lastActivityAt: "2026-05-07T06:00:00.000Z",
    alarmTargetRunId: SAMPLE_RUN_ID,
    alarmKind: "retry",
    ...over,
  }
  store.set("state", s)
  return s
}

let consoleSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  consoleSpy.mockRestore()
})

// ─── retry alarm ─────────────────────────────────────────────

describe("PrReviewRunDO.alarm — retry alarm fires", () => {
  it("re-enqueues same runId + increments attempts (single-increment-point)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, { state: "failed-transient", attempts: 1, alarmKind: "retry" })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("queued")
    expect(after.attempts).toBe(2) // was 1, alarm fired → 2
    expect(queue.sent.length).toBe(1)
    const msg = queue.sent[0] as { type: string; runId: string }
    expect(msg.type).toBe("pr-review")
    expect(msg.runId).toBe(SAMPLE_RUN_ID)
  })

  it("retry alarm schedules a fresh watchdog after re-enqueue", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store, alarms } = makeDoState()
    seedState(store, { state: "failed-transient", attempts: 1, alarmKind: "retry" })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.alarmKind).toBe("watchdog")
    expect(after.alarmTargetRunId).toBe(SAMPLE_RUN_ID)
    expect(alarms.alarmAt).not.toBeNull()
  })

  it("retry alarm with stale runId is a no-op (state.runId !== alarmTargetRunId)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, {
      runId: "NEW-runId",
      alarmTargetRunId: "OLD-runId",
      state: "queued",
      alarmKind: "retry",
      attempts: 1,
    })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.runId).toBe("NEW-runId")
    expect(after.attempts).toBe(1) // NOT incremented
    expect(queue.sent.length).toBe(0) // NOT re-enqueued
  })

  it("ARC-251 Codex BLOCKER #2 — retry alarm preserves staleHeadRequeueDepth from RunState", async () => {
    // Without this guarantee, the retry-alarm rebuilds the pr-review
    // message from RunState (not from the original queue message) and
    // silently resets depth to 0 — bypassing MAX_STALE_HEAD_REQUEUES.
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "failed-transient",
      attempts: 1,
      alarmKind: "retry",
      staleHeadRequeueDepth: 2,
    })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.staleHeadRequeueDepth).toBe(2)
    expect(queue.sent.length).toBe(1)
    const msg = queue.sent[0] as { staleHeadRequeueDepth?: number }
    expect(msg.staleHeadRequeueDepth).toBe(2)
  })
})

// ─── watchdog alarm ──────────────────────────────────────────

describe("PrReviewRunDO.alarm — watchdog alarm fires", () => {
  it("state still queued + attempts<max → schedule retry alarm (transient)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue, 3)
    const { ctx, store, alarms } = makeDoState()
    seedState(store, { state: "queued", attempts: 1, alarmKind: "watchdog" })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed-transient")
    expect(after.attempts).toBe(1) // NOT incremented at watchdog fire
    // (single-increment is at retry-alarm fire)
    expect(after.alarmKind).toBe("retry")
    expect(alarms.alarmAt).not.toBeNull()
    expect(after.lastError?.stage).toBe("watchdog")
  })

  it("state running + attempts<max → schedule retry alarm", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue, 3)
    const { ctx, store } = makeDoState()
    seedState(store, { state: "running", attempts: 2, alarmKind: "watchdog" })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed-transient")
    expect(after.alarmKind).toBe("retry")
  })

  it("state queued + attempts=max → terminal failed", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue, 3)
    const { ctx, store } = makeDoState()
    seedState(store, { state: "queued", attempts: 3, alarmKind: "watchdog" })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed")
    expect(after.lastError?.stage).toBe("watchdog")
  })

  it("state already done → no-op", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, { state: "done", attempts: 1, alarmKind: "watchdog" })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("done") // unchanged
    expect(queue.sent.length).toBe(0)
  })

  it("state already failed → no-op", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, { state: "failed", attempts: 3, alarmKind: "watchdog" })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed")
  })

  it("watchdog with stale runId → no-op", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, {
      runId: "NEW-runId",
      alarmTargetRunId: "OLD-runId",
      state: "running",
      alarmKind: "watchdog",
    })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.runId).toBe("NEW-runId")
    expect(after.state).toBe("running") // unchanged
  })
})

// ─── degenerate / no-state cases ─────────────────────────────

describe("PrReviewRunDO.alarm — defensive cases", () => {
  it("no state → no-op", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx } = makeDoState()
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()
    expect(queue.sent.length).toBe(0)
  })

  it("alarmKind missing → no-op", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, {})
    const s = store.get("state") as RunState
    delete s.alarmKind
    store.set("state", s)
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()
    expect(queue.sent.length).toBe(0)
  })
})

// ─── terminal-state guard (Codex P1 regression) ─────────────

describe("PrReviewRunDO.alarm — terminal-state guard", () => {
  it("retry alarm no-ops when state is already done (consumer posted /run-result success before retry fired)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "done",
      attempts: 1,
      alarmKind: "retry", // stale alarm — /run-result didn't clear
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("done") // NOT resurrected
    expect(after.attempts).toBe(1) // NOT incremented
    expect(queue.sent.length).toBe(0) // NOT re-enqueued
  })

  it("retry alarm no-ops when state is already failed (terminal)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "failed",
      attempts: 3,
      alarmKind: "retry",
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed")
    expect(queue.sent.length).toBe(0)
  })
})

// ─── watchdog-terminal history pruning (Codex P2) ────────────

describe("PrReviewRunDO.alarm — watchdog terminal prunes history", () => {
  it("watchdog-terminal writes history record AND prunes to historyLimit", async () => {
    const queue: QueueState = { sent: [] }
    const env = {
      ...makeEnv(queue, 3),
      OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "2", // tight cap
    } as unknown as Env
    const { ctx, store } = makeDoState()
    seedState(store, { state: "queued", attempts: 3, alarmKind: "watchdog" })
    // Pre-seed two existing history records (older finishedAt).
    store.set("run:OLD-1", {
      runId: "OLD-1",
      headSha: "x".repeat(40),
      finalState: "done",
      attempts: 1,
      startedAt: "2026-05-01T00:00:00.000Z",
      finishedAt: "2026-05-01T01:00:00.000Z",
    })
    store.set("run:OLD-2", {
      runId: "OLD-2",
      headSha: "y".repeat(40),
      finalState: "failed",
      attempts: 3,
      startedAt: "2026-05-02T00:00:00.000Z",
      finishedAt: "2026-05-02T01:00:00.000Z",
    })

    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    // The new watchdog-terminal record should be present; oldest
    // (OLD-1) should have been evicted to honor limit=2.
    expect(store.has("run:OLD-1")).toBe(false)
    expect(store.has("run:OLD-2")).toBe(true)
    expect(store.has(`run:${SAMPLE_RUN_ID}`)).toBe(true)
  })
})

// ─── retry clears pickedUpAt (Codex P3) ──────────────────────

describe("PrReviewRunDO.alarm — retry clears pickedUpAt", () => {
  it("retry alarm clears pickedUpAt so the new attempt records its own pickup time", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "failed-transient",
      attempts: 1,
      alarmKind: "retry",
      pickedUpAt: "2026-05-07T05:00:00.000Z", // stale from prev attempt
      consumerId: "old-consumer",
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("queued")
    expect(after.pickedUpAt).toBeUndefined()
    expect(after.consumerId).toBeUndefined()
  })
})

// ─── single-increment-point invariant ────────────────────────

describe("PrReviewRunDO.alarm — single-increment-point", () => {
  it("scheduling a retry does NOT increment attempts (only firing does)", async () => {
    // Setup: failed-transient with attempts=1 and retry alarm scheduled
    // (which is what /run-result transient does).
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue, 3)
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "failed-transient",
      attempts: 1,
      alarmKind: "retry",
    })
    // Pre-fire snapshot
    expect((store.get("state") as RunState).attempts).toBe(1)

    // Fire retry alarm → attempts → 2
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()
    expect((store.get("state") as RunState).attempts).toBe(2)
  })
})
