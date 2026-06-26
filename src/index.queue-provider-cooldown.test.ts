// SIG-455 Task 6 — queue() provider-cooldown read-before-fire tests.
//
// Exercises the REAL worker `queue()` consumer with the cooldown client
// mocked so we can drive remaining-ms values deterministically, and a
// mocked `dispatchJob` so the "did the review actually run?" decision is
// observable without executing the real pipeline.
//
// The matrix covers every SIGILIX_PROVIDER_COOLDOWN_MODE branch (enforce /
// shadow / off) plus the fail-open guarantees (defer non-2xx, defer throws,
// DO/get throws, deferCount bypass).

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { MAX_DEFERS } from "@/src/features/tenancy"
import { JITTER_BASE_MS, JITTER_CAP_MS } from "@/src/lib/ensemble/domain/backpressure"

// Mock the dispatcher so the consumer's "did the review run?" decision is
// observable without executing the real (heavy) review pipeline.
const { dispatchJobMock } = vi.hoisted(() => ({ dispatchJobMock: vi.fn(async () => {}) }))
vi.mock("@/src/index-dispatch", () => ({
  dispatchJob: dispatchJobMock,
  prMetaIsClosedOrMerged: vi.fn(),
}))

// Mock the cooldown client so remaining-ms is deterministic in tests.
// Default → 0 (no cooldown). Override per test.
const { getCooldownMock } = vi.hoisted(() => ({ getCooldownMock: vi.fn(async () => 0) }))
vi.mock("@/src/shared/adapters/model/provider-cooldown-client", () => ({
  getProviderCooldownRemainingMs: getCooldownMock,
  setProviderCooldown: vi.fn(),
}))

import worker from "@/src/index"

// ─── fakes ────────────────────────────────────────────────────

function makeNamespaceStub(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchSpy = vi.fn(fetchImpl)
  const namespace = {
    idFromName: vi.fn((name: string) => ({ toString: () => name, name })),
    get: vi.fn(() => ({ fetch: fetchSpy })),
  }
  return { namespace, fetchSpy }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface BuildCooldownEnvOpts {
  cooldownMode: "off" | "shadow" | "enforce"
  /** Response factory for /defer calls on PR_REVIEW_RUN. Defaults to 200 ok. */
  defer?: () => Promise<Response>
}

/** Build an Env with the cooldown flag set and fairness OFF so only the
 *  cooldown short-circuit is exercised (no TENANT_CONCURRENCY needed). */
function buildCooldownEnv(opts: BuildCooldownEnvOpts) {
  const prRun = makeNamespaceStub(async () => (opts.defer ? opts.defer() : jsonResponse(200, { ok: true })))
  const env = {
    SIGILIX_PROVIDER_COOLDOWN_MODE: opts.cooldownMode,
    SIGILIX_FAIRNESS_MODE: "off", // fairness off — isolates the cooldown path
    PR_REVIEW_RUN: prRun.namespace,
  } as unknown as Env
  return { env, prRun }
}

function makeJob(over: Partial<Extract<JobMessage, { type: "pr-review" }>> = {}): JobMessage {
  return {
    type: "pr-review",
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    headSha: "a".repeat(40),
    installationId: 42,
    runId: "run-1",
    ...over,
  } as JobMessage
}

function makeMessage(job: JobMessage) {
  return { body: job, attempts: 1, id: "m1", timestamp: new Date(), ack: vi.fn(), retry: vi.fn() }
}

function runQueue(env: Env, message: ReturnType<typeof makeMessage>) {
  const batch = { queue: "q", messages: [message] } as unknown as MessageBatch<JobMessage>
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
  return worker.queue(batch, env, ctx)
}

function calledWithDefer(prRun: ReturnType<typeof makeNamespaceStub>): boolean {
  return prRun.fetchSpy.mock.calls.some((c) => typeof c[0] === "string" && (c[0] as string).includes("/defer"))
}

/** Extract the parsed body from the first /defer fetch call. */
function deferBody(prRun: ReturnType<typeof makeNamespaceStub>): { runId?: string; backoffMs?: number } {
  const call = prRun.fetchSpy.mock.calls.find((c) => typeof c[0] === "string" && (c[0] as string).includes("/defer"))
  if (!call) return {}
  const init = call[1] as RequestInit
  return JSON.parse(init.body as string) as { runId?: string; backoffMs?: number }
}

beforeEach(() => {
  dispatchJobMock.mockClear()
  getCooldownMock.mockClear()
  getCooldownMock.mockResolvedValue(0) // default: no cooldown
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

// ─── matrix ───────────────────────────────────────────────────

describe("queue() provider-cooldown read-before-fire", () => {
  it("enforce + remaining>0 → /defer POSTed with backoffMs≈remaining+jitter, message.ack(), dispatchJob NOT called", async () => {
    const REMAINING = 30_000
    getCooldownMock.mockResolvedValue(REMAINING)
    const { env, prRun } = buildCooldownEnv({ cooldownMode: "enforce" })
    const message = makeMessage(makeJob())
    await runQueue(env, message)

    expect(calledWithDefer(prRun)).toBe(true)
    expect(dispatchJobMock).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()

    // backoffMs must be remaining + jitter in [JITTER_BASE_MS, JITTER_CAP_MS)
    const body = deferBody(prRun)
    expect(body.runId).toBe("run-1")
    expect(body.backoffMs).toBeGreaterThanOrEqual(REMAINING + JITTER_BASE_MS)
    expect(body.backoffMs).toBeLessThanOrEqual(REMAINING + JITTER_CAP_MS)
  })

  it("deferCount >= MAX_DEFERS → bypass (anti-starvation), dispatch runs", async () => {
    getCooldownMock.mockResolvedValue(30_000)
    const { env } = buildCooldownEnv({ cooldownMode: "enforce" })
    const message = makeMessage(makeJob({ deferCount: MAX_DEFERS }))
    await runQueue(env, message)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("enforce + remaining>0 + /defer non-2xx → FAIL-OPEN: dispatch runs, message.ack()", async () => {
    getCooldownMock.mockResolvedValue(30_000)
    const { env, prRun } = buildCooldownEnv({
      cooldownMode: "enforce",
      defer: () => Promise.resolve(jsonResponse(500, { error: "defer failed" })),
    })
    const message = makeMessage(makeJob())
    await runQueue(env, message)

    expect(calledWithDefer(prRun)).toBe(true)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("enforce + remaining>0 + /defer throws → FAIL-OPEN: dispatch runs", async () => {
    getCooldownMock.mockResolvedValue(30_000)
    const { env } = buildCooldownEnv({
      cooldownMode: "enforce",
      defer: () => Promise.reject(new Error("defer threw")),
    })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("shadow + remaining>0 → skip entirely (not honored): no cooldown read, dispatch runs", async () => {
    getCooldownMock.mockResolvedValue(30_000)
    const { env } = buildCooldownEnv({ cooldownMode: "shadow" })
    const message = makeMessage(makeJob())
    await runQueue(env, message)

    // shadow → the enforce branch is not entered, so the client is never called
    expect(getCooldownMock).not.toHaveBeenCalled()
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("off → no cooldown read at all, dispatch runs", async () => {
    getCooldownMock.mockResolvedValue(30_000)
    const { env } = buildCooldownEnv({ cooldownMode: "off" })
    const message = makeMessage(makeJob())
    await runQueue(env, message)

    expect(getCooldownMock).not.toHaveBeenCalled()
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("enforce + getProviderCooldownRemainingMs throws → FAIL-OPEN: dispatch runs", async () => {
    // The cooldown client is always fail-open (returns 0 on error) — but we test
    // the case where the mock itself throws to verify the queue handler is robust.
    getCooldownMock.mockRejectedValue(new Error("DO unavailable"))
    const { env } = buildCooldownEnv({ cooldownMode: "enforce" })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("enforce + remaining=0 → no cooldown (no defer, dispatch runs)", async () => {
    getCooldownMock.mockResolvedValue(0)
    const { env, prRun } = buildCooldownEnv({ cooldownMode: "enforce" })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(calledWithDefer(prRun)).toBe(false)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("non-pr-review job type → no cooldown read, dispatch runs", async () => {
    getCooldownMock.mockResolvedValue(30_000)
    const { env } = buildCooldownEnv({ cooldownMode: "enforce" })
    // index-repo job is not a pr-review
    const job = { type: "index-repo", owner: "Sigilix", repo: "sigilix", installationId: 42 } as unknown as JobMessage
    const message = makeMessage(job)
    await runQueue(env, message)
    expect(getCooldownMock).not.toHaveBeenCalled()
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })
})
