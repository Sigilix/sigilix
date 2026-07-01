// SIG-545 (Boreas CLI gateway) — POST /v1/boreas/chat/completions.
//
// A thin wrapper over the shared Vertex chat proxy (handleVertexChatRoute, see
// vertex-chat-route.ts for the full behavior: auth-first, daily ceiling, model forcing,
// keyless SA-token mint, stream passthrough, generic GCP errors). This file pins ONLY the
// Boreas-specific knobs: the forced model id, the daily-counter key prefix, and the daily
// ceiling env var — plus (#158) its ordered-fallback-chain knobs (see fallback-chain.ts).

import type { Env } from "@/src/shared/types/env"
import { handleVertexChatRoute } from "./vertex-chat-route"
import { VERTEX_MODEL, DEFAULT_BOREAS_FALLBACK_TURBO_MODEL } from "./constants"

/** POST /v1/boreas/chat/completions — the Boreas-pinned Vertex chat proxy. */
export function handleBoreasApiRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return handleVertexChatRoute(request, env, ctx, {
    model: VERTEX_MODEL,
    counterKey: "boreas",
    limitEnvVar: "OPENCLAW_BOREAS_DAILY_LIMIT",
    sigilixModel: "boreas",
    fallbackTurboModelEnvVar: "OPENCLAW_BOREAS_FALLBACK_TURBO_MODEL",
    defaultFallbackTurboModel: DEFAULT_BOREAS_FALLBACK_TURBO_MODEL,
    fallbackBedrockModelEnvVar: "OPENCLAW_BOREAS_FALLBACK_BEDROCK_MODEL",
  })
}
