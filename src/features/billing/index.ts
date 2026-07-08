// SIG-41 (Stripe paid tier) — feature barrel. External callers import from HERE only
// (COMPLIANCE §2). The public surface is the inbound webhook route + the outbound
// Stripe helpers the checkout route (src/lib/billing-checkout-route.ts) composes:
// price-config, the pure checkout builder/validator, the Stripe REST calls, and the
// customer↔installation link store.
export { handleStripeWebhookRoute, resolvePriceTierConfig } from "./adapters/stripe-webhook-route"
export {
  validateCheckoutRequest,
  resolvePriceForTier,
  buildCheckoutForm,
  type PaidTier,
} from "./domain/checkout-session"
export { createStripeCustomer, createCheckoutSession, createBillingPortalSession } from "./adapters/stripe-api"
export { linkCustomerToInstallation, resolveCustomerForInstallation } from "./adapters/stripe-link-store"
