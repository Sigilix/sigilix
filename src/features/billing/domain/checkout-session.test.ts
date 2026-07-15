// sig-stripe-checkout: the PURE checkout builder/validator contract. These pin the
// security-critical invariants (the Pro-only 14-day trial, the installation as
// client_reference_id, per-tier seat bounds) in isolation so a regression is a red
// unit test, not a prod bug.

import { describe, expect, it } from "vitest"
import {
  SEAT_BOUNDS,
  isPaidTier,
  validateCheckoutRequest,
  resolvePriceForTier,
  buildCheckoutForm,
  fingerprintCheckoutIntent,
  trialDaysForTier,
} from "@/src/features/billing/domain/checkout-session"

describe("isPaidTier", () => {
  it("accepts only the four purchasable tiers", () => {
    for (const t of ["pro", "teams", "max", "ultra"]) expect(isPaidTier(t)).toBe(true)
    for (const t of ["free", "enterprise", "team", "TEAMS", "", null, undefined, 3]) {
      expect(isPaidTier(t)).toBe(false)
    }
  })
})

describe("validateCheckoutRequest — tier gate", () => {
  it("rejects free / enterprise / unknown tiers with 400", () => {
    for (const tier of ["free", "enterprise", "gold", undefined]) {
      const r = validateCheckoutRequest({ tier })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.status).toBe(400)
        expect(r.error).toBe("invalid_tier")
      }
    }
  })

  it("defaults seats to the tier minimum when omitted", () => {
    const teams = validateCheckoutRequest({ tier: "teams" })
    expect(teams).toMatchObject({ ok: true, tier: "teams", seats: 10 })
    const pro = validateCheckoutRequest({ tier: "pro" })
    expect(pro).toMatchObject({ ok: true, tier: "pro", seats: 1 })
  })

  it("accepts monthly/annual billing periods and defaults an omitted period to monthly", () => {
    expect(validateCheckoutRequest({ tier: "pro", billingPeriod: "monthly" })).toMatchObject({
      ok: true,
      billingPeriod: "monthly",
      billingPeriodDefaulted: false,
    })
    expect(validateCheckoutRequest({ tier: "max", billingPeriod: "annual" })).toMatchObject({
      ok: true,
      billingPeriod: "annual",
      billingPeriodDefaulted: false,
    })
    expect(validateCheckoutRequest({ tier: "ultra" })).toMatchObject({
      ok: true,
      billingPeriod: "monthly",
      billingPeriodDefaulted: true,
    })
  })

  it("rejects every provided billing period outside monthly|annual", () => {
    for (const billingPeriod of ["yearly", "MONTHLY", "", null, 12]) {
      expect(validateCheckoutRequest({ tier: "pro", billingPeriod })).toMatchObject({
        ok: false,
        status: 400,
        error: "invalid_billing_period",
      })
    }
  })
})

describe("validateCheckoutRequest — seat bounds (server-side)", () => {
  it("Teams enforces a 10–150 range", () => {
    expect(validateCheckoutRequest({ tier: "teams", seats: 9 })).toMatchObject({ ok: false, status: 400 })
    expect(validateCheckoutRequest({ tier: "teams", seats: 10 })).toMatchObject({ ok: true, seats: 10 })
    expect(validateCheckoutRequest({ tier: "teams", seats: 150 })).toMatchObject({ ok: true, seats: 150 })
    expect(validateCheckoutRequest({ tier: "teams", seats: 151 })).toMatchObject({ ok: false, status: 400 })
  })

  it("pro/max/ultra allow a minimum of 1", () => {
    for (const tier of ["pro", "max", "ultra"] as const) {
      expect(validateCheckoutRequest({ tier, seats: 0 })).toMatchObject({ ok: false, status: 400 })
      expect(validateCheckoutRequest({ tier, seats: 1 })).toMatchObject({ ok: true, seats: 1 })
      expect(validateCheckoutRequest({ tier, seats: SEAT_BOUNDS[tier].max })).toMatchObject({ ok: true })
      expect(validateCheckoutRequest({ tier, seats: SEAT_BOUNDS[tier].max + 1 })).toMatchObject({ ok: false })
    }
  })

  it("rejects non-integer / non-number seats with 400", () => {
    expect(validateCheckoutRequest({ tier: "pro", seats: 1.5 })).toMatchObject({ ok: false, error: "invalid_seats" })
    expect(validateCheckoutRequest({ tier: "pro", seats: "10" })).toMatchObject({ ok: false, error: "invalid_seats" })
    expect(validateCheckoutRequest({ tier: "pro", seats: Number.NaN })).toMatchObject({ ok: false })
  })
})

describe("resolvePriceForTier", () => {
  const cfg = {
    pro: "price_pro",
    teams: "price_teams",
    max: undefined,
    ultra: "",
    proAnnual: "price_pro_annual",
    teamsAnnual: "price_teams_annual",
  }
  it("returns the configured monthly or annual price id", () => {
    expect(resolvePriceForTier("pro", "monthly", cfg)).toBe("price_pro")
    expect(resolvePriceForTier("teams", "monthly", cfg)).toBe("price_teams")
    expect(resolvePriceForTier("pro", "annual", cfg)).toBe("price_pro_annual")
    expect(resolvePriceForTier("teams", "annual", cfg)).toBe("price_teams_annual")
  })
  it("returns null for an unconfigured (undefined/empty) tier price", () => {
    expect(resolvePriceForTier("max", "monthly", cfg)).toBeNull()
    expect(resolvePriceForTier("ultra", "monthly", cfg)).toBeNull()
    expect(resolvePriceForTier("max", "annual", cfg)).toBeNull()
    expect(resolvePriceForTier("ultra", "annual", cfg)).toBeNull()
  })
})

describe("trialDaysForTier — the Pro-only trial gate", () => {
  it("grants a 14-day trial for pro ONLY", () => {
    expect(trialDaysForTier("pro")).toBe(14)
  })

  it("grants NO trial (0 days) for teams / max / ultra", () => {
    for (const tier of ["teams", "max", "ultra"] as const) {
      expect(trialDaysForTier(tier)).toBe(0)
    }
  })
})

describe("buildCheckoutForm — the Stripe form fields", () => {
  const expiresAtEpochSeconds = 1_800_000_000
  const form = buildCheckoutForm({
    priceId: "price_teams",
    seats: 12,
    bounds: SEAT_BOUNDS.teams,
    tier: "teams",
    billingPeriod: "monthly",
    installationId: 987654,
    customerId: "cus_ABC",
    successUrl: "https://app.sigilix.ai/org?checkout=success",
    cancelUrl: "https://app.sigilix.ai/org?checkout=cancel",
    expiresAtEpochSeconds,
  })

  it("sets a 14-day trial for PRO only", () => {
    const proForm = buildCheckoutForm({
      priceId: "price_pro",
      seats: 1,
      bounds: SEAT_BOUNDS.pro,
      tier: "pro",
      billingPeriod: "monthly",
      installationId: 987654,
      customerId: "cus_ABC",
      successUrl: "https://app.sigilix.ai/org?checkout=success",
      cancelUrl: "https://app.sigilix.ai/org?checkout=cancel",
      expiresAtEpochSeconds,
    })
    expect(proForm.get("subscription_data[trial_period_days]")).toBe("14")
  })

  it("sets NO trial for teams / max / ultra (immediate paid subscription)", () => {
    for (const tier of ["teams", "max", "ultra"] as const) {
      const f = buildCheckoutForm({
        priceId: `price_${tier}`,
        seats: SEAT_BOUNDS[tier].min,
        bounds: SEAT_BOUNDS[tier],
        tier,
        billingPeriod: "monthly",
        installationId: 987654,
        customerId: "cus_ABC",
        successUrl: "https://app.sigilix.ai/org?checkout=success",
        cancelUrl: "https://app.sigilix.ai/org?checkout=cancel",
        expiresAtEpochSeconds,
      })
      expect(f.has("subscription_data[trial_period_days]")).toBe(false)
      expect(f.get("subscription_data[trial_period_days]")).toBeNull()
    }
  })

  it("sets client_reference_id AND subscription metadata to the installation id", () => {
    expect(form.get("client_reference_id")).toBe("987654")
    expect(form.get("subscription_data[metadata][installation_id]")).toBe("987654")
    expect(form.get("subscription_data[metadata][billing_period]")).toBe("monthly")
  })

  it("carries the price, quantity, and adjustable-quantity bounds", () => {
    expect(form.get("mode")).toBe("subscription")
    expect(form.get("line_items[0][price]")).toBe("price_teams")
    expect(form.get("line_items[0][quantity]")).toBe("12")
    expect(form.get("line_items[0][adjustable_quantity][enabled]")).toBe("true")
    expect(form.get("line_items[0][adjustable_quantity][minimum]")).toBe("10")
    expect(form.get("line_items[0][adjustable_quantity][maximum]")).toBe("150")
  })

  it("reuses the resolved customer and sets the redirect URLs", () => {
    expect(form.get("customer")).toBe("cus_ABC")
    expect(form.get("success_url")).toBe("https://app.sigilix.ai/org?checkout=success")
    expect(form.get("cancel_url")).toBe("https://app.sigilix.ai/org?checkout=cancel")
    expect(form.get("expires_at")).toBe(String(expiresAtEpochSeconds))
  })

  it("keeps intent identity stable across attempt expiries but changes for purchase semantics", async () => {
    const base = {
      priceId: "price_pro",
      seats: 1,
      bounds: SEAT_BOUNDS.pro,
      tier: "pro" as const,
      billingPeriod: "monthly" as const,
      installationId: 987654,
      customerId: "cus_ABC",
      successUrl: "https://app.sigilix.ai/org?checkout=success",
      cancelUrl: "https://app.sigilix.ai/org?checkout=cancel",
      expiresAtEpochSeconds,
    }
    const original = await fingerprintCheckoutIntent(base)
    const laterExpiry = await fingerprintCheckoutIntent({ ...base, expiresAtEpochSeconds: expiresAtEpochSeconds + 600 })
    const changedSeats = await fingerprintCheckoutIntent({ ...base, seats: 2 })

    expect(original).toMatch(/^[0-9a-f]{64}$/)
    expect(laterExpiry).toBe(original)
    expect(changedSeats).not.toBe(original)
  })
})
