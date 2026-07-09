// sig-admin-metrics — READ-ONLY platform-wide Stripe reader for the admin metrics
// endpoint. Distinct from features/billing/adapters/stripe-api.ts (that client is
// per-customer + checkout-focused): this one lists EVERY subscription to compute
// MRR / per-tier revenue / status counts for the staff dashboard.
//
// Secret hygiene (mirrors stripe-api.ts): the secret is ONLY ever an Authorization
// header — never logged, never returned in an error. A non-2xx surfaces Stripe's
// own (non-secret) message + status; a transport error degrades to a 502. Callers
// run this SERVER-SIDE only, gated behind the ADMIN_API_SECRET bearer check.

import { mapPriceToTier, type PriceTierConfig } from "@/src/features/billing"
import type { NormalizedSubscription } from "@/src/lib/admin/admin-metrics-aggregate"

const STRIPE_API_BASE = "https://api.stripe.com"

// Bound the pagination walk. 20×100 = 2,000 subscriptions is far beyond launch
// scale; the cap only guarantees termination (we fail closed if truncated).
const MAX_PAGES = 20

export type ListAllResult =
  | { ok: true; subscriptions: NormalizedSubscription[] }
  | { ok: false; error: string; status: number }

interface StripeSubItemPrice {
  id?: unknown
  unit_amount?: unknown
  lookup_key?: unknown
  nickname?: unknown
  recurring?: { interval?: unknown; interval_count?: unknown }
}
interface StripeSubItem {
  quantity?: unknown
  price?: StripeSubItemPrice
}
interface StripeSub {
  id?: unknown
  status?: unknown
  items?: { data?: StripeSubItem[] }
}

/** Monthly-normalized USD for one subscription item: (unit_amount/100)×qty, yearly ÷ 12. */
function itemMonthlyUsd(item: StripeSubItem): number {
  const price = item.price
  const cents = typeof price?.unit_amount === "number" && Number.isFinite(price.unit_amount) ? price.unit_amount : 0
  const qty =
    typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1
  const interval = typeof price?.recurring?.interval === "string" ? price.recurring.interval : "month"
  const intervalCount =
    typeof price?.recurring?.interval_count === "number" && price.recurring.interval_count > 0
      ? price.recurring.interval_count
      : 1
  let monthly = (cents / 100) * qty
  // Normalize any billing cadence to a monthly figure (year→÷12, every-N-months→÷N).
  if (interval === "year") monthly /= 12 * intervalCount
  else if (interval === "week") monthly *= 52 / 12
  else if (interval === "day") monthly *= 365 / 12
  else if (interval === "month") monthly /= intervalCount
  return monthly
}

/** Narrow one Stripe subscription list entry into a NormalizedSubscription (or null). */
function normalize(item: unknown, tierCfg: PriceTierConfig): NormalizedSubscription | null {
  if (typeof item !== "object" || item === null) return null
  const o = item as StripeSub
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : null
  const status = typeof o.status === "string" && o.status.length > 0 ? o.status : null
  if (!id || !status) return null
  const items = Array.isArray(o.items?.data) ? o.items.data : []
  let monthlyUsd = 0
  for (const it of items) monthlyUsd += itemMonthlyUsd(it)
  // Tier from the FIRST item's price (mirrors mapPriceToTier's use in the webhook).
  const firstPrice = items[0]?.price
  const tier =
    mapPriceToTier(
      firstPrice
        ? {
            id: typeof firstPrice.id === "string" ? firstPrice.id : null,
            lookup_key: typeof firstPrice.lookup_key === "string" ? firstPrice.lookup_key : null,
            nickname: typeof firstPrice.nickname === "string" ? firstPrice.nickname : null,
          }
        : undefined,
      tierCfg,
    ) ?? "unknown"
  return { id, status, tier, monthlyUsd }
}

function rawEntryId(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null
  const id = (item as { id?: unknown }).id
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * List EVERY subscription (`status=all`) as normalized summaries for the MRR /
 * per-tier / churn rollup. Walks cursor pages until Stripe reports no more (up to
 * MAX_PAGES); a truncated view fails CLOSED (never a partial-and-wrong MRR).
 * Returns a failure result (never throws) so a Stripe outage can't crash the route.
 */
export async function listAllSubscriptions(secret: string, tierCfg: PriceTierConfig): Promise<ListAllResult> {
  const subscriptions: NormalizedSubscription[] = []
  let startingAfter: string | null = null
  let moreRemaining = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ status: "all", limit: "100" })
    if (startingAfter) params.set("starting_after", startingAfter)
    let res: Response
    try {
      res = await fetch(`${STRIPE_API_BASE}/v1/subscriptions?${params.toString()}`, {
        headers: { authorization: `Bearer ${secret}` },
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "stripe request failed", status: 502 }
    }
    let body: { data?: unknown; has_more?: unknown } | null = null
    try {
      body = (await res.json()) as { data?: unknown; has_more?: unknown }
    } catch {
      /* handled by the !ok / !Array branch below */
    }
    if (!res.ok) {
      // Log the status ONLY. Return a FIXED, non-secret message — never Stripe's
      // upstream error string (defense-in-depth against any key material a proxy
      // could echo back into an error body).
      console.error(JSON.stringify({ event: "admin-stripe-list-error", status: res.status }))
      return { ok: false, error: "stripe subscription list failed", status: res.status }
    }
    const data = body?.data
    if (!Array.isArray(data)) {
      console.error(JSON.stringify({ event: "admin-stripe-list-malformed" }))
      return { ok: false, error: "malformed subscription list", status: 502 }
    }
    for (const item of data) {
      const n = normalize(item, tierCfg)
      if (n) subscriptions.push(n)
    }
    const hasMore = body?.has_more === true
    if (!hasMore) {
      moreRemaining = false
      break
    }
    // Stripe says more pages exist. If we can't derive a cursor to fetch them,
    // FAIL CLOSED (never return a partial-and-wrong MRR from a stalled walk).
    const nextCursor = data.length > 0 ? rawEntryId(data[data.length - 1]) : null
    if (!nextCursor) {
      console.error(JSON.stringify({ event: "admin-stripe-list-no-cursor" }))
      return { ok: false, error: "subscription list pagination stalled", status: 502 }
    }
    moreRemaining = true
    startingAfter = nextCursor
  }
  if (moreRemaining) {
    console.error(JSON.stringify({ event: "admin-stripe-list-truncated" }))
    return { ok: false, error: "subscription list too large to page", status: 502 }
  }
  return { ok: true, subscriptions }
}
