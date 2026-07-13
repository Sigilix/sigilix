import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const { recoverOrgSeatBillingOperation } = vi.hoisted(() => ({
  recoverOrgSeatBillingOperation: vi.fn(async () => undefined),
}))

vi.mock("@/src/features/billing", () => ({ recoverOrgSeatBillingOperation }))

import { dispatchJob } from "@/src/index-dispatch"

describe("dispatchJob — durable Stripe seat reconciliation", () => {
  beforeEach(() => {
    recoverOrgSeatBillingOperation.mockClear()
  })

  it("routes the exact installation and operation to the billing recovery handler", async () => {
    const env = {} as Env

    await dispatchJob({ type: "org-seat-billing-reconcile", installationId: 42, operationId: "op-seat-1" }, env)

    expect(recoverOrgSeatBillingOperation).toHaveBeenCalledOnce()
    expect(recoverOrgSeatBillingOperation).toHaveBeenCalledWith(env, {
      type: "org-seat-billing-reconcile",
      installationId: 42,
      operationId: "op-seat-1",
    })
  })
})
