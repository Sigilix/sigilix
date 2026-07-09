// SIG-41 (Stripe paid tier) — feature barrel. External callers import from HERE only
// (COMPLIANCE §2). The public surface is the inbound webhook route + the outbound
// Stripe helpers the checkout route (src/lib/billing-checkout-route.ts) composes:
// price-config, the pure checkout builder/validator, the Stripe REST calls, and the
// customer↔installation link store.
export { handleStripeWebhookRoute, resolvePriceTierConfig } from "./adapters/stripe-webhook-route"
// sig-admin-metrics: the admin metrics reader (src/lib/admin/stripe-admin.ts) maps a
// listed subscription's price → Sigilix tier for the per-tier revenue rollup, using
// the SAME mapping the webhook uses. Exposed here so that cross-feature read goes
// through the barrel (COMPLIANCE §2) rather than reaching into domain/stripe-events.
export { mapPriceToTier, type PriceTierConfig } from "./domain/stripe-events"
export {
  validateCheckoutRequest,
  resolvePriceForTier,
  buildCheckoutForm,
  type PaidTier,
} from "./domain/checkout-session"
export { createStripeCustomer, createCheckoutSession, createBillingPortalSession } from "./adapters/stripe-api"
export { linkCustomerToInstallation, resolveCustomerForInstallation } from "./adapters/stripe-link-store"
