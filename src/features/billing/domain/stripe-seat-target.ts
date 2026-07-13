import { SEAT_BOUNDS, type BillingPeriod, type PaidTier } from "./checkout-session"
import type { PriceTierConfig } from "./stripe-events"

export interface StripeSubscriptionItemRecurring {
  interval: string
  intervalCount: number
  usageType: string
}

export interface StripeSubscriptionItemPriceSummary {
  id: string
  lookupKey: string | null
  nickname: string | null
  recurring: StripeSubscriptionItemRecurring
}

/** The complete Stripe subscription-item shape required to identify a safe seat target. */
export interface StripeSubscriptionItemSummary {
  id: string
  quantity: number
  price: StripeSubscriptionItemPriceSummary
}

export type StripeSeatTargetBlockReason =
  | "subscription_not_active"
  | "duplicate_configured_price_id"
  | "no_matching_subscription_item"
  | "multiple_matching_subscription_items"
  | "invalid_subscription_item"
  | "price_cadence_mismatch"
  | "price_not_licensed"
  | "quantity_out_of_bounds"

export interface StripeSeatTarget {
  subscriptionItemId: string
  priceId: string
  quantity: number
  tier: PaidTier
  billingPeriod: BillingPeriod
}

export type StripeSeatTargetResolution =
  | { kind: "resolved"; target: StripeSeatTarget }
  | { kind: "blocked"; reason: StripeSeatTargetBlockReason }

interface ConfiguredPrice {
  priceId: string
  tier: PaidTier
  billingPeriod: BillingPeriod
}

function configuredPrices(config: PriceTierConfig): ConfiguredPrice[] {
  const candidates: Array<{ value: unknown; tier: PaidTier; billingPeriod: BillingPeriod }> = [
    { value: config.pro, tier: "pro", billingPeriod: "monthly" },
    { value: config.teams, tier: "teams", billingPeriod: "monthly" },
    { value: config.max, tier: "max", billingPeriod: "monthly" },
    { value: config.ultra, tier: "ultra", billingPeriod: "monthly" },
    { value: config.proAnnual, tier: "pro", billingPeriod: "annual" },
    { value: config.teamsAnnual, tier: "teams", billingPeriod: "annual" },
    { value: config.maxAnnual, tier: "max", billingPeriod: "annual" },
    { value: config.ultraAnnual, tier: "ultra", billingPeriod: "annual" },
  ]
  return candidates.flatMap((candidate) =>
    typeof candidate.value === "string" && candidate.value.length > 0
      ? [{ priceId: candidate.value, tier: candidate.tier, billingPeriod: candidate.billingPeriod }]
      : [],
  )
}

function cadenceMatches(item: StripeSubscriptionItemSummary, billingPeriod: BillingPeriod): boolean {
  const { interval, intervalCount } = item.price.recurring
  return billingPeriod === "monthly"
    ? interval === "month" && intervalCount === 1
    : interval === "year" && intervalCount === 1
}

/**
 * Resolve the single Stripe subscription item Sigilix may resize. Price-id equality is
 * authoritative: lookup keys and nicknames are display/fallback metadata, never a billing
 * target. Unrelated add-ons are ignored; every ambiguity fails closed.
 */
export function resolveStripeSeatTarget(args: {
  subscriptionStatus: unknown
  priceConfig: PriceTierConfig
  items: readonly StripeSubscriptionItemSummary[]
}): StripeSeatTargetResolution {
  if (args.subscriptionStatus !== "active" && args.subscriptionStatus !== "trialing") {
    return { kind: "blocked", reason: "subscription_not_active" }
  }

  const configured = configuredPrices(args.priceConfig)
  const seen = new Set<string>()
  for (const entry of configured) {
    if (seen.has(entry.priceId)) return { kind: "blocked", reason: "duplicate_configured_price_id" }
    seen.add(entry.priceId)
  }

  const matches = args.items.flatMap((item) => {
    const config = configured.find((entry) => entry.priceId === item.price.id)
    return config ? [{ item, config }] : []
  })
  if (matches.length === 0) return { kind: "blocked", reason: "no_matching_subscription_item" }
  if (matches.length !== 1) return { kind: "blocked", reason: "multiple_matching_subscription_items" }

  const match = matches[0]
  // `noUncheckedIndexedAccess` deliberately keeps this defensive boundary explicit even
  // after the runtime length check above.
  if (!match) return { kind: "blocked", reason: "no_matching_subscription_item" }
  const { item, config } = match
  // Defense in depth for direct domain callers; the Stripe adapter performs the same check.
  if (typeof item.id !== "string" || item.id.length === 0) {
    return { kind: "blocked", reason: "invalid_subscription_item" }
  }
  if (!cadenceMatches(item, config.billingPeriod)) {
    return { kind: "blocked", reason: "price_cadence_mismatch" }
  }
  if (item.price.recurring.usageType !== "licensed") {
    return { kind: "blocked", reason: "price_not_licensed" }
  }
  const bounds = SEAT_BOUNDS[config.tier]
  if (!Number.isSafeInteger(item.quantity) || item.quantity < bounds.min || item.quantity > bounds.max) {
    return { kind: "blocked", reason: "quantity_out_of_bounds" }
  }

  return {
    kind: "resolved",
    target: {
      subscriptionItemId: item.id,
      priceId: item.price.id,
      quantity: item.quantity,
      tier: config.tier,
      billingPeriod: config.billingPeriod,
    },
  }
}
