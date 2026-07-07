// SIG-41: KV persistence for the Stripe integration (env.OPENCLAW_STATE).
//
// Three concerns, all fail-soft (KV faults log + degrade, never throw into the
// webhook path):
//   1. customer ↔ installation link — later subscription/invoice events carry only
//      the Stripe customer id, so we persist the mapping the FIRST time an event
//      carries both (checkout.session.completed / subscription.* with metadata) and
//      resolve it back on events that omit installation_id.
//   2. event idempotency — Stripe retries deliveries; a short-TTL marker keyed by
//      event.id lets a re-delivery be acked without re-applying.
//   3. orphan reconcile record — an event whose tenant can't be resolved is stashed
//      so it can be reconciled once the link exists, instead of being lost.

import type { Env } from "@/src/shared/types/env"

const CUSTOMER_LINK_PREFIX = "stripe-customer:" // → installationId (string)
const INSTALLATION_LINK_PREFIX = "stripe-installation:" // → customerId
const EVENT_MARKER_PREFIX = "stripe-event:" // idempotency marker
const ORPHAN_PREFIX = "stripe-orphan:" // unresolved-tenant reconcile record

/** Idempotency marker retention — comfortably longer than Stripe's ~3-day retry window. */
const EVENT_MARKER_TTL_SECONDS = 72 * 60 * 60
/** Orphan records linger long enough for a manual/portal reconcile, then expire. */
const ORPHAN_TTL_SECONDS = 30 * 24 * 60 * 60

/** Persist the bidirectional customer↔installation link. Fail-soft. */
export async function linkCustomerToInstallation(
  env: Pick<Env, "OPENCLAW_STATE">,
  customerId: string,
  installationId: number,
): Promise<void> {
  try {
    await Promise.all([
      env.OPENCLAW_STATE.put(CUSTOMER_LINK_PREFIX + customerId, String(installationId)),
      env.OPENCLAW_STATE.put(INSTALLATION_LINK_PREFIX + String(installationId), customerId),
    ])
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "stripe-link-write-failed",
        customerId,
        installationId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/**
 * Resolve a Stripe customer id back to its Sigilix installation id. Returns a
 * discriminated result so the caller can tell a definite MISS (no link on file) apart
 * from a transient storage ERROR — the latter must NOT be treated as "no tenant" (a
 * downgrade would be silently dropped); the caller returns 500 so Stripe redelivers.
 */
export type CustomerLinkResult = { kind: "hit"; installationId: number } | { kind: "miss" } | { kind: "error" }

export async function resolveInstallationForCustomer(
  env: Pick<Env, "OPENCLAW_STATE">,
  customerId: string,
): Promise<CustomerLinkResult> {
  try {
    const raw = await env.OPENCLAW_STATE.get(CUSTOMER_LINK_PREFIX + customerId)
    if (!raw || !/^\d+$/.test(raw)) return { kind: "miss" }
    const n = Number.parseInt(raw, 10)
    return Number.isInteger(n) && n > 0 ? { kind: "hit", installationId: n } : { kind: "miss" }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "stripe-link-read-failed",
        customerId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return { kind: "error" }
  }
}

/** True when this event id was already processed (a Stripe retry). Fail-soft → false. */
export async function wasStripeEventProcessed(env: Pick<Env, "OPENCLAW_STATE">, eventId: string): Promise<boolean> {
  try {
    return (await env.OPENCLAW_STATE.get(EVENT_MARKER_PREFIX + eventId)) !== null
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "stripe-event-marker-read-failed",
        eventId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return false
  }
}

/** Mark an event id processed with a bounded TTL. Fail-soft. */
export async function markStripeEventProcessed(env: Pick<Env, "OPENCLAW_STATE">, eventId: string): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(EVENT_MARKER_PREFIX + eventId, "1", { expirationTtl: EVENT_MARKER_TTL_SECONDS })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "stripe-event-marker-write-failed",
        eventId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/** Stash an event whose tenant couldn't be resolved, for later reconcile. Fail-soft. */
export async function recordOrphanEvent(
  env: Pick<Env, "OPENCLAW_STATE">,
  eventId: string,
  detail: { type: string; customerId: string | null },
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(ORPHAN_PREFIX + eventId, JSON.stringify({ ...detail, at: new Date().toISOString() }), {
      expirationTtl: ORPHAN_TTL_SECONDS,
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "stripe-orphan-write-failed",
        eventId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
