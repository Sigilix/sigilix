// sig-dashboard-review-config — the portal's server-persisted review-config API.
//
//   GET  /v1/org/:installationId/review-config[?repoId=owner/repo] → read stored config
//   PUT  /v1/org/:installationId/review-config[?repoId=owner/repo] → validate + store
//
// The settings an admin sets here are validated against the `sigilix.json`
// schema, stored server-side (KV — see review-config-store.ts), and merged UNDER
// any committed `sigilix.json` at review time (config-as-code wins; see
// mergeSigilixConfigLayers). This replaces the localStorage-only editor that
// silently did nothing.
//
// AUTH — SESSION-ONLY, admin-gated, PER-INSTALLATION (mirrors data-consent-route.ts
// / org-seat-route.ts). A portal SESSION cookie is required; the caller must be an
// admin of THIS installation via `isAdminOfInstallation` (NOT the aggregate
// `resolveUserRole`) — this enforces the admin gate AND tenant isolation in one
// check (an installation the caller's token can't see is never one they admin, so
// a cross-tenant target 403s and nothing is read / written). The GET is admin-
// gated too (review config is org-governance data).
//
// FAIL-CLOSED: no session → 401; wrong content-type on PUT → 415; missing
// encryption key → 503; decrypt failure → 500; not an admin → 403; malformed
// config → 400; oversize → 413. A write only happens once every gate has passed.

import { requireSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { readDashboardReviewConfig, writeDashboardReviewConfig, repoScopeId } from "@/src/lib/review-config-store"
import type { SigilixConfig } from "@/src/shared/domain/config/types"
import type { Env } from "@/src/shared/types/env"

const MAX_BODY_BYTES = 65_536 // mirror the config-as-code 64KB cap

export interface ReviewConfigResponse {
  installationId: number
  scope: { level: "org" } | { level: "repo"; repoId: string }
  config: SigilixConfig
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Validate + normalize the optional `?repoId=owner/repo` scope token. Returns
 *  `undefined` (org scope) when absent, a normalized token, or `null` = malformed. */
function parseRepoIdParam(request: Request): string | null | undefined {
  const raw = new URL(request.url).searchParams.get("repoId")
  if (raw === null) return undefined
  const trimmed = raw.trim()
  // Must look like `owner/repo` — exactly one slash, non-empty halves, no traversal.
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return null
  const [owner, repo] = trimmed.split("/") as [string, string]
  return repoScopeId(owner, repo)
}

/** Resolve the session + per-installation admin gate. Mirrors data-consent-route's authAdmin. */
async function authAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "review-config-encryption-key-missing" }))
    return { ok: false, response: json({ error: "misconfigured" }, 503) }
  }
  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "review-config-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, response: json({ error: "review_config_failed" }, 500) }
  }
  const isAdmin = await isAdminOfInstallation(accessToken, session.record.login, installationId)
  if (!isAdmin) return { ok: false, response: json({ error: "forbidden" }, 403) }
  return { ok: true }
}

function scopeFor(repoId: string | undefined): ReviewConfigResponse["scope"] {
  return repoId ? { level: "repo", repoId } : { level: "org" }
}

/** GET — the stored dashboard config for one installation (org or repo scope). Admin-only. */
export async function handleGetReviewConfig(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  const repoId = parseRepoIdParam(request)
  if (repoId === null) return json({ error: "invalid repoId (expected owner/repo)" }, 400)

  const auth = await authAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  const config = await readDashboardReviewConfig(env, installationId, repoId)
  return json({ installationId, scope: scopeFor(repoId), config: config ?? {} } satisfies ReviewConfigResponse, 200)
}

/** PUT — validate + store the dashboard config for one installation. Admin-only. */
export async function handleSetReviewConfig(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  // CSRF guard (SameSite=None session cookie) — force a preflight before the body.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const repoId = parseRepoIdParam(request)
  if (repoId === null) return json({ error: "invalid repoId (expected owner/repo)" }, 400)

  const auth = await authAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return json({ error: "unreadable body" }, 400)
  }
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return json({ error: "config exceeds max size of 64KB" }, 413)
  }
  if (rawBody.trim().length === 0) return json({ error: "empty body" }, 400)

  const result = await writeDashboardReviewConfig(env, installationId, rawBody, repoId)
  if (!result.ok) return json({ error: "invalid config", reason: result.reason }, 400)
  return json({ installationId, scope: scopeFor(repoId), config: result.config } satisfies ReviewConfigResponse, 200)
}
