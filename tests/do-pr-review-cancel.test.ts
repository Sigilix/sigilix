// SIG-329 — operator cancel route (`POST /cancel` on PrReviewRunDO).
//
// `/sigilix cancel` aborts a stuck in-flight review without waiting on
// the watchdog: the DO finalizes an active run (queued | running |
// failed-transient) as terminal `failed` with a `cancelled` stage
// marker, cancels the pending alarm, archives a history record, and
// closes the upstream check (`skipped` → wire `neutral`). Cancel of an
// absent / already-terminal run is a clean 200 no-op.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { RunState } from "../src/do/types"
import type { Env } from "../src/index"

// ─── Mock the GitHub check-run primitives BEFORE importing the DO ──

const startSpy = vi.fn()
const attachSpy = vi.fn()
const completeSpy = vi.fn()

vi.mock("../src/lib/pr-review-check-run", () => ({
  startInProgressCheckRun: (...args: unknown[]) => startSpy(...args),
  attachExistingCheckRun: (...args: unknown[]) => attachSpy(...args),
  completeCheckRun: (...args: unknown[]) => completeSpy(...args),
  CHECK_RUN_NAME: "Sigilix",
}))

import { PrReviewRunDO } from "../src/do/pr-review-run"

// ─── DO storage stub ─────────────────────────────────────────

interface FakeAlarmState { alarmAt: number | null }

function makeDoState(): {
  ctx: DurableObjectState
  store: Map<string, unknown>
  alarms: FakeAlarmState
} {
  const store = new Map<string, unknown>()
  const alarms: FakeAlarmState = { alarmAt: 999 } // pretend an alarm is armed
  const ctx = {
    storage: {
      async get<T>(k: string): Promise<T | undefined> { return store.get(k) as T | undefined },
      async put<T>(k: string, v: T): Promise<void> { store.set(k, v) },
      async delete(k: string): Promise<boolean> { return store.delete(k) },
      async setAlarm(t: number): Promise<void> { alarms.alarmAt = t },
      async getAlarm(): Promise<number | null> { return alarms.alarmAt },
      async deleteAlarm(): Promise<void> { alarms.alarmAt = null },
      list: async (opts?: { prefix?: string }): Promise<Map<string, unknown>> => {
        const prefix = opts?.prefix ?? ""
        const m = new Map<string, unknown>()
        for (const [k, v] of store) if (k.startsWith(prefix)) m.set(k, v)
        return m
      },
    },
    id: { toString: () => "Arc-and-Anchor/sigilix#7", name: "Arc-and-Anchor/sigilix#7" },
  } as unknown as DurableObjectState
  return { ctx, store, alarms }
}

function makeEnv(): Env {
  return {
    OPENCLAW_JOBS: { send: async () => undefined },
    OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: "3",
    OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "600000",
    OPENCLAW_PR_REVIEW_DO_LIVENESS_MS: "90000",
    OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "10",
  } as unknown as Env
}

const HEAD_SHA = "a".repeat(40)
const BASE_SHA = "b".repeat(40)
const RUN_ID = "11111111-1111-4111-8111-111111111111"
const CHECK_RUN_ID = 8675309

function seedState(store: Map<string, unknown>, over: Partial<RunState> = {}): RunState {
  const s: RunState = {
    schemaVersion: 1,
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    prNumber: 7,
    runId: RUN_ID,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    installationId: 99,
    state: "running",
    attempts: 1,
    startedAt: "2026-05-07T06:00:00.000Z",
    lastActivityAt: "2026-05-07T06:00:00.000Z",
    alarmTargetRunId: RUN_ID,
    alarmKind: "liveness",
    consumerId: "consumer-abc",
    ...over,
  }
  store.set("state", s)
  return s
}

async function cancel(instance: PrReviewRunDO): Promise<Response> {
  return instance.fetch(new Request("https://do.internal/cancel", { method: "POST" }))
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  startSpy.mockReset()
  attachSpy.mockReset()
  completeSpy.mockReset()
  attachSpy.mockResolvedValue({ id: CHECK_RUN_ID })
  completeSpy.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("PrReviewRunDO /cancel — terminates an active run", () => {
  for (const priorState of ["queued", "running", "failed-transient"] as const) {
    it(`cancels a ${priorState} run → failed + alarm cleared + history record + cancelled marker`, async () => {
      const env = makeEnv()
      const { ctx, store, alarms } = makeDoState()
      seedState(store, { state: priorState })
      const instance = new PrReviewRunDO(ctx, env)

      const res = await cancel(instance)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ cancelled: true, runId: RUN_ID })

      const after = store.get("state") as RunState
      expect(after.state).toBe("failed")
      expect(after.finishedAt).toBeDefined()
      expect(after.lastError?.stage).toBe("cancelled")
      expect(after.alarmKind).toBeUndefined()
      expect(after.alarmTargetRunId).toBeUndefined()
      expect(alarms.alarmAt).toBeNull() // deleteAlarm() called
      expect(store.has(`run:${RUN_ID}`)).toBe(true)
    })
  }

  it("closes the upstream check as `skipped` when checkRunId is set", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, { state: "running", checkRunId: CHECK_RUN_ID })
    const instance = new PrReviewRunDO(ctx, env)

    await cancel(instance)

    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(attachSpy.mock.calls[0]![0]).toMatchObject({
      owner: "Arc-and-Anchor", repo: "sigilix", installationId: 99, checkRunId: CHECK_RUN_ID,
    })
    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy.mock.calls[0]![0]).toMatchObject({ conclusion: "skipped" })
  })

  it("does not touch the check when checkRunId is unset", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, { state: "running" })
    const instance = new PrReviewRunDO(ctx, env)

    await cancel(instance)
    expect(attachSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
  })
})

describe("PrReviewRunDO /cancel — no-op cases", () => {
  it("no state → 200 cancelled:false reason no-state", async () => {
    const env = makeEnv()
    const { ctx } = makeDoState()
    const instance = new PrReviewRunDO(ctx, env)

    const res = await cancel(instance)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cancelled: false, reason: "no-state" })
  })

  for (const terminal of ["done", "failed"] as const) {
    it(`already-${terminal} → 200 no-op, state unchanged, check not re-closed`, async () => {
      const env = makeEnv()
      const { ctx, store } = makeDoState()
      seedState(store, { state: terminal, checkRunId: CHECK_RUN_ID, finishedAt: "2026-05-07T07:00:00.000Z" })
      const instance = new PrReviewRunDO(ctx, env)

      const res = await cancel(instance)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ cancelled: false, reason: "already-terminal" })
      const after = store.get("state") as RunState
      expect(after.state).toBe(terminal)
      expect(completeSpy).not.toHaveBeenCalled()
    })
  }
})
