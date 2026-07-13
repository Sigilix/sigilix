// sig-stripe-checkout: the minimal Stripe REST client for the OUTBOUND calls the
// checkout flow needs — Workers-compatible `fetch` against api.stripe.com with a
// form-encoded body and the `SIGILIX_STRIPE_SECRET_KEY` as a Bearer token. We
// deliberately do NOT pull in the Node `stripe` SDK (it assumes a Node runtime).
//
// Secret hygiene: the secret is only ever an Authorization header — it is never
// logged and never placed in a returned error. A non-2xx surfaces Stripe's own
// error message (safe, non-secret) plus the status; the caller maps that to a 502.

import type { SubscriptionSummary } from "@/src/features/billing/domain/subscription-dedupe"
import type { StripeSubscriptionItemSummary } from "@/src/features/billing/domain/stripe-seat-target"

const STRIPE_API_BASE = "https://api.stripe.com"

/** A Stripe call that either yields a resource `url`, or a non-secret failure. */
export type StripeResult = { ok: true; url: string } | { ok: false; error: string; status: number }

interface StripeErrorBody {
  error?: { message?: unknown; type?: unknown }
}

/** POST a form-encoded body to Stripe. `idempotencyKey` makes a create safely retryable. */
async function stripePost(
  secret: string,
  path: string,
  form: URLSearchParams,
  idempotencyKey?: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status: number }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${secret}`,
    "content-type": "application/x-www-form-urlencoded",
  }
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey

  let res: Response
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, { method: "POST", headers, body: form.toString() })
  } catch (err) {
    // Network/transport error — never contains the secret.
    return { ok: false, error: err instanceof Error ? err.message : "stripe request failed", status: 502 }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body (shouldn't happen for Stripe) — handled by the !ok branch below */
  }

  if (!res.ok) {
    const msg = (body as StripeErrorBody | null)?.error?.message
    const safe = typeof msg === "string" && msg.length > 0 ? msg : `stripe ${res.status}`
    // Log the status + Stripe's error type ONLY (never the request, which carries the key).
    console.error(
      JSON.stringify({
        event: "stripe-api-error",
        path,
        status: res.status,
        stripeErrorType: (body as StripeErrorBody | null)?.error?.type ?? null,
      }),
    )
    return { ok: false, error: safe, status: res.status }
  }
  return { ok: true, body }
}

/**
 * Issue a bodyless GET/DELETE to Stripe (the subscription list + cancel calls). Shares
 * the same secret-hygiene contract as {@link stripePost}: the secret is only ever an
 * Authorization header, never logged, never returned. A non-2xx surfaces Stripe's own
 * (non-secret) error message + status; a transport error degrades to a 502.
 */
async function stripeBodyless(
  method: "GET" | "DELETE",
  secret: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status: number }> {
  let res: Response
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}` },
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "stripe request failed", status: 502 }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body — handled by the !ok branch below */
  }

  if (!res.ok) {
    const msg = (body as StripeErrorBody | null)?.error?.message
    const safe = typeof msg === "string" && msg.length > 0 ? msg : `stripe ${res.status}`
    console.error(
      JSON.stringify({
        event: "stripe-api-error",
        path,
        status: res.status,
        stripeErrorType: (body as StripeErrorBody | null)?.error?.type ?? null,
      }),
    )
    return { ok: false, error: safe, status: res.status }
  }
  return { ok: true, body }
}

/** Narrow one entry of a Stripe subscription list into a {@link SubscriptionSummary}. */
function parseSubscriptionSummary(item: unknown): SubscriptionSummary | null {
  if (typeof item !== "object" || item === null) return null
  const o = item as { id?: unknown; status?: unknown; created?: unknown; items?: { data?: unknown } }
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : null
  const status = typeof o.status === "string" && o.status.length > 0 ? o.status : null
  const created = typeof o.created === "number" && Number.isSafeInteger(o.created) && o.created >= 0 ? o.created : null
  if (!id || !status || created === null) return null
  const firstItem = Array.isArray(o.items?.data) ? o.items?.data[0] : null
  let price: SubscriptionSummary["price"] = null
  if (firstItem && typeof firstItem === "object") {
    const p = (firstItem as { price?: unknown }).price
    if (p && typeof p === "object") {
      const pr = p as { id?: unknown; lookup_key?: unknown; nickname?: unknown }
      price = {
        id: typeof pr.id === "string" ? pr.id : null,
        lookup_key: typeof pr.lookup_key === "string" ? pr.lookup_key : null,
        nickname: typeof pr.nickname === "string" ? pr.nickname : null,
      }
    }
  }
  return { id, status, created, price }
}

/** Read the raw `id` off a Stripe list entry (for cursor pagination). */
function rawEntryId(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null
  const id = (item as { id?: unknown }).id
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * Bound on the number of `starting_after` pages walked. status=all includes historical
 * canceled subscriptions, so a long-lived customer could push its oldest ACTIVE sub past
 * the first page — we page until `has_more` is false (up to this cap) so keep-oldest is
 * never decided on a truncated view. 20×100 = 2,000 subscriptions is far beyond any real
 * customer; the cap just guarantees termination.
 */
const MAX_SUBSCRIPTION_PAGES = 20

/** Same conservative termination bound as subscription discovery: 20×100 provider rows. */
const MAX_SUBSCRIPTION_ITEM_PAGES = 20

/**
 * List a customer's subscriptions (`GET /v1/subscriptions?customer=<id>&status=all`) as
 * minimal summaries — the input to the single-active-subscription dedupe guard. Walks
 * cursor pages until Stripe reports no more, so the oldest active/trialing subscription is
 * never missed behind a page of historical cancellations. Returns a failure result (never
 * throws) so a Stripe outage can't crash the webhook.
 */
export async function listCustomerSubscriptions(
  secret: string,
  customerId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; subscriptions: SubscriptionSummary[] } | { ok: false; error: string; status: number }> {
  const subscriptions: SubscriptionSummary[] = []
  let startingAfter: string | null = null
  let moreRemaining = false
  for (let page = 0; page < MAX_SUBSCRIPTION_PAGES; page++) {
    const params = new URLSearchParams({ customer: customerId, status: "all", limit: "100" })
    if (startingAfter) params.set("starting_after", startingAfter)
    const res = await stripeBodyless("GET", secret, `/v1/subscriptions?${params.toString()}`, signal)
    if (!res.ok) return res
    const body = res.body as { data?: unknown; has_more?: unknown } | null
    const data = body?.data
    // A 2xx Stripe list ALWAYS carries a `data` array (empty is valid). A missing/malformed
    // one — or a body that failed to parse — is untrusted: FAIL CLOSED (ok:false) so the
    // caller retries, rather than mistaking it for "no subscriptions" and dropping a payer.
    if (!Array.isArray(data)) {
      console.error(JSON.stringify({ event: "stripe-subscriptions-malformed-list", customerId }))
      return { ok: false, error: "malformed subscription list", status: 502 }
    }
    for (const item of data) {
      const parsed = parseSubscriptionSummary(item)
      if (!parsed) {
        console.error(JSON.stringify({ event: "stripe-subscriptions-malformed-entry", customerId }))
        return { ok: false, error: "malformed subscription list", status: 502 }
      }
      subscriptions.push(parsed)
    }
    // Advance the cursor by the RAW last entry id (not a parsed one — a skipped/malformed
    // entry must not stall pagination). Stop on an empty page or when Stripe reports no more.
    const nextCursor = data.length > 0 ? rawEntryId(data[data.length - 1]) : null
    moreRemaining = body?.has_more === true && nextCursor !== null
    if (!moreRemaining) break
    startingAfter = nextCursor
  }
  // Still more pages after the cap → we hold a TRUNCATED view and can't trust keep-oldest.
  // FAIL CLOSED (this never happens for a real customer; 2,000 subs is the absurd bound).
  if (moreRemaining) {
    console.error(JSON.stringify({ event: "stripe-subscriptions-list-truncated", customerId }))
    return { ok: false, error: "subscription list too large to page", status: 502 }
  }
  return { ok: true, subscriptions }
}

function nullableStripeString(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === "string" ? value : undefined
}

/** Strictly narrow one Stripe subscription-item list entry into the seat-target shape. */
function parseSubscriptionItem(item: unknown): StripeSubscriptionItemSummary | null {
  if (typeof item !== "object" || item === null) return null
  const raw = item as { id?: unknown; quantity?: unknown; price?: unknown }
  if (typeof raw.id !== "string" || raw.id.length === 0) return null
  // Zero is valid provider data and remains observable here; the product-aware resolver
  // rejects it through the configured plan's positive minimum.
  if (!Number.isSafeInteger(raw.quantity) || (raw.quantity as number) < 0) return null
  if (typeof raw.price !== "object" || raw.price === null) return null

  const price = raw.price as { id?: unknown; lookup_key?: unknown; nickname?: unknown; recurring?: unknown }
  const lookupKey = nullableStripeString(price.lookup_key)
  const nickname = nullableStripeString(price.nickname)
  if (
    typeof price.id !== "string" ||
    price.id.length === 0 ||
    lookupKey === undefined ||
    nickname === undefined ||
    typeof price.recurring !== "object" ||
    price.recurring === null
  ) {
    return null
  }

  const recurring = price.recurring as { interval?: unknown; interval_count?: unknown; usage_type?: unknown }
  if (
    typeof recurring.interval !== "string" ||
    recurring.interval.length === 0 ||
    !Number.isSafeInteger(recurring.interval_count) ||
    (recurring.interval_count as number) <= 0 ||
    typeof recurring.usage_type !== "string" ||
    recurring.usage_type.length === 0
  ) {
    return null
  }

  return {
    id: raw.id,
    quantity: raw.quantity as number,
    price: {
      id: price.id,
      lookupKey,
      nickname,
      recurring: {
        interval: recurring.interval,
        intervalCount: recurring.interval_count as number,
        usageType: recurring.usage_type,
      },
    },
  }
}

/**
 * Read every item for one exact subscription. This is intentionally stricter than the
 * duplicate-subscription summary parser: a malformed or partial item view must never become
 * the target of a quantity-changing Stripe request.
 */
export async function listSubscriptionItems(
  secret: string,
  subscriptionId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; items: StripeSubscriptionItemSummary[] } | { ok: false; error: string; status: number }> {
  const items: StripeSubscriptionItemSummary[] = []
  const itemIds = new Set<string>()
  let startingAfter: string | null = null
  let moreRemaining = false

  for (let page = 0; page < MAX_SUBSCRIPTION_ITEM_PAGES; page++) {
    const params = new URLSearchParams({ subscription: subscriptionId, limit: "100" })
    if (startingAfter) params.set("starting_after", startingAfter)
    const result = await stripeBodyless("GET", secret, `/v1/subscription_items?${params.toString()}`, signal)
    if (!result.ok) return result

    const body = result.body as { data?: unknown; has_more?: unknown } | null
    if (!Array.isArray(body?.data) || typeof body.has_more !== "boolean") {
      console.error(JSON.stringify({ event: "stripe-subscription-items-malformed-list", subscriptionId }))
      return { ok: false, error: "malformed subscription item list", status: 502 }
    }

    const pageItems: StripeSubscriptionItemSummary[] = []
    for (const rawItem of body.data) {
      const parsed = parseSubscriptionItem(rawItem)
      // Provider mutation during pagination could repeat a row across pages. Treat that as
      // an unstable/truncated view and fail closed instead of silently deduplicating it.
      if (!parsed || itemIds.has(parsed.id)) {
        console.error(JSON.stringify({ event: "stripe-subscription-items-malformed-entry", subscriptionId }))
        return { ok: false, error: "malformed subscription item list", status: 502 }
      }
      itemIds.add(parsed.id)
      pageItems.push(parsed)
    }
    items.push(...pageItems)

    moreRemaining = body.has_more
    if (!moreRemaining) break
    const nextCursor = pageItems.at(-1)?.id ?? null
    if (!nextCursor) {
      console.error(JSON.stringify({ event: "stripe-subscription-items-missing-cursor", subscriptionId }))
      return { ok: false, error: "malformed subscription item list", status: 502 }
    }
    startingAfter = nextCursor
  }

  if (moreRemaining) {
    console.error(JSON.stringify({ event: "stripe-subscription-items-list-truncated", subscriptionId }))
    return { ok: false, error: "subscription item list too large to page", status: 502 }
  }
  return { ok: true, items }
}

/**
 * Cancel a subscription IMMEDIATELY (`DELETE /v1/subscriptions/<id>`) — used to remove a
 * duplicate active subscription so it stops billing at once. Returns a failure result
 * (never throws); the caller logs it and keeps the surviving subscription.
 */
export async function cancelSubscription(
  secret: string,
  subscriptionId: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const res = await stripeBodyless("DELETE", secret, `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, signal)
  return res.ok ? { ok: true } : res
}

function readUrl(body: unknown): string | null {
  if (typeof body === "object" && body !== null && typeof (body as { url?: unknown }).url === "string") {
    return (body as { url: string }).url
  }
  return null
}

/**
 * Find-or-create the Stripe customer for an installation. Uses a DETERMINISTIC
 * idempotency key (`sigilix-customer-<installationId>`) so a retried checkout for
 * an org with no KV link yet can't mint two customers — Stripe returns the same
 * customer for the same key. Carries `metadata[installation_id]` so the customer is
 * self-describing even if the KV link is later lost.
 */
export async function createStripeCustomer(
  secret: string,
  installationId: number,
): Promise<{ ok: true; customerId: string } | { ok: false; error: string; status: number }> {
  const form = new URLSearchParams()
  form.set("metadata[installation_id]", String(installationId))
  const res = await stripePost(secret, "/v1/customers", form, `sigilix-customer-${installationId}`)
  if (!res.ok) return res
  const id = typeof (res.body as { id?: unknown }).id === "string" ? (res.body as { id: string }).id : null
  if (!id) return { ok: false, error: "stripe customer id missing", status: 502 }
  return { ok: true, customerId: id }
}

/** Create a Checkout Session from a pre-built form (see domain/checkout-session.ts). */
export async function createCheckoutSession(secret: string, form: URLSearchParams): Promise<StripeResult> {
  const res = await stripePost(secret, "/v1/checkout/sessions", form)
  if (!res.ok) return res
  const url = readUrl(res.body)
  return url ? { ok: true, url } : { ok: false, error: "stripe checkout url missing", status: 502 }
}

/** Create a Billing Portal session so an existing subscriber can manage/cancel. */
export async function createBillingPortalSession(
  secret: string,
  customerId: string,
  returnUrl: string,
): Promise<StripeResult> {
  const form = new URLSearchParams()
  form.set("customer", customerId)
  form.set("return_url", returnUrl)
  const res = await stripePost(secret, "/v1/billing_portal/sessions", form)
  if (!res.ok) return res
  const url = readUrl(res.body)
  return url ? { ok: true, url } : { ok: false, error: "stripe portal url missing", status: 502 }
}
