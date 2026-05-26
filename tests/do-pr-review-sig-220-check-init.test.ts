// SIG-220 — synchronous "Sigilix · In progress" check creation inside
// `PrReviewRunDO.handleEnqueue`. Pre-SIG-220 the check was created at
// dispatcher time, after the queue consumer dequeued, leading to 5–30s
// of perceived latency before the customer saw any signal in the GitHub
// UI. Post-SIG-220 the check is created upstream so it appears within
// ~1–2s of webhook receipt.
//
// These tests exercise the new behaviors without needing real GitHub
// credentials by mocking `pr-review-check-run` at the module boundary
// (`startInProgressCheckRun` returns a stub handle; `completeCheckRun`
// records the call). The DO instance threads `checkRunId` through
// RunState + the queue message + the retry-alarm path, and the
// watchdog terminal-failure path closes the check via
// `attachExistingCheckRun + completeCheckRun`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { EnqueueRequest, RunState } from "../src/do/types"
import type { Env } from "../src/index"

// ─── Mock the GitHub check-run primitives BEFORE importing the DO ──

const startSpy = vi.fn()
const attachSpy = vi.fn()
const completeSpy = vi.fn()

vi.mock("../src/lib/pr-review-check-run", () => ({
  startInProgressCheckRun: (...args: unknown[]) => startSpy(...args),
  attachExistingCheckRun: (...args: unknown[]) => attachSpy(...args),
  completeCheckRun: (...args: unknown[]) => completeSpy(...args),
  // CHECK_RUN_NAME is exported for KNOWN_CHECK_NAMES tests; not used here.
  CHECK_RUN_NAME: "Sigilix",
}))

// Imported AFTER vi.mock so the DO picks up the mocked module.
import { PrReviewRunDO } from "../src/do/pr-review-run"

// ─── DO storage stub (shared with the route + alarm test files) ────

interface FakeAlarmState { alarmAt: number | null }

function makeDoState(): {
  ctx: DurableObjectState
  store: Map<string, unknown>
  alarms: FakeAlarmState
  triggerAlarm: () => Promise<void>
} {
  const store = new Map<string, unknown>()
  const alarms: FakeAlarmState = { alarmAt: null }
  let alarmHandler: (() => Promise<void>) | null = null
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
        for (const [k, v] of store) {
          if (k.startsWith(prefix)) m.set(k, v)
        }
        return m
      },
    },
    id: { toString: () => "Arc-and-Anchor/sigilix#7", name: "Arc-and-Anchor/sigilix#7" },
  } as unknown as DurableObjectState
  ;(ctx as unknown as { _setAlarmHandler: (h: () => Promise<void>) => void })._setAlarmHandler = (h) => {
    alarmHandler = h
  }
  return {
    ctx,
    store,
    alarms,
    triggerAlarm: async () => {
      if (alarmHandler) await alarmHandler()
    },
  }
}

interface QueueState { sent: unknown[] }

function makeEnv(queue: QueueState, retries: number = 3): Env {
  return {
    OPENCLAW_JOBS: { send: async (m: unknown) => { queue.sent.push(m) } },
    OPENCLAW_PR_REVIEW_DO_MAX_RETRIES: String(retries),
    OPENCLAW_PR_REVIEW_DO_WATCHDOG_MS: "1200000",
    OPENCLAW_PR_REVIEW_DO_HISTORY_LIMIT: "10",
    GITHUB_APP_ID: "stub-app",
    GITHUB_PRIVATE_KEY: "stub-key",
    OPENCLAW_STATE: {} as unknown,
  } as unknown as Env
}

const SAMPLE_HEAD_SHA = "a".repeat(40)
const SAMPLE_BASE_SHA = "b".repeat(40)
const SAMPLE_CHECK_RUN_ID = 8675309
const SAMPLE_RUN_ID = "11111111-1111-4111-8111-111111111111"

function makeEnqueueReq(over: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    owner: "Arc-and-Anchor",
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
  return instance.fetch(new Request(`https://do.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }))
}

let consoleSpy: ReturnType<typeof vi.spyOn>
let consoleErrSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  startSpy.mockReset()
  attachSpy.mockReset()
  completeSpy.mockReset()
  // Default: createCheckRun succeeds, returns a stub handle.
  startSpy.mockResolvedValue({
    id: SAMPLE_CHECK_RUN_ID,
    client: {} as unknown,
    owner: "Arc-and-Anchor",
    repo: "sigilix",
  })
  attachSpy.mockImplementation(async (args: { checkRunId: number }) => ({
    id: args.checkRunId,
    client: {} as unknown,
    owner: "Arc-and-Anchor",
    repo: "sigilix",
  }))
  completeSpy.mockResolvedValue(undefined)
})
afterEach(() => {
  consoleSpy.mockRestore()
  consoleErrSpy.mockRestore()
  consoleWarnSpy.mockRestore()
})

// ─── /enqueue ─────────────────────────────────────────────────

describe("SIG-220 — PrReviewRunDO.handleEnqueue creates the check upstream", () => {
  it("create action: calls startInProgressCheckRun + persists checkRunId on RunState + forwards on queue message", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    const res = await postJson(instance, "/enqueue", makeEnqueueReq())
    expect(res.status).toBe(200)
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy.mock.calls[0]![0]).toMatchObject({
      env,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      headSha: SAMPLE_HEAD_SHA,
      installationId: 99,
    })

    const stored = ds.store.get("state") as RunState
    expect(stored.checkRunId).toBe(SAMPLE_CHECK_RUN_ID)

    expect(queue.sent.length).toBe(1)
    const msg = queue.sent[0] as { type: string; checkRunId?: number }
    expect(msg.type).toBe("pr-review")
    expect(msg.checkRunId).toBe(SAMPLE_CHECK_RUN_ID)
  })

  it("create action with check-create failure (null handle): RunState + queue message both omit checkRunId (legacy dispatcher fallback applies)", async () => {
    startSpy.mockResolvedValueOnce(null)
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    const res = await postJson(instance, "/enqueue", makeEnqueueReq())
    expect(res.status).toBe(200)

    const stored = ds.store.get("state") as RunState
    expect("checkRunId" in stored).toBe(false)

    const msg = queue.sent[0] as Record<string, unknown>
    expect("checkRunId" in msg).toBe(false)
  })

  it("dedupe-active path does NOT call startInProgressCheckRun (no orphan check on webhook replay)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    // First enqueue creates a run (and a check).
    await postJson(instance, "/enqueue", makeEnqueueReq())
    expect(startSpy).toHaveBeenCalledTimes(1)

    // Second enqueue at the same SHA deduplicates → must NOT create another check.
    startSpy.mockClear()
    queue.sent.length = 0
    const res = await postJson(instance, "/enqueue", makeEnqueueReq())
    expect(res.status).toBe(200)
    const body = await res.json() as { deduped: boolean; action: string }
    expect(body.deduped).toBe(true)
    expect(body.action).toBe("dedupe-active")
    expect(startSpy).not.toHaveBeenCalled()
    expect(queue.sent.length).toBe(0)
  })

  it("dedupe-terminal path does NOT call startInProgressCheckRun", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    await postJson(instance, "/enqueue", makeEnqueueReq())
    const s = ds.store.get("state") as RunState
    s.state = "done"
    ds.store.set("state", s)

    startSpy.mockClear()
    queue.sent.length = 0
    const res = await postJson(instance, "/enqueue", makeEnqueueReq())
    expect(res.status).toBe(200)
    const body = await res.json() as { action: string }
    expect(body.action).toBe("dedupe-terminal")
    expect(startSpy).not.toHaveBeenCalled()
  })

  it("supersede path creates a fresh check for the new head SHA", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    await postJson(instance, "/enqueue", makeEnqueueReq({ headSha: "OLD".padEnd(40, "0") }))
    expect(startSpy).toHaveBeenCalledTimes(1)

    // Different SHA → supersede + new check.
    startSpy.mockClear()
    startSpy.mockResolvedValueOnce({
      id: 99999,
      client: {} as unknown,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
    })
    const res = await postJson(instance, "/enqueue", makeEnqueueReq({ headSha: "NEW".padEnd(40, "0") }))
    expect(res.status).toBe(200)
    const body = await res.json() as { action: string }
    expect(body.action).toBe("supersede")

    expect(startSpy).toHaveBeenCalledTimes(1)
    const stored = ds.store.get("state") as RunState
    expect(stored.checkRunId).toBe(99999)
  })
})

// ─── retry alarm ──────────────────────────────────────────────

describe("SIG-220 — retry alarm forwards checkRunId from RunState", () => {
  it("re-enqueues with checkRunId so the retry consumer attaches to the same check", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    const seeded: RunState = {
      schemaVersion: 1,
      owner: "Arc-and-Anchor",
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
      checkRunId: SAMPLE_CHECK_RUN_ID,
    }
    ds.store.set("state", seeded)

    await instance.alarm()
    expect(queue.sent.length).toBe(1)
    const msg = queue.sent[0] as { runId: string; checkRunId?: number }
    expect(msg.runId).toBe(SAMPLE_RUN_ID)
    expect(msg.checkRunId).toBe(SAMPLE_CHECK_RUN_ID)
  })

  it("omits checkRunId on retry when RunState has none (legacy)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    const seeded: RunState = {
      schemaVersion: 1,
      owner: "Arc-and-Anchor",
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
    }
    ds.store.set("state", seeded)

    await instance.alarm()
    const msg = queue.sent[0] as Record<string, unknown>
    expect("checkRunId" in msg).toBe(false)
  })
})

// ─── watchdog terminal failure ────────────────────────────────

describe("SIG-220 — watchdog terminal failure closes the upstream check", () => {
  it("calls attachExistingCheckRun + completeCheckRun with failure conclusion when checkRunId is set", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue, 1)  // max attempts = 1 so first watchdog goes terminal
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    const seeded: RunState = {
      schemaVersion: 1,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      runId: SAMPLE_RUN_ID,
      headSha: SAMPLE_HEAD_SHA,
      baseSha: SAMPLE_BASE_SHA,
      installationId: 99,
      state: "queued",
      attempts: 1,
      startedAt: "2026-05-07T06:00:00.000Z",
      lastActivityAt: "2026-05-07T06:00:00.000Z",
      alarmTargetRunId: SAMPLE_RUN_ID,
      alarmKind: "watchdog",
      checkRunId: SAMPLE_CHECK_RUN_ID,
    }
    ds.store.set("state", seeded)

    await instance.alarm()
    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(attachSpy.mock.calls[0]![0]).toMatchObject({
      env,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      installationId: 99,
      checkRunId: SAMPLE_CHECK_RUN_ID,
    })
    expect(completeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy.mock.calls[0]![0]).toMatchObject({
      conclusion: "failure",
    })

    const updated = ds.store.get("state") as RunState
    expect(updated.state).toBe("failed")
  })

  it("does not call completeCheckRun when RunState has no checkRunId (nothing to close)", async () => {
    const queue: QueueState = { sent: [] }
    const env = makeEnv(queue, 1)
    const ds = makeDoState()
    const instance = new PrReviewRunDO(ds.ctx, env)

    const seeded: RunState = {
      schemaVersion: 1,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      runId: SAMPLE_RUN_ID,
      headSha: SAMPLE_HEAD_SHA,
      baseSha: SAMPLE_BASE_SHA,
      installationId: 99,
      state: "queued",
      attempts: 1,
      startedAt: "2026-05-07T06:00:00.000Z",
      lastActivityAt: "2026-05-07T06:00:00.000Z",
      alarmTargetRunId: SAMPLE_RUN_ID,
      alarmKind: "watchdog",
    }
    ds.store.set("state", seeded)

    await instance.alarm()
    expect(completeSpy).not.toHaveBeenCalled()
    expect(attachSpy).not.toHaveBeenCalled()
    const updated = ds.store.get("state") as RunState
    expect(updated.state).toBe("failed")
  })
})
