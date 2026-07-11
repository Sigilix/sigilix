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

import type { AuthedSession } from "@/src/lib/auth-middleware"
import { LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { getInstallationsForUser } from "@/src/lib/api-key-store"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { listGithubUserInstallationRepos } from "@/src/lib/github-user-repo-scope"
import { userCanAccessInstallation } from "@/src/shared/adapters/github/user-installation-access"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import {
  appendUsageEvent,
  checkUsagePool,
  readTenantSubscriptionStatus,
  isFullPaidStatus,
} from "@/src/features/tenancy"
import { resolveInstallationPlan } from "@/src/lib/resolve-plan"
import { requireRuntimePrincipal } from "@/src/lib/runtime-principal"
import { parseEffort, parseMode, parseTier } from "./config"
import { CREATOR_HEADER } from "./deep-research-do"
import { isCodebaseQuestion, resolveRepoTarget } from "./repo-grounding"
import type { Env } from "@/src/shared/types/env"

const DO_BASE = "https://deep-research.do"

/** The caller's stable identity + the 401 branch when unauthenticated. `creator`
 *  binds the run; the exact session repo scope / tenant installation resolves
 *  which indexed repo may ground it (sig-deep-research-repo-grounding). */
type CallerAuth = { creator: string; installationId?: number; session?: AuthedSession } | { response: Response }

/**
 * Session-OR-API-key gate. On success returns the caller's opaque `creator`
 * identity (session subject or api tenant), which the run is bound to so only
 * the creator can stream/cancel it and metering is attributed to a tenant. Also
 * surfaces the live session or installation id (tenant) so the run can resolve
 * the caller's exact authorized repo scope for codebase grounding.
 */
async function authorize(request: Request, env: Env, ctx: ExecutionContext): Promise<CallerAuth> {
  const auth = await requireRuntimePrincipal(request, env, ctx)
  if ("response" in auth) return auth
  if (auth.principal.kind === "session") {
    return { creator: auth.principal.scope, session: auth.principal.session }
  }
  return { creator: auth.principal.scope, installationId: auth.principal.installationId }
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

/**
 * SIG-303 — resolve the ORG installation to stamp on a chatbot SEAT event so an
 * org admin can drill into a specific member's seat usage. chatbot stays a SEAT
 * meter (installation_id is org CONTEXT only — it never draws the org pool), but
 * the usage read scopes a per-member drill by installation_id for tenant-safety,
 * so the event MUST carry the developer's org link. A portal session's github
 * user is looked up in `account_tenant` (the SAME link `/setup` + CLI-login
 * write); its newest installation wins. Non-session creators (api tenants) keep
 * their own `fallback` context. FAILS SOFT — no D1 / no github link / a fault →
 * the `fallback` (0 = no org context), never throws.
 *
 * KNOWN LIMITATION (multi-org member): a portal chat request has no org in its
 * context, so every chatbot event for a member in >1 org is stamped with their
 * NEWEST installation only. It is always ONE of the member's own orgs (never a
 * cross-tenant leak), but an admin of an OLDER org drilling into such a member
 * sees zero chatbot usage (their coding_agent still shows — each CLI key carries
 * its own real installation). Correct for the common single-org case; the read
 * path stays tenant-safe either way.
 */
async function resolveSeatOrgInstallation(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  creator: string,
  fallback: number,
): Promise<number> {
  if (!env.SIGILIX_PLATFORM_DB || !creator.startsWith("session:")) return fallback
  const githubUserId = creator.slice("session:".length)
  if (!githubUserId || githubUserId === "anon") return fallback
  const installs = await getInstallationsForUser(env.SIGILIX_PLATFORM_DB, githubUserId)
  return installs[0] ?? fallback
}

/**
 * POST /v1/research — body { question, model?, effort?, mode?, installationId? } → { id }.
 * Session callers may select one of their current GitHub App installations;
 * API-key callers are always pinned to the installation authenticated by the key.
 */
export async function handleResearchCreate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const auth = await authorize(request, env, ctx)
  if ("response" in auth) return auth.response

  let body: {
    question?: unknown
    model?: unknown
    effort?: unknown
    mode?: unknown
    owner?: unknown
    repo?: unknown
    installationId?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  const question = typeof body.question === "string" ? body.question.trim() : ""
  if (!question) return json({ error: "missing question" }, 400)

  const model = body.model === undefined ? "astraeus" : parseTier(body.model)
  if (model === null) return json({ error: "model must be one of: boreas, pyroeis, astraeus" }, 400)
  const effort = body.effort === undefined ? "medium" : parseEffort(body.effort)
  if (effort === null) return json({ error: "effort must be one of: low, medium, high" }, 400)
  const mode = body.mode === undefined ? "deep" : parseMode(body.mode)
  if (mode === null) return json({ error: "mode must be one of: deep, chat" }, 400)

  const explicitOwner = typeof body.owner === "string" ? body.owner : undefined
  const explicitRepo = typeof body.repo === "string" ? body.repo : undefined
  const selectedInstallationId =
    Number.isSafeInteger(body.installationId) && Number(body.installationId) > 0
      ? Number(body.installationId)
      : undefined
  const needsSessionRepoScope =
    mode === "deep" || isCodebaseQuestion(question) || (explicitOwner !== undefined && explicitRepo !== undefined)
  let sessionRepos: Array<{ installationId: number; owner: string; repo: string }> | undefined
  let sessionAccessToken: string | null = null
  if (auth.session && (needsSessionRepoScope || selectedInstallationId !== undefined)) {
    if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
      if (needsSessionRepoScope) {
        console.error(JSON.stringify({ event: "deep-research-repo-scope-failed", reason: "missing_encryption_key" }))
        sessionRepos = []
      }
      if (selectedInstallationId !== undefined) {
        console.warn(JSON.stringify({ event: "research-mcp-installation-denied", reason: "missing_encryption_key" }))
      }
    } else {
      try {
        sessionAccessToken = await getValidGithubToken({
          env,
          sessionId: auth.session.sessionId,
          record: auth.session.record,
          encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
        })
      } catch (error) {
        if (needsSessionRepoScope) {
          console.error(
            JSON.stringify({
              event: "deep-research-repo-scope-failed",
              reason: "token_failed",
              err: error instanceof Error ? error.message : String(error),
            }),
          )
          sessionRepos = []
        }
        if (selectedInstallationId !== undefined) {
          console.warn(JSON.stringify({ event: "research-mcp-installation-denied", reason: "token_failed" }))
        }
      }
    }
  }
  let verifiedSelectedInstallationId: number | undefined
  let mcpTenantScope: string | undefined
  if (!auth.session && Number.isSafeInteger(auth.installationId) && Number(auth.installationId) > 0) {
    mcpTenantScope = `tenant:${auth.installationId}`
  }
  if (auth.session && selectedInstallationId !== undefined && sessionAccessToken) {
    const access = await userCanAccessInstallation(sessionAccessToken, selectedInstallationId)
    if (access.ok) {
      verifiedSelectedInstallationId = selectedInstallationId
      mcpTenantScope = `tenant:${selectedInstallationId}`
    } else {
      console.warn(JSON.stringify({ event: "research-mcp-installation-denied", reason: access.reason }))
    }
  }

  // SIG-303 SEAT pool (chatbot). GRACE POLICY: checked at the START of a new run,
  // before the DO is spun up — an over-cap seat blocks the NEXT run, never aborts
  // an in-flight one. Behind SIGILIX_USAGE_METER_MODE (default shadow → no block).
  const seat = seatIdentityFromCreator(auth.creator)
  const now = Date.now()
  // sig-cost-based-metering: resolve the seat's org + tier so the SEAT pool is
  // COST-capped (chatbot spend) the same way as the org PR pool — this is what caps
  // a FREE user's chatbot usage. Resolved once here and reused for the event stamp
  // below. The plan + status reads both depend only on the org id → issued in ONE
  // round-trip. FAULT DIRECTION (deliberate, matches the PR gate): a fault degrades to
  // free / not-active — the TIGHTEST budget (spend-protective), latent while the meter
  // mode defaults to shadow.
  const orgInstallationId =
    verifiedSelectedInstallationId ?? (await resolveSeatOrgInstallation(env, auth.creator, seat.installationId))
  const [tier, subStatus] = await Promise.all([
    resolveInstallationPlan(env, orgInstallationId),
    readTenantSubscriptionStatus(env, orgInstallationId),
  ])
  const trialing = !isFullPaidStatus(subStatus)
  const meterDecision = await checkUsagePool(env, {
    pool: "seat",
    userKey: seat.userKey,
    nowMs: now,
    tier,
    trialing,
  })
  if (!meterDecision.allowed) return json({ error: "usage_limit_exceeded", pool: "seat" }, 429)

  // sig-deep-research-repo-grounding: resolve which authorized indexed repo (if
  // any) to ground this run in. Session grounding always uses the user's current,
  // exact GitHub App repo scope; the heavier code retrieval happens in the DO.
  if (auth.session && needsSessionRepoScope && sessionAccessToken) {
    try {
      const scope = await listGithubUserInstallationRepos(sessionAccessToken)
      if (scope.ok) {
        sessionRepos = scope.repos
      } else {
        console.error(JSON.stringify({ event: "deep-research-repo-scope-failed", reason: scope.reason }))
        sessionRepos = []
      }
    } catch {
      sessionRepos = []
    }
  }
  if (sessionRepos && verifiedSelectedInstallationId !== undefined) {
    sessionRepos = sessionRepos.filter((repo) => repo.installationId === verifiedSelectedInstallationId)
  }
  let repoTarget: { owner: string; repo: string } | null = null
  let hasIndexedRepo = false
  try {
    const resolution = await resolveRepoTarget(env, {
      explicitOwner,
      explicitRepo,
      sessionRepos,
      installationId:
        Number.isSafeInteger(auth.installationId) && Number(auth.installationId) > 0
          ? Number(auth.installationId)
          : undefined,
    })
    repoTarget = resolution.target
    hasIndexedRepo = resolution.hasIndexedRepo
  } catch {
    // Resolution is best-effort — a failure just means no grounding this run.
  }

  const id = env.DEEP_RESEARCH.newUniqueId()
  const stub = env.DEEP_RESEARCH.get(id)
  const started = await stub.fetch(`${DO_BASE}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question,
      model,
      effort,
      mode,
      creator: auth.creator,
      ...(mcpTenantScope ? { mcpTenantScope } : {}),
      ...(repoTarget ? { owner: repoTarget.owner, repo: repoTarget.repo } : {}),
      hasIndexedRepo,
    }),
  })
  if (!started.ok) {
    return json({ error: "failed to start research run" }, 502)
  }

  // SIG-303: record the chatbot SEAT event (one per started run). event_id = the
  // DO id → idempotent on a retry. Fire-and-forget (fail-open; never fails the run).
  // mode="off" is a true kill switch — shed the D1 write entirely.
  if (meterDecision.mode !== "off") {
    // The SEAT event carries the org (account_tenant link, resolved above as
    // `orgInstallationId`) for the admin per-member drill. The append stays
    // fire-and-forget via waitUntil (never adds latency, never fails the run).
    ctx.waitUntil(
      appendUsageEvent(env, {
        meter: "chatbot",
        installationId: orgInstallationId,
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
