// #155 onboarding-backend FOUNDATION (slice 1 of 2) — key management
// endpoints: POST /v1/keys (mint) + DELETE /v1/keys/:id (revoke).
//
// Cookie-authed via requireSession (the same browser session as
// /auth/welcome, /auth/me). Authorization beyond "is logged in" is checked
// against `account_tenant` via api-key-store.ts's isLinkedToInstallation,
// which FAILS CLOSED on a D1 error (denies, never grants). A minted
// plaintext key is returned in the response body exactly once and is NEVER
// logged — only its SHA-256 hash (api-key-store.ts's insertApiKey) is
// persisted.

import { requireSession } from "@/src/lib/auth-middleware"
import { sha256Hex } from "@/src/lib/auth-bearer"
import {
  getApiKeyById,
  insertApiKey,
  isLinkedToInstallation,
  mintApiKeyPlaintext,
  revokeApiKeyById,
} from "@/src/lib/api-key-store"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Strict-positive-integer installationId from a parsed JSON body. */
function extractInstallationId(body: unknown): number | null {
  if (body == null || typeof body !== "object") return null
  const raw = (body as Record<string, unknown>).installationId
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}

/** POST /v1/keys — mint a new API key for an installation the caller is linked to. */
export async function handleCreateApiKeyRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)
  const db = env.SIGILIX_PLATFORM_DB

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const installationId = extractInstallationId(body)
  if (installationId === null) {
    return json({ error: "installationId (positive integer) is required" }, 400)
  }

  const githubUserId = String(authed.record.githubUserId)
  const authorized = await isLinkedToInstallation(db, githubUserId, installationId)
  if (!authorized) return json({ error: "forbidden" }, 403)

  const plaintext = mintApiKeyPlaintext()
  const keyHash = await sha256Hex(plaintext)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await insertApiKey(db, { id, keyHash, installationId, createdBy: githubUserId, nowIso: now })
  } catch (error) {
    console.error(
      JSON.stringify({ event: "api-key-mint-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return json({ error: "mint_failed" }, 500)
  }

  // Plaintext is returned exactly once here and is never logged above.
  return json({ id, key: plaintext, installationId }, 201)
}

/** DELETE /v1/keys/:id — revoke a key the caller is linked to (via its installation). */
export async function handleRevokeApiKeyRoute(
  request: Request,
  env: Env,
  keyId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)
  const db = env.SIGILIX_PLATFORM_DB

  const existing = await getApiKeyById(db, keyId)
  if (!existing) return json({ error: "not_found" }, 404)

  const githubUserId = String(authed.record.githubUserId)
  const authorized = await isLinkedToInstallation(db, githubUserId, existing.installationId)
  if (!authorized) return json({ error: "forbidden" }, 403)

  if (existing.revokedAt) return json({ ok: true, alreadyRevoked: true }, 200)

  try {
    await revokeApiKeyById(db, keyId, new Date().toISOString())
  } catch (error) {
    console.error(
      JSON.stringify({ event: "api-key-revoke-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return json({ error: "revoke_failed" }, 500)
  }
  return json({ ok: true }, 200)
}
