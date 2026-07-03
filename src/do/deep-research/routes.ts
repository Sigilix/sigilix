// SIG-298 — HTTP routes for the deep-research engine, wired into src/index.ts.
// Auth accepts EITHER a portal session cookie (requireSession) OR an API-key
// bearer (requireApiTenant), and BINDS each run to the caller's identity so only
// the creator can stream or cancel it. The endpoints are CORS'd by the caller in
// index.ts via withPortalCors (the SSE stream response passes its body through
// untouched).
//
//   POST /v1/research            → create a run, return { id }
//   GET  /v1/research/:id/stream → SSE transcript (replays from start, then live)
//   POST /v1/research/:id/cancel → cooperative cancel
//
// Mutating POST routes require an application/json content-type (CSRF guard, per
// portal-cors.ts's hasJsonContentType doc comment) because the session cookie is
// SameSite=None.

import { requireSession } from "@/src/lib/auth-middleware"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { appendUsageEvent, checkUsagePool } from "@/src/features/tenancy"
import { parseEffort, parseTier } from "./config"
import { CREATOR_HEADER } from "./deep-research-do"
import type { Env } from "@/src/shared/types/env"

const DO_BASE = "https://deep-research.do"

/** The caller's stable identity + the 401 branch when unauthenticated. */
type CallerAuth = { creator: string } | { response: Response }

/**
 * Session-OR-API-key gate. On success returns the caller's opaque `creator`
 * identity (session subject or api tenant), which the run is bound to so only
 * the creator can stream/cancel it and metering is attributed to a tenant.
 */
async function authorize(request: Request, env: Env, ctx: ExecutionContext): Promise<CallerAuth> {
  const session = await requireSession(request, env, ctx)
  // sig-user-identity: prefer the provider-agnostic user_id so Google /
  // email-password sessions (no githubUserId) get a distinct, non-colliding
  // creator instead of all sharing "session:undefined".
  if (session) return { creator: `session:${session.record.githubUserId ?? session.record.userId ?? "anon"}` }
  const tenant = await requireApiTenant(request, env, ctx)
  if ("caller" in tenant) return { creator: `tenant:${tenant.caller.installationId}` }
  return { response: tenant.response }
}

/**
 * SIG-303 — derive the chatbot SEAT identity from the deep-research `creator`
 * handle. A portal session is a real per-user seat (`gh:<githubUserId>`); an
 * API-key tenant's seat is its key (`inst:<installationId>`, matching the CLI
 * gateway's seat keying). `installationId` is org CONTEXT only (0 = none / legacy)
 * — chatbot is a SEAT meter and never draws the org pool.
 */
export function seatIdentityFromCreator(creator: string): { userKey: string; installationId: number } {
  if (creator.startsWith("session:")) return { userKey: `gh:${creator.slice("session:".length)}`, installationId: 0 }
  if (creator.startsWith("tenant:")) {
    const id = Number(creator.slice("tenant:".length))
    const installationId = Number.isInteger(id) && id !== LEGACY_TENANT_INSTALLATION_ID ? id : 0
    return { userKey: `inst:${Number.isInteger(id) ? id : creator.slice("tenant:".length)}`, installationId }
  }
  return { userKey: creator, installationId: 0 }
}

/** POST /v1/research — body { question, model?, effort? } → { id }. */
export async function handleResearchCreate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) return auth.response

  // SIG-303 SEAT pool (chatbot). GRACE POLICY: checked at the START of a new run,
  // before the DO is spun up — an over-cap seat blocks the NEXT run, never aborts
  // an in-flight one. Behind SIGILIX_USAGE_METER_MODE (default shadow → no block).
  const seat = seatIdentityFromCreator(auth.creator)
  const now = Date.now()
  const meterDecision = await checkUsagePool(env, { pool: "seat", userKey: seat.userKey, nowMs: now })
  if (!meterDecision.allowed) return json({ error: "usage_limit_exceeded", pool: "seat" }, 429)

  let body: { question?: unknown; model?: unknown; effort?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  const question = typeof body.question === "string" ? body.question.trim() : ""
  if (!question) return json({ error: "missing question" }, 400)

  // Validate the tier + effort; unknown values are rejected (not silently defaulted).
  const model = body.model === undefined ? "astraeus" : parseTier(body.model)
  if (model === null) return json({ error: "model must be one of: boreas, pyroeis, astraeus" }, 400)
  const effort = body.effort === undefined ? "medium" : parseEffort(body.effort)
  if (effort === null) return json({ error: "effort must be one of: low, medium, high" }, 400)

  const id = env.DEEP_RESEARCH.newUniqueId()
  const stub = env.DEEP_RESEARCH.get(id)
  const started = await stub.fetch(`${DO_BASE}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, model, effort, creator: auth.creator }),
  })
  if (!started.ok) {
    return json({ error: "failed to start research run" }, 502)
  }

  // SIG-303: record the chatbot SEAT event (one per started run). event_id = the
  // DO id → idempotent on a retry. Fire-and-forget (fail-open; never fails the run).
  // mode="off" is a true kill switch — shed the D1 write entirely.
  if (meterDecision.mode !== "off") {
    ctx.waitUntil(
      appendUsageEvent(env, {
        meter: "chatbot",
        installationId: seat.installationId,
        userKey: seat.userKey,
        surface: "portal",
        eventId: id.toString(),
        nowIso: new Date(now).toISOString(),
      }),
    )
  }

  return json({ id: id.toString() })
}

/** GET /v1/research/:id/stream — proxy the DO's SSE stream (creator-bound). */
export async function handleResearchStream(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  idStr: string,
): Promise<Response> {
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) return auth.response

  const stub = resolveStub(env, idStr)
  if (!stub) return json({ error: "invalid research id" }, 400)
  return stub.fetch(`${DO_BASE}/stream`, { method: "GET", headers: { [CREATOR_HEADER]: auth.creator } })
}

/** POST /v1/research/:id/cancel — cooperative cancellation (creator-bound). */
export async function handleResearchCancel(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  idStr: string,
): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) return auth.response

  const stub = resolveStub(env, idStr)
  if (!stub) return json({ error: "invalid research id" }, 400)
  return stub.fetch(`${DO_BASE}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", [CREATOR_HEADER]: auth.creator },
  })
}

/** Reconstruct the DO stub from the string id, or null when malformed. */
function resolveStub(env: Env, idStr: string): DurableObjectStub | null {
  try {
    const id = env.DEEP_RESEARCH.idFromString(idStr)
    return env.DEEP_RESEARCH.get(id)
  } catch {
    return null
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
