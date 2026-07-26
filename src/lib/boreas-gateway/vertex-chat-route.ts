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

import { withUsageReporting, teeForUsage } from "@/src/lib/boreas-gateway/provider-usage"
import { codingAgentEventCost } from "@/src/shared/domain/sigilix-model-burn"
import { gatewayProviderUsageEnabled } from "@/src/lib/boreas-gateway/provider-usage-mode"
import { updateUsageEventCost } from "@/src/features/tenancy"
import type { Env } from "@/src/shared/types/env"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID, seatKeyFor } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import {
  appendUsageEvent,
  checkUsagePool,
  readTenantSubscriptionStatus,
  isFullPaidStatus,
} from "@/src/features/tenancy"
import { resolveInstallationPlan } from "@/src/lib/resolve-plan"
import { runGatewayChain } from "./fallback-chain"

// Chat bodies carry the full prompt/history, so the cap is generous (vs the tiny
// query routes) but still bounds an abusive buffer. Enforced as the stream is read.
// Sized to the widest model window: Pyroeis (Gemini 3.5 Flash) is 1M tokens ≈ 4MB of
// UTF-8, so a 2MB cap silently halved its usable window. 8MB fits a full 1M-token
// prompt plus JSON/history overhead; Boreas/Astraeus (262K/200K ≈ ≤1MB) are well under.
const MAX_BODY_BYTES = 8 * 1024 * 1024
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

/** Max correlation-id length kept as an event_id (a UUID is 36 chars; bound abuse). */
const MAX_CORRELATION_ID_LEN = 128

/**
 * Sanitize a client-supplied correlation id into a safe `event_id`: trim, reject
 * anything with control/whitespace chars (a UUID has none), cap the length. Returns
 * `undefined` for a missing/blank/oversized/garbage value so the caller records an
 * unkeyed row rather than a poisoned one. Shared with the /v1/usage/report route so
 * both ends agree on what a valid correlation id is.
 */
export function sanitizeCorrelationId(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (trimmed === "" || trimmed.length > MAX_CORRELATION_ID_LEN) return undefined
  // Allowlist printable ASCII only (no space/control/DEL/non-ASCII) — a UUID qualifies.
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return undefined
  return trimmed
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

  // SIG-303 SEAT pool (coding_agent). The CLI seat is the DEVELOPER behind the
  // API key: `gh:<createdBy>` (the github user id that minted the key), so a
  // per-developer, org-scoped seat read is possible and this key aligns with the
  // portal chatbot seat (`gh:<githubUserId>`). Only the legacy shared global key
  // (no developer) falls back to `inst:<installationId>`.
  // GRACE POLICY: checked at admission BEFORE the token mint / Vertex call — an
  // over-cap request never mints a GCP token; an in-flight stream is never aborted.
  // Behind SIGILIX_USAGE_METER_MODE (default shadow → never blocks). Fail-open.
  const seatKey = seatKeyFor(auth.caller)
  const now = Date.now()
  // sig-cost-based-metering: resolve the caller's tier so the SEAT pool is COST-capped
  // (the same $ budget as the org PR pool) — this is what caps a FREE user's CLI usage.
  // The legacy global key has no real org → tier resolves to the deployment default
  // (free). The two reads are independent → issued in ONE round-trip (Promise.all).
  //
  // FAULT DIRECTION (deliberate, matches the PR rate-limit gate): a D1 blip or an
  // unresolvable tenant degrades tier→free / status→not-active, i.e. the TIGHTEST
  // budget — the spend-protective direction (never widen a cap on a fault). This is
  // fail-CLOSED for the customer (a paid tenant could be under-served during a blip),
  // NOT fail-open — accepted here exactly as index-dispatch-rate-limit-gate.ts accepts
  // it for the PR path, and latent while SIGILIX_USAGE_METER_MODE defaults to shadow.
  //
  // sig-cli-cost-report: `coding_agent` cost is late-bound. The gateway stays a
  // founder-locked streaming passthrough (never inspects the body), so it can't
  // read the model usage itself. Instead the CLI stamps a per-request correlation
  // id header (x-sigilix-correlation-id); this route records the coding_agent event
  // KEYED by that id (as event_id), and the CLI — which already knows the turn's
  // token usage — POSTs it to /v1/usage/report, which computes cost and late-binds
  // it onto THIS row via updateUsageEventCost. No second event → the count stays
  // correct. A request with no correlation header records an unkeyed row exactly as
  // before (its cost simply never binds — a documented under-count, never a block).
  const orgId = auth.caller.installationId === LEGACY_TENANT_INSTALLATION_ID ? 0 : auth.caller.installationId
  const [tier, subStatus] = await Promise.all([
    resolveInstallationPlan(env, orgId),
    readTenantSubscriptionStatus(env, orgId),
  ])
  const trialing = !isFullPaidStatus(subStatus)
  const meterDecision = await checkUsagePool(env, { pool: "seat", userKey: seatKey, nowMs: now, tier, trialing })
  if (!meterDecision.allowed) return json({ error: "usage_limit_exceeded", pool: "seat" }, 429)

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

  // SIG-303: record the coding_agent SEAT event (one per admitted CLI request).
  // Fire-and-forget via waitUntil so metering never adds latency and a ledger
  // fault never fails the request (appendUsageEvent is itself fail-open). The
  // legacy global key (Sigilix-internal) is not a real seat → installation_id 0.
  // mode="off" is a true kill switch — shed the D1 write entirely. Best-effort by
  // design: the append is fire-and-forget (never awaited), so under burst a few
  // events may land just after an admission read — same non-atomic posture as SIG-38.
  const installationId = auth.caller.installationId === LEGACY_TENANT_INSTALLATION_ID ? 0 : auth.caller.installationId
  // sig-cli-cost-report: key the row by the CLI's per-request correlation id so
  // /v1/usage/report can late-bind cost onto it. Sanitized (bounded length, control
  // chars stripped); absent/blank → undefined → an unkeyed row (unchanged behavior).
  const correlationId = sanitizeCorrelationId(request.headers.get("x-sigilix-correlation-id"))
  // sig-gateway-usage: the correlation header is OUR CLI's convention. A third-party
  // OpenAI-compatible client (which this gateway supports) never sends it, and a
  // modified CLI can simply drop it — either way the row would be unkeyed and its
  // cost invisible forever. Mint one server-side so every admitted request is
  // meterable. Only used when provider metering is on, so the off-path is unchanged.
  const meterEventId = correlationId ?? crypto.randomUUID()
  if (meterDecision.mode !== "off") {
    ctx.waitUntil(
      appendUsageEvent(env, {
        meter: "coding_agent",
        installationId,
        userKey: seatKey,
        surface: "cli",
        eventId: gatewayProviderUsageEnabled(env) ? meterEventId : (correlationId ?? null),
        nowIso: new Date(now).toISOString(),
      }),
    )
  }

  // #158: walk the ordered per-model failover chain (Vertex -> Ollama Turbo ->
  // AWS Bedrock scaffold). Model-forcing happens PER LEG inside the chain (each
  // leg substitutes its own model id) — `raw` is passed through untouched so a
  // fallback leg doesn't inherit the Vertex model id. Streaming/response
  // semantics, the daily counter (already applied above, once), and the
  // generic-error-detail contract are all preserved; see fallback-chain.ts for
  // the retry/telemetry/marker design.
  // sig-gateway-usage: meter from PROVIDER-REPORTED usage instead of trusting the
  // client's self-report. `withUsageReporting` asks a streaming provider to emit a
  // final usage chunk; `teeForUsage` reads a COPY of the response so the caller's
  // stream stays byte-identical. Dark by default — with the flag off this is the
  // previous behavior exactly (client-attested cost via /v1/usage/report).
  // Skip when: the flag is off, OR metering is explicitly killed (mode "off" is a
  // true kill switch — it must shed this D1 write too, not just the append).
  if (!gatewayProviderUsageEnabled(env) || meterDecision.mode === "off") {
    return runGatewayChain(env, ctx, cfg, raw as Record<string, unknown>)
  }
  const upstream = await runGatewayChain(env, ctx, cfg, withUsageReporting(raw as Record<string, unknown>))
  const { forward, usage } = teeForUsage(upstream)
  ctx.waitUntil(
    usage
      .then(async (u) => {
        if (!u) return // provider reported nothing — leave the client-attested path alone
        const { tokens, costUsd } = codingAgentEventCost(cfg.sigilixModel, u.inputTokens, u.outputTokens)
        if (tokens <= 0) return
        // userKey scopes the UPDATE to THIS seat. The event id can be client-supplied,
        // so without it a caller could late-bind its cheap numbers onto another
        // seat's row (the guard usage-report-route.ts already applies).
        await updateUsageEventCost(env, {
          meter: "coding_agent",
          eventId: meterEventId,
          tokens,
          costUsd,
          userKey: seatKey,
        })
      })
      .catch(() => {}),
  )
  return forward
}
