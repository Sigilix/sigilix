// SIG-329 — runner heartbeat + DO liveness tests.
//
// The liveness model decouples dead-consumer detection from the watchdog
// backstop: a running attempt re-arms a short `liveness` alarm on every
// /heartbeat, so an evicted isolate (e.g. a production redeploy on the
// bot's own repo) is detected within one `livenessMs` gap (~90s) instead
// of the full watchdog (~10 min). The single DO alarm slot still enforces
// the absolute max-review-duration cap via `watchdogDeadlineAt`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PrReviewRunDO } from "@/do/pr-review-run"
import { runPrReviewWithDoCallback } from "@/do/consumer-wrapper"
import type { Env } from "@/shared/types/env"
import type { JobMessage } from "@/shared/types/job"
import type { RunState } from "@/do/types"

// ─── DO-side harness ─────────────────────────────────────────

interface FakeAlarmState { alarmAt: number | null }

function makeDoState(): {
  ctx: DurableObjectState
  store: Map<string, unknown>
  alarms: FakeAlarmState
} {
  const store = new Map<string, unknown>()
  const alarms: FakeAlarmState = { alarmAt: null }
  const ctx = {
    storage: {
      async get<T>(k: string): Promise<T | undefined> { return store.get(k) as T | undefined },
      async put<T>(k: string, v: T): Promise<void> { store.set(k, v) },
      async delete(k: string): Promise<boolean> { return store.delete(k) },
      async setAlarm(t: number): Promise<void> { alarms.alarmAt = t },
      async getAlarm(): Promise<number | null> { return alarms.alarmAt },
      async deleteAlarm(): Promise<void> { alarms.alarmAt = null },
    },
    id: { toString: () => "Arc-and-Anchor/sigilix#7", name: "Arc-and-Anchor/sigilix#7" },
    store,
    alarms,
  } as unknown as DurableObjectState
  return {
    ctx,
    store: (ctx as unknown as { store: Map<string, unknown> }).store,
    alarms: (ctx as unknown as { alarms: FakeAlarmState }).alarms,
  }
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
const CONSUMER_ID = "consumer-abc"

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
    consumerId: CONSUMER_ID,
    ...over,
  }
  store.set("state", s)
  return s
}

function isoAgo(ms: number): string { return new Date(Date.now() - ms).toISOString() }
function isoIn(ms: number): string { return new Date(Date.now() + ms).toISOString() }

async function postJson(instance: PrReviewRunDO, path: string, body: unknown): Promise<Response> {
  return instance.fetch(new Request(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
}

let logSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
  vi.useRealTimers()
})

// ─── /heartbeat route ────────────────────────────────────────

describe("PrReviewRunDO /heartbeat", () => {
  it("valid heartbeat → 200, updates lastHeartbeatAt + re-arms liveness alarm", async () => {
    const env = makeEnv()
    const { ctx, store, alarms } = makeDoState()
    seedState(store, { lastHeartbeatAt: isoAgo(20_000) })
    const instance = new PrReviewRunDO(ctx, env)

    const res = await postJson(instance, "/heartbeat", { runId: RUN_ID, consumerId: CONSUMER_ID })

    expect(res.status).toBe(200)
    const after = store.get("state") as RunState
    expect(after.alarmKind).toBe("liveness")
    // lastHeartbeatAt advanced to ~now (was 20s ago).
    expect(Date.parse(after.lastHeartbeatAt!)).toBeGreaterThan(Date.now() - 5_000)
    // Alarm re-armed roughly livenessMs (90s) out.
    expect(alarms.alarmAt).not.toBeNull()
    expect(alarms.alarmAt!).toBeGreaterThan(Date.now() + 60_000)
  })

  it("caps the re-arm at the absolute watchdog deadline", async () => {
    const env = makeEnv()
    const { ctx, store, alarms } = makeDoState()
    // Deadline only 10s away — closer than the 90s liveness window.
    seedState(store, { watchdogDeadlineAt: isoIn(10_000) })
    const instance = new PrReviewRunDO(ctx, env)

    await postJson(instance, "/heartbeat", { runId: RUN_ID, consumerId: CONSUMER_ID })

    expect(alarms.alarmAt!).toBeLessThan(Date.now() + 30_000)
  })

  it("a corrupted watchdogDeadlineAt never sets a NaN alarm (Date.parse guard)", async () => {
    const env = makeEnv()
    const { ctx, store, alarms } = makeDoState()
    seedState(store, { watchdogDeadlineAt: "not-an-iso" })
    const instance = new PrReviewRunDO(ctx, env)

    const res = await postJson(instance, "/heartbeat", { runId: RUN_ID, consumerId: CONSUMER_ID })
    expect(res.status).toBe(200)
    expect(alarms.alarmAt).not.toBeNull()
    expect(Number.isFinite(alarms.alarmAt!)).toBe(true)
  })

  it("wrong consumerId → 410 (stop heartbeating)", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store)
    const instance = new PrReviewRunDO(ctx, env)

    const res = await postJson(instance, "/heartbeat", { runId: RUN_ID, consumerId: "someone-else" })
    expect(res.status).toBe(410)
  })

  it("runId mismatch → 410", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store)
    const instance = new PrReviewRunDO(ctx, env)

    const res = await postJson(instance, "/heartbeat", { runId: "other-run", consumerId: CONSUMER_ID })
    expect(res.status).toBe(410)
  })

  it("non-running state (queued) → 410", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, { state: "queued" })
    const instance = new PrReviewRunDO(ctx, env)

    const res = await postJson(instance, "/heartbeat", { runId: RUN_ID, consumerId: CONSUMER_ID })
    expect(res.status).toBe(410)
  })
})

// ─── /pickup arms the liveness model ─────────────────────────

describe("PrReviewRunDO /pickup — SIG-329 liveness arming", () => {
  it("claim arms a liveness alarm (not watchdog) + seeds lastHeartbeatAt + watchdogDeadlineAt", async () => {
    const env = makeEnv()
    const { ctx, store, alarms } = makeDoState()
    seedState(store, { state: "queued", alarmKind: "watchdog", consumerId: undefined })
    const instance = new PrReviewRunDO(ctx, env)

    const res = await postJson(instance, "/pickup", { runId: RUN_ID, consumerId: CONSUMER_ID })

    expect(res.status).toBe(200)
    const after = store.get("state") as RunState
    expect(after.state).toBe("running")
    expect(after.alarmKind).toBe("liveness")
    expect(after.lastHeartbeatAt).toBeDefined()
    expect(after.watchdogDeadlineAt).toBeDefined()
    // Deadline ~watchdogMs (600s) out; liveness alarm ~livenessMs (90s) out.
    expect(Date.parse(after.watchdogDeadlineAt!)).toBeGreaterThan(Date.now() + 300_000)
    expect(alarms.alarmAt!).toBeLessThan(Date.now() + 120_000)
  })
})

// ─── liveness alarm ──────────────────────────────────────────

describe("PrReviewRunDO.alarm — liveness gap detection (SIG-329)", () => {
  it("REVERT-SENSITIVE: stale heartbeat (gap > livenessMs) → dead consumer detected immediately → retry scheduled", async () => {
    // The SIG-329 win: a running attempt whose consumer went silent is
    // declared dead within one liveness gap, NOT after the watchdog. If
    // the liveness handler is reverted, alarm() would not route "liveness"
    // and this running state would never transition — this test fails.
    const env = makeEnv()
    const { ctx, store, alarms } = makeDoState()
    seedState(store, {
      state: "running",
      attempts: 1,
      lastHeartbeatAt: isoAgo(200_000), // 200s ago ≫ 90s liveness
      watchdogDeadlineAt: isoIn(300_000), // backstop NOT yet hit
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed-transient")
    expect(after.attempts).toBe(1) // single-increment-point: bumped only at retry-fire
    expect(after.alarmKind).toBe("retry")
    expect(after.lastError?.stage).toBe("liveness")
    expect(alarms.alarmAt).not.toBeNull()
  })

  it("fresh heartbeat + before deadline → re-arm only, stays running", async () => {
    const env = makeEnv()
    const { ctx, store, alarms } = makeDoState()
    seedState(store, {
      state: "running",
      lastHeartbeatAt: isoAgo(1_000), // 1s ago ≪ 90s
      watchdogDeadlineAt: isoIn(300_000),
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("running") // unchanged
    expect(after.alarmKind).toBe("liveness")
    expect(alarms.alarmAt).not.toBeNull()
  })

  it("past absolute deadline (even with fresh heartbeat) → fail/retry as watchdog backstop", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "running",
      attempts: 1,
      lastHeartbeatAt: isoAgo(1_000), // heartbeat is fresh...
      watchdogDeadlineAt: isoAgo(1_000), // ...but the absolute cap is blown
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed-transient")
    expect(after.lastError?.stage).toBe("watchdog")
  })

  it("stale heartbeat at attempts=max → terminal failed", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "running",
      attempts: 3, // == maxRetries
      lastHeartbeatAt: isoAgo(200_000),
      watchdogDeadlineAt: isoIn(300_000),
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed")
    expect(after.lastError?.stage).toBe("liveness")
    expect(store.has(`run:${RUN_ID}`)).toBe(true) // history record written
  })

  it("a corrupted lastHeartbeatAt is treated as dead (no NaN re-arm)", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, {
      state: "running",
      attempts: 1,
      lastHeartbeatAt: "not-an-iso",
      pickedUpAt: undefined,
      watchdogDeadlineAt: isoIn(300_000),
    })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("failed-transient") // dead → retry, not a NaN re-arm
    expect(after.lastError?.stage).toBe("liveness")
  })

  it("liveness alarm on terminal state (done) → no-op", async () => {
    const env = makeEnv()
    const { ctx, store } = makeDoState()
    seedState(store, { state: "done", alarmKind: "liveness", lastHeartbeatAt: isoAgo(200_000) })
    const instance = new PrReviewRunDO(ctx, env)
    await instance.alarm!()

    const after = store.get("state") as RunState
    expect(after.state).toBe("done")
  })
})

// ─── consumer heartbeat loop ─────────────────────────────────

type PrReviewJob = Extract<JobMessage, { type: "pr-review" }>

function makeConsumerEnv(opts: { heartbeat410?: boolean } = {}): {
  env: Env
  paths: string[]
} {
  const paths: string[] = []
  const fetchMock = vi.fn(async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url
    const path = new URL(url).pathname
    paths.push(path)
    if (path === "/heartbeat" && opts.heartbeat410) {
      return new Response(JSON.stringify({ reason: "stale-or-terminal" }), {
        status: 410, headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    })
  })
  const stub = { fetch: fetchMock } as unknown as DurableObjectStub
  const env = {
    PR_REVIEW_RUN: {
      idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
      get: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env
  return { env, paths }
}

function makeJob(): PrReviewJob {
  return {
    type: "pr-review",
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    prNumber: 7,
    headSha: HEAD_SHA,
    installationId: 99,
    runId: RUN_ID,
  }
}

describe("runPrReviewWithDoCallback — heartbeat loop (SIG-329)", () => {
  it("posts heartbeats every ~30s while the ensemble runs, then stops", async () => {
    vi.useFakeTimers()
    const { env, paths } = makeConsumerEnv()
    let resolveEnsemble: () => void = () => undefined
    const ensemble = new Promise<void>((r) => { resolveEnsemble = r })

    const p = runPrReviewWithDoCallback(makeJob(), env, () => ensemble)
    await vi.advanceTimersByTimeAsync(0) // let /pickup settle, arm first heartbeat

    await vi.advanceTimersByTimeAsync(30_000)
    expect(paths.filter((x) => x === "/heartbeat")).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(paths.filter((x) => x === "/heartbeat")).toHaveLength(2)

    resolveEnsemble()
    await p
    const beatsAtStop = paths.filter((x) => x === "/heartbeat").length

    // No further heartbeats after the ensemble settles + stop() clears the timer.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(paths.filter((x) => x === "/heartbeat")).toHaveLength(beatsAtStop)
    expect(paths).toContain("/run-result")
  })

  it("stops heartbeating when the DO returns 410 (superseded / cancelled)", async () => {
    vi.useFakeTimers()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { env, paths } = makeConsumerEnv({ heartbeat410: true })
    let resolveEnsemble: () => void = () => undefined
    const ensemble = new Promise<void>((r) => { resolveEnsemble = r })

    const p = runPrReviewWithDoCallback(makeJob(), env, () => ensemble)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000) // first heartbeat → 410 → loop stops
    expect(paths.filter((x) => x === "/heartbeat")).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(120_000) // no more heartbeats scheduled
    expect(paths.filter((x) => x === "/heartbeat")).toHaveLength(1)

    resolveEnsemble()
    await p
    errSpy.mockRestore()
  })
})
