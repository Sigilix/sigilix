// SIG-545 (Astraeus CLI gateway) — POST /v1/astraeus/chat/completions.
//
// A thin wrapper over the shared Vertex chat proxy (handleVertexChatRoute, see
// vertex-chat-route.ts for the full behavior: auth-first, daily ceiling, model forcing,
// keyless SA-token mint, stream passthrough, generic GCP errors). Identical to the Boreas
// route (same project / SA / WIF token mint) — it pins ONLY the Astraeus-specific knobs:
// the forced model id (GLM-5.2 serverless MaaS), the daily-counter key prefix, and the
// daily ceiling env var.

import type { Env } from "@/src/shared/types/env"
import { handleVertexChatRoute } from "./vertex-chat-route"
import { ASTRAEUS_MODEL } from "./constants"

/** POST /v1/astraeus/chat/completions — the Astraeus-pinned Vertex chat proxy. */
export function handleAstraeusApiRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return handleVertexChatRoute(request, env, ctx, {
    model: ASTRAEUS_MODEL,
    counterKey: "astraeus",
    limitEnvVar: "OPENCLAW_ASTRAEUS_DAILY_LIMIT",
  })
}
