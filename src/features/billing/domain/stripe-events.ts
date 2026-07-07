// SIG-41 (Stripe paid tier): PURE interpretation of a Stripe webhook event into a
// billing action against a Sigilix tenant. No IO — the caller (stripe-webhook-route)
// resolves the KV customer↔installation link, persists it, and upserts tenant.tier.
//
// Recall-safety is the whole point of this file: a paid tier is ONLY ever produced
// for an active/trialing subscription that maps to a known price. Any cancellation /
// non-payment / unknown status resolves to "free". A missing installation link never
// yields a tier for a fabricated tenant — the interpreter reports the identifiers it
// can extract and it is the adapter that refuses to write when no installation resolves.
//
// We model only the handful of fields we read; Stripe's payloads are far larger.
// Everything is optional + defensively narrowed because a webhook body is untrusted
// (its signature is verified, but a malformed-but-signed body must not throw).

/** The Sigilix paid/free tiers this webhook drives (subset of tenant.tier's domain). */
export type BillingTier = "free" | "pro" | "max" | "ultra"

/** Env-configured Stripe price ids → Sigilix tier. Any/all may be unset. */
export interface PriceTierConfig {
  pro?: string | undefined
  max?: string | undefined
  ultra?: string | undefined
}

/** The Stripe events we act on; every other event type is acked + ignored. */
export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const

// ─── Minimal Stripe wire shapes (only the fields we read) ────────────────────

interface StripePrice {
  id?: unknown
  lookup_key?: unknown
  nickname?: unknown
}

interface StripeSubscriptionItem {
  price?: StripePrice
}

interface StripeSubscription {
  status?: unknown
  customer?: unknown
  metadata?: Record<string, unknown>
  items?: { data?: StripeSubscriptionItem[] }
}

interface StripeCheckoutSession {
  customer?: unknown
  client_reference_id?: unknown
  metadata?: Record<string, unknown>
  // A string subscription id, OR (when the checkout flow expands `subscription`) the
  // subscription object — only the expanded, active form can set a tier (see header).
  subscription?: unknown
}

interface StripeInvoice {
  customer?: unknown
  // A string subscription id, OR (when expanded by the checkout/portal flow) the
  // subscription object itself — only the expanded, active form can reaffirm a tier.
  subscription?: unknown
  metadata?: Record<string, unknown>
}

/** A parsed Stripe event envelope — `id` + `type` + the object under data.object. */
export interface StripeEvent {
  id?: unknown
  type?: unknown
  data?: { object?: unknown }
}

/** The outcome of interpreting an event: either ignore it, or apply a billing change. */
export type BillingInterpretation =
  | { kind: "ignore"; reason: string }
  | {
      kind: "apply"
      /** Stripe customer id carried by the event (for the KV link), or null. */
      customerId: string | null
      /** installation_id read from the event, or null (adapter falls back to KV). */
      installationId: number | null
      /** Target tenant.tier, or null when this event only establishes the link. */
      tier: BillingTier | null
    }

// ─── helpers ─────────────────────────────────────────────────────────────────

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Parse a metadata/reference installation_id (string or number) into a positive int. */
export function parseInstallationId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number.parseInt(v, 10)
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

function installationFromMetadata(meta: Record<string, unknown> | undefined): number | null {
  if (!meta) return null
  return parseInstallationId(meta.installation_id ?? meta.installationId)
}

/**
 * Map a Stripe price to a Sigilix tier. FIRST by exact configured price-id match
 * (the authoritative signal — the founder pastes each price id into env), THEN a
 * fallback substring match on the price's lookup_key / nickname containing
 * `pro`/`max`/`ultra` (so a correctly-named price still maps before the ids are set).
 * Returns null when nothing matches — the caller must NOT grant a tier on a null.
 */
export function mapPriceToTier(price: StripePrice | undefined, cfg: PriceTierConfig): BillingTier | null {
  if (!price) return null
  const id = asString(price.id)
  if (id) {
    if (cfg.ultra && id === cfg.ultra) return "ultra"
    if (cfg.max && id === cfg.max) return "max"
    if (cfg.pro && id === cfg.pro) return "pro"
  }
  const key = `${asString(price.lookup_key) ?? ""} ${asString(price.nickname) ?? ""}`.toLowerCase()
  // Check highest tier first so "ultra"/"max" win over a generic match. Token match on
  // NON-ALPHANUMERIC delimiters (so underscore-delimited Stripe lookup_keys like
  // `sigilix_pro_monthly` match `pro`, while `approve`/`product`/`maximum` do NOT).
  if (hasTierToken(key, "ultra")) return "ultra"
  if (hasTierToken(key, "max")) return "max"
  if (hasTierToken(key, "pro")) return "pro"
  return null
}

/** True when `word` appears in `key` delimited by a non-letter (or string edge). */
function hasTierToken(key: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(key)
}

/** A subscription status that entitles the mapped paid tier. Everything else → free. */
function isActiveStatus(status: unknown): boolean {
  return status === "active" || status === "trialing"
}

function priceFromSubscription(sub: StripeSubscription): StripePrice | undefined {
  return sub.items?.data?.[0]?.price
}

/** Narrow a `subscription` field to the expanded object form (null for a bare string id). */
function expandedSubscription(v: unknown): StripeSubscription | null {
  return typeof v === "object" && v !== null ? (v as StripeSubscription) : null
}

/**
 * The single, uniform tier-derivation rule (recall-safety core): a paid tier is
 * produced ONLY from an EXPANDED subscription proven active/trialing whose price maps.
 * A bare subscription-id string, a non-active status, or an unmapped price → null.
 */
function tierFromActiveSubscription(sub: StripeSubscription | null, cfg: PriceTierConfig): BillingTier | null {
  return sub && isActiveStatus(sub.status) ? mapPriceToTier(priceFromSubscription(sub), cfg) : null
}

// ─── the interpreter ─────────────────────────────────────────────────────────

/**
 * Interpret a signature-verified Stripe event into a billing action. Never throws on a
 * malformed body — it degrades to `{kind:"ignore"}`. See file header for the
 * recall-safety contract (paid tier only for an active/trialing mapped subscription).
 */
export function interpretStripeEvent(event: StripeEvent, cfg: PriceTierConfig): BillingInterpretation {
  const type = asString(event.type)
  if (!type) return { kind: "ignore", reason: "missing-type" }
  const object = event.data?.object
  if (typeof object !== "object" || object === null) return { kind: "ignore", reason: "missing-object" }

  switch (type) {
    case "checkout.session.completed": {
      const session = object as StripeCheckoutSession
      const customerId = asString(session.customer)
      const sub = expandedSubscription(session.subscription)
      const installationId =
        parseInstallationId(session.client_reference_id) ??
        installationFromMetadata(session.metadata) ??
        (sub ? installationFromMetadata(sub.metadata) : null)
      // Recall-safety: a completed checkout only sets a tier when it carries an EXPANDED
      // active/trialing subscription (the flow does `expand: ['subscription']`). Without
      // that proof this is LINK-ONLY — the paired subscription.created event, which
      // carries the authoritative status, sets the tier.
      const tier = tierFromActiveSubscription(sub, cfg)
      return { kind: "apply", customerId, installationId, tier }
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = object as StripeSubscription
      const customerId = asString(sub.customer)
      const installationId = installationFromMetadata(sub.metadata)
      if (!isActiveStatus(sub.status)) {
        // canceled / unpaid / past_due / incomplete / paused → drop to free.
        return { kind: "apply", customerId, installationId, tier: "free" }
      }
      const tier = mapPriceToTier(priceFromSubscription(sub), cfg)
      // Active but unmapped price → we can't prove which paid tier; DON'T guess a
      // paid tier (recall-safety). Establish the link only.
      return { kind: "apply", customerId, installationId, tier }
    }

    case "customer.subscription.deleted": {
      const sub = object as StripeSubscription
      return {
        kind: "apply",
        customerId: asString(sub.customer),
        installationId: installationFromMetadata(sub.metadata),
        tier: "free",
      }
    }

    case "invoice.paid": {
      const inv = object as StripeInvoice
      const customerId = asString(inv.customer)
      // Recall-safety: a paid invoice does NOT by itself prove the subscription is
      // currently active (a final invoice can post for a canceled sub). Only reaffirm a
      // tier when the invoice carries an EXPANDED active/trialing subscription with a
      // mapped price (same rule as checkout). Otherwise this is link-only (tier null) —
      // the subscription.* events remain the authoritative tier signal.
      const sub = expandedSubscription(inv.subscription)
      const installationId =
        installationFromMetadata(inv.metadata) ?? (sub ? installationFromMetadata(sub.metadata) : null)
      const tier = tierFromActiveSubscription(sub, cfg)
      return { kind: "apply", customerId, installationId, tier }
    }

    case "invoice.payment_failed": {
      const inv = object as StripeInvoice
      // Payment failed → the subscription is past_due; withdraw the paid tier.
      return {
        kind: "apply",
        customerId: asString(inv.customer),
        installationId: installationFromMetadata(inv.metadata),
        tier: "free",
      }
    }

    default:
      return { kind: "ignore", reason: `unhandled:${type}` }
  }
}
