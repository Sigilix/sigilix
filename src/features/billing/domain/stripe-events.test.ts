import { describe, expect, it } from "vitest"
import {
  interpretStripeEvent,
  mapPriceToTier,
  parseInstallationId,
  type PriceTierConfig,
  type StripeEvent,
} from "@/src/features/billing/domain/stripe-events"

const CFG: PriceTierConfig = {
  pro: "price_pro",
  teams: "price_teams",
  max: "price_max",
  ultra: "price_ultra",
  proAnnual: "price_pro_annual",
  teamsAnnual: "price_teams_annual",
  maxAnnual: "price_max_annual",
  ultraAnnual: "price_ultra_annual",
}

describe("parseInstallationId", () => {
  it("accepts positive int number and numeric string", () => {
    expect(parseInstallationId(123)).toBe(123)
    expect(parseInstallationId("456")).toBe(456)
  })
  it("rejects zero/negative/non-numeric/floats", () => {
    expect(parseInstallationId(0)).toBeNull()
    expect(parseInstallationId(-1)).toBeNull()
    expect(parseInstallationId("12x")).toBeNull()
    expect(parseInstallationId(1.5)).toBeNull()
    expect(parseInstallationId(undefined)).toBeNull()
  })
})

describe("mapPriceToTier", () => {
  it("maps by exact configured price id", () => {
    expect(mapPriceToTier({ id: "price_pro" }, CFG)).toBe("pro")
    expect(mapPriceToTier({ id: "price_teams" }, CFG)).toBe("teams")
    expect(mapPriceToTier({ id: "price_max" }, CFG)).toBe("max")
    expect(mapPriceToTier({ id: "price_ultra" }, CFG)).toBe("ultra")
  })
  it("maps every annual price by exact configured price id", () => {
    expect(mapPriceToTier({ id: "price_pro_annual" }, CFG)).toBe("pro")
    expect(mapPriceToTier({ id: "price_teams_annual" }, CFG)).toBe("teams")
    expect(mapPriceToTier({ id: "price_max_annual" }, CFG)).toBe("max")
    expect(mapPriceToTier({ id: "price_ultra_annual" }, CFG)).toBe("ultra")
  })
  it("falls back to lookup_key / nickname substring when id unmapped", () => {
    expect(mapPriceToTier({ id: "price_x", lookup_key: "ultra_monthly" }, CFG)).toBe("ultra")
    expect(mapPriceToTier({ id: "price_x", lookup_key: "sigilix_pro_monthly" }, CFG)).toBe("pro")
    expect(mapPriceToTier({ id: "price_x", nickname: "Pro plan" }, CFG)).toBe("pro")
    expect(mapPriceToTier({ id: "price_x", lookup_key: "max annual" }, {})).toBe("max")
    expect(mapPriceToTier({ id: "price_x", lookup_key: "sigilix_teams_monthly" }, {})).toBe("teams")
    expect(mapPriceToTier({ id: "price_x", nickname: "Teams plan" }, {})).toBe("teams")
  })
  it("returns null when nothing matches", () => {
    expect(mapPriceToTier({ id: "price_x", nickname: "starter" }, CFG)).toBeNull()
    expect(mapPriceToTier(undefined, CFG)).toBeNull()
  })
})

function ev(type: string, object: unknown, id = "evt_1"): StripeEvent {
  return { id, type, data: { object } }
}

describe("interpretStripeEvent", () => {
  it("checkout.session.completed → link only (tier null), installation from client_reference_id", () => {
    const r = interpretStripeEvent(
      ev("checkout.session.completed", { customer: "cus_1", client_reference_id: "789" }),
      CFG,
    )
    expect(r).toEqual({
      kind: "apply",
      customerId: "cus_1",
      installationId: 789,
      tier: null,
      subscriptionId: null,
      subscriptionStatus: null,
    })
  })

  it("checkout.session.completed with an expanded ACTIVE subscription → mapped tier", () => {
    const r = interpretStripeEvent(
      ev("checkout.session.completed", {
        customer: "cus_1",
        client_reference_id: "789",
        subscription: { status: "active", items: { data: [{ price: { id: "price_pro" } }] } },
      }),
      CFG,
    )
    expect(r).toEqual({
      kind: "apply",
      customerId: "cus_1",
      installationId: 789,
      tier: "pro",
      subscriptionId: null,
      subscriptionStatus: "active",
    })
  })

  it("checkout.session.completed with an expanded TRIALING subscription → mapped tier + trialing status", () => {
    const r = interpretStripeEvent(
      ev("checkout.session.completed", {
        customer: "cus_1",
        client_reference_id: "789",
        subscription: { status: "trialing", items: { data: [{ price: { id: "price_pro" } }] } },
      }),
      CFG,
    )
    expect(r).toMatchObject({ tier: "pro", subscriptionStatus: "trialing" })
  })

  it("checkout.session.completed with a NON-active expanded subscription → link only (never grant)", () => {
    const r = interpretStripeEvent(
      ev("checkout.session.completed", {
        customer: "cus_1",
        client_reference_id: "789",
        subscription: { status: "incomplete", items: { data: [{ price: { id: "price_pro" } }] } },
      }),
      CFG,
    )
    expect(r).toMatchObject({ tier: null })
  })

  it("checkout.session.completed with a bare subscription-id string → link only (unexpanded)", () => {
    const r = interpretStripeEvent(
      ev("checkout.session.completed", { customer: "cus_1", client_reference_id: "789", subscription: "sub_123" }),
      CFG,
    )
    expect(r).toMatchObject({ tier: null })
  })

  it("checkout.session.completed reads metadata.installation_id fallback", () => {
    const r = interpretStripeEvent(
      ev("checkout.session.completed", { customer: "cus_1", metadata: { installation_id: "55" } }),
      CFG,
    )
    expect(r).toMatchObject({ installationId: 55 })
  })

  it("subscription.created active + mapped price → paid tier", () => {
    const r = interpretStripeEvent(
      ev("customer.subscription.created", {
        status: "active",
        customer: "cus_1",
        metadata: { installation_id: "10" },
        items: { data: [{ price: { id: "price_max" } }] },
      }),
      CFG,
    )
    expect(r).toEqual({
      kind: "apply",
      customerId: "cus_1",
      installationId: 10,
      tier: "max",
      subscriptionId: null,
      subscriptionStatus: "active",
    })
  })

  it("subscription.created/deleted carry the subscription id (for the dup-cancel guard)", () => {
    const created = interpretStripeEvent(
      ev("customer.subscription.created", {
        id: "sub_abc",
        status: "active",
        customer: "cus_1",
        metadata: { installation_id: "10" },
        items: { data: [{ price: { id: "price_max" } }] },
      }),
      CFG,
    )
    expect(created).toMatchObject({ subscriptionId: "sub_abc" })
    const deleted = interpretStripeEvent(
      ev("customer.subscription.deleted", { id: "sub_abc", customer: "cus_1", metadata: { installation_id: "10" } }),
      CFG,
    )
    expect(deleted).toMatchObject({ subscriptionId: "sub_abc", tier: "free" })
  })

  it("subscription.updated trialing → paid tier + trialing status (half volume, full features)", () => {
    const r = interpretStripeEvent(
      ev("customer.subscription.updated", {
        status: "trialing",
        customer: "cus_1",
        items: { data: [{ price: { id: "price_pro" } }] },
      }),
      CFG,
    )
    expect(r).toMatchObject({ tier: "pro", subscriptionStatus: "trialing" })
  })

  it("subscription.updated trial→active conversion → active status (full volume restored)", () => {
    const r = interpretStripeEvent(
      ev("customer.subscription.updated", {
        status: "active",
        customer: "cus_1",
        metadata: { installation_id: "10" },
        items: { data: [{ price: { id: "price_pro" } }] },
      }),
      CFG,
    )
    expect(r).toMatchObject({ tier: "pro", subscriptionStatus: "active" })
  })

  it("subscription active but UNMAPPED price → tier null (never guess a paid tier)", () => {
    const r = interpretStripeEvent(
      ev("customer.subscription.updated", {
        status: "active",
        customer: "cus_1",
        items: { data: [{ price: { id: "price_unknown" } }] },
      }),
      CFG,
    )
    expect(r).toMatchObject({ tier: null })
  })

  it("subscription non-active status (past_due) → free", () => {
    const r = interpretStripeEvent(
      ev("customer.subscription.updated", {
        status: "past_due",
        customer: "cus_1",
        items: { data: [{ price: { id: "price_max" } }] },
      }),
      CFG,
    )
    expect(r).toMatchObject({ tier: "free" })
  })

  it("subscription.deleted → free", () => {
    const r = interpretStripeEvent(ev("customer.subscription.deleted", { customer: "cus_1" }), CFG)
    expect(r).toMatchObject({ tier: "free", customerId: "cus_1" })
  })

  it("invoice.paid without an expanded active subscription → link only, never upgrade", () => {
    const r = interpretStripeEvent(
      ev("invoice.paid", { customer: "cus_1", lines: { data: [{ price: { id: "price_ultra" } }] } }),
      CFG,
    )
    expect(r).toMatchObject({ tier: null })
  })

  it("invoice.paid with an expanded active subscription and mapped price → reaffirm tier", () => {
    const r = interpretStripeEvent(
      ev("invoice.paid", {
        customer: "cus_1",
        subscription: {
          status: "active",
          metadata: { installation_id: "99" },
          items: { data: [{ price: { id: "price_ultra" } }] },
        },
        lines: { data: [{ price: { id: "price_ultra" } }] },
      }),
      CFG,
    )
    expect(r).toMatchObject({ tier: "ultra" })
    expect(r).toMatchObject({ installationId: 99 })
  })

  it("invoice.payment_failed → free", () => {
    const r = interpretStripeEvent(ev("invoice.payment_failed", { customer: "cus_1" }), CFG)
    expect(r).toMatchObject({ tier: "free" })
  })

  it("unhandled type → ignore", () => {
    expect(interpretStripeEvent(ev("charge.succeeded", {}), CFG)).toEqual({
      kind: "ignore",
      reason: "unhandled:charge.succeeded",
    })
  })

  it("malformed object → ignore, never throws", () => {
    expect(interpretStripeEvent(ev("customer.subscription.updated", null), CFG)).toEqual({
      kind: "ignore",
      reason: "missing-object",
    })
    expect(interpretStripeEvent({ id: "x", data: { object: {} } }, CFG)).toEqual({
      kind: "ignore",
      reason: "missing-type",
    })
  })
})
