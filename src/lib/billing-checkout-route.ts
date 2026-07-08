// sig-stripe-checkout: the OUTBOUND billing routes that turn an admin's "upgrade"
// click into a hosted Stripe Checkout / Billing-Portal URL. Lives in src/lib (next to
// usage-route.ts / org-routes.ts) because it composes the session + GitHub admin gate
// helpers here with the billing feature's Stripe helpers (imported via its barrel).
//
//   POST /v1/billing/checkout → { url }   (start a subscription — 14-day trial)
//   POST /v1/billing/portal   → { url }   (manage/cancel an existing subscription)
//
// Security spine (mirrors /v1/usage's admin gate):
//   • Session-authed. No session → 401.
//   • The installation being subscribed is resolved SERVER-SIDE from the session's
//     own GitHub token, NEVER trusted from the body: the request may pass an
//     `installationId` only as a SELECTOR, and it is honored only after
//     `isAdminOfInstallation` proves the caller administers it (else 403). That
//     server-verified id — not any body value — becomes Stripe's client_reference_id.
//   • Seat bounds (Teams 10–150, others 1–500) are validated server-side.
//   • Customer reuse: the KV installation→customer link is read FIRST; a returning
//     org reuses its one customer (a KV read ERROR fails 503 rather than risk a
//     duplicate). A deterministic Stripe idempotency key is the second guard.
//   • Unconfigured secret → 503. The secret is never leaked in any response.

import type { Env } from "@/src/shared/types/env"
import { requireSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
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
  resolveCustomerForInstallation,
} from "@/src/features/billing"

const DEFAULT_PORTAL_URL = "https://app.sigilix.ai"
const MAX_INSTALLATION_PAGES = 20

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** The portal base for success/cancel/return URLs — env-configured, defaulted. */
function portalBase(env: Env): string {
  const raw = env.OPENCLAW_PORTAL_URL
  return raw && raw.length > 0 ? raw.replace(/\/+$/, "") : DEFAULT_PORTAL_URL
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: Array<{ id?: number }>
}

/** Every installation id the session's GitHub token can see (paginated, soft-fails to []). */
async function fetchUserInstallationIds(accessToken: string): Promise<number[]> {
  const ids: number[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(accessToken),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: UserInstallationsResponse
    try {
      body = (await res.json()) as UserInstallationsResponse
    } catch {
      break
    }
    const installs = Array.isArray(body.installations) ? body.installations : []
    for (const inst of installs) {
      if (typeof inst.id === "number") ids.push(inst.id)
    }
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return ids
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
 * Whether the org already has a LIVE (active/trialing) Stripe subscription — the
 * anti-duplicate signal. DISCRIMINATED so a genuine D1 fault can FAIL CLOSED (a null
 * from the shared reader would conflate a fault with "no row" and let a duplicate
 * subscription through during an outage — see the checkout guard).
 *
 *   • "none"  — no billing DB configured, or no tenant row, or a non-live status.
 *               A first-time checkout MUST proceed here (there is nothing to duplicate).
 *   • "live"  — active/trialing subscription on file → block a second checkout (409).
 *   • "error" — the read threw (D1 outage) → the caller returns 503, never Stripe.
 */
async function readSubscriptionLiveness(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<"none" | "live" | "error"> {
  // No billing DB configured is a static deploy state (not a transient fault): there
  // are no subscriptions to duplicate, so allow checkout rather than hard-blocking it.
  if (!env.SIGILIX_PLATFORM_DB) return "none"
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT subscription_status FROM tenant WHERE installation_id = ?",
    )
      .bind(installationId)
      .first<{ subscription_status: unknown }>()
    if (row == null) return "none"
    const status = typeof row.subscription_status === "string" ? row.subscription_status.toLowerCase() : null
    return status === "active" || status === "trialing" ? "live" : "none"
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

/** Parse a body installationId SELECTOR (string or number) into a positive int, or null. */
function parseInstallationSelector(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number.parseInt(v.trim(), 10)
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

/** Resolved caller: the server-verified admin installation. */
type AdminContext = { ok: true; installationId: number } | { ok: false; response: Response }

/**
 * The shared front half of both routes: session → decrypt token → resolve the
 * target installation from the session (body value is a selector only) → admin gate.
 * Returns the server-verified installation id, or a ready-to-send error Response.
 */
async function resolveAdminContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  selector: unknown,
): Promise<AdminContext> {
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }

  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "billing-encryption-key-missing" }))
    return { ok: false, response: json({ error: "misconfigured" }, 503) }
  }

  let accessToken: string
  try {
    // sig-portal-bugs: refresh the short-lived GitHub App user token before the
    // installation-scope + admin-role lookups. A stale token 401s both, which
    // fail-safe to "no installations / not admin" — that would 403 a REAL org admin
    // out of checkout until they re-login. getValidGithubToken renews it transparently.
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
  } catch (error) {
    console.error(
      JSON.stringify({ event: "billing-decrypt-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return { ok: false, response: json({ error: "billing_failed" }, 500) }
  }

  const requested = parseInstallationSelector(selector)
  const ownedIds = await fetchUserInstallationIds(accessToken)
  if (ownedIds.length === 0) {
    // No installation visible to this session → nothing they could admin. 403 (not 401:
    // they're authenticated, just not an admin of any installed org).
    return { ok: false, response: json({ error: "no_admin_installation" }, 403) }
  }

  // The selector, when present, must be one the token can see; otherwise pick the sole
  // installation. Ambiguous (multiple installs, none selected) → the client must choose.
  let target: number
  if (requested !== null) {
    if (!ownedIds.includes(requested)) {
      return { ok: false, response: json({ error: "forbidden" }, 403) }
    }
    target = requested
  } else if (ownedIds.length === 1) {
    target = ownedIds[0]!
  } else {
    return { ok: false, response: json({ error: "installation_required" }, 400) }
  }

  // The authoritative gate: admin of THIS installation specifically (not the aggregate
  // role). A mere member — even the selector's own owner elsewhere — is rejected here.
  const isAdmin = await isAdminOfInstallation(accessToken, session.record.login, target)
  if (!isAdmin) {
    return { ok: false, response: json({ error: "forbidden" }, 403) }
  }
  return { ok: true, installationId: target }
}

/**
 * Resolve (reuse) or create the org's Stripe customer. Reads the KV
 * installation→customer link FIRST so a returning org reuses its one customer; a
 * KV read ERROR fails (503) rather than risk a duplicate. A newly-created customer
 * is linked immediately (idempotent, anti-duplicate) — the webhook link is a fallback.
 */
async function resolveOrCreateCustomer(
  env: Env,
  secret: string,
  installationId: number,
): Promise<{ ok: true; customerId: string } | { ok: false; response: Response }> {
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

/** POST /v1/billing/checkout — start a paid subscription (14-day trial). See file header. */
export async function handleBillingCheckoutRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const secret = env.SIGILIX_STRIPE_SECRET_KEY
  if (!secret) return json({ error: "stripe_not_configured" }, 503)

  // CSRF guard: these routes authenticate by a SameSite=None session cookie, so a
  // cross-site form/fetch with a CORS-simple content-type could otherwise drive a
  // side effect before withPortalCors hides the response. Requiring application/json
  // forces a preflight the CORS allowlist rejects for a foreign origin.
  if (!hasJsonContentType(request)) return json({ error: "content_type_must_be_json" }, 415)

  const body = await parseJsonObject(request)
  if (!body) return json({ error: "invalid_json" }, 400)

  const admin = await resolveAdminContext(request, env, ctx, body.installationId)
  if (!admin.ok) return admin.response

  // Anti-duplicate-subscription: an org that already has a live (active/trialing)
  // subscription must NOT start a second one — a duplicate would double-bill and let a
  // single cancellation (webhook downgrades by customer) drop the tenant to free while
  // the other sub is live. Send them to the Billing Portal (Manage billing) instead.
  // FAIL CLOSED on a read fault: proceeding on an unknown status could duplicate a sub.
  const liveness = await readSubscriptionLiveness(env, admin.installationId)
  if (liveness === "error") return json({ error: "billing_unavailable" }, 503)
  if (liveness === "live") return json({ error: "already_subscribed" }, 409)

  const validation = validateCheckoutRequest({ tier: body.tier, seats: body.seats })
  if (!validation.ok) return json({ error: validation.error }, validation.status)

  const priceId = resolvePriceForTier(validation.tier, resolvePriceTierConfig(env))
  if (!priceId) {
    console.error(JSON.stringify({ event: "billing-price-not-configured", tier: validation.tier }))
    return json({ error: "tier_not_available" }, 503)
  }

  const customer = await resolveOrCreateCustomer(env, secret, admin.installationId)
  if (!customer.ok) return customer.response

  const base = portalBase(env)
  const form = buildCheckoutForm({
    priceId,
    seats: validation.seats,
    bounds: validation.bounds,
    installationId: admin.installationId,
    customerId: customer.customerId,
    successUrl: `${base}/org?checkout=success`,
    cancelUrl: `${base}/org?checkout=cancel`,
  })

  const session = await createCheckoutSession(secret, form)
  if (!session.ok) return json({ error: "stripe_error" }, 502)

  console.log(
    JSON.stringify({
      event: "billing-checkout-created",
      installationId: admin.installationId,
      tier: validation.tier,
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

  // The portal call carries no meaningful body beyond an optional selector — a null /
  // non-object / absent body is fine (defaults to the caller's sole installation).
  const body = (await parseJsonObject(request)) ?? {}

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
