// SIG-545 / sig-cli-cost-report — the CLI-gateway route group.
//
// One place that dispatches every POST the Sigilix CLI makes to the hosted gateway
// surface: the three per-model chat proxies (Boreas/Pyroeis/Astraeus — authenticated
// keyless-WIF Vertex passthroughs that force the backing model server-side) and the
// usage-report endpoint the CLI POSTs its per-turn token usage to. Extracted from
// index.ts so the entry file stays under its size budget and the CLI-gateway surface
// lives together. Returns the route's Response, or `null` when the path/method isn't
// one of these (so the caller falls through to the next route group).

import type { Env } from "@/src/shared/types/env"
import { handleBoreasApiRoute } from "@/src/lib/boreas-gateway/api-boreas-route"
import { handlePyroeisApiRoute } from "@/src/lib/boreas-gateway/api-pyroeis-route"
import { handleAstraeusApiRoute } from "@/src/lib/boreas-gateway/api-astraeus-route"
import { handleUsageReportRoute } from "@/src/lib/usage-report-route"

/**
 * Dispatch the CLI-gateway POST routes. Each per-model route is a keyless-WIF Vertex
 * proxy (static-bearer auth, server-side SA-token mint, model forcing; inert 503 until
 * OPENCLAW_SIGILIX_API_KEY + OPENCLAW_GATEWAY_ISSUER are set). `/v1/usage/report` late-
 * binds the CLI turn's token cost onto its coding_agent event (same bearer auth; a
 * caller can only report its OWN usage). Returns `null` for a non-match.
 */
export function handleCliGatewayRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> | null {
  if (request.method !== "POST") return null
  switch (url.pathname) {
    case "/v1/boreas/chat/completions":
      return handleBoreasApiRoute(request, env, ctx)
    case "/v1/pyroeis/chat/completions":
      return handlePyroeisApiRoute(request, env, ctx)
    case "/v1/astraeus/chat/completions":
      return handleAstraeusApiRoute(request, env, ctx)
    case "/v1/usage/report":
      return handleUsageReportRoute(request, env, ctx)
    default:
      return null
  }
}
