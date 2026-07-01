// #158 (model-gateway failover chain) — leg 2: Ollama Turbo (per-token/serverless),
// the OpenAI-compatible `/v1/chat/completions` endpoint (NOT the NDJSON
// `/api/chat` / `/api/generate` adapters in shared/adapters/model — those speak a
// different wire protocol and are consumed by the review ensemble / agent loop,
// a separate concern). Same auth pattern already used elsewhere in this Worker
// for Ollama Turbo (Authorization: Bearer OLLAMA_API_KEY) and the same base URL
// (`https://ollama.com/v1`, see admin-agent-run-route.ts / linear-agent-run.ts).
//
// The gateway proxies raw OpenAI chat-completions bodies, so this leg forwards
// the SAME request shape as the Vertex leg with only the model id swapped —
// streaming or not, the upstream response body is passed straight through by the
// caller (fallback-chain.ts), never buffered or re-encoded here.

import { OLLAMA_TURBO_CHAT_COMPLETIONS_URL } from "./constants"

export interface TurboLegResult {
  response: Response
  upstreamModel: string
}

/**
 * Resolve the Turbo fallback model id for a route: an env override, else the
 * route's built-in default (may be undefined — e.g. Pyroeis has none). Returns
 * undefined when there is no model to substitute — the caller must treat that
 * as "leg not configured" and skip it, never guess a model id.
 */
export function resolveTurboModel(
  envOverride: string | undefined,
  builtInDefault: string | undefined,
): string | undefined {
  const trimmed = envOverride?.trim()
  return trimmed ? trimmed : builtInDefault
}

/** True when the Turbo leg can be attempted at all: a key AND a resolved model id. */
export function isTurboConfigured(apiKey: string | undefined, modelId: string | undefined): boolean {
  return Boolean(apiKey?.trim()) && Boolean(modelId)
}

/**
 * Attempt the Turbo leg: forward `rawPayload` with `model` forced to `modelId`.
 * Always returns a Response (success or a synthesized 502/504 on a connect
 * error / timeout) — callers decide whether the status is retryable. Never
 * throws; a network failure or timeout is caught and turned into a generic
 * 502 (mirrors the Vertex leg's failure shape — no upstream error body/detail
 * leaked to the caller, no secret in the synthesized body).
 */
export async function attemptTurboLeg(
  rawPayload: Record<string, unknown>,
  modelId: string,
  apiKey: string,
  timeoutMs: number,
): Promise<TurboLegResult> {
  const payload = { ...rawPayload, model: modelId }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const upstream = await fetch(OLLAMA_TURBO_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return {
      response: new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      }),
      upstreamModel: modelId,
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "gateway-leg-error", leg: "turbo", detail: String(err) }))
    return {
      response: new Response(JSON.stringify({ error: "boreas_upstream_error", detail: "upstream request failed" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
      upstreamModel: modelId,
    }
  } finally {
    clearTimeout(timer)
  }
}
