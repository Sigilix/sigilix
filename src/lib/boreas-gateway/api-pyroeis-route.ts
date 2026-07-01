// SIG-545 (Pyroeis CLI gateway) — POST /v1/pyroeis/chat/completions.
//
// A thin wrapper over the shared Vertex chat proxy (handleVertexChatRoute, see
// vertex-chat-route.ts for the full behavior: auth-first, daily ceiling, model forcing,
// keyless SA-token mint, stream passthrough, generic GCP errors). Identical to the Boreas
// route (same project / SA / WIF token mint) — it pins ONLY the Pyroeis-specific knobs:
// the forced model id (Gemma 4 26B serverless MaaS), the daily-counter key prefix, and the
// daily ceiling env var — plus (#158) its ordered-fallback-chain knobs. Pyroeis has NO
// built-in default Turbo fallback model (see constants.ts) — OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL
// must be set explicitly, or a Vertex failure surfaces directly (no silent Gemma-tag guess).

import type { Env } from "@/src/shared/types/env"
import { handleVertexChatRoute } from "./vertex-chat-route"
import { PYROEIS_MODEL } from "./constants"

/** POST /v1/pyroeis/chat/completions — the Pyroeis-pinned Vertex chat proxy. */
export function handlePyroeisApiRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return handleVertexChatRoute(request, env, ctx, {
    model: PYROEIS_MODEL,
    counterKey: "pyroeis",
    limitEnvVar: "OPENCLAW_PYROEIS_DAILY_LIMIT",
    sigilixModel: "pyroeis",
    fallbackTurboModelEnvVar: "OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL",
    // No defaultFallbackTurboModel — see file header.
    fallbackBedrockModelEnvVar: "OPENCLAW_PYROEIS_FALLBACK_BEDROCK_MODEL",
  })
}
