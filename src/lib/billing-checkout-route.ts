// sig-stripe-checkout: the OUTBOUND billing routes that turn an admin's "upgrade"
// click into a hosted Stripe Checkout / Billing-Portal URL. Lives in src/lib (next to
// usage-route.ts / org-routes.ts) because it composes the central exact-installation
// org access gate with the billing feature's Stripe helpers (imported via its barrel).
//
//   POST /v1/billing/checkout → { url }   (start a subscription — Pro gets a 14-day
//                                          trial; Teams/Max/Ultra are paid immediately)
//   POST /v1/billing/portal   → { url }   (manage/cancel an existing subscription)
//
// Security spine:
//   • Session-authed. No session → 401.
//   • An explicit positive `installationId` is required. `requireOrgAccess` proves
//     the session's fresh GitHub token can see that exact installation, then uses
//     its stored Sigilix role while managed membership is on (or the exact live
//     role while rollout is off). Only the verified id reaches Stripe.
//   • Seat bounds (Teams 10–150, others 1–500) are validated server-side.
//   • Customer reuse: the D1 seat snapshot is authoritative once established;
//     pre-snapshot checkouts fall back to the legacy KV link. Any read ERROR fails
//     503 rather than risk a duplicate. A deterministic Stripe idempotency key is
//     the second guard.
//   • Unconfigured secret → 503. The secret is never leaked in any response.

import type { Env } from "@/src/shared/types/env"
import { requireOrgAccess } from "@/src/lib/org-access"
import { withPortalCors, handlePortalPreflight, hasJsonContentType } from "@/src/lib/portal-cors"
import {
  resolvePriceTierConfig,
  validateCheckoutRequest,
  resolvePriceForTier,
  buildCheckoutForm,
  createStripeCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  linkCustomerToInstallation,
  readStripeCustomerBinding,
  resolveCustomerForInstallation,
} from "@/src/features/billing"

const DEFAULT_PORTAL_URL = "https://app.sigilix.ai"

/**
 * The sole active/trialing tenant marker allowed to start self-serve Stripe Checkout.
 * It identifies a historical entitlement that is not backed by a billing provider.
 * Every other active source — including null or an unknown future value — blocks
 * fail-closed. This must never be inferred from a missing KV customer link.
 */
const LEGACY_ENTITLEMENT_BILLING_SOURCE = "legacy_entitlement"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** The portal base for success/cancel/return URLs — env-configured, defaulted. */
function portalBase(env: Env): string {
  const raw = env.OPENCLAW_PORTAL_URL
  return raw && raw.length > 0 ? raw.replace(/\/+$/, "") : DEFAULT_PORTAL_URL
}

/**
 * Parse a JSON request body to a plain object, or null when it is malformed OR a
 * non-object (a bare `null` / array / string / number). Guards `body.x` access from
 * throwing on `JSON.parse("null")` — a malformed billing request must return a
 * controlled 400, never 500 the Worker.
 */
async function parseJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Whether the org is eligible to start Stripe Checkout — the anti-duplicate signal.
 * DISCRIMINATED so a genuine D1 fault can FAIL CLOSED (a null
 * from the shared reader would conflate a fault with "no row" and let a duplicate
 * subscription through during an outage — see the checkout guard).
 *
 *   • "none"   — no tenant row, or a non-live status → proceed.
 *   • "legacy" — active/trialing, but explicitly marked as a non-provider legacy
 *                  entitlement → proceed into the first real Stripe checkout.
 *   • "live"   — active/trialing under every other source, including null/unknown
 *                  → block a second checkout (409).
 *   • "error" — the read threw (D1 outage) → the caller returns 503, never Stripe.
 */
async function readSubscriptionLiveness(
  db: D1Database,
  installationId: number,
): Promise<"none" | "legacy" | "live" | "error"> {
  try {
    const row = await db
      .prepare("SELECT subscription_status, billing_source FROM tenant WHERE installation_id = ?")
      .bind(installationId)
      .first<{ subscription_status: unknown; billing_source: unknown }>()
    if (row == null) return "none"
    const status = typeof row.subscription_status === "string" ? row.subscription_status.trim().toLowerCase() : null
    if (status !== "active" && status !== "trialing") return "none"
    return row.billing_source === LEGACY_ENTITLEMENT_BILLING_SOURCE ? "legacy" : "live"
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "billing-subscription-status-read-error",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return "error"
  }
}

/** Parse an explicit body installationId (number or trimmed decimal string). */
function parseInstallationSelector(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim())
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return null
}

/** Resolved caller: the server-verified admin installation. */
type AdminContext = { ok: true; installationId: number } | { ok: false; response: Response }

/**
 * Require one explicit installation, then delegate all session, fresh-token,
 * exact-visibility, rollout, and role policy to the central org access guard.
 * JSON structure is validated by each route before this call so a malformed or
 * CORS-simple request can never trigger the guard's first-admin bootstrap.
 */
async function resolveAdminContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  selector: unknown,
): Promise<AdminContext> {
  const installationId = parseInstallationSelector(selector)
  if (installationId === null) {
    return { ok: false, response: json({ error: "installation_required" }, 400) }
  }
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "admin" })
  if (!access.ok) return { ok: false, response: access.response }
  if (access.installationId !== installationId) {
    console.error(
      JSON.stringify({
        event: "billing-org-access-scope-mismatch",
        requestedInstallationId: installationId,
        resolvedInstallationId: access.installationId,
      }),
    )
    return { ok: false, response: json({ error: "forbidden" }, 403) }
  }
  return { ok: true, installationId }
}

/**
 * Resolve (reuse) or create the org's Stripe customer. A materialized D1 seat
 * snapshot is the durable binding; KV remains the bootstrap link for customers
 * created before their first signed subscription webhook. Either storage error
 * fails closed rather than minting a duplicate customer.
 */
async function resolveOrCreateCustomer(
  env: Env,
  secret: string,
  installationId: number,
): Promise<{ ok: true; customerId: string } | { ok: false; response: Response }> {
  const durable = await readStripeCustomerBinding(env, installationId)
  if (durable.kind === "error") {
    return { ok: false, response: json({ error: "billing_unavailable" }, 503) }
  }
  if (durable.kind === "hit") {
    return { ok: true, customerId: durable.customerId }
  }
  const link = await resolveCustomerForInstallation(env, installationId)
  if (link.kind === "error") {
    return { ok: false, response: json({ error: "billing_unavailable" }, 503) }
  }
  if (link.kind === "hit") {
    return { ok: true, customerId: link.customerId }
  }
  const created = await createStripeCustomer(secret, installationId)
  if (!created.ok) {
    console.error(JSON.stringify({ event: "billing-customer-create-failed", installationId, status: created.status }))
    return { ok: false, response: json({ error: "stripe_error" }, 502) }
  }
  await linkCustomerToInstallation(env, created.customerId, installationId)
  return { ok: true, customerId: created.customerId }
}

/** POST /v1/billing/checkout — start a paid subscription (Pro-only 14-day trial). See file header. */
export async function handleBillingCheckoutRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const secret = env.SIGILIX_STRIPE_SECRET_KEY
  if (!secret) return json({ error: "stripe_not_configured" }, 503)
  if (!env.SIGILIX_PLATFORM_DB) {
    console.error(JSON.stringify({ event: "billing-platform-db-missing" }))
    return json({ error: "billing_unavailable" }, 503)
  }

  // CSRF guard: these routes authenticate by a SameSite=None session cookie, so a
  // cross-site form/fetch with a CORS-simple content-type could otherwise drive a
  // side effect before withPortalCors hides the response. Requiring application/json
  // forces a preflight the CORS allowlist rejects for a foreign origin.
  if (!hasJsonContentType(request)) return json({ error: "content_type_must_be_json" }, 415)

  const body = await parseJsonObject(request)
  if (!body) return json({ error: "invalid_json" }, 400)

  const validation = validateCheckoutRequest({
    tier: body.tier,
    seats: body.seats,
    billingPeriod: body.billingPeriod,
  })
  if (!validation.ok) return json({ error: validation.error }, validation.status)

  const admin = await resolveAdminContext(request, env, ctx, body.installationId)
  if (!admin.ok) return admin.response

  // Worker-first rollout compatibility: old Portal clients omit the new field. Emit
  // at validation time (including later 409/503 paths), separately from success, so
  // operators can measure when it is safe to require an explicit cadence.
  if (validation.billingPeriodDefaulted) {
    console.warn(
      JSON.stringify({
        event: "billing-checkout-period-defaulted",
        installationId: admin.installationId,
        tier: validation.tier,
        billingPeriod: validation.billingPeriod,
      }),
    )
  }

  // Anti-duplicate-subscription: an org that already has a live (active/trialing)
  // subscription must NOT start a second one — a duplicate would double-bill and let a
  // single cancellation (webhook downgrades by customer) drop the tenant to free while
  // the other sub is live. Send them to the Billing Portal (Manage billing) instead.
  // FAIL CLOSED on a read fault: proceeding on an unknown status could duplicate a sub.
  const liveness = await readSubscriptionLiveness(env.SIGILIX_PLATFORM_DB, admin.installationId)
  if (liveness === "error") return json({ error: "billing_unavailable" }, 503)
  if (liveness === "live") return json({ error: "already_subscribed" }, 409)

  const priceId = resolvePriceForTier(validation.tier, validation.billingPeriod, resolvePriceTierConfig(env))
  if (!priceId) {
    console.error(
      JSON.stringify({
        event: "billing-price-not-configured",
        tier: validation.tier,
        billingPeriod: validation.billingPeriod,
      }),
    )
    return json({ error: "tier_not_available" }, 503)
  }

  const customer = await resolveOrCreateCustomer(env, secret, admin.installationId)
  if (!customer.ok) return customer.response

  const base = portalBase(env)
  const form = buildCheckoutForm({
    priceId,
    seats: validation.seats,
    bounds: validation.bounds,
    tier: validation.tier,
    billingPeriod: validation.billingPeriod,
    installationId: admin.installationId,
    customerId: customer.customerId,
    successUrl: `${base}/org?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/org?checkout=cancel`,
  })

  const session = await createCheckoutSession(secret, form)
  if (!session.ok) return json({ error: "stripe_error" }, 502)

  console.log(
    JSON.stringify({
      event: "billing-checkout-created",
      installationId: admin.installationId,
      tier: validation.tier,
      billingPeriod: validation.billingPeriod,
      seats: validation.seats,
    }),
  )
  return json({ url: session.url }, 200)
}

/** POST /v1/billing/portal — manage/cancel an existing subscription. See file header. */
export async function handleBillingPortalRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const secret = env.SIGILIX_STRIPE_SECRET_KEY
  if (!secret) return json({ error: "stripe_not_configured" }, 503)

  if (!hasJsonContentType(request)) return json({ error: "content_type_must_be_json" }, 415)

  // Both billing routes require an explicit exact installation. Old clients
  // that omitted it must refresh rather than letting the server guess an org.
  const body = await parseJsonObject(request)
  if (!body) return json({ error: "invalid_json" }, 400)

  const admin = await resolveAdminContext(request, env, ctx, body.installationId)
  if (!admin.ok) return admin.response

  // The portal only makes sense for an org that already has a customer — never mint one.
  const link = await resolveCustomerForInstallation(env, admin.installationId)
  if (link.kind === "error") return json({ error: "billing_unavailable" }, 503)
  if (link.kind === "miss") return json({ error: "no_subscription" }, 404)

  const session = await createBillingPortalSession(secret, link.customerId, `${portalBase(env)}/org`)
  if (!session.ok) return json({ error: "stripe_error" }, 502)
  return json({ url: session.url }, 200)
}

/**
 * Self-contained dispatcher for the billing routes (mirrors tryHandlePortalAccountRoute):
 * it owns the portal-CORS preflight + response wrapping, so index.ts needs no
 * allowlist entry. Returns null when the path/method isn't ours.
 */
export async function tryHandleBillingRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/v1/billing/checkout" && url.pathname !== "/v1/billing/portal") return null

  if (request.method === "OPTIONS") {
    return handlePortalPreflight(request, env)
  }
  if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
    return withPortalCors(request, await handleBillingCheckoutRoute(request, env, ctx), env)
  }
  if (request.method === "POST" && url.pathname === "/v1/billing/portal") {
    return withPortalCors(request, await handleBillingPortalRoute(request, env, ctx), env)
  }
  return null
}
