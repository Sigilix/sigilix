// SIG-545 (Boreas CLI gateway) — POST /v1/boreas/chat/completions.
//
// A thin wrapper over the shared Vertex chat proxy (handleVertexChatRoute, see
// vertex-chat-route.ts for the full behavior: auth-first, daily ceiling, model forcing,
// keyless SA-token mint, stream passthrough, generic GCP errors). This file pins ONLY the
// Boreas-specific knobs: the forced model id, the daily-counter key prefix, and the daily
// ceiling env var.

import type { Env } from "@/src/shared/types/env"
import { handleVertexChatRoute } from "./vertex-chat-route"
import { VERTEX_MODEL } from "./constants"

/** POST /v1/boreas/chat/completions — the Boreas-pinned Vertex chat proxy. */
export function handleBoreasApiRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return handleVertexChatRoute(request, env, ctx, {
    model: VERTEX_MODEL,
    counterKey: "boreas",
    limitEnvVar: "OPENCLAW_BOREAS_DAILY_LIMIT",
  })
}
