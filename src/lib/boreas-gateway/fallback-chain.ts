// #158 — the model-gateway failover chain: an ORDERED per-model fallback so a
// flaky Vertex MaaS leg doesn't fail the whole request when a next leg is
// configured. Founder-locked doctrine (see the constants.ts / turbo-chat.ts /
// bedrock-chat.ts headers for each leg's own detail):
//
//   1. Vertex MaaS         — the existing leg, unchanged behavior.
//   2. Ollama Turbo        — per-token/serverless; env-configurable per-model
//                            substitute model id, sensible built-in defaults
//                            for Boreas/Astraeus, NONE for Pyroeis (no guessed
//                            Gemma tag).
//   3. AWS Bedrock         — per-token/serverless; SCAFFOLD, skipped entirely
//                            until OPENCLAW_AWS_* creds + a per-model Bedrock
//                            model id are all configured.
//
// FAILOVER TRIGGERS — only BEFORE the first response byte: a connect
// error, a timeout, HTTP 5xx, or HTTP 429 (`isRetryableStatus`/`LEG_TIMEOUT_MS`
// below). A genuine 4xx (a caller mistake) is NEVER retried onto the next leg —
// only Vertex being flaky retries, not the caller being wrong. Once a leg's
// `fetch` has resolved with headers/status, we've already decided retry or
// serve — we never buffer or inspect the body, so streaming passes straight
// through untouched on whichever leg ultimately serves (mid-stream failover is
// explicitly NOT attempted, per doctrine).
//
// SUBSTITUTION IS NEVER SILENT: any leg past Vertex that serves the response
// gets a `gateway-fallback` structured log line (no secret/token material —
// only sigilixModel/leg/upstreamModel/reason) AND an `x-sigilix-served-by`
// response header, so the CLI/telemetry can see the degradation. Both are
// fail-closed by construction: if EVERY configured leg fails, the last leg's
// real error response surfaces as-is — never a fabricated success.
//
// The daily-ceiling counter (admitUnderDailyCeiling in vertex-chat-route.ts)
// runs ONCE, before this chain is ever invoked — so a request that falls
// through legs is still metered exactly once, regardless of which leg serves.

import type { Env } from "@/src/shared/types/env"
import { getVertexAccessToken } from "./vertex-token"
import { VERTEX_CHAT_COMPLETIONS_URL } from "./constants"
import { attemptTurboLeg, isTurboConfigured, resolveTurboModel } from "./turbo-chat"
import { attemptBedrockLeg, isBedrockConfigured, type BedrockCreds, type BedrockCredsInput } from "./bedrock-chat"
import type { VertexChatRouteConfig } from "./vertex-chat-route"

/** Time budget for a single leg's fetch to resolve HEADERS (not the full stream). */
const LEG_TIMEOUT_MS = 20_000

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

/** Coarse reason label for a completed (non-thrown) HTTP response — used only
 *  for the telemetry `reason` field carried forward to a LATER leg's success
 *  marker; has no bearing on the retry decision itself (status does). */
function classifyHttpReason(status: number): string {
  if (status === 429) return "429"
  if (status >= 500) return "5xx"
  return "terminal"
}

interface LegAttempt {
  leg: "vertex" | "turbo" | "bedrock"
  upstreamModel: string
  reason: string
  response: Response
}

async function attemptVertexLeg(
  env: Env,
  ctx: ExecutionContext,
  cfg: VertexChatRouteConfig,
  rawPayload: Record<string, unknown>,
): Promise<LegAttempt> {
  let accessToken: string
  try {
    accessToken = await getVertexAccessToken(env, ctx)
  } catch (err) {
    // Server-side detail only — see vertex-chat-route.ts's header note on why the
    // GCP error body must never reach the caller (project/pool/provider/SA leak).
    console.error(`${cfg.counterKey}: vertex token mint failed`, err)
    return {
      leg: "vertex",
      upstreamModel: cfg.model,
      reason: "token_mint_error", // treated as retryable below (synthesized 502) — a WIF/STS
      // outage is exactly the kind of "Vertex is flaky" condition this chain exists for.
      response: new Response(JSON.stringify({ error: "boreas_upstream_error", detail: "upstream token mint failed" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    }
  }

  const payload = { ...rawPayload, model: cfg.model }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LEG_TIMEOUT_MS)
  try {
    const upstream = await fetch(VERTEX_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return {
      leg: "vertex",
      upstreamModel: cfg.model,
      reason: classifyHttpReason(upstream.status),
      response: new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      }),
    }
  } catch (err) {
    console.error(`${cfg.counterKey}: vertex chat-completions fetch failed`, err)
    return {
      leg: "vertex",
      upstreamModel: cfg.model,
      reason: "connect_error",
      response: new Response(JSON.stringify({ error: "boreas_upstream_error", detail: "upstream request failed" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    }
  } finally {
    clearTimeout(timer)
  }
}

function buildTurboLeg(
  env: Env,
  cfg: VertexChatRouteConfig,
  rawPayload: Record<string, unknown>,
): (() => Promise<LegAttempt>) | null {
  const modelId = resolveTurboModel(
    env[cfg.fallbackTurboModelEnvVar] as string | undefined,
    cfg.defaultFallbackTurboModel,
  )
  if (!isTurboConfigured(env.OLLAMA_API_KEY, modelId)) return null
  return async () => {
    const result = await attemptTurboLeg(rawPayload, modelId as string, env.OLLAMA_API_KEY as string, LEG_TIMEOUT_MS)
    return {
      leg: "turbo",
      upstreamModel: result.upstreamModel,
      reason: classifyHttpReason(result.response.status),
      response: result.response,
    }
  }
}

function buildBedrockLeg(
  env: Env,
  cfg: VertexChatRouteConfig,
  rawPayload: Record<string, unknown>,
): (() => Promise<LegAttempt>) | null {
  const modelId = (env[cfg.fallbackBedrockModelEnvVar] as string | undefined)?.trim() || undefined
  const credsInput: BedrockCredsInput = {
    region: env.OPENCLAW_AWS_REGION,
    accessKeyId: env.OPENCLAW_AWS_ACCESS_KEY_ID,
    secretAccessKey: env.OPENCLAW_AWS_SECRET_ACCESS_KEY,
  }
  if (!isBedrockConfigured(credsInput, modelId)) return null
  const creds: BedrockCreds = credsInput
  return async () => {
    const result = await attemptBedrockLeg(rawPayload, modelId as string, creds, LEG_TIMEOUT_MS)
    return {
      leg: "bedrock",
      upstreamModel: result.upstreamModel,
      reason: classifyHttpReason(result.response.status),
      response: result.response,
    }
  }
}

/**
 * Walk the ordered leg chain for one request, stopping at the first leg whose
 * outcome is terminal (a real success, a real non-retryable client error, or
 * simply the last configured leg — its result surfaces either way). A
 * retryable outcome (connect error / timeout / 5xx / 429) on a leg that has a
 * next leg configured drops that leg's response body and moves on.
 */
export async function runGatewayChain(
  env: Env,
  ctx: ExecutionContext,
  cfg: VertexChatRouteConfig,
  rawPayload: Record<string, unknown>,
): Promise<Response> {
  const legs: Array<() => Promise<LegAttempt>> = [() => attemptVertexLeg(env, ctx, cfg, rawPayload)]
  const turboLeg = buildTurboLeg(env, cfg, rawPayload)
  if (turboLeg) legs.push(turboLeg)
  const bedrockLeg = buildBedrockLeg(env, cfg, rawPayload)
  if (bedrockLeg) legs.push(bedrockLeg)

  let precedingFailureReason = "n/a"
  for (let i = 0; i < legs.length; i++) {
    const runLeg = legs[i]
    if (!runLeg) break // unreachable — i < legs.length guarantees an entry; satisfies noUncheckedIndexedAccess
    const attempt = await runLeg()
    const retryable = isRetryableStatus(attempt.response.status)
    const isLastLeg = i === legs.length - 1

    if (retryable && !isLastLeg) {
      // Not serving this leg's response — release its body promptly and remember
      // why, so a later leg's success telemetry can say what it fell over from.
      await attempt.response.body?.cancel().catch(() => {})
      precedingFailureReason = attempt.reason
      continue
    }

    if (attempt.leg !== "vertex" && !retryable) {
      // A fallback leg served a terminal (non-retryable) response — NEVER silent.
      console.log(
        JSON.stringify({
          event: "gateway-fallback",
          sigilixModel: cfg.sigilixModel,
          leg: attempt.leg,
          upstreamModel: attempt.upstreamModel,
          reason: precedingFailureReason,
        }),
      )
      const headers = new Headers(attempt.response.headers)
      headers.set("x-sigilix-served-by", attempt.leg)
      return new Response(attempt.response.body, { status: attempt.response.status, headers })
    }

    // Vertex serving normally (no marker), OR the chain is exhausted and this
    // leg's real error/response surfaces as-is — recall-safe, no fake success.
    return attempt.response
  }

  // Unreachable: `legs` always has >= 1 entry (Vertex) and the loop always
  // returns on its last iteration. Satisfies the compiler's control-flow check.
  throw new Error("runGatewayChain: no leg produced a response")
}
