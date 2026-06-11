// SIG-285 PR 2 — recordVerificationMetricsBounded: the best-effort, time-bounded
// batch-record helper the ensemble calls on the hot path. Telemetry must never
// block or break a review, so the timeout race + swallowed error path are the
// load-bearing behavior under test.

import { describe, expect, it, vi } from "vitest"
import { recordVerificationMetricsBounded } from "@/src/lib/verification-metrics-client"
import type { Env } from "@/src/shared/types/env"
import type { RecordVerificationArgs } from "@/src/do/verification-metrics"

const ITEMS: RecordVerificationArgs[] = [
  { verdict: "refuted", category: "security" },
  { verdict: "confirmed", category: "logic" },
]

// Mock VERIFICATION_METRICS_DO as the other tests do: a stub namespace whose
// .get().recordBatch we control.
function makeEnv(recordBatch: (items: RecordVerificationArgs[]) => Promise<void>): Env {
  const stub = { recordBatch }
  const ns = { idFromName: (_: string) => "id", get: (_: unknown) => stub }
  return { VERIFICATION_METRICS_DO: ns } as unknown as Env
}

describe("recordVerificationMetricsBounded", () => {
  it("is a no-op on an empty batch (recordBatch never called)", async () => {
    const recordBatch = vi.fn(async () => {})
    const log = vi.fn()
    await recordVerificationMetricsBounded(makeEnv(recordBatch), [], 1_500, log)
    expect(recordBatch).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it("records and resolves on the success path (no log)", async () => {
    const recordBatch = vi.fn(async () => {})
    const log = vi.fn()
    await recordVerificationMetricsBounded(makeEnv(recordBatch), ITEMS, 1_500, log)
    expect(recordBatch).toHaveBeenCalledTimes(1)
    expect(recordBatch).toHaveBeenCalledWith(ITEMS)
    expect(log).not.toHaveBeenCalled()
  })

  it("swallows a DO rejection and logs it once", async () => {
    const recordBatch = vi.fn(async () => {
      throw new Error("DO down")
    })
    const log = vi.fn()
    await expect(recordVerificationMetricsBounded(makeEnv(recordBatch), ITEMS, 1_500, log)).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith("verification-metric-record-failed", {
      error: "Error: DO down",
    })
  })

  it("resolves anyway when the DO hangs past timeoutMs, logging the timeout", async () => {
    vi.useFakeTimers()
    try {
      // recordBatch never resolves — the race must be won by the timer.
      const recordBatch = vi.fn(() => new Promise<void>(() => {}))
      const log = vi.fn()
      const p = recordVerificationMetricsBounded(makeEnv(recordBatch), ITEMS, 20, log)
      await vi.advanceTimersByTimeAsync(25)
      await expect(p).resolves.toBeUndefined()
      expect(log).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith("verification-metric-record-failed", {
        error: "Error: verification-metric-timeout",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears the timeout timer on the success path (no pending fake timers)", async () => {
    vi.useFakeTimers()
    try {
      const recordBatch = vi.fn(async () => {})
      const log = vi.fn()
      await recordVerificationMetricsBounded(makeEnv(recordBatch), ITEMS, 1_500, log)
      // finally{} cleared the timer, so nothing is left armed.
      expect(vi.getTimerCount()).toBe(0)
      expect(log).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("tolerates a missing log callback", async () => {
    const recordBatch = vi.fn(async () => {
      throw new Error("boom")
    })
    await expect(recordVerificationMetricsBounded(makeEnv(recordBatch), ITEMS, 1_500)).resolves.toBeUndefined()
  })
})
