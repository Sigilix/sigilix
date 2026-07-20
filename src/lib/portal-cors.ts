// Portal-facing CORS-with-credentials helper (#155 onboarding-backend
// slice 3 — portal endpoints).
//
// The portal (https://app.sigilix.ai in prod, http://localhost:3300 in dev)
// is a DIFFERENT ORIGIN from this Worker, and its setup wizard drives the
// session-based onboarding flow over `fetch(..., { credentials: "include" })`
// — a credentialed cross-origin request. The marketing site
// (https://sigilix.ai / https://www.sigilix.ai) is likewise a different
// origin: its nav reads GET /auth/session credentialed to swap the "Sign in /
// Start a free trial" CTAs for a "Dashboard" link when the visitor already has
// a live session. Both are same-site (*.sigilix.ai) so the SameSite=None
// session cookie is attached; they still need an EXACT-Origin CORS grant to
// read the response. The Fetch spec forbids
// `Access-Control-Allow-Origin: *` whenever credentials are involved (the
// browser refuses the response if a server tries it), so every response on
// a portal-facing session endpoint must echo back the EXACT matched Origin
// header — never a wildcard — and only when that Origin is on an
// allowlist. This file is the single place that decision is made so
// nothing outside it can drift the allowlist or fall back to a wildcard.
//
// Allowlist: OPENCLAW_PORTAL_ORIGINS, comma-separated, EXACT match (scheme +
// host + port, same as the browser's Origin header — no wildcards, no
// suffix matching). Defaults to the prod portal + its local dev server. A
// non-allowlisted Origin gets NO CORS headers at all — not an error
// response carrying headers, just silence — so the browser's own
// same-origin policy blocks the caller from ever reading the response.

export interface PortalCorsEnv {
  OPENCLAW_PORTAL_ORIGINS?: string
}

/**
 * CSRF guard for session-cookie-authed MUTATING routes on this cookie (see
 * auth-session.ts's setSessionCookie doc comment for the SameSite=None
 * tradeoff this exists to mitigate). A cross-site attacker can still fire a
 * "simple" request — GET/POST/HEAD with a CORS-safelisted Content-Type
 * (`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`,
 * or none) — WITHOUT a preflight, so the origin allowlist above is never
 * consulted for it; the browser still attaches the SameSite=None cookie.
 * Requiring `application/json` (which is NOT CORS-safelisted) forces the
 * browser to preflight first, so the allowlist actually gates the request.
 * Every mutating route on this cookie (including POST /v1/keys, POST
 * /v1/onboarding, and repository-context onboarding import)
 * MUST call this before touching the body. This is a request-shape check,
 * not a substitute for the origin allowlist — pair the two.
 */
export function hasJsonContentType(request: Request): boolean {
  const raw = request.headers.get("content-type") ?? ""
  return raw.toLowerCase().split(";")[0]!.trim() === "application/json"
}

const DEFAULT_PORTAL_ORIGINS = "https://app.sigilix.ai,https://sigilix.ai,https://www.sigilix.ai,http://localhost:3300"
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
const ALLOWED_HEADERS = "content-type"
const PREFLIGHT_MAX_AGE_SECONDS = "600"

function parsePortalOrigins(env: PortalCorsEnv): string[] {
  const raw = env.OPENCLAW_PORTAL_ORIGINS ?? DEFAULT_PORTAL_ORIGINS
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Exact-match check against the allowlist. Never wildcards. */
export function isAllowedPortalOrigin(origin: string | null, env: PortalCorsEnv): origin is string {
  if (!origin) return false
  return parsePortalOrigins(env).includes(origin)
}

/**
 * Wrap a handler's response with CORS-with-credentials headers when the
 * request's Origin is allowlisted. `Vary: Origin` is appended
 * unconditionally (allowed or not) so a shared/edge cache never serves one
 * origin's CORS grant (or lack of one) to a different origin.
 */
export function withPortalCors(request: Request, response: Response, env: PortalCorsEnv): Response {
  const origin = request.headers.get("origin")
  const headers = new Headers(response.headers)
  headers.append("vary", "Origin")
  if (isAllowedPortalOrigin(origin, env)) {
    headers.set("access-control-allow-origin", origin)
    headers.set("access-control-allow-credentials", "true")
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Handle an OPTIONS preflight for a portal-facing route. An allowlisted
 * Origin gets a 204 with the full CORS grant (origin echoed, credentials
 * true, allowed methods/headers, preflight cache). A non-allowlisted
 * Origin (or no Origin header at all) gets a bare 403 with no CORS headers
 * — we never echo an origin we didn't verify.
 */
export function handlePortalPreflight(request: Request, env: PortalCorsEnv): Response {
  const origin = request.headers.get("origin")
  if (!isAllowedPortalOrigin(origin, env)) {
    return new Response(null, { status: 403, headers: { vary: "Origin" } })
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": ALLOWED_METHODS,
      "access-control-allow-headers": ALLOWED_HEADERS,
      "access-control-max-age": PREFLIGHT_MAX_AGE_SECONDS,
      vary: "Origin",
    },
  })
}
