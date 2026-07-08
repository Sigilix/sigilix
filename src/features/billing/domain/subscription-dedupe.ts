// sig-billing-dup-sub-guard: PURE keep-OLDEST selection for the "one active/trialing
// subscription per Stripe customer" webhook guard. No IO — the adapter lists the
// customer's subscriptions from Stripe and cancels exactly the duplicates this picks.
//
// Why the webhook, and why keep-oldest: the checkout 409 ("already-subscribed") reads
// tenant.subscription_status, which is only written AFTER a webhook lands. Two checkout
// URLs completed before the first webhook fires therefore both pass the guard and leave
// two active subscriptions on ONE Stripe customer. The webhook is the authoritative point
// where every active subscription is observed, so we enforce the invariant here. Keeping
// the OLDEST (earliest `created`, ties broken by id) makes the choice DETERMINISTIC and
// order-independent: whichever duplicate's event lands first, the same survivor is chosen.

/** The minimal Stripe subscription shape this selection needs (id + status + created + price). */
export interface SubscriptionSummary {
  id: string
  /** Stripe subscription status (e.g. active / trialing / canceled / past_due). */
  status: string
  /** Stripe `created` epoch-seconds — the tiebreaker-free ordering key. */
  created: number
  /** The first line item's price (for mapping the survivor back to a tier), or null. */
  price: { id: string | null; lookup_key: string | null; nickname: string | null } | null
}

export interface DedupeSelection {
  /** The subscription to KEEP: the oldest active/trialing one, or null when none is active/trialing. */
  survivor: SubscriptionSummary | null
  /** The newer active/trialing duplicates to cancel (empty when ≤1 is active/trialing). */
  duplicates: SubscriptionSummary[]
}

/** A subscription status that counts as a live, billing subscription. */
function isActiveOrTrialing(status: string): boolean {
  return status === "active" || status === "trialing"
}

/**
 * Split a customer's subscriptions into the one to KEEP (oldest active/trialing) and the
 * newer active/trialing duplicates to cancel. When zero or one subscription is
 * active/trialing, `duplicates` is empty — this is the normal, single-subscription path
 * and the caller must NOT cancel anything. Non-active subscriptions (canceled, past_due,
 * incomplete, …) are ignored entirely: they neither survive nor get re-cancelled.
 */
export function selectDuplicateSubscriptions(subs: readonly SubscriptionSummary[]): DedupeSelection {
  const live = subs.filter((s) => isActiveOrTrialing(s.status))
  if (live.length <= 1) return { survivor: live[0] ?? null, duplicates: [] }
  const sorted = [...live].sort((a, b) =>
    a.created !== b.created ? a.created - b.created : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  const [survivor, ...duplicates] = sorted
  return { survivor: survivor ?? null, duplicates }
}
