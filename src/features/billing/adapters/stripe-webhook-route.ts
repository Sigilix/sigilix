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
  mapPriceToTier,
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
import {
  enforceSingleActiveSubscription,
  findActiveSurvivor,
} from "@/src/features/billing/adapters/enforce-single-subscription"
import { upsertTenantTier, readTenantBillingGuard } from "@/src/features/tenancy"

/** Guard against an absurd body (Stripe events are well under this). */
const MAX_BODY_BYTES = 1024 * 1024

/** Resolve the env-configured Stripe price-id → tier map (SIGILIX_-preferred via shim). */
export function resolvePriceTierConfig(env: Env): PriceTierConfig {
  return {
    pro: env.SIGILIX_STRIPE_PRICE_PRO,
    teams: env.SIGILIX_STRIPE_PRICE_TEAMS,
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

  let tier: BillingTier | null = interpretation.tier
  let subscriptionStatus = interpretation.subscriptionStatus

  // sig-billing-dup-sub-guard: enforce one active/trialing subscription per Stripe
  // customer at the webhook (the authoritative point). Two checkout URLs completed before
  // the first webhook fires leave two active subs on ONE customer, because the checkout
  // 409 reads a status that is only written AFTER a webhook lands. Skipped entirely when
  // the outbound Stripe key is unset (behaviour unchanged).
  const outboundSecret = env.SIGILIX_STRIPE_SECRET_KEY
  // Every event that can WRITE a paid tier from an active/trialing subscription —
  // subscription.created/updated, plus a checkout.session.completed / invoice.paid that
  // carries an EXPANDED active subscription. All must route through the dedupe guard so a
  // stale duplicate event can never bypass it and set the cancelled duplicate's tier.
  const carriesSubscription =
    eventType === "customer.subscription.created" ||
    eventType === "customer.subscription.updated" ||
    eventType === "checkout.session.completed" ||
    eventType === "invoice.paid"
  const isActiveSubEvent = carriesSubscription && (subscriptionStatus === "active" || subscriptionStatus === "trialing")
  // Any event that would DROP the tenant to free: a deleted sub, a sub gone non-active, OR
  // a failed invoice. All must be checked against the live survivor — a downgrade for a
  // duplicate (e.g. a cancel that failed, or a payment_failed racing the cancellation) must
  // never drop a tenant whose older subscription still bills.
  const isDowngradeEvent =
    tier === "free" &&
    (eventType === "customer.subscription.deleted" ||
      eventType === "customer.subscription.updated" ||
      eventType === "invoice.payment_failed")

  if (customerId && outboundSecret && isActiveSubEvent) {
    // Active/trialing sub event → KEEP THE OLDEST live subscription and cancel the newer
    // duplicate(s). The SURVIVING (oldest) sub is authoritative for tier/status.
    const dedupe = await enforceSingleActiveSubscription(outboundSecret, customerId)
    if (dedupe.listFailed) {
      // The authoritative list is unavailable → we CANNOT tell this event from a stale
      // duplicate. FAIL CLOSED (500 → Stripe redelivers) rather than persist a possibly
      // cancelled duplicate's tier — symmetric with the downgrade branch below.
      console.error(
        JSON.stringify({
          event: "stripe-webhook-dedupe-list-failed",
          type: eventType,
          customerId,
          stripeEventId: eventId,
        }),
      )
      return new Response("subscription list unavailable\n", { status: 500 })
    }
    if (!dedupe.survivor) {
      // The list SUCCEEDED but shows no active/trialing subscription for this customer →
      // this active payload is STALE (the sub was cancelled). Do NOT (re)grant a paid tier:
      // leave the tenant UNCHANGED (link-only) rather than trust the stale event. The
      // authoritative downgrade rides its own subscription.deleted / payment_failed.
      tier = null
    } else if (dedupe.canceledIds.length > 0 || dedupe.survivor.id !== interpretation.subscriptionId) {
      // This event's own subscription is NOT the survivor (a duplicate we just cancelled, or
      // one an earlier delivery already cancelled) → drive tier/status from the survivor,
      // never the cancelled/stale duplicate. An unmapped survivor price yields tier null
      // (link-only → tenant left UNCHANGED); never fall back to the dup's tier.
      tier = mapPriceToTier(dedupe.survivor.price ?? undefined, resolvePriceTierConfig(env))
      subscriptionStatus = dedupe.survivor.status
    }
    // else: the survivor IS this event's subscription → keep the interpreted tier (the
    // single-subscription happy path is unchanged).
  } else if (customerId && outboundSecret && isDowngradeEvent) {
    // Downgrade event (a subscription deleted / gone non-active, or a failed invoice). Do
    // NOT drop the tenant to free while an OLDER subscription still bills — e.g. the paired
    // deletion of a duplicate we cancelled, or a payment failure on that duplicate. Reaffirm
    // the surviving sub's tier instead. A list failure fails CLOSED (500 → Stripe redelivers)
    // so a transient error can never wrongly downgrade a payer.
    const found = await findActiveSurvivor(outboundSecret, customerId)
    if (found.listFailed) {
      console.error(
        JSON.stringify({
          event: "stripe-webhook-survivor-list-failed",
          type: eventType,
          customerId,
          stripeEventId: eventId,
        }),
      )
      return new Response("subscription list unavailable\n", { status: 500 })
    }
    if (found.survivor) {
      // An active/trialing survivor exists → keep its tier (mapped), or leave the tenant
      // UNCHANGED (tier null → link-only below) when its price is unmapped — never drop it.
      tier = mapPriceToTier(found.survivor.price ?? undefined, resolvePriceTierConfig(env))
      subscriptionStatus = found.survivor.status
    }
    // No survivor → the interpreted downgrade to free stands (a genuine cancellation).
  }

  if (tier === null) {
    // Link-only event (e.g. checkout.session.completed, or an active-but-unmapped
    // price). The paired subscription.* event carries the tier; no write here.
    if (eventId) await markStripeEventProcessed(env, eventId)
    return new Response("linked\n", { status: 200 })
  }

  const nowIso = new Date().toISOString()
  // sig-github-marketplace-billing: reciprocal clobber-guard. If this tenant is currently a
  // paying GitHub Marketplace subscriber (source github_marketplace + active/trialing), a
  // Stripe event — especially a stale/late `subscription.deleted` / `payment_failed` for an
  // OLD Stripe link the org left behind — must NOT overwrite the live Marketplace tier or
  // re-stamp the source. Log + ack (mark processed so Stripe doesn't redeliver). Fail-open:
  // a null guard (unknown state) never blocks a legitimate Stripe write.
  const mpGuard = await readTenantBillingGuard(env, installationId)
  if (
    mpGuard?.billingSource === "github_marketplace" &&
    (mpGuard.subscriptionStatus === "active" || mpGuard.subscriptionStatus === "trialing")
  ) {
    console.warn(
      JSON.stringify({ event: "stripe-webhook-marketplace-active-skip", type: eventType, installationId, tier }),
    )
    if (eventId) await markStripeEventProcessed(env, eventId)
    return new Response("marketplace active not clobbered\n", { status: 200 })
  }
  // sig-trial-cap: persist the subscription status alongside the tier so the caps layer
  // resolves FULL (active) vs HALF (trialing/unknown) volume. Co-written in one UPSERT so
  // a trial→active conversion can never leave a stale 'trialing' behind the new tier.
  // sig-github-marketplace-billing: stamp billing_source='stripe' so a GitHub Marketplace
  // event can recognise (and refuse to clobber) an active Stripe payer.
  const result = await upsertTenantTier(env, installationId, tier, nowIso, subscriptionStatus, "stripe")
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
