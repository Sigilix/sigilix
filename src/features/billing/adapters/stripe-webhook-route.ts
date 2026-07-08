// SIG-41: POST /stripe/webhook — Stripe subscription events drive tenant.tier.
//
// Flow (mirrors the GitHub webhook's shape — 503 when unconfigured, verify → 400,
// bad JSON → 400):
//   1. No SIGILIX_STRIPE_WEBHOOK_SECRET → 503 "stripe not configured" (never 500).
//   2. Verify the Stripe-Signature over the RAW body (async Web Crypto HMAC + replay
//      tolerance). Invalid → 400, body NEVER processed.
//   3. Idempotency: a re-delivered event.id (Stripe retries) → 200 ack, no re-apply.
//   4. Interpret the event (pure). Ignore → 200 ack.
//   5. Resolve the tenant: installation_id from the event, else the KV customer link.
//      Absent → log + record an orphan + 200 ack (NEVER upgrade a random tenant).
//   6. Persist the customer↔installation link when both are known.
//   7. On a resolved tier, UPSERT tenant.tier (the resolve-plan seam). A genuine D1
//      write failure returns 500 (unmarked) so Stripe redelivers; success marks the
//      event processed and returns 200.
//
// Recall-safety: a paid tier is only ever written for a signature-verified event whose
// interpretation produced a paid tier (active/trialing + mapped price) AND a resolved
// installation. Everything else either downgrades to free or no-ops.

import type { Env } from "@/src/shared/types/env"
import { verifyStripeSignature } from "@/src/features/billing/adapters/verify-stripe-signature"
import {
  interpretStripeEvent,
  type BillingTier,
  type PriceTierConfig,
  type StripeEvent,
} from "@/src/features/billing/domain/stripe-events"
import {
  linkCustomerToInstallation,
  markStripeEventProcessed,
  recordOrphanEvent,
  resolveInstallationForCustomer,
  wasStripeEventProcessed,
} from "@/src/features/billing/adapters/stripe-link-store"
import { upsertTenantTier } from "@/src/features/tenancy"

/** Guard against an absurd body (Stripe events are well under this). */
const MAX_BODY_BYTES = 1024 * 1024

/** Resolve the env-configured Stripe price-id → tier map (SIGILIX_-preferred via shim). */
export function resolvePriceTierConfig(env: Env): PriceTierConfig {
  return {
    pro: env.SIGILIX_STRIPE_PRICE_PRO,
    max: env.SIGILIX_STRIPE_PRICE_MAX,
    ultra: env.SIGILIX_STRIPE_PRICE_ULTRA,
  }
}

export async function handleStripeWebhookRoute(request: Request, env: Env): Promise<Response> {
  const secret = env.SIGILIX_STRIPE_WEBHOOK_SECRET
  if (!secret) {
    return new Response("stripe not configured\n", { status: 503 })
  }

  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return new Response("payload too large\n", { status: 413 })
  }

  const verified = await verifyStripeSignature({
    rawBody,
    signatureHeader: request.headers.get("stripe-signature"),
    secret,
  })
  if (!verified) {
    return new Response("invalid signature\n", { status: 400 })
  }

  let event: StripeEvent
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    return new Response("invalid json\n", { status: 400 })
  }

  const eventId = typeof event.id === "string" && event.id.length > 0 ? event.id : null
  const eventType = typeof event.type === "string" ? event.type : "unknown"

  // Idempotency — a Stripe retry of an already-applied event acks without re-applying.
  if (eventId && (await wasStripeEventProcessed(env, eventId))) {
    return new Response("duplicate\n", { status: 200 })
  }

  const interpretation = interpretStripeEvent(event, resolvePriceTierConfig(env))
  if (interpretation.kind === "ignore") {
    if (eventId) await markStripeEventProcessed(env, eventId)
    return new Response("ignored\n", { status: 200 })
  }

  const { customerId } = interpretation
  const eventInstallationId = interpretation.installationId

  // Look up any EXISTING customer→installation link first. A storage ERROR here is NOT
  // "no link": treating it as such could silently drop a downgrade (subscription.deleted
  // / payment_failed carry only the customer), so we 500 (unmarked) and let Stripe retry.
  let existingLink: number | null = null
  if (customerId) {
    const linkRes = await resolveInstallationForCustomer(env, customerId)
    if (linkRes.kind === "error") {
      console.error(
        JSON.stringify({ event: "stripe-webhook-link-read-error", type: eventType, stripeEventId: eventId }),
      )
      return new Response("link store unavailable\n", { status: 500 })
    }
    existingLink = linkRes.kind === "hit" ? linkRes.installationId : null
  }

  // Conflict guard: a signed event naming a DIFFERENT installation than the one already
  // linked to this customer must NEVER rebind the customer or upgrade/downgrade the
  // wrong tenant. Record for reconcile + ack (redelivery can't resolve a data conflict).
  if (existingLink !== null && eventInstallationId !== null && existingLink !== eventInstallationId) {
    console.warn(
      JSON.stringify({
        event: "stripe-webhook-installation-conflict",
        type: eventType,
        customerId,
        existingInstallationId: existingLink,
        eventInstallationId,
        stripeEventId: eventId,
      }),
    )
    if (eventId) {
      await recordOrphanEvent(env, eventId, { type: eventType, customerId })
      await markStripeEventProcessed(env, eventId)
    }
    return new Response("installation conflict\n", { status: 200 })
  }

  // Prefer the event-carried installation (authoritative on the first checkout that
  // establishes the link); otherwise fall back to the existing link.
  const installationId = eventInstallationId ?? existingLink

  // Establish the link only when it is NEW (existingLink === null). We never overwrite a
  // differing link — that case is the conflict handled above; a matching one needs no write.
  if (customerId && installationId !== null && existingLink === null) {
    await linkCustomerToInstallation(env, customerId, installationId)
  }

  // No tenant → we CANNOT safely touch any tier. Record for reconcile + ack (a Stripe
  // redelivery would never resolve it; the missing link is a checkout-flow follow-up).
  if (installationId === null) {
    console.warn(
      JSON.stringify({ event: "stripe-webhook-no-installation", type: eventType, customerId, stripeEventId: eventId }),
    )
    if (eventId) {
      await recordOrphanEvent(env, eventId, { type: eventType, customerId })
      await markStripeEventProcessed(env, eventId)
    }
    return new Response("no installation link\n", { status: 200 })
  }

  const tier: BillingTier | null = interpretation.tier
  if (tier === null) {
    // Link-only event (e.g. checkout.session.completed, or an active-but-unmapped
    // price). The paired subscription.* event carries the tier; no write here.
    if (eventId) await markStripeEventProcessed(env, eventId)
    return new Response("linked\n", { status: 200 })
  }

  const nowIso = new Date().toISOString()
  // sig-trial-cap: persist the subscription status alongside the tier so the caps layer
  // resolves FULL (active) vs HALF (trialing/unknown) volume. Co-written in one UPSERT so
  // a trial→active conversion can never leave a stale 'trialing' behind the new tier.
  const result = await upsertTenantTier(env, installationId, tier, nowIso, interpretation.subscriptionStatus)
  if (!result.ok) {
    // Genuine write failure — DON'T mark processed; 500 so Stripe redelivers.
    console.error(JSON.stringify({ event: "stripe-webhook-tier-upsert-failed", type: eventType, installationId, tier }))
    return new Response("tier upsert failed\n", { status: 500 })
  }

  console.log(
    JSON.stringify({
      event: "stripe-webhook-tier-applied",
      type: eventType,
      installationId,
      tier,
      stripeEventId: eventId,
    }),
  )
  if (eventId) await markStripeEventProcessed(env, eventId)
  return new Response("ok\n", { status: 200 })
}
