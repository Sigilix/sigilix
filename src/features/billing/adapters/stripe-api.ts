// sig-stripe-checkout: the minimal Stripe REST client for the OUTBOUND calls the
// checkout flow needs — Workers-compatible `fetch` against api.stripe.com with a
// form-encoded body and the `SIGILIX_STRIPE_SECRET_KEY` as a Bearer token. We
// deliberately do NOT pull in the Node `stripe` SDK (it assumes a Node runtime).
//
// Secret hygiene: the secret is only ever an Authorization header — it is never
// logged and never placed in a returned error. A non-2xx surfaces Stripe's own
// error message (safe, non-secret) plus the status; the caller maps that to a 502.

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
