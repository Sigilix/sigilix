// sig-billing-dup-sub-guard: enforce "one active/trialing subscription per Stripe
// customer" at the webhook (the authoritative point). Lists the customer's
// subscriptions, keeps the OLDEST active/trialing one, and cancels the newer
// duplicate(s) immediately so they stop billing. Every failure degrades (logs, keeps
// going) — it must never throw into the webhook nor drop the surviving subscription.
//
// The webhook drives tier/status from the LIVE survivor (not the current event's stale
// payload), so a duplicate that was already cancelled by an earlier delivery — or one we
// cancel now — can never set the tenant's tier, and a downgrade event for a cancelled
// duplicate can never drop the tenant while the older survivor still bills.

import { listCustomerSubscriptions, cancelSubscription } from "@/src/features/billing/adapters/stripe-api"
import {
  selectDuplicateSubscriptions,
  type SubscriptionSummary,
} from "@/src/features/billing/domain/subscription-dedupe"

export interface DedupeResult {
  /** The surviving (oldest) active/trialing subscription — drives the tenant's tier. */
  survivor: SubscriptionSummary | null
  /** Subscription ids we SUCCESSFULLY cancelled (a subset of the duplicates). */
  canceledIds: string[]
  /** True when the Stripe list call failed — the caller keeps the interpreted tier (no override). */
  listFailed: boolean
}

/**
 * Ensure `customerId` has at most one active/trialing subscription. On >1, keep the
 * oldest and cancel the rest. Returns the live survivor + the ids we cancelled. A list
 * failure returns `listFailed:true` (no cancels, no override); a cancel failure is logged
 * and skipped (the survivor is never among the duplicates, so it always stands).
 */
export async function enforceSingleActiveSubscription(secret: string, customerId: string): Promise<DedupeResult> {
  const listed = await listCustomerSubscriptions(secret, customerId)
  if (!listed.ok) {
    console.error(JSON.stringify({ event: "stripe-dedupe-list-failed", customerId, status: listed.status }))
    return { survivor: null, canceledIds: [], listFailed: true }
  }

  const { survivor, duplicates } = selectDuplicateSubscriptions(listed.subscriptions)
  if (duplicates.length === 0) {
    // Normal path: zero or one active/trialing subscription — nothing to cancel.
    return { survivor, canceledIds: [], listFailed: false }
  }

  const canceledIds: string[] = []
  for (const dup of duplicates) {
    // Defensive: the survivor is never in `duplicates`, but never cancel it regardless.
    if (survivor && dup.id === survivor.id) continue
    const res = await cancelSubscription(secret, dup.id)
    if (res.ok) {
      canceledIds.push(dup.id)
      console.warn(
        JSON.stringify({
          event: "stripe-duplicate-subscription-canceled",
          customerId,
          canceledSubscriptionId: dup.id,
          keptSubscriptionId: survivor?.id ?? null,
        }),
      )
    } else {
      // A cancel failure must NOT crash the webhook or drop the survivor — surface the
      // anomaly and move on. The webhook still acks 200 (Stripe won't infinite-retry) and
      // still drives the tenant's tier from the live survivor.
      console.error(
        JSON.stringify({
          event: "stripe-duplicate-cancel-failed",
          customerId,
          subscriptionId: dup.id,
          status: res.status,
        }),
      )
    }
  }
  return { survivor, canceledIds, listFailed: false }
}

/**
 * Read-only survivor lookup for a DOWNGRADE event (subscription.deleted / a sub going
 * non-active): does the customer still have an active/trialing subscription? Used to
 * avoid dropping the tenant to free when an older sub still bills (e.g. the paired
 * deletion of a duplicate we cancelled). Never cancels anything. `listFailed` lets the
 * caller fail closed (retry) rather than wrongly downgrade on a transient Stripe error.
 */
export async function findActiveSurvivor(
  secret: string,
  customerId: string,
): Promise<{ survivor: SubscriptionSummary | null; listFailed: boolean }> {
  const listed = await listCustomerSubscriptions(secret, customerId)
  if (!listed.ok) {
    console.error(JSON.stringify({ event: "stripe-survivor-list-failed", customerId, status: listed.status }))
    return { survivor: null, listFailed: true }
  }
  const { survivor } = selectDuplicateSubscriptions(listed.subscriptions)
  return { survivor, listFailed: false }
}
