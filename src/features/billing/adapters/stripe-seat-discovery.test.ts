import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PriceTierConfig } from "@/src/features/billing/domain/stripe-events"
import type { StripeSubscriptionItemSummary } from "@/src/features/billing/domain/stripe-seat-target"
import type { SubscriptionSummary } from "@/src/features/billing/domain/subscription-dedupe"
import { discoverStripeSeatSubscription } from "./stripe-seat-discovery"

const stripeApi = vi.hoisted(() => ({
  listCustomerSubscriptions: vi.fn(),
  listSubscriptionItems: vi.fn(),
  cancelSubscription: vi.fn(),
}))

vi.mock("./stripe-api", () => stripeApi)

const PRICE_CONFIG: PriceTierConfig = {
  pro: "price_pro",
  teams: "price_teams",
  max: "price_max",
  ultra: "price_ultra",
  proAnnual: "price_pro_annual",
  teamsAnnual: "price_teams_annual",
  maxAnnual: "price_max_annual",
  ultraAnnual: "price_ultra_annual",
}

function subscription(id: string, status: string, created: number): SubscriptionSummary {
  return { id, status, created, price: null }
}

function item(
  id: string,
  priceId: string,
  quantity: number,
  overrides: { interval?: string; intervalCount?: number; usageType?: string } = {},
): StripeSubscriptionItemSummary {
  return {
    id,
    quantity,
    price: {
      id: priceId,
      lookupKey: null,
      nickname: null,
      recurring: {
        interval: overrides.interval ?? "month",
        intervalCount: overrides.intervalCount ?? 1,
        usageType: overrides.usageType ?? "licensed",
      },
    },
  }
}

function discover(cancelDuplicates?: boolean) {
  return discoverStripeSeatSubscription({
    secret: "sk_test_secret",
    customerId: "cus_42",
    priceConfig: PRICE_CONFIG,
    ...(cancelDuplicates === undefined ? {} : { cancelDuplicates }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stripeApi.cancelSubscription.mockResolvedValue({ ok: true })
})

describe("discoverStripeSeatSubscription", () => {
  it("returns not_applicable without item reads for an empty or non-live subscription set", async () => {
    for (const subscriptions of [
      [],
      [subscription("sub_canceled", "canceled", 1), subscription("sub_past_due", "past_due", 2)],
    ]) {
      vi.clearAllMocks()
      stripeApi.listCustomerSubscriptions.mockResolvedValue({ ok: true, subscriptions })

      await expect(discover()).resolves.toEqual({ kind: "not_applicable" })
      expect(stripeApi.listSubscriptionItems).not.toHaveBeenCalled()
      expect(stripeApi.cancelSubscription).not.toHaveBeenCalled()
    }
  })

  it("blocks an anomalous active-subscription fanout before issuing item-list calls", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: Array.from({ length: 21 }, (_, index) => subscription(`sub_${index}`, "active", index)),
    })

    await expect(discover()).resolves.toEqual({
      kind: "blocked",
      reason: "too_many_active_subscriptions",
      subscriptionId: "sub_0",
    })
    expect(stripeApi.listSubscriptionItems).not.toHaveBeenCalled()
    expect(stripeApi.cancelSubscription).not.toHaveBeenCalled()
  })

  it("keeps the oldest valid Sigilix subscription and cancels only newer valid candidates", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [
        subscription("sub_valid_new", "active", 30),
        subscription("sub_dead", "canceled", 1),
        subscription("sub_unrelated", "active", 10),
        subscription("sub_valid_old", "trialing", 20),
      ],
    })
    stripeApi.listSubscriptionItems.mockImplementation(async (_secret: string, subscriptionId: string) => {
      const items: Record<string, StripeSubscriptionItemSummary[]> = {
        sub_unrelated: [item("si_addon", "price_addon", 1, { usageType: "metered" })],
        sub_valid_old: [item("si_pro", "price_pro", 4)],
        sub_valid_new: [item("si_max", "price_max", 2)],
      }
      return { ok: true, items: items[subscriptionId] ?? [] }
    })

    await expect(discover()).resolves.toEqual({
      kind: "ready",
      target: {
        subscriptionId: "sub_valid_old",
        subscriptionStatus: "trialing",
        subscriptionItemId: "si_pro",
        priceId: "price_pro",
        quantity: 4,
        tier: "pro",
        billingPeriod: "monthly",
      },
      duplicateSubscriptionIds: ["sub_valid_new"],
      canceledSubscriptionIds: ["sub_valid_new"],
    })
    expect(stripeApi.listSubscriptionItems.mock.calls.map((call) => call[1])).toEqual([
      "sub_unrelated",
      "sub_valid_old",
      "sub_valid_new",
    ])
    expect(stripeApi.listSubscriptionItems).not.toHaveBeenCalledWith(expect.anything(), "sub_dead")
    expect(stripeApi.cancelSubscription).toHaveBeenCalledTimes(1)
    expect(stripeApi.cancelSubscription).toHaveBeenCalledWith("sk_test_secret", "sub_valid_new", undefined)
  })

  it("uses subscription id as the deterministic tie-breaker between valid candidates", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [subscription("sub_b", "active", 10), subscription("sub_a", "active", 10)],
    })
    stripeApi.listSubscriptionItems.mockImplementation(async (_secret: string, subscriptionId: string) => ({
      ok: true,
      items: [item(`si_${subscriptionId}`, subscriptionId === "sub_a" ? "price_pro" : "price_max", 2)],
    }))

    const result = await discover()

    expect(result).toMatchObject({
      kind: "ready",
      target: { subscriptionId: "sub_a" },
      duplicateSubscriptionIds: ["sub_b"],
      canceledSubscriptionIds: ["sub_b"],
    })
  })

  it("ignores unrelated live subscriptions and returns not_applicable when none are Sigilix", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [subscription("sub_dead", "past_due", 1), subscription("sub_addon", "active", 2)],
    })
    stripeApi.listSubscriptionItems.mockResolvedValue({
      ok: true,
      items: [item("si_addon", "price_unrelated", 100, { usageType: "metered" })],
    })

    await expect(discover()).resolves.toEqual({ kind: "not_applicable" })
    expect(stripeApi.listSubscriptionItems).toHaveBeenCalledTimes(1)
    expect(stripeApi.listSubscriptionItems).toHaveBeenCalledWith("sk_test_secret", "sub_addon", undefined)
    expect(stripeApi.cancelSubscription).not.toHaveBeenCalled()
  })

  it("resolves every live subscription before canceling and blocks on any non-unrelated target defect", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [subscription("sub_valid", "active", 10), subscription("sub_bad", "active", 20)],
    })
    stripeApi.listSubscriptionItems.mockImplementation(async (_secret: string, subscriptionId: string) => ({
      ok: true,
      items:
        subscriptionId === "sub_valid" ? [item("si_pro", "price_pro", 2)] : [item("si_bad", "price_max_annual", 2)],
    }))

    await expect(discover()).resolves.toEqual({
      kind: "blocked",
      reason: "price_cadence_mismatch",
      subscriptionId: "sub_bad",
    })
    expect(stripeApi.listSubscriptionItems).toHaveBeenCalledTimes(2)
    expect(stripeApi.cancelSubscription).not.toHaveBeenCalled()
  })

  it("reports the oldest blocked subscription's reason deterministically", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [subscription("sub_new", "active", 20), subscription("sub_old", "active", 10)],
    })
    stripeApi.listSubscriptionItems.mockImplementation(async (_secret: string, subscriptionId: string) => ({
      ok: true,
      items:
        subscriptionId === "sub_old"
          ? [item("si_old", "price_pro_annual", 1)]
          : [item("si_new", "price_max", 1, { usageType: "metered" })],
    }))

    await expect(discover()).resolves.toEqual({
      kind: "blocked",
      reason: "price_cadence_mismatch",
      subscriptionId: "sub_old",
    })
    expect(stripeApi.cancelSubscription).not.toHaveBeenCalled()
  })

  it("fails the whole discovery on a subscription-list or item-list error", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValueOnce({ ok: false, error: "list down", status: 503 })
    await expect(discover()).resolves.toEqual({ kind: "error", error: "list down", status: 503 })
    expect(stripeApi.listSubscriptionItems).not.toHaveBeenCalled()

    vi.clearAllMocks()
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [subscription("sub_a", "active", 1), subscription("sub_b", "active", 2)],
    })
    stripeApi.listSubscriptionItems
      .mockResolvedValueOnce({ ok: true, items: [item("si_a", "price_pro", 1)] })
      .mockResolvedValueOnce({ ok: false, error: "items down", status: 502 })

    await expect(discover()).resolves.toEqual({ kind: "error", error: "items down", status: 502 })
    expect(stripeApi.cancelSubscription).not.toHaveBeenCalled()
  })

  it("returns blocked and not converged when any newer valid duplicate cannot be canceled", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [
        subscription("sub_old", "active", 1),
        subscription("sub_new", "active", 2),
        subscription("sub_newest", "trialing", 3),
      ],
    })
    stripeApi.listSubscriptionItems.mockImplementation(async (_secret: string, subscriptionId: string) => ({
      ok: true,
      items: [item(`si_${subscriptionId}`, "price_pro", 2)],
    }))
    stripeApi.cancelSubscription
      .mockResolvedValueOnce({ ok: false, error: "cancel failed", status: 409 })
      .mockResolvedValueOnce({ ok: true })

    await expect(discover()).resolves.toEqual({
      kind: "blocked",
      reason: "duplicate_subscription_cancel_failed",
      subscriptionId: "sub_new",
    })
    expect(stripeApi.cancelSubscription.mock.calls.map((call) => call[1])).toEqual(["sub_new", "sub_newest"])
  })

  it("supports a read-only survivor lookup without canceling valid duplicates", async () => {
    stripeApi.listCustomerSubscriptions.mockResolvedValue({
      ok: true,
      subscriptions: [subscription("sub_new", "active", 2), subscription("sub_old", "active", 1)],
    })
    stripeApi.listSubscriptionItems.mockImplementation(async (_secret: string, subscriptionId: string) => ({
      ok: true,
      items: [item(`si_${subscriptionId}`, "price_pro_annual", 3, { interval: "year" })],
    }))

    await expect(discover(false)).resolves.toEqual({
      kind: "ready",
      target: {
        subscriptionId: "sub_old",
        subscriptionStatus: "active",
        subscriptionItemId: "si_sub_old",
        priceId: "price_pro_annual",
        quantity: 3,
        tier: "pro",
        billingPeriod: "annual",
      },
      duplicateSubscriptionIds: ["sub_new"],
      canceledSubscriptionIds: [],
    })
    expect(stripeApi.cancelSubscription).not.toHaveBeenCalled()
  })
})
