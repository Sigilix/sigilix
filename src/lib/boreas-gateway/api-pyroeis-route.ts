// SIG-545 (Pyroeis CLI gateway) — POST /v1/pyroeis/chat/completions.
//
// A thin wrapper over the shared Vertex chat proxy (handleVertexChatRoute, see
// vertex-chat-route.ts for the full behavior: auth-first, daily ceiling, model forcing,
// keyless SA-token mint, stream passthrough, generic GCP errors). Identical to the Boreas
// route (same project / SA / WIF token mint) — it pins ONLY the Pyroeis-specific knobs:
// the forced model id (Gemini 3.5 Flash on Vertex AI, addressed over the same OpenAI-compat
// endpoint — no adapter), the daily-counter key prefix, and the daily ceiling env var —
// plus (#158) its ordered-fallback-chain knobs. Pyroeis has NO built-in default Turbo
// fallback model (see constants.ts) — OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL must be set
// explicitly, or a Vertex failure surfaces directly (no silent Gemini-tag guess).
//
// The forced model id is env-overridable (SIGILIX_PYROEIS_MODEL) over the built-in
// DEFAULT_PYROEIS_MODEL default — the exact Gemini 3.5 Flash version string can't be
// confirmed without live Vertex, so correcting it is a config flip, not a code change.

import type { Env } from "@/src/shared/types/env"
import { handleVertexChatRoute } from "./vertex-chat-route"
import { DEFAULT_PYROEIS_MODEL } from "./constants"

/** POST /v1/pyroeis/chat/completions — the Pyroeis-pinned Vertex chat proxy. */
export function handlePyroeisApiRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return handleVertexChatRoute(request, env, ctx, {
    model: env.SIGILIX_PYROEIS_MODEL?.trim() || DEFAULT_PYROEIS_MODEL,
    counterKey: "pyroeis",
    limitEnvVar: "OPENCLAW_PYROEIS_DAILY_LIMIT",
    sigilixModel: "pyroeis",
    fallbackTurboModelEnvVar: "OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL",
    // No defaultFallbackTurboModel — see file header.
    fallbackBedrockModelEnvVar: "OPENCLAW_PYROEIS_FALLBACK_BEDROCK_MODEL",
  })
}
