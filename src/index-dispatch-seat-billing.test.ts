import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const { consumeActivitySeatCommand, recoverOrgSeatBillingOperation } = vi.hoisted(() => ({
  consumeActivitySeatCommand: vi.fn(async () => undefined),
  recoverOrgSeatBillingOperation: vi.fn(async () => undefined),
}))

vi.mock("@/src/features/billing", () => ({ consumeActivitySeatCommand, recoverOrgSeatBillingOperation }))

import { dispatchJob } from "@/src/index-dispatch"

describe("dispatchJob — durable Stripe seat reconciliation", () => {
  beforeEach(() => {
    consumeActivitySeatCommand.mockClear()
    recoverOrgSeatBillingOperation.mockClear()
  })

  it("routes one immutable activity command by delivery id", async () => {
    const env = {} as Env

    await dispatchJob({ type: "org-activity-seat-command", deliveryId: "delivery-1" }, env)

    expect(consumeActivitySeatCommand).toHaveBeenCalledOnce()
    expect(consumeActivitySeatCommand).toHaveBeenCalledWith(env, {
      type: "org-activity-seat-command",
      deliveryId: "delivery-1",
    })
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
