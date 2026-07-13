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
  type BillingPeriod,
} from "./domain/checkout-session"
export { createStripeCustomer, createCheckoutSession, createBillingPortalSession } from "./adapters/stripe-api"
export { linkCustomerToInstallation, resolveCustomerForInstallation } from "./adapters/stripe-link-store"
// sig-github-marketplace-billing: GitHub Marketplace subscription path — the webhook
// handler (dispatched from the GitHub webhook entry on X-GitHub-Event:
// marketplace_purchase) + the install-time purchase-before-install reconcile.
export {
  handleMarketplacePurchaseEvent,
  reconcileMarketplaceSubscriptionOnInstall,
  MARKETPLACE_BILLING_SOURCE,
} from "./adapters/marketplace-webhook"
export {
  resolveMarketplaceTier,
  parseMarketplacePlanMap,
  extractSeats,
  interpretMarketplaceEvent,
  type MarketplaceTier,
  type MarketplacePlanMap,
  type MarketplaceEvent,
} from "./domain/marketplace-plan"
// Stripe seat reconciliation foundation. These are tenant-bound D1 reads and
// the atomic lease primitive only; provider mutation remains a later slice.
export {
  acquireOrgSeatBillingLease,
  deriveBillableSeatQuantity,
  ensureSeatReconciliationTenant,
  readActiveOrgSeatBillingOperation,
  readStripeCustomerBinding,
  readStripeInstallationBinding,
  readStripeSeatSubscription,
  readTenantBillingState,
  releaseOrgSeatBillingLease,
  writeStripeSeatSubscriptionSnapshot,
  type StripeSeatSubscriptionSnapshotWrite,
  type StripeSeatSubscriptionSnapshotWriteResult,
} from "./adapters/d1-seat-reconciliation-store"
export {
  decodeStripeSeatSubscriptionRow,
  decodeOrgSeatBillingOperationRow,
  type OrgSeatBillingOperation,
  type OrgSeatBillingOperationState,
  type StripeSeatSubscriptionSnapshot,
  type StripeSnapshotState,
  type TenantBillingState,
} from "./domain/seat-reconciliation"
