import { describe, expect, it } from "vitest"
import { SEAT_BOUNDS } from "./checkout-session"
import { resolveStripeSeatTarget, type StripeSubscriptionItemSummary } from "./stripe-seat-target"
import type { PriceTierConfig } from "./stripe-events"

const CONFIG: PriceTierConfig = {
  pro: "price_pro",
  teams: "price_teams",
  max: "price_max",
  ultra: "price_ultra",
  proAnnual: "price_pro_annual",
  teamsAnnual: "price_teams_annual",
  maxAnnual: "price_max_annual",
  ultraAnnual: "price_ultra_annual",
}

function item(
  id: string,
  priceId: string,
  quantity: number,
  overrides: {
    interval?: string
    intervalCount?: number
    usageType?: string
  } = {},
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

describe("resolveStripeSeatTarget", () => {
  it("resolves the one exact monthly plan item and ignores unrelated add-ons", () => {
    const result = resolveStripeSeatTarget({
      subscriptionStatus: "active",
      priceConfig: CONFIG,
      items: [item("si_addon", "price_unrelated_addon", 50, { usageType: "metered" }), item("si_pro", "price_pro", 4)],
    })

    expect(result).toEqual({
      kind: "resolved",
      target: {
        subscriptionItemId: "si_pro",
        priceId: "price_pro",
        quantity: 4,
        tier: "pro",
        billingPeriod: "monthly",
      },
    })
  })

  it("resolves an exact annual item for an active or trialing subscription", () => {
    const annual = item("si_max_year", "price_max_annual", 3, { interval: "year" })
    for (const subscriptionStatus of ["active", "trialing"]) {
      expect(resolveStripeSeatTarget({ subscriptionStatus, priceConfig: CONFIG, items: [annual] })).toEqual({
        kind: "resolved",
        target: {
          subscriptionItemId: "si_max_year",
          priceId: "price_max_annual",
          quantity: 3,
          tier: "max",
          billingPeriod: "annual",
        },
      })
    }
  })

  it("blocks every status outside active or trialing", () => {
    for (const subscriptionStatus of ["canceled", "past_due", "incomplete", null, undefined]) {
      expect(
        resolveStripeSeatTarget({ subscriptionStatus, priceConfig: CONFIG, items: [item("si_pro", "price_pro", 1)] }),
      ).toEqual({ kind: "blocked", reason: "subscription_not_active" })
    }
  })

  it("blocks duplicate configured ids before choosing a target", () => {
    expect(
      resolveStripeSeatTarget({
        subscriptionStatus: "active",
        priceConfig: { ...CONFIG, proAnnual: "price_pro" },
        items: [item("si_pro", "price_pro", 1)],
      }),
    ).toEqual({ kind: "blocked", reason: "duplicate_configured_price_id" })
  })

  it("blocks zero or multiple configured-price item matches", () => {
    expect(
      resolveStripeSeatTarget({
        subscriptionStatus: "active",
        priceConfig: CONFIG,
        items: [item("si_addon", "price_addon", 1)],
      }),
    ).toEqual({ kind: "blocked", reason: "no_matching_subscription_item" })

    expect(
      resolveStripeSeatTarget({
        subscriptionStatus: "active",
        priceConfig: CONFIG,
        items: [item("si_pro", "price_pro", 1), item("si_max", "price_max", 1)],
      }),
    ).toEqual({ kind: "blocked", reason: "multiple_matching_subscription_items" })
  })

  it("blocks cadence mismatches for monthly and annual configuration", () => {
    for (const candidate of [
      item("si_month_wrong_interval", "price_pro", 1, { interval: "year" }),
      item("si_month_wrong_count", "price_pro", 1, { intervalCount: 2 }),
      item("si_year_wrong_interval", "price_pro_annual", 1),
      item("si_year_wrong_count", "price_pro_annual", 1, { interval: "year", intervalCount: 2 }),
    ]) {
      expect(
        resolveStripeSeatTarget({ subscriptionStatus: "active", priceConfig: CONFIG, items: [candidate] }),
      ).toEqual({ kind: "blocked", reason: "price_cadence_mismatch" })
    }
  })

  it("blocks metered plan items and quantities outside the product bounds", () => {
    expect(
      resolveStripeSeatTarget({
        subscriptionStatus: "active",
        priceConfig: CONFIG,
        items: [item("si_metered", "price_pro", 1, { usageType: "metered" })],
      }),
    ).toEqual({ kind: "blocked", reason: "price_not_licensed" })

    expect(
      resolveStripeSeatTarget({
        subscriptionStatus: "active",
        priceConfig: CONFIG,
        items: [item("", "price_pro", 1)],
      }),
    ).toEqual({ kind: "blocked", reason: "invalid_subscription_item" })

    for (const quantity of [SEAT_BOUNDS.pro.min - 1, SEAT_BOUNDS.pro.max + 1]) {
      expect(
        resolveStripeSeatTarget({
          subscriptionStatus: "active",
          priceConfig: CONFIG,
          items: [item("si_pro", "price_pro", quantity)],
        }),
      ).toEqual({ kind: "blocked", reason: "quantity_out_of_bounds" })
    }
    for (const quantity of [SEAT_BOUNDS.teams.min - 1, SEAT_BOUNDS.teams.max + 1]) {
      expect(
        resolveStripeSeatTarget({
          subscriptionStatus: "active",
          priceConfig: CONFIG,
          items: [item("si_teams", "price_teams", quantity)],
        }),
      ).toEqual({ kind: "blocked", reason: "quantity_out_of_bounds" })
    }
  })
})
