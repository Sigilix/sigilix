// sig-user-profile — the portal's account/plan panel routes, pulled out of
// index.ts (which sits at the 1,000-line size-budget ceiling) into a small
// dispatcher mirroring tryHandleMcpRoute.
//
// These two routes are the cohesive pair that read the shared billing seam in
// resolve-plan.ts (its header names both as consumers), so they belong to one
// account/plan surface:
//   GET   /v1/usage   → portal "Plan usage limits" panel + CLI `/usage` bars
//   GET   /v1/profile → account menu (name + plan badge), greeting, /settings
//   PATCH /v1/profile → save the /settings profile editor
//
// The dispatcher self-contains the portal CORS preflight + response wrapping
// (like the MCP dispatcher), so index.ts needs no allowlist entry for these
// paths. Returns null when the path/method isn't ours so the caller falls
// through to the next route.
import { handleUsageRoute } from "@/src/lib/usage-route"
import { handleUserProfileGetRoute, handleUserProfilePatchRoute } from "@/src/lib/user-profile-route"
import { withPortalCors, handlePortalPreflight } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"

export async function tryHandlePortalAccountRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const isAccountPath = url.pathname === "/v1/usage" || url.pathname === "/v1/profile"
  if (!isAccountPath) return null

  if (request.method === "OPTIONS") {
    return handlePortalPreflight(request, env)
  }
  // sig-usage: portal "Plan usage limits" panel + CLI `/usage` bars (usage-route.ts).
  if (request.method === "GET" && url.pathname === "/v1/usage") {
    return withPortalCors(request, await handleUsageRoute(request, env, ctx), env)
  }
  // sig-user-profile: account menu (name + plan badge), greeting, and the
  // /settings profile editor. Session-authed, own-profile-only.
  if (request.method === "GET" && url.pathname === "/v1/profile") {
    return withPortalCors(request, await handleUserProfileGetRoute(request, env, ctx), env)
  }
  if (request.method === "PATCH" && url.pathname === "/v1/profile") {
    return withPortalCors(request, await handleUserProfilePatchRoute(request, env, ctx), env)
  }
  return null
}
