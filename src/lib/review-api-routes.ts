// sig-public-demo — the review HTTP surface, extracted from src/index.ts into one
// cohesive sub-dispatcher (the same move auth-routes.ts made, and for the same reason:
// the entry module sits exactly on its 1,000-line ceiling — COMPLIANCE §4). Routing is
// byte-identical to what index.ts did for /v1/review; /v1/demo/review is the new route.
//
// Two sibling endpoints, DIFFERENT trust models — the difference is the whole point:
//
//   POST /v1/review       AUTHED. An API bearer (CLI) or an exact-repo-scoped portal
//                         session. Credentialed CORS (portal-cors: origin echoed,
//                         credentials true). See api-review-route.ts.
//
//   POST /v1/demo/review  PUBLIC. NO AUTH AT ALL — a stranger pastes a public GitHub PR
//                         URL and gets a real review. It is gated instead by the abuse
//                         controls inside the handler (fail-closed kill switch, per-IP
//                         cap, global daily USD budget, public-repos-only, diff-size
//                         cap, 7d result cache) — see api-demo-review-route.ts. Its CORS
//                         is CREDENTIAL-LESS (it carries no cookie and must not), which
//                         is why it does NOT join the portal-cors path list.
//
// `null` = not a review route → the caller falls through to the rest of the dispatcher.

import type { Env } from "@/src/shared/types/env"
import { handleReviewApiRoute } from "@/src/lib/api-review-route"
import { handleDemoPreflight, handleDemoReviewRoute, withDemoCors } from "@/src/lib/api-demo-review-route"
import { withPortalCors } from "@/src/lib/portal-cors"

async function demoReview(request: Request, env: Env): Promise<Response> {
  return withDemoCors(request, await handleDemoReviewRoute(request, env), env)
}

async function authedReview(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return withPortalCors(request, await handleReviewApiRoute(request, env, ctx), env)
}

export function tryHandleReviewApiRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> | null {
  if (url.pathname === "/v1/demo/review") {
    // Preflight is handled HERE (not in the portal-cors block) because the demo's CORS
    // grant must never carry `Access-Control-Allow-Credentials` — it is a public,
    // cookie-less endpoint, and a credentialed grant on it would be a needless CSRF surface.
    if (request.method === "OPTIONS") return Promise.resolve(handleDemoPreflight(request, env))
    if (request.method === "POST") return demoReview(request, env)
    return null
  }
  if (request.method === "POST" && url.pathname === "/v1/review") return authedReview(request, env, ctx)
  return null
}
