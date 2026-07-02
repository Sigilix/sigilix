// SIG-298 follow-on — SDK guidance pack: Stripe. Self-authored from Stripe's
// public docs (stripe.com/docs). NOT a partner integration — no endorsement
// claim, no logo; the label is "SDK guidance."

import type { SdkPack } from "@/src/lib/sdk-packs/types"

const DOCS_URL = "https://stripe.com/docs"

export const stripePack: SdkPack = {
  id: "stripe",
  vendor: "Stripe",
  docsUrl: DOCS_URL,
  matchers: {
    packages: ["stripe", "@stripe/stripe-js", "@stripe/react-stripe-js"],
    importPatterns: [/from\s+["']stripe["']/, /require\(\s*["']stripe["']\s*\)/, /from\s+["']@stripe\//],
  },
  rules: [
    {
      id: "webhook-signature-verification",
      title: "Webhook signature verification",
      guidance:
        "Every webhook handler must verify the payload with `stripe.webhooks.constructEvent` using the raw request body and the `Stripe-Signature` header before trusting the event — parsing `req.body` as JSON first (common with body-parser/Next.js API routes) breaks signature verification and lets anyone POST a forged event.",
      severityHint: "P1",
      docsUrl: "https://stripe.com/docs/webhooks/signatures",
    },
    {
      id: "webhook-idempotency-on-replay",
      title: "Webhook handlers must be idempotent",
      guidance:
        "Stripe retries webhook delivery on any non-2xx response, so a handler that isn't idempotent (e.g. always inserts a new order row, always increments a credit balance) will double-process on retry — key side effects off the event id or a unique object id, not just the event type.",
      severityHint: "P1",
      docsUrl: "https://stripe.com/docs/webhooks#handle-duplicate-events",
    },
    {
      id: "idempotency-keys-on-mutating-calls",
      title: "Idempotency keys on charge/PaymentIntent creation",
      guidance:
        "A client-retried `paymentIntents.create` or `charges.create` without an `idempotencyKey` can create a duplicate charge on a flaky network — mutating API calls triggered by user-facing retries (checkout retry, double-click) should pass a stable idempotency key.",
      severityHint: "P1",
      docsUrl: "https://stripe.com/docs/api/idempotent_requests",
    },
    {
      id: "amounts-are-integer-minor-units",
      title: "Amounts are integer minor units (cents), not decimals",
      guidance:
        "Stripe amounts are integers in the currency's smallest unit (e.g. cents for USD) — passing a float dollar amount (`19.99`) instead of `1999`, or double-converting an amount that's already in cents, is a 100x pricing bug that's easy to miss in review.",
      severityHint: "P1",
      docsUrl: "https://stripe.com/docs/currencies#zero-decimal",
    },
    {
      id: "zero-decimal-currencies",
      title: "Zero-decimal currencies don't multiply by 100",
      guidance:
        'A subset of currencies (JPY, KRW, etc.) are zero-decimal — the smallest unit IS the currency unit, so multiplying by 100 before charging overcharges by 100x. Any generic "amount * 100" helper needs a zero-decimal-currency check.',
      severityHint: "P2",
      docsUrl: "https://stripe.com/docs/currencies#zero-decimal",
    },
    {
      id: "api-version-pinning",
      title: "Pin the Stripe API version explicitly",
      guidance:
        "Initializing the SDK without an explicit `apiVersion` (or letting it silently drift from the Dashboard-configured default) means a Stripe-side API upgrade can change response shapes under you with no code change on your end — pin the version and bump it deliberately.",
      severityHint: "P2",
      docsUrl: "https://stripe.com/docs/api/versioning",
    },
    {
      id: "pii-in-metadata",
      title: "Don't put sensitive PII in metadata",
      guidance:
        "`metadata` fields are plain strings stored unencrypted and often surfaced in dashboards, logs, and exports — avoid writing raw SSNs, full card numbers, or other sensitive PII into `metadata` on Charges, PaymentIntents, or Customers.",
      severityHint: "P2",
      docsUrl: "https://stripe.com/docs/api/metadata",
    },
    {
      id: "never-trust-client-side-amounts",
      title: "Never trust a client-supplied amount",
      guidance:
        "A checkout flow that reads the charge amount from a request body/query param controlled by the browser (instead of recomputing it server-side from the cart/line items) lets an attacker pay whatever they want — the amount must be derived server-side.",
      severityHint: "P1",
      docsUrl: "https://stripe.com/docs/security/guide",
    },
    {
      id: "secret-key-on-client",
      title: "Secret key must never reach client code",
      guidance:
        "The Stripe secret key (`sk_...`) grants full account access and must only be used server-side — bundling it into client JS, a mobile app, or a public env var (e.g. `NEXT_PUBLIC_*`) is a critical credential leak.",
      severityHint: "P1",
      docsUrl: "https://stripe.com/docs/keys",
    },
  ],
}
