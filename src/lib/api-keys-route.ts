// #155 onboarding-backend FOUNDATION (slice 1 of 2) — key management
// endpoints: POST /v1/keys (mint) + DELETE /v1/keys/:id (revoke).
//
// Cookie-authed via requireSession (the same browser session as
// /auth/welcome, /auth/me). Mint authorization uses requireOrgAccess for the
// exact installation: fresh GitHub visibility in rollout-off mode, plus active
// managed access in rollout-on mode. Personal revoke is creator-owned by the
// immutable GitHub id; admin member removal owns bulk revocation. A minted
// plaintext key is returned exactly once and is NEVER logged — only its SHA-256
// hash (api-key-store.ts's insertApiKey) is persisted.

import { requireSession } from "@/src/lib/auth-middleware"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { requireOrgAccess } from "@/src/lib/org-access"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import {
  API_KEY_PREFIX,
  getApiKeyById,
  insertApiKey,
  listApiKeysByCreator,
  mintApiKeyPlaintext,
  revokeApiKeyById,
} from "@/src/lib/api-key-store"
import type { Env } from "@/src/shared/types/env"

/** The masked stand-in the list shows for every key — only the non-secret type
 *  prefix; the random tail is never stored, so it can't be reconstructed. */
const MASKED_KEY = `${API_KEY_PREFIX}••••••••`

/** Bound on a user-supplied key name (a display label, never key material). */
const MAX_KEY_NAME = 60

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

/** Read an optional trimmed `name` label from a parsed body. Null when absent/blank/over-long. */
function extractKeyName(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null
  const raw = (body as Record<string, unknown>).name
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed === "" || trimmed.length > MAX_KEY_NAME) return null
  return trimmed
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
  // sig-user-identity: API keys are minted for a GitHub App installation the
  // caller is linked to (account_tenant, keyed by github_user_id). A non-GitHub
  // session has no such link — fail closed.
  if (authed.record.githubUserId == null) return json({ error: "github_account_required" }, 403)

  // CSRF guard (SIG-155 slice 3 — see portal-cors.ts's hasJsonContentType doc
  // comment): required because the session cookie is now SameSite=None.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

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
  // account_tenant is legacy compatibility metadata, not authorization. The
  // central exact-installation guard requires fresh GitHub visibility in
  // rollout-off mode and active managed access in rollout-on mode.
  const access = await requireOrgAccess(request, env, ctx, installationId, { requiredRole: "member" })
  if (!access.ok) return access.response
  // Belt-and-suspenders only: requireOrgAccess already derives this identity
  // from the authenticated session while performing the real authorization.
  if (access.githubUserId !== githubUserId) return json({ error: "forbidden" }, 403)

  const name = extractKeyName(body)
  const plaintext = mintApiKeyPlaintext()
  const keyHash = await sha256Hex(plaintext)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await insertApiKey(db, { id, keyHash, installationId, createdBy: githubUserId, nowIso: now, name })
  } catch (error) {
    console.error(
      JSON.stringify({ event: "api-key-mint-failed", err: error instanceof Error ? error.message : String(error) }),
    )
    return json({ error: "mint_failed" }, 500)
  }

  // Plaintext is returned exactly once here and is never logged above.
  return json({ id, key: plaintext, installationId, name }, 201)
}

/**
 * GET /v1/keys — list the CALLER'S OWN keys (metadata only; never the secret).
 *
 * Session-authed (portal browser), GitHub-account-required (keys are keyed by the
 * caller's GitHub user id). Returns every key the caller MINTED — scoped to
 * `created_by`, so a caller can never see another user's keys. Each entry carries
 * id, name, installation, timestamps, revoked state, and a MASKED prefix stand-in;
 * the SHA-256 hash is never selected. FAILS SOFT on the data path (empty list, not
 * a 500). Response: `{ keys: [{ id, name, installationId, createdAt, lastUsedAt,
 * revokedAt, keyPrefix }] }`.
 */
export async function handleListApiKeysRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (authed.record.githubUserId == null) return json({ error: "github_account_required" }, 403)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)

  const githubUserId = String(authed.record.githubUserId)
  const summaries = await listApiKeysByCreator(env.SIGILIX_PLATFORM_DB, githubUserId)
  const keys = summaries.map((k) => ({
    id: k.id,
    name: k.name,
    installationId: k.installationId,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    keyPrefix: MASKED_KEY,
  }))
  return json({ keys }, 200)
}

/** DELETE /v1/keys/:id — revoke one key minted by this exact GitHub account. */
export async function handleRevokeApiKeyRoute(
  request: Request,
  env: Env,
  keyId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (authed.record.githubUserId == null) return json({ error: "github_account_required" }, 403)
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "platform_db_not_configured" }, 503)
  const db = env.SIGILIX_PLATFORM_DB

  const existing = await getApiKeyById(db, keyId)
  if (!existing) return json({ error: "not_found" }, 404)

  const githubUserId = String(authed.record.githubUserId)
  // Personal key IDs are creator-owned, not installation-member capabilities.
  // Hide another creator's random UUID behind the same 404 as an unknown id.
  // Admin member removal owns the separate exact-install bulk-revocation path.
  if (existing.createdBy !== githubUserId) return json({ error: "not_found" }, 404)

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
