// SIG-298 — HTTP routes for the deep-research engine, wired into src/index.ts.
// Auth accepts EITHER a portal session cookie (requireSession) OR an API-key
// bearer (requireApiTenant). The endpoints are CORS'd by the caller in index.ts
// via withPortalCors (the SSE stream response passes its body through untouched).
//
//   POST /v1/research            → create a run, return { id }
//   GET  /v1/research/:id/stream → SSE transcript (replays from start, then live)
//   POST /v1/research/:id/cancel → cooperative cancel

import { requireSession } from "@/src/lib/auth-middleware"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import type { Env } from "@/src/shared/types/env"

const DO_BASE = "https://deep-research.do"

/** Session-OR-API-key gate. Returns null when authorized, or the 401 to send. */
async function authorize(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const session = await requireSession(request, env, ctx)
  if (session) return null
  const tenant = await requireApiTenant(request, env, ctx)
  if ("caller" in tenant) return null
  return tenant.response
}

/** POST /v1/research — body { question, mode? } → { id }. */
export async function handleResearchCreate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const denied = await authorize(request, env, ctx)
  if (denied) return denied

  let body: { question?: unknown; mode?: unknown }
  try {
    body = (await request.json()) as { question?: unknown; mode?: unknown }
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  const question = typeof body.question === "string" ? body.question.trim() : ""
  if (!question) return json({ error: "missing question" }, 400)

  const id = env.DEEP_RESEARCH.newUniqueId()
  const stub = env.DEEP_RESEARCH.get(id)
  const started = await stub.fetch(`${DO_BASE}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  })
  if (!started.ok) {
    return json({ error: "failed to start research run" }, 502)
  }
  return json({ id: id.toString() })
}

/** GET /v1/research/:id/stream — proxy the DO's SSE stream. */
export async function handleResearchStream(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  idStr: string,
): Promise<Response> {
  const denied = await authorize(request, env, ctx)
  if (denied) return denied

  const stub = resolveStub(env, idStr)
  if (!stub) return json({ error: "invalid research id" }, 400)
  return stub.fetch(`${DO_BASE}/stream`, { method: "GET" })
}

/** POST /v1/research/:id/cancel — cooperative cancellation. */
export async function handleResearchCancel(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  idStr: string,
): Promise<Response> {
  const denied = await authorize(request, env, ctx)
  if (denied) return denied

  const stub = resolveStub(env, idStr)
  if (!stub) return json({ error: "invalid research id" }, 400)
  return stub.fetch(`${DO_BASE}/cancel`, { method: "POST" })
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
