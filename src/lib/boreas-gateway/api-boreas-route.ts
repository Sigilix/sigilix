// SIG-545 (Boreas CLI gateway) — POST /v1/boreas/chat/completions.
//
// The authenticated proxy a CLI user hits: it validates the shared bearer
// ($OPENCLAW_SIGILIX_API_KEY), mints/reuses a keyless Vertex SA token (see
// vertex-token.ts), and proxies the chat-completions request to Vertex — forcing
// the model id so a caller can't pick another (cost/abuse control). Streaming is a
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
import { requireBearerToken } from "@/src/lib/auth-bearer"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { getVertexAccessToken } from "./vertex-token"
import { VERTEX_CHAT_COMPLETIONS_URL, VERTEX_MODEL } from "./constants"

// Chat bodies carry the full prompt/history, so the cap is generous (vs the tiny
// query routes) but still bounds an abusive buffer. Enforced as the stream is read.
const MAX_BODY_BYTES = 2 * 1024 * 1024
const DAY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60 // expire yesterday's counter (2-day window)
const DEFAULT_DAILY_LIMIT = 200 // coarse endpoint-wide daily request ceiling (cost guard)

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/**
 * Coarse endpoint-wide daily ceiling (mirrors handleReviewApiRoute's
 * admitUnderDailyCeiling). A single global KV counter per day — NOT per-key metering.
 * Returns false (→ 429) once the day's count reaches the limit, otherwise increments
 * and returns true. The limit is env-driven (OPENCLAW_BOREAS_DAILY_LIMIT, numeric;
 * unset → DEFAULT_DAILY_LIMIT). Best-effort: a KV hiccup never blocks a request. The
 * check+increment is non-atomic (KV has no atomic incr) — acceptable for a COARSE
 * ceiling: a burst may slip a few past, but runaway GCP spend is still bounded.
 */
async function admitUnderDailyCeiling(env: Env): Promise<boolean> {
  const parsed = Number(env.OPENCLAW_BOREAS_DAILY_LIMIT)
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `boreas:count:${day}`
    const current = Number(await env.OPENCLAW_STATE.get(key)) || 0
    if (current >= limit) return false
    await env.OPENCLAW_STATE.put(key, String(current + 1), { expirationTtl: DAY_COUNTER_TTL_SECONDS })
    return true
  } catch {
    return true // never block a request on a counter failure
  }
}

/**
 * POST /v1/boreas/chat/completions — see file header. 503 until keyed / issuer set;
 * 401 on a bad bearer; 429 over the daily ceiling; 400 on bad JSON / non-object body;
 * 413 on an oversized body; 502 on a GCP/Vertex failure; otherwise the Vertex response
 * is passed through.
 */
export async function handleBoreasApiRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // AUTH FIRST — before body read, token mint, or any GCP call.
  const token = env.OPENCLAW_SIGILIX_API_KEY
  if (!token) return json({ error: "boreas_gateway_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)
  if (!env.OPENCLAW_GATEWAY_ISSUER) return json({ error: "boreas_gateway_not_configured" }, 503)

  // Daily cost ceiling — checked AFTER auth but BEFORE the token mint / Vertex call, so
  // an over-limit request never mints a GCP token or bills Vertex. The increment IS the
  // meter (the `boreas:count:<day>` counter), so it now gates rather than just counting.
  if (!(await admitUnderDailyCeiling(env))) return json({ error: "daily_limit_exceeded" }, 429)

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

  // Force the model id — the caller can't override which model the gateway bills for.
  const payload = { ...(raw as Record<string, unknown>), model: VERTEX_MODEL }

  // Mint/reuse the keyless Vertex SA token. A GCP failure → 502 (never a clean pass).
  // The error is logged SERVER-SIDE for debugging but the caller-facing `detail` is
  // generic — a GCP STS/IAM error body carries the project number / pool / provider /
  // SA email, which must never reach a caller.
  let accessToken: string
  try {
    accessToken = await getVertexAccessToken(env, ctx)
  } catch (err) {
    console.error("boreas: vertex token mint failed", err)
    return json({ error: "boreas_upstream_error", detail: "upstream token mint failed" }, 502)
  }

  let upstream: Response
  try {
    upstream = await fetch(VERTEX_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.error("boreas: vertex chat-completions fetch failed", err)
    return json({ error: "boreas_upstream_error", detail: "upstream request failed" }, 502)
  }

  // Passthrough: forwarding the upstream body streams transparently when the caller
  // requested `stream:true` and returns the JSON otherwise — same code path either way.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  })
}
