// SIG-41: POST /stripe/webhook — Stripe subscription events drive tenant.tier.
//
// Flow (mirrors the GitHub webhook's shape — 503 when unconfigured, verify → 400,
// bad JSON → 400):
//   1. No SIGILIX_STRIPE_WEBHOOK_SECRET → 503 "stripe not configured" (never 500).
//   2. Verify the Stripe-Signature over the RAW body (async Web Crypto HMAC + replay
//      tolerance). Invalid → 400, body NEVER processed.
//   3. Idempotency: a re-delivered event.id (Stripe retries) → 200 ack, no re-apply.
//   4. Interpret the event (pure). Ignore → 200 ack.
//   5. Resolve the tenant: installation_id from the event, else the D1 customer
//      binding (legacy KV is bootstrap-only before the first snapshot).
//      Absent → log + record an orphan + 200 ack (NEVER upgrade a random tenant).
//   6. With an outbound Stripe key, claim the D1-unique binding, serialize a live
//      subscription/item refresh, and snapshot exact purchased capacity.
//   7. Apply tier + provider snapshot. A genuine D1/provider fault returns 500
//      (unmarked) so Stripe redelivers; success repairs KV and marks the event.
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
  resolveCustomerForInstallation,
  resolveInstallationForCustomer,
  wasStripeEventProcessed,
} from "@/src/features/billing/adapters/stripe-link-store"
import {
  acquireOrgSeatBillingLease,
  claimStripeSeatSubscriptionBinding,
  ensureSeatReconciliationTenant,
  readStripeCustomerBinding,
  readStripeInstallationBinding,
  readStripeSeatSubscription,
  releaseOrgSeatBillingLease,
  writeStripeSeatSubscriptionSnapshot,
  type StripeSeatSubscriptionSnapshotWrite,
} from "@/src/features/billing/adapters/d1-seat-reconciliation-store"
import { discoverStripeSeatSubscription } from "@/src/features/billing/adapters/stripe-seat-discovery"
import { upsertTenantTier, readTenantBillingGuard } from "@/src/features/tenancy"

/** Guard against an absurd body (Stripe events are well under this). */
const MAX_BODY_BYTES = 1024 * 1024
const SEAT_RECONCILIATION_LEASE_TTL_MS = 60_000
const SEAT_RECONCILIATION_PROVIDER_TIMEOUT_MS = 45_000
const STRIPE_READ_AFTER_WRITE_GRACE_MS = 5 * 60_000

/** Resolve the env-configured Stripe price-id → tier map (SIGILIX_-preferred via shim). */
export function resolvePriceTierConfig(env: Env): PriceTierConfig {
  return {
    pro: env.SIGILIX_STRIPE_PRICE_PRO,
    teams: env.SIGILIX_STRIPE_PRICE_TEAMS,
    max: env.SIGILIX_STRIPE_PRICE_MAX,
    ultra: env.SIGILIX_STRIPE_PRICE_ULTRA,
    proAnnual: env.SIGILIX_STRIPE_PRICE_PRO_ANNUAL,
    teamsAnnual: env.SIGILIX_STRIPE_PRICE_TEAMS_ANNUAL,
    maxAnnual: env.SIGILIX_STRIPE_PRICE_MAX_ANNUAL,
    ultraAnnual: env.SIGILIX_STRIPE_PRICE_ULTRA_ANNUAL,
  }
}

function stripeEventCreatedAtMs(event: StripeEvent, receivedAtMs: number): number {
  const created = (event as StripeEvent & { created?: unknown }).created
  return typeof created === "number" && Number.isSafeInteger(created) && created >= 0 ? created * 1_000 : receivedAtMs
}

function recentlyCreated(event: StripeEvent, nowMs: number): boolean {
  const created = (event as StripeEvent & { created?: unknown }).created
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) return false
  const createdAtMs = created * 1_000
  return (
    createdAtMs <= nowMs + STRIPE_READ_AFTER_WRITE_GRACE_MS && createdAtMs >= nowMs - STRIPE_READ_AFTER_WRITE_GRACE_MS
  )
}

async function persistSeatSnapshot(env: Env, value: StripeSeatSubscriptionSnapshotWrite): Promise<Response | null> {
  const written = await writeStripeSeatSubscriptionSnapshot(env, value)
  if (written.kind === "written") return null
  console.error(
    JSON.stringify({
      event: "stripe-seat-snapshot-write-failed",
      installationId: value.installationId,
      reason: written.kind === "error" ? written.reason : "revision_conflict",
    }),
  )
  return new Response("seat snapshot unavailable\n", { status: 500 })
}

async function handleAuthoritativeSeatRefresh(args: {
  env: Env
  event: StripeEvent
  eventId: string | null
  eventType: string
  customerId: string | null
  installationId: number
  outboundSecret: string
  rawTier: BillingTier | null
  isActiveSubscriptionEvent: boolean
  isDowngradeEvent: boolean
}): Promise<Response | null> {
  if (!args.customerId || (!args.isActiveSubscriptionEvent && !args.isDowngradeEvent)) return null
  if (!args.eventId) return new Response("stripe event id required\n", { status: 500 })

  const marketplace = await readTenantBillingGuard(args.env, args.installationId)
  if (
    marketplace?.billingSource === "github_marketplace" &&
    (marketplace.subscriptionStatus === "active" || marketplace.subscriptionStatus === "trialing")
  ) {
    console.warn(
      JSON.stringify({
        event: "stripe-webhook-marketplace-active-skip",
        type: args.eventType,
        installationId: args.installationId,
        tier: args.rawTier,
      }),
    )
    await markStripeEventProcessed(args.env, args.eventId)
    return new Response("marketplace active not clobbered\n", { status: 200 })
  }

  const receivedAtMs = Date.now()
  const nowIso = new Date(receivedAtMs).toISOString()
  const tenant = await ensureSeatReconciliationTenant(args.env, args.installationId, nowIso)
  if (tenant.kind === "error") return new Response("seat snapshot unavailable\n", { status: 500 })

  const leaseToken = crypto.randomUUID()
  const lease = await acquireOrgSeatBillingLease(args.env, {
    installationId: args.installationId,
    token: leaseToken,
    nowMs: receivedAtMs,
    ttlMs: SEAT_RECONCILIATION_LEASE_TTL_MS,
  })
  if (lease.kind !== "acquired") {
    return new Response(lease.kind === "busy" ? "seat reconciliation busy\n" : "seat snapshot unavailable\n", {
      status: 500,
    })
  }

  try {
    // Serialize same-installation first claims, then let the D1 unique-customer
    // index arbitrate simultaneous claims for one customer across installations.
    // No paid tier write occurs until this durable ownership claim succeeds.
    const binding = await claimStripeSeatSubscriptionBinding(args.env, {
      installationId: args.installationId,
      customerId: args.customerId,
      nowMs: receivedAtMs,
    })
    if (binding.kind === "conflict") {
      await recordOrphanEvent(args.env, args.eventId, { type: args.eventType, customerId: args.customerId })
      await markStripeEventProcessed(args.env, args.eventId)
      return new Response("installation conflict\n", { status: 200 })
    }
    if (binding.kind === "error") return new Response("seat snapshot unavailable\n", { status: 500 })

    const current = await readStripeSeatSubscription(args.env, args.installationId)
    if (current.kind === "error") return new Response("seat snapshot unavailable\n", { status: 500 })
    const expectedRevision = current.kind === "ok" ? current.snapshot.revision : null
    const audit = {
      installationId: args.installationId,
      expectedRevision,
      customerId: args.customerId,
      eventId: args.eventId,
      eventCreatedAtMs: stripeEventCreatedAtMs(args.event, receivedAtMs),
      eventReceivedAtMs: receivedAtMs,
      nowMs: receivedAtMs,
    }

    const discovery = await discoverStripeSeatSubscription({
      secret: args.outboundSecret,
      customerId: args.customerId,
      priceConfig: resolvePriceTierConfig(args.env),
      signal: AbortSignal.timeout(SEAT_RECONCILIATION_PROVIDER_TIMEOUT_MS),
    })
    if (discovery.kind === "error") {
      console.error(
        JSON.stringify({
          event: "stripe-seat-discovery-failed",
          installationId: args.installationId,
          status: discovery.status,
        }),
      )
      return new Response("subscription list unavailable\n", { status: 500 })
    }

    if (discovery.kind === "blocked") {
      const failed = await persistSeatSnapshot(args.env, {
        ...audit,
        state: "blocked",
        reason: discovery.reason,
      })
      if (failed) return failed
      await linkCustomerToInstallation(args.env, args.customerId, args.installationId)
      await markStripeEventProcessed(args.env, args.eventId)
      return new Response("seat snapshot blocked\n", { status: 200 })
    }

    if (discovery.kind === "not_applicable") {
      // A just-created active payload contradicted by the live API can be Stripe
      // read-after-write lag. Keep the event unmarked so Stripe retries after the
      // short consistency window instead of prematurely clearing paid capacity.
      if (args.isActiveSubscriptionEvent && args.rawTier !== null && recentlyCreated(args.event, receivedAtMs)) {
        return new Response("subscription state not visible yet\n", { status: 500 })
      }
      // A missing live Stripe subscription may withdraw only an entitlement that
      // Stripe itself owns. Legacy, Marketplace, null, and future provider sources
      // are never downgraded by a stale Stripe customer/event.
      if (args.rawTier !== null && marketplace?.billingSource === "stripe") {
        const downgraded = await upsertTenantTier(args.env, args.installationId, "free", nowIso, null, "stripe")
        if (!downgraded.ok) return new Response("tier upsert failed\n", { status: 500 })
      }
      const failed = await persistSeatSnapshot(args.env, { ...audit, state: "not_applicable" })
      if (failed) return failed
      await linkCustomerToInstallation(args.env, args.customerId, args.installationId)
      await markStripeEventProcessed(args.env, args.eventId)
      return new Response(args.rawTier === null ? "linked\n" : "ok\n", { status: 200 })
    }

    const applied = await upsertTenantTier(
      args.env,
      args.installationId,
      discovery.target.tier,
      nowIso,
      discovery.target.subscriptionStatus,
      "stripe",
    )
    if (!applied.ok) return new Response("tier upsert failed\n", { status: 500 })
    const failed = await persistSeatSnapshot(args.env, {
      ...audit,
      state: "ready",
      subscriptionId: discovery.target.subscriptionId,
      subscriptionItemId: discovery.target.subscriptionItemId,
      priceId: discovery.target.priceId,
      subscriptionStatus: discovery.target.subscriptionStatus,
      quantity: discovery.target.quantity,
    })
    if (failed) return failed
    await linkCustomerToInstallation(args.env, args.customerId, args.installationId)
    console.log(
      JSON.stringify({
        event: "stripe-webhook-tier-applied",
        type: args.eventType,
        installationId: args.installationId,
        tier: discovery.target.tier,
        stripeEventId: args.eventId,
      }),
    )
    await markStripeEventProcessed(args.env, args.eventId)
    return new Response("ok\n", { status: 200 })
  } finally {
    const released = await releaseOrgSeatBillingLease(args.env, {
      installationId: args.installationId,
      token: leaseToken,
      acquiredAtMs: receivedAtMs,
    })
    if (released.kind !== "released") {
      console.warn(
        JSON.stringify({
          event: "stripe-seat-reconciliation-lease-release-failed",
          installationId: args.installationId,
          result: released.kind,
        }),
      )
    }
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
  const outboundSecret = env.SIGILIX_STRIPE_SECRET_KEY

  // D1 is authoritative once a provider snapshot exists. KV is the bootstrap
  // compatibility link for the first signed event only. A D1/KV read error is never
  // treated as a miss: doing so could bind one Stripe customer to the wrong tenant.
  let existingLink: number | null = null
  let durableLink: number | null = null
  if (customerId) {
    if (outboundSecret) {
      const d1Link = await readStripeInstallationBinding(env, customerId)
      if (d1Link.kind === "error") {
        console.error(
          JSON.stringify({ event: "stripe-webhook-d1-link-read-error", type: eventType, stripeEventId: eventId }),
        )
        return new Response("link store unavailable\n", { status: 500 })
      }
      durableLink = d1Link.kind === "hit" ? d1Link.installationId : null
    }
    const kvLink = await resolveInstallationForCustomer(env, customerId)
    if (kvLink.kind === "error" && durableLink === null) {
      console.error(
        JSON.stringify({ event: "stripe-webhook-link-read-error", type: eventType, stripeEventId: eventId }),
      )
      return new Response("link store unavailable\n", { status: 500 })
    }
    const kvInstallationId = kvLink.kind === "hit" ? kvLink.installationId : null
    if (durableLink !== null && kvInstallationId !== null && durableLink !== kvInstallationId) {
      console.warn(
        JSON.stringify({
          event: "stripe-webhook-kv-link-drift",
          customerId,
          durableInstallationId: durableLink,
          kvInstallationId,
        }),
      )
    }
    existingLink = durableLink ?? kvInstallationId
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

  // The reverse installation→customer claim must agree too. Before a D1 snapshot
  // exists, require the legacy KV reverse link to agree; after D1 exists, D1 wins
  // and the stale KV pair is repaired after the snapshot commit.
  if (customerId && outboundSecret) {
    const durableCustomer = await readStripeCustomerBinding(env, installationId)
    if (durableCustomer.kind === "error") return new Response("link store unavailable\n", { status: 500 })
    if (durableCustomer.kind === "hit" && durableCustomer.customerId !== customerId) {
      console.warn(
        JSON.stringify({
          event: "stripe-webhook-customer-conflict",
          installationId,
          customerId,
          existingCustomerId: durableCustomer.customerId,
        }),
      )
      if (eventId) {
        await recordOrphanEvent(env, eventId, { type: eventType, customerId })
        await markStripeEventProcessed(env, eventId)
      }
      return new Response("installation conflict\n", { status: 200 })
    }
    const kvCustomer = await resolveCustomerForInstallation(env, installationId)
    if (kvCustomer.kind === "error" && durableCustomer.kind !== "hit") {
      return new Response("link store unavailable\n", { status: 500 })
    }
    if (durableCustomer.kind !== "hit" && kvCustomer.kind === "hit" && kvCustomer.customerId !== customerId) {
      if (eventId) {
        await recordOrphanEvent(env, eventId, { type: eventType, customerId })
        await markStripeEventProcessed(env, eventId)
      }
      return new Response("installation conflict\n", { status: 200 })
    }
  }

  // Preserve the legacy link path for deployments without the outbound Stripe key.
  // Snapshot-enabled paths repair this same pair after D1 establishes authority.
  if (customerId && !outboundSecret && existingLink === null) {
    await linkCustomerToInstallation(env, customerId, installationId)
  }

  const tier: BillingTier | null = interpretation.tier
  const subscriptionStatus = interpretation.subscriptionStatus

  // Every event that can WRITE a paid tier from an active/trialing subscription —
  // subscription.created/updated, plus a checkout.session.completed / invoice.paid that
  // carries an EXPANDED active subscription. Snapshot-enabled deployments resolve current
  // provider truth and the exact licensed seat item before applying either tier or capacity.
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

  if (outboundSecret) {
    const authoritative = await handleAuthoritativeSeatRefresh({
      env,
      event,
      eventId,
      eventType,
      customerId,
      installationId,
      outboundSecret,
      rawTier: tier,
      isActiveSubscriptionEvent: isActiveSubEvent,
      isDowngradeEvent,
    })
    if (authoritative) return authoritative
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
