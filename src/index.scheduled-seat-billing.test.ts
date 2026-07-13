import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const { enqueueDueOrgSeatBillingOperations } = vi.hoisted(() => ({
  enqueueDueOrgSeatBillingOperations: vi.fn(async () => 0),
}))

vi.mock("@/src/features/billing", () => ({
  enqueueDueOrgSeatBillingOperations,
  handleStripeWebhookRoute: vi.fn(),
}))

import worker from "@/src/index"

function emptyKv(): KVNamespace {
  return {
    get: async () => null,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace
}

describe("scheduled — Stripe seat recovery", () => {
  beforeEach(() => {
    enqueueDueOrgSeatBillingOperations.mockClear()
  })

  it("runs even when automatic repository indexing is disabled", async () => {
    const env = { OPENCLAW_STATE: emptyKv() } as unknown as Env
    const waits: Promise<unknown>[] = []
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise)
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext

    await worker.scheduled({} as ScheduledEvent, env, ctx)
    await Promise.all(waits)

    expect(enqueueDueOrgSeatBillingOperations).toHaveBeenCalledOnce()
    expect(enqueueDueOrgSeatBillingOperations).toHaveBeenCalledWith(
      expect.objectContaining({ OPENCLAW_STATE: env.OPENCLAW_STATE }),
    )
  })
})
