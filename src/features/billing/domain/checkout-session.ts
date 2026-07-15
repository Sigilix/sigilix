// sig-stripe-checkout: PURE construction + validation of a Stripe Checkout Session
// for a paid Sigilix subscription. No IO — the adapter resolves the session/admin
// gate, the Stripe customer, and POSTs the built form to Stripe.
//
// Recall-safety / anti-spoof is enforced by the ADAPTER (it only ever passes a
// server-verified installation id here). This file's job is the deterministic,
// unit-testable shape: which tiers are purchasable, the per-tier seat bounds, and
// the exact Stripe form fields (the Pro-only 14-day trial, client_reference_id=the
// installation, adjustable_quantity min/max) — so those invariants are provable in
// isolation and can never silently drift.

import type { PriceTierConfig } from "@/src/features/billing/domain/stripe-events"

/** The tiers a customer can actually subscribe to (free/enterprise are NOT purchasable here). */
export type PaidTier = "pro" | "teams" | "max" | "ultra"

/** The Stripe Price cadence selected by the buyer. */
export type BillingPeriod = "monthly" | "annual"

/** Per-tier seat bounds enforced SERVER-SIDE (never trust the client). Teams is a
 *  team plan — a minimum of 10 seats, capped at 150; the individual tiers start at 1. */
export interface SeatBounds {
  min: number
  max: number
}

export const SEAT_BOUNDS: Record<PaidTier, SeatBounds> = {
  pro: { min: 1, max: 500 },
  teams: { min: 10, max: 150 },
  max: { min: 1, max: 500 },
  ultra: { min: 1, max: 500 },
}

const PAID_TIERS: readonly PaidTier[] = ["pro", "teams", "max", "ultra"]

/** True for a tier a customer may check out. Narrows unknown/free/enterprise out. */
export function isPaidTier(v: unknown): v is PaidTier {
  return typeof v === "string" && (PAID_TIERS as readonly string[]).includes(v)
}

/** The free-trial length, in days, granted for a subscription (0 = no trial). */
export const TRIAL_PERIOD_DAYS = 14

/**
 * Trial days for a resolved paid tier. The 14-day trial is Pro-ONLY: Teams / Max /
 * Ultra go straight to a paid subscription (0 days → no `trial_period_days` on the
 * Stripe form). This is the AUTHORITATIVE gate — a client that spoofs a trial intent
 * for a non-pro plan still gets 0 here, because the tier is derived server-side from
 * the validated checkout request. Fail toward "no trial": anything but `pro` → 0.
 */
export function trialDaysForTier(tier: PaidTier): number {
  return tier === "pro" ? TRIAL_PERIOD_DAYS : 0
}

/** A validated checkout request, or a typed rejection carrying the HTTP status. */
export type CheckoutValidation =
  | {
      ok: true
      tier: PaidTier
      seats: number
      bounds: SeatBounds
      billingPeriod: BillingPeriod
      /** True only for the Worker-first compatibility path where the field was absent. */
      billingPeriodDefaulted: boolean
    }
  | { ok: false; status: 400; error: string }

/**
 * Validate the request body into a purchasable {tier, seats}. Rejects a
 * non-purchasable tier (free/enterprise/unknown) and any seat count that is not an
 * integer within the tier's bounds. When `seats` is omitted it defaults to the
 * tier minimum (so a bare `{tier:"teams"}` is a valid 10-seat checkout).
 */
export function validateCheckoutRequest(body: {
  tier?: unknown
  seats?: unknown
  billingPeriod?: unknown
}): CheckoutValidation {
  const { tier } = body
  if (!isPaidTier(tier)) {
    return { ok: false, status: 400, error: "invalid_tier" }
  }
  const bounds = SEAT_BOUNDS[tier]

  const billingPeriodDefaulted = body.billingPeriod === undefined
  let billingPeriod: BillingPeriod
  if (billingPeriodDefaulted) {
    billingPeriod = "monthly"
  } else if (body.billingPeriod === "monthly" || body.billingPeriod === "annual") {
    billingPeriod = body.billingPeriod
  } else {
    return { ok: false, status: 400, error: "invalid_billing_period" }
  }

  const rawSeats = body.seats
  let seats: number
  if (rawSeats === undefined || rawSeats === null) {
    seats = bounds.min
  } else if (typeof rawSeats === "number" && Number.isInteger(rawSeats)) {
    seats = rawSeats
  } else {
    return { ok: false, status: 400, error: "invalid_seats" }
  }

  if (seats < bounds.min || seats > bounds.max) {
    return { ok: false, status: 400, error: "seats_out_of_range" }
  }
  return { ok: true, tier, seats, bounds, billingPeriod, billingPeriodDefaulted }
}

/**
 * Resolve a purchasable tier to its configured Stripe price id (reusing the SAME
 * env-config the webhook maps prices back FROM, so the two directions can never
 * disagree). Returns null when the founder hasn't set that tier's price id — the
 * caller returns 503 rather than guessing.
 */
export function resolvePriceForTier(tier: PaidTier, billingPeriod: BillingPeriod, cfg: PriceTierConfig): string | null {
  const annualKey = `${tier}Annual` as const
  const id = billingPeriod === "annual" ? cfg[annualKey] : cfg[tier]
  return typeof id === "string" && id.length > 0 ? id : null
}

export interface CheckoutFormInput {
  priceId: string
  seats: number
  bounds: SeatBounds
  /** The validated, server-derived tier — decides trial eligibility (Pro-only). */
  tier: PaidTier
  /** The validated Stripe Price cadence, recorded as operational subscription metadata. */
  billingPeriod: BillingPeriod
  /** SERVER-VERIFIED installation id (admin-gated) — the anti-spoof link the webhook reads. */
  installationId: number
  /** The Stripe customer carrying metadata[installation_id] — resolved/created by the adapter. */
  customerId: string
  successUrl: string
  cancelUrl: string
  /** Server-generated absolute Stripe Session expiry (Unix seconds). */
  expiresAtEpochSeconds: number
}

/**
 * Stable semantic identity for one Checkout intent. Attempt identity and provider
 * expiry are deliberately excluded so a stale lease can replay the winner's exact
 * stored request instead of looking like a different purchase.
 */
export async function fingerprintCheckoutIntent(input: CheckoutFormInput): Promise<string> {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    installationId: input.installationId,
    customerId: input.customerId,
    priceId: input.priceId,
    tier: input.tier,
    billingPeriod: input.billingPeriod,
    seats: input.seats,
    minimumSeats: input.bounds.min,
    maximumSeats: input.bounds.max,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Build the x-www-form-urlencoded body for `POST /v1/checkout/sessions`. Every
 * value is a string (Stripe's form API); nested params use Stripe's bracket
 * notation. The three security-critical fields — client_reference_id (the
 * installation), subscription_data[metadata][installation_id], and the adjustable
 * quantity bounds — are set HERE from the validated/verified inputs only.
 */
export function buildCheckoutForm(input: CheckoutFormInput): URLSearchParams {
  if (!Number.isSafeInteger(input.expiresAtEpochSeconds) || input.expiresAtEpochSeconds <= 0) {
    throw new Error("invalid checkout expiry")
  }
  const form = new URLSearchParams()
  form.set("mode", "subscription")
  form.set("line_items[0][price]", input.priceId)
  form.set("line_items[0][quantity]", String(input.seats))
  // Let the buyer nudge the seat count on Stripe's page, but pin the same bounds we
  // validated server-side so they can't drop Teams below 10 or past 150.
  form.set("line_items[0][adjustable_quantity][enabled]", "true")
  form.set("line_items[0][adjustable_quantity][minimum]", String(input.bounds.min))
  form.set("line_items[0][adjustable_quantity][maximum]", String(input.bounds.max))
  // Pro-ONLY 14-day trial → the subscription lands 'trialing' → the trial-cap layer
  // serves HALF volume until it converts to 'active' (already wired in the webhook).
  // Teams / Max / Ultra get 0 days here, so NO `trial_period_days` is sent and the
  // subscription is paid immediately. Derived from the server-validated tier, so a
  // spoofed client trial intent for a non-pro plan can never grant a trial.
  const trialDays = trialDaysForTier(input.tier)
  if (trialDays > 0) {
    form.set("subscription_data[trial_period_days]", String(trialDays))
  }
  form.set("subscription_data[metadata][installation_id]", String(input.installationId))
  form.set("subscription_data[metadata][billing_period]", input.billingPeriod)
  // The anti-spoof link the webhook reads FIRST (server-side, never from the body).
  form.set("client_reference_id", String(input.installationId))
  form.set("customer", input.customerId)
  form.set("success_url", input.successUrl)
  form.set("cancel_url", input.cancelUrl)
  form.set("expires_at", String(input.expiresAtEpochSeconds))
  return form
}
