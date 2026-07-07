// SIG-543 Task 4 — queue() shadow-quota admission wire tests.
//
// The queue consumer directly `await`s checkShadowQuota for every pr-review job
// that has a numeric installationId and quotaMode !== "off".  ctx.waitUntil is
// NOT used for this call (a Queue consumer's ctx.waitUntil does not reliably
// extend the isolate lifetime — see reference_cloudflare_queue_consumer_waituntil).
// This is INDEPENDENT of fairness (no runId required, no fairnessMode check)
// and NEVER blocks or refuses the review (Phase 1 observation-only).

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

// Mock the dispatcher so the "did the review run?" decision is observable
// without executing the real (heavy) review pipeline.
const { dispatchJobMock } = vi.hoisted(() => ({ dispatchJobMock: vi.fn(async () => {}) }))
vi.mock("@/src/index-dispatch", () => ({
  dispatchJob: dispatchJobMock,
  prMetaIsClosedOrMerged: vi.fn(),
}))

// Mock checkShadowQuota so we can assert it was called without needing D1.
// All other tenancy exports use the real implementations.
const { checkShadowQuotaMock } = vi.hoisted(() => ({ checkShadowQuotaMock: vi.fn(async () => {}) }))
vi.mock("@/src/features/tenancy", async (importActual) => {
  const actual = await importActual()
  return {
    ...(actual as object),
    checkShadowQuota: checkShadowQuotaMock,
  }
})

import worker from "@/src/index"

// ─── helpers ─────────────────────────────────────────────────

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
  return { run: worker.queue(batch, env, ctx), ctx }
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    SIGILIX_FAIRNESS_MODE: "off",
    SIGILIX_PROVIDER_COOLDOWN_MODE: "off",
    ...extra,
  } as unknown as Env
}

beforeEach(() => {
  dispatchJobMock.mockClear()
  checkShadowQuotaMock.mockClear()
  checkShadowQuotaMock.mockResolvedValue(undefined)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

// ─── matrix ──────────────────────────────────────────────────

describe("queue() shadow-quota wire (SIG-543 Task 4)", () => {
  it("pr-review + numeric installationId + quotaMode=shadow → checkShadowQuota invoked AND dispatch runs", async () => {
    const env = makeEnv({ SIGILIX_TENANT_QUOTA_MODE: "shadow" })
    const message = makeMessage(makeJob())
    const { run } = runQueue(env, message)
    await run

    // quota check was directly awaited (not via waitUntil)
    // queue() passes the normalizeEnv()'d env (a SIGILIX_/OPENCLAW_-mirrored SUPERSET of
    // the input) to checkShadowQuota, so assert containment rather than exact shape.
    expect(checkShadowQuotaMock).toHaveBeenCalledWith(expect.objectContaining(env), 42)
    // review still dispatched — never blocks
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("fires when SIGILIX_FAIRNESS_MODE=off (independent of fairness)", async () => {
    const env = makeEnv({ SIGILIX_TENANT_QUOTA_MODE: "shadow", SIGILIX_FAIRNESS_MODE: "off" })
    const message = makeMessage(makeJob())
    const { run } = runQueue(env, message)
    await run

    // queue() passes the normalizeEnv()'d env (a SIGILIX_/OPENCLAW_-mirrored SUPERSET of
    // the input) to checkShadowQuota, so assert containment rather than exact shape.
    expect(checkShadowQuotaMock).toHaveBeenCalledWith(expect.objectContaining(env), 42)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("fires when runId is absent (slash reruns / no-runId jobs)", async () => {
    const env = makeEnv({ SIGILIX_TENANT_QUOTA_MODE: "shadow" })
    const job = makeJob()
    delete (job as { runId?: string }).runId
    const message = makeMessage(job)
    const { run } = runQueue(env, message)
    await run

    // queue() passes the normalizeEnv()'d env (a SIGILIX_/OPENCLAW_-mirrored SUPERSET of
    // the input) to checkShadowQuota, so assert containment rather than exact shape.
    expect(checkShadowQuotaMock).toHaveBeenCalledWith(expect.objectContaining(env), 42)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("quotaMode=off → checkShadowQuota NOT invoked", async () => {
    const env = makeEnv({ SIGILIX_TENANT_QUOTA_MODE: "off" })
    const message = makeMessage(makeJob())
    const { run } = runQueue(env, message)
    await run

    expect(checkShadowQuotaMock).not.toHaveBeenCalled()
    // review still runs regardless
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("quotaMode absent (default=shadow) → checkShadowQuota invoked", async () => {
    // resolveQuotaMode falls through to "shadow" when the flag is absent
    const env = makeEnv({}) // no SIGILIX_TENANT_QUOTA_MODE
    const message = makeMessage(makeJob())
    const { run } = runQueue(env, message)
    await run

    // queue() passes the normalizeEnv()'d env (a SIGILIX_/OPENCLAW_-mirrored SUPERSET of
    // the input) to checkShadowQuota, so assert containment rather than exact shape.
    expect(checkShadowQuotaMock).toHaveBeenCalledWith(expect.objectContaining(env), 42)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("non pr-review job type → checkShadowQuota NOT invoked", async () => {
    const env = makeEnv({ SIGILIX_TENANT_QUOTA_MODE: "shadow" })
    const job = { type: "pr-close", owner: "o", repo: "r", prNumber: 1 } as unknown as JobMessage
    const message = makeMessage(job)
    const { run } = runQueue(env, message)
    await run

    expect(checkShadowQuotaMock).not.toHaveBeenCalled()
  })
})
