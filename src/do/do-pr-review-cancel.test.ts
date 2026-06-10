// SIG-329 — operator cancel route (`POST /cancel` on PrReviewRunDO).
//
// `/sigilix cancel` aborts a stuck in-flight review without waiting on
// the watchdog: the DO finalizes an active run (queued | running |
// failed-transient) as terminal `failed` with a `cancelled` stage
// marker, cancels the pending alarm, archives a history record, and
// closes the upstream check (`skipped` → wire `neutral`). Cancel of an
// absent / already-terminal run is a clean 200 no-op.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { RunState } from "@/do/types"
import type { Env } from "@/shared/types/env"

// ─── Mock the GitHub check-run primitives BEFORE importing the DO ──

const startSpy = vi.fn()
const attachSpy = vi.fn()
const completeSpy = vi.fn()
const closeOrphanSpy = vi.fn()

vi.mock("@/lib/pr-review-check-run", () => ({
  startInProgressCheckRun: (...args: unknown[]) => startSpy(...args),
  attachExistingCheckRun: (...args: unknown[]) => attachSpy(...args),
  completeCheckRun: (...args: unknown[]) => completeSpy(...args),
  closeOrphanedInProgressChecksByHeadSha: (...args: unknown[]) => closeOrphanSpy(...args),
  CHECK_RUN_NAME: "Sigilix",
}))

import { PrReviewRunDO } from "@/do/pr-review-run"

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
  closeOrphanSpy.mockReset()
  attachSpy.mockResolvedValue({ id: CHECK_RUN_ID })
  completeSpy.mockResolvedValue(undefined)
  closeOrphanSpy.mockResolvedValue(undefined)
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

  it("closes the upstream check as `skipped` when checkRunId is set (attach-by-id fast path; no head-sha fallback)", async () => {
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
    // Fast path only — the head-sha orphan fallback must stay dormant.
    expect(closeOrphanSpy).not.toHaveBeenCalled()
  })

  // SIG-stuck-check (PR #402): when the DO never received a checkRunId
  // (handleEnqueue's synchronous create lost the 3s race and the consumer
  // created the check via startInProgressCheckRun instead), the attach-by-id
  // close is impossible. The cancel path MUST fall back to closing any
  // orphaned in-progress Sigilix check by head_sha — otherwise the check
  // hangs `in_progress` forever, which is the bug observed in prod.
  it("falls back to closing the orphaned check by head_sha when checkRunId is unset", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, { state: "running" })
    const instance = new PrReviewRunDO(ctx, env)

    await cancel(instance)

    // Attach-by-id is impossible without an id; the head-sha fallback runs.
    expect(attachSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
    expect(closeOrphanSpy).toHaveBeenCalledTimes(1)
    expect(closeOrphanSpy.mock.calls[0]![0]).toMatchObject({
      env,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      headSha: HEAD_SHA,
    })
  })

  it("swallows a head-sha fallback failure — a GitHub hiccup never breaks the cancel state machine", async () => {
    closeOrphanSpy.mockRejectedValueOnce(new Error("HTTP 503 GitHub down"))
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, { state: "running" })
    const instance = new PrReviewRunDO(ctx, env)

    // Still resolves 200 cancelled, and the state machine still finalized.
    const res = await cancel(instance)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cancelled: true, runId: RUN_ID })
    const after = store.get("state") as RunState
    expect(after.state).toBe("failed")
  })

  it("prunes history to historyLimit WITHOUT nuking valid records (refutes Sigilix PR #370 #1)", async () => {
    // Sigilix flagged that handleCancel might delete ALL history because
    // `pruneHistoryRecords` could key its result by raw runId while
    // `collectHistory` keys by `run:<id>`. It does NOT — pruneHistoryRecords
    // preserves the input (prefixed) keys, so only the genuine overflow is
    // evicted. This locks that in: 2 pre-seeded records + the cancelled
    // record, limit 2 → only the OLDEST is evicted.
    const env = { ...makeEnv(), OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "2" } as unknown as Env
    const { ctx, store } = makeDoState()
    seedState(store, { state: "running" })
    store.set("run:OLD-1", {
      runId: "OLD-1", headSha: "x".repeat(40), finalState: "done",
      attempts: 1, startedAt: "2026-05-01T00:00:00.000Z",
      finishedAt: "2026-05-01T01:00:00.000Z",
    })
    store.set("run:OLD-2", {
      runId: "OLD-2", headSha: "y".repeat(40), finalState: "failed",
      attempts: 2, startedAt: "2026-05-02T00:00:00.000Z",
      finishedAt: "2026-05-02T01:00:00.000Z",
    })
    const instance = new PrReviewRunDO(ctx, env)

    await cancel(instance)

    // Oldest evicted; newer record AND the freshly-cancelled record survive.
    expect(store.has("run:OLD-1")).toBe(false)
    expect(store.has("run:OLD-2")).toBe(true)
    expect(store.has(`run:${RUN_ID}`)).toBe(true)
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
