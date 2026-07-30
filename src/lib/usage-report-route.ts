// sig-cli-cost-report — POST /v1/usage/report.
//
// The LAST piece of cost-based usage metering for the CLI (coding_agent) surface.
// The Boreas/Pyroeis/Astraeus gateway is a founder-locked streaming passthrough that
// never inspects the body, so it records a coding_agent event but no tokens/cost. The
// CLI — which already knows each turn's token usage (it renders the live token meter) —
// stamps a per-request correlation id header on its gateway call and then POSTs
// { correlationId, model, inputTokens, outputTokens } here. This route computes the
// blended model cost (the SAME representative burn rate the chatbot uses) and LATE-BINDS
// tokens + cost_usd onto the coding_agent row the gateway already keyed by that id. No
// second event is appended — the count stays correct; only the existing row's cost fills
// in (the deep-research DO uses the identical updateUsageEventCost seam).
//
// AUTH FIRST — same bearer the gateway requires (requireApiTenant, fail-closed). The
// caller's resolved seat is passed as the UPDATE's user_key scope, so a caller can only
// ever bind cost onto its OWN events (the correlation id is client-generated, so the
// user_key scope — not the id alone — is what makes this tenant-safe). Best-effort: a
// malformed body 400s, but a match-nothing report (unknown id, wrong seat) is a 200 no-op
// — this is telemetry the CLI fires fire-and-forget and must never block a coding turn.

import { gatewayProviderUsageEnabled } from "@/src/lib/boreas-gateway/provider-usage-mode"
import type { Env } from "@/src/shared/types/env"
import { requireApiTenant, seatKeyFor } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { sanitizeCorrelationId } from "@/src/lib/boreas-gateway/vertex-chat-route"
import { updateUsageEventCost } from "@/src/features/tenancy"
import { codingAgentEventCost } from "@/src/shared/domain/sigilix-model-burn"

// A usage report is tiny (an id + a model id + two integers). Cap hard so an abusive
// caller can't force a large buffer on an authenticated endpoint.
const MAX_BODY_BYTES = 4 * 1024

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Coerce a JSON number field to a finite, non-negative token count (else 0). */
function tokenField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * POST /v1/usage/report — see file header. 401 on a bad/absent bearer; 400 on a
 * non-JSON / non-object body; 413 on an oversized body; otherwise 200. A 200 does
 * NOT imply a row was updated (an unknown correlation id or a foreign seat is a
 * harmless no-op) — the endpoint is best-effort by design.
 */
export async function handleUsageReportRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // AUTH FIRST — before the body is read. Same resolver + fail-closed posture as the gateway.
  const auth = await requireApiTenant(request, env, ctx)
  if ("response" in auth) return auth.response

  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null) return json({ error: "payload_too_large" }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return json({ error: "invalid_request", detail: "body must be a JSON object" }, 400)
  }
  const body = raw as Record<string, unknown>

  // The correlation id is validated with the SAME sanitizer the gateway used to KEY
  // the row, so a value that could never have been recorded (blank/oversized/garbage)
  // is rejected up front rather than issuing a match-nothing UPDATE.
  const correlationId = sanitizeCorrelationId(typeof body["correlationId"] === "string" ? body["correlationId"] : null)
  if (!correlationId) return json({ error: "invalid_request", detail: "correlationId is required" }, 400)
  // TRUST BOUNDARY (accepted for the shadow phase): the model + token counts are
  // CLIENT-ATTESTED. The gateway is body-blind so it can't measure them itself, and
  // usage_events records no model, so cost is priced from the reported `model`. A
  // modified CLI could under-report tokens or report a cheaper model than the route it
  // actually hit (premium→cheap downgrade), shrinking its own seat cost. This is a
  // KNOWN residual, tolerable while SIGILIX_USAGE_METER_MODE defaults to shadow (this
  // path only records, never blocks). BEFORE cost ENFORCEMENT goes live, record the
  // forced model (cfg.sigilixModel) on the coding_agent row and price from THAT — see
  // the follow-up note in the PR. Cost is bounded to the caller's OWN seat regardless,
  // so the worst case is a caller mis-accounting its own budget, never another tenant's.
  const model = typeof body["model"] === "string" ? body["model"] : ""
  const { tokens, costUsd } = codingAgentEventCost(
    model,
    tokenField(body["inputTokens"]),
    tokenField(body["outputTokens"]),
  )

  // The caller's seat — derived through the SHARED seatKeyFor helper (single source of
  // truth) so the user_key scope on the UPDATE matches the row the gateway wrote for
  // THIS key. This is the tenant guard: the client-supplied id alone can't reach
  // another seat's row.
  const seatKey = seatKeyFor(auth.caller)

  // sig-gateway-usage: when the gateway meters from PROVIDER-reported usage, the
  // server's number is authoritative and this client-attested one MUST NOT land.
  // updateUsageEventCost is a plain overwrite, and this route fires AFTER the
  // gateway's waitUntil resolves — so without this guard the untrusted client's
  // value would simply win the race, defeating the whole point. It can also post
  // zeros to wipe a real measurement. Accept + no-op so old CLIs don't see errors.
  if (gatewayProviderUsageEnabled(env)) {
    return json({ ok: true, ignored: "provider-metered" }, 200)
  }

  // updateUsageEventCost fails open (never throws) and is a pure UPDATE — it never
  // appends a row, so the coding_agent COUNT is untouched and can't double-count.
  await updateUsageEventCost(env, {
    meter: "coding_agent",
    eventId: correlationId,
    tokens,
    costUsd,
    userKey: seatKey,
  })

  return json({ ok: true }, 200)
}
