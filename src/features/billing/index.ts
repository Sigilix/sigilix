// SIG-41 (Stripe paid tier) — feature barrel. External callers import from HERE only
// (COMPLIANCE §2). The public surface is the webhook route; index.ts wires it.
export { handleStripeWebhookRoute, resolvePriceTierConfig } from "./adapters/stripe-webhook-route"
