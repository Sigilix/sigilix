// SIG-545 (Boreas/Pyroeis CLI gateway) — the SHARED authenticated Vertex chat proxy.
//
// Both /v1/boreas/chat/completions and /v1/pyroeis/chat/completions are the SAME route
// (auth → daily ceiling → body read → force model → keyless SA-token mint → Vertex
// passthrough); they differ ONLY by the forced model id and the daily-counter key/limit,
// which are passed in as `VertexChatRouteConfig`. The thin per-model wrappers live in
// api-boreas-route.ts / api-pyroeis-route.ts.
//
// The authenticated proxy a CLI user hits: it validates the shared bearer
// ($OPENCLAW_SIGILIX_API_KEY), mints/reuses a keyless Vertex SA token (see
// vertex-token.ts), and proxies the chat-completions request to Vertex — forcing the
// model id so a caller can't pick another (cost/abuse control). Streaming is a
// transparent body passthrough.
//
// AUTH FIRST (Codex review fix P0 #3, mirrors handleReviewApiRoute): the bearer is
// checked from the HEADER before the body is read, before any GCP token is minted,
// and before Vertex is called — so an unauthenticated caller can never force a body
// buffer or trigger a token mint. The route is additionally inert (503) until
// OPENCLAW_GATEWAY_ISSUER is set (the WIF issuer the GCP provider trusts).
//
// NOTHING here logs or returns the SA token / the request body.

import type { Env } from "@/src/shared/types/env"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { runGatewayChain } from "./fallback-chain"

// Chat bodies carry the full prompt/history, so the cap is generous (vs the tiny
// query routes) but still bounds an abusive buffer. Enforced as the stream is read.
const MAX_BODY_BYTES = 2 * 1024 * 1024
const DAY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60 // expire yesterday's counter (2-day window)
const DEFAULT_DAILY_LIMIT = 200 // coarse endpoint-wide daily request ceiling (cost guard)

/**
 * The ONLY things that differ between the Boreas and Pyroeis routes. Everything else
 * (auth, ceiling logic, token mint, model forcing, passthrough) is shared.
 */
export interface VertexChatRouteConfig {
  /** Forced Vertex model id — the caller can't override which model the gateway bills for. */
  model: string
  /** KV daily-counter key prefix → the counter is `<counterKey>:count:<day>`. */
  counterKey: string
  /** Env var holding this route's numeric daily ceiling (unset → DEFAULT_DAILY_LIMIT). */
  limitEnvVar: keyof Env
  // #158 (model-gateway failover chain) — see fallback-chain.ts for the full design.
  /** Telemetry model id for the `gateway-fallback` event ("boreas" | "pyroeis" | "astraeus"). */
  sigilixModel: string
  /** Env var holding this route's Turbo fallback model override. */
  fallbackTurboModelEnvVar: keyof Env
  /** Built-in default Turbo fallback model id — undefined → no default (e.g. Pyroeis). */
  defaultFallbackTurboModel?: string
  /** Env var holding this route's Bedrock fallback model id (scaffold — see bedrock-chat.ts). */
  fallbackBedrockModelEnvVar: keyof Env
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/**
 * Coarse endpoint-wide daily ceiling (mirrors handleReviewApiRoute's
 * admitUnderDailyCeiling). A single global KV counter per day — NOT per-key metering.
 * Returns false (→ 429) once the day's count reaches the limit, otherwise increments
 * and returns true. The limit is env-driven (cfg.limitEnvVar, numeric; unset →
 * DEFAULT_DAILY_LIMIT). Best-effort: a KV hiccup never blocks a request. The
 * check+increment is non-atomic (KV has no atomic incr) — acceptable for a COARSE
 * ceiling: a burst may slip a few past, but runaway GCP spend is still bounded.
 */
async function admitUnderDailyCeiling(env: Env, cfg: VertexChatRouteConfig): Promise<boolean> {
  const parsed = Number(env[cfg.limitEnvVar])
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `${cfg.counterKey}:count:${day}`
    const current = Number(await env.OPENCLAW_STATE.get(key)) || 0
    if (current >= limit) return false
    await env.OPENCLAW_STATE.put(key, String(current + 1), { expirationTtl: DAY_COUNTER_TTL_SECONDS })
    return true
  } catch {
    return true // never block a request on a counter failure
  }
}

/**
 * Shared handler for the Vertex chat-completions gateway routes. 503 until keyed / issuer
 * set; 401 on a bad bearer; 429 over the daily ceiling; 400 on bad JSON / non-object body;
 * 413 on an oversized body; 502 on a GCP/Vertex failure; otherwise the Vertex response is
 * passed through. The forced model + the daily-counter key/limit come from `cfg`.
 */
export async function handleVertexChatRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cfg: VertexChatRouteConfig,
): Promise<Response> {
  // AUTH FIRST — before body read, token mint, or any GCP call.
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication). No
  // installationId is threaded further: this gateway has no per-tenant concept
  // downstream (only the global per-day KV counter below), so the resolved
  // identity is used ONLY to decide 401 vs proceed.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "boreas_gateway_not_configured" }, 503)
  }
  const auth = await requireApiTenant(request, env, ctx)
  if ("response" in auth) return auth.response
  if (!env.OPENCLAW_GATEWAY_ISSUER) return json({ error: "boreas_gateway_not_configured" }, 503)

  // Daily cost ceiling — checked AFTER auth but BEFORE the token mint / Vertex call, so
  // an over-limit request never mints a GCP token or bills Vertex. The increment IS the
  // meter (the `<counterKey>:count:<day>` counter), so it now gates rather than just counting.
  if (!(await admitUnderDailyCeiling(env, cfg))) return json({ error: "daily_limit_exceeded" }, 429)

  // Body read is CAPPED as the stream is consumed (post-auth) so an oversized payload
  // is aborted, never fully buffered; `null` = over the cap → 413.
  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null)
      return json({ error: "payload_too_large", detail: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return json({ error: "invalid_request", detail: "body must be a JSON object" }, 400)
  }

  // #158: walk the ordered per-model failover chain (Vertex -> Ollama Turbo ->
  // AWS Bedrock scaffold). Model-forcing happens PER LEG inside the chain (each
  // leg substitutes its own model id) — `raw` is passed through untouched so a
  // fallback leg doesn't inherit the Vertex model id. Streaming/response
  // semantics, the daily counter (already applied above, once), and the
  // generic-error-detail contract are all preserved; see fallback-chain.ts for
  // the retry/telemetry/marker design.
  return runGatewayChain(env, ctx, cfg, raw as Record<string, unknown>)
}
