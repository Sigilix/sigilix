// Session-only managed app-memory HTTP handlers.
//
// Every request resolves one exact GitHub installation and returns that
// installation's role. Members can read organization memories and manage only
// their own personal rows; exact installation admins may also manage
// organization rows. An aggregate "admin somewhere" role is never sufficient.

import {
  createAppMemory,
  deleteAppMemory,
  listAppMemories,
  normalizeAppMemoryContent,
  parseAppMemoryScope,
  resolveManagedAppId,
  type AppMemory,
  type AppMemoryCursor,
} from "@/src/features/app-memory"
import { requireSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { resolveExactUserInstallationScope, type UserRole } from "@/src/lib/resolve-user-role"
import { hasHighConfidenceSecretText } from "@/src/lib/secret-scan"
import { findByGithubUserId } from "@/src/lib/user-identity-store"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const MAX_BODY_BYTES = 8 * 1024
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SAFE_MEMORY_ID = /^appmem_[0-9a-f-]{36}$/

interface AppMemoryAuth {
  userId: string
  role: UserRole
}

type AuthResult = { ok: true; value: AppMemoryAuth } | { ok: false; response: Response }

export async function handleListAppMemories(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
  rawAppId: string,
): Promise<Response> {
  const appId = resolveManagedAppId(rawAppId)
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  if (!appId) return json({ error: "unknown app" }, 404)
  const auth = await authenticate(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  if (cursor === "invalid") return json({ error: "invalid cursor" }, 400)

  const listed = await listAppMemories(env, {
    installationId,
    callerUserId: auth.value.userId,
    appId,
    limit,
    cursor,
  })
  if (listed.status === "unavailable") return json({ error: "app_memory_unavailable" }, 503)
  return json({
    version: 1,
    installationId,
    appId,
    role: auth.value.role,
    memories: listed.memories.map(publicMemory),
    ...(listed.nextCursor ? { cursor: encodeCursor(listed.nextCursor) } : {}),
  })
}

export async function handleCreateAppMemory(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
  rawAppId: string,
): Promise<Response> {
  const appId = resolveManagedAppId(rawAppId)
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  if (!appId) return json({ error: "unknown app" }, 404)
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const auth = await authenticate(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  const parsed = await parseCreateBody(request)
  if (parsed instanceof Response) return parsed
  if (parsed.scope === "organization" && auth.value.role !== "admin") {
    return json({ error: "forbidden" }, 403)
  }
  if (hasHighConfidenceSecretText(parsed.content)) return json({ error: "credential_detected" }, 400)

  const created = await createAppMemory(env, {
    installationId,
    scope: parsed.scope,
    ownerUserId: auth.value.userId,
    appId,
    content: parsed.content,
    nowMs: Date.now(),
  })
  if (created.status === "unavailable") return json({ error: "app_memory_unavailable" }, 503)
  if (created.status === "limit_reached") return json({ error: "app_memory_limit_reached" }, 409)

  emitMutation(created.deduped ? "app-memory-deduped" : "app-memory-created", {
    installationId,
    appId,
    scope: created.memory.scope,
    memoryId: created.memory.id,
    actorUserId: auth.value.userId,
  })
  return json(
    {
      version: 1,
      installationId,
      appId,
      role: auth.value.role,
      deduped: created.deduped,
      memory: publicMemory(created.memory),
    },
    created.deduped ? 200 : 201,
  )
}

export async function handleDeleteAppMemory(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
  rawAppId: string,
  memoryId: string,
): Promise<Response> {
  const appId = resolveManagedAppId(rawAppId)
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  if (!appId) return json({ error: "unknown app" }, 404)
  if (!SAFE_MEMORY_ID.test(memoryId)) return json({ error: "not found" }, 404)
  const auth = await authenticate(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  const deleted = await deleteAppMemory(env, {
    installationId,
    callerUserId: auth.value.userId,
    appId,
    memoryId,
    canManageOrganization: auth.value.role === "admin",
  })
  if (deleted.status === "unavailable") return json({ error: "app_memory_unavailable" }, 503)
  if (deleted.status === "not_found") return json({ error: "not found" }, 404)

  emitMutation("app-memory-deleted", {
    installationId,
    appId,
    memoryId,
    actorUserId: auth.value.userId,
  })
  return json({ ok: true, deleted: true })
}

async function authenticate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  installationId: number,
): Promise<AuthResult> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false, response: json({ error: "app_memory_unavailable" }, 503) }
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  if (session.record.githubUserId === undefined) {
    return { ok: false, response: json({ error: "app_memory_identity_unavailable" }, 401) }
  }

  let identity: Awaited<ReturnType<typeof findByGithubUserId>>
  try {
    identity = await findByGithubUserId(env.SIGILIX_PLATFORM_DB, String(session.record.githubUserId))
  } catch (error) {
    emitFailure("app-memory-identity-resolve-failed", error, installationId)
    return { ok: false, response: json({ error: "app_memory_unavailable" }, 503) }
  }
  if (!identity) return { ok: false, response: json({ error: "app_memory_identity_unavailable" }, 401) }
  if (session.record.userId && session.record.userId !== identity.userId) {
    emitFailure("app-memory-session-identity-mismatch", new Error("session identity mismatch"), installationId)
    return { ok: false, response: json({ error: "unauthorized" }, 401) }
  }
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    return { ok: false, response: json({ error: "app_memory_unavailable" }, 503) }
  }

  let accessToken: string
  try {
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
  } catch (error) {
    emitFailure("app-memory-token-resolve-failed", error, installationId)
    return { ok: false, response: json({ error: "app_memory_scope_unavailable" }, 503) }
  }

  const resolved = await resolveExactUserInstallationScope(accessToken, session.record.login, installationId)
  if (!resolved) return { ok: false, response: json({ error: "forbidden" }, 403) }
  return { ok: true, value: { userId: identity.userId, role: resolved.role } }
}

async function parseCreateBody(
  request: Request,
): Promise<{ scope: "personal" | "organization"; content: string } | Response> {
  const raw = await readBodyCapped(request, MAX_BODY_BYTES)
  if (raw === null) return json({ error: "payload_too_large" }, 413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid request" }, 400)
  const scope = parseAppMemoryScope((body as Record<string, unknown>).scope)
  const content = normalizeAppMemoryContent((body as Record<string, unknown>).content)
  return scope && content ? { scope, content } : json({ error: "invalid request" }, 400)
}

function publicMemory(memory: AppMemory): Record<string, unknown> {
  return {
    id: memory.id,
    scope: memory.scope,
    appId: memory.appId,
    content: memory.content,
    createdAt: new Date(memory.createdAtMs).toISOString(),
  }
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

function encodeCursor(cursor: AppMemoryCursor): string {
  return btoa(JSON.stringify({ t: cursor.createdAtMs, i: cursor.id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function parseCursor(raw: string | null): AppMemoryCursor | null | "invalid" {
  if (raw === null || raw === "") return null
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const parsed = JSON.parse(atob(padded)) as { t?: unknown; i?: unknown }
    return Number.isSafeInteger(parsed.t) &&
      Number(parsed.t) >= 0 &&
      typeof parsed.i === "string" &&
      SAFE_MEMORY_ID.test(parsed.i)
      ? { createdAtMs: Number(parsed.t), id: parsed.i }
      : "invalid"
  } catch {
    return "invalid"
  }
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

function emitMutation(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function emitFailure(event: string, error: unknown, installationId: number): void {
  console.error(
    JSON.stringify({
      event,
      installationId,
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}
