// Portal Organization page HTTP routes, wired into src/index.ts through the
// single `handleOrgRoutes` dispatcher below. Kept here (not inlined in
// index.ts) for the file's COMPLIANCE.md §4 line budget — the same pattern as
// src/do/mcp/routes.ts's `tryHandleMcpRoute`.
//
//   GET  /v1/org/overview                              → org-overview-route.ts
//   POST /v1/org/:installationId/members/:login/seat   → org-seat-route.ts
//
// Both are portal-facing (a DIFFERENT ORIGIN — app.sigilix.ai / localhost:3300
// drives them over `fetch(…, { credentials: "include" })`), so this surface
// owns its own portal-CORS handling: the OPTIONS preflight is answered via
// handlePortalPreflight and every matched response is wrapped with
// withPortalCors (never a `*` origin). The dispatcher returns `null` when
// nothing under /v1/org/ matches, so index.ts falls through to its own routing.

import { handleOrgOverviewRoute } from "@/src/lib/org-overview-route"
import { handleOrgSeatRoute } from "@/src/lib/org-seat-route"
import { handlePortalPreflight, withPortalCors } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"

// Non-global (no `g` flag) so it is safe to reuse for both `.test()` and
// `.exec()` — matches the two regex literals index.ts used inline.
const SEAT_PATH_RE = /^\/v1\/org\/([^/]+)\/members\/([^/]+)\/seat$/

/** True for a path this surface serves — the overview endpoint or a seat path. */
function isOrgPath(pathname: string): boolean {
  return pathname === "/v1/org/overview" || SEAT_PATH_RE.test(pathname)
}

/**
 * Match + dispatch the portal Organization routes. Answers this surface's own
 * CORS preflight, routes GET /v1/org/overview and POST …/seat to their
 * handlers, and applies portal CORS on the way out. Returns `null` when the
 * request matches nothing here so the caller falls through to its own routing.
 */
export async function handleOrgRoutes(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === "OPTIONS" && isOrgPath(url.pathname)) {
    return handlePortalPreflight(request, env)
  }
  // portal Organization page: overview (GET) + seat assign/unassign (POST) — org-*-route.ts
  if (request.method === "GET" && url.pathname === "/v1/org/overview") {
    return withPortalCors(request, await handleOrgOverviewRoute(request, env, ctx), env)
  }
  const seatMatch = SEAT_PATH_RE.exec(url.pathname)
  if (request.method === "POST" && seatMatch) {
    const iid = Number(decodeURIComponent(seatMatch[1]!))
    const who = decodeURIComponent(seatMatch[2]!)
    return withPortalCors(request, await handleOrgSeatRoute(request, env, ctx, iid, who), env)
  }
  return null
}
