// sig-gitlab-connector: the portal-facing project endpoints of the connect flow.
// These are CORS'd fetches (session cookie) the portal calls AFTER the OAuth
// round-trip stored the user's `api`-scoped token:
//
//   GET    /gitlab/connect/status              — {authorized, projects:[connected]}
//   GET    /gitlab/connect/projects            — the user's Maintainer+ GitLab projects
//   POST   /gitlab/connect/projects  {projectId} — provision hook + review token + persist
//   DELETE /gitlab/connect/projects/:id         — remove hook + revoke token + purge
//
// SECURITY:
//   - Every route is session-gated (401 without a session).
//   - Connecting a project re-verifies the user's access via THEIR OWN OAuth
//     token (Maintainer, access_level >= 40) — a user cannot connect a project
//     they don't maintain, nor spoof an arbitrary projectId.
//   - A project already connected by a DIFFERENT user is refused (409) — no
//     cross-tenant takeover.
//   - Webhook secret + review token are generated server-side and never returned
//     to the client nor logged.

import type { Env } from "@/src/shared/types/env"
import {
  abandonGitLabRepositoryAuthorityClaim,
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  normalizeGitLabInstanceOrigin,
  releaseGitLabRepositoryAuthority,
} from "@/src/features/repository-context"
import { requireSession } from "@/src/lib/auth-middleware"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import {
  MAINTAINER_ACCESS_LEVEL,
  createMergeRequestHook,
  createProjectAccessToken,
  deleteHookWithReviewToken,
  deleteMergeRequestHook,
  fetchProject,
  listMaintainerProjects,
  reviewTokenExpiryIso,
  revokeProjectAccessToken,
} from "./gitlab-connect-api"
import { connectUserKey } from "./gitlab-connect-oauth"
import { reconcileGitLabRepositoryContextAfterAuthorityChange } from "./gitlab-repository-context-lifecycle"
import {
  addUserConnectionId,
  deleteConnection,
  deleteProjectReviewToken,
  deleteProjectWebhookSecret,
  generateWebhookSecret,
  getConnection,
  getProjectReviewToken,
  getUserConnectionIds,
  getUserOAuthToken,
  putConnection,
  putProjectReviewToken,
  putProjectWebhookSecret,
  removeUserConnectionId,
  type GitLabConnection,
} from "./gitlab-connect-store"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function webhookUrl(env: Env): string {
  const base = env.OPENCLAW_BASE_URL ?? "https://api.sigilix.ai"
  return `${base.replace(/\/+$/, "")}/gitlab/webhook`
}

function baseUrlOpt(env: Env): { baseUrl?: string } {
  return env.SIGILIX_GITLAB_BASE_URL ? { baseUrl: env.SIGILIX_GITLAB_BASE_URL } : {}
}

function contextAuthorityEnabled(env: Env): boolean {
  return env.OPENCLAW_REPOSITORY_CONTEXT_API === "on"
}

interface AuthorityGeneration {
  scopeId: string
  externalId: string
  claimToken: string
  instanceOrigin: string
}

/** The portal-visible summary of one connected project. */
interface ConnectionSummary {
  projectId: number
  projectPath: string
  name: string
  reviewTokenExpiresAt?: string
  contextReconnectRequired?: true
}

function toSummary(projectId: number, conn: GitLabConnection, authorityEnabled: boolean): ConnectionSummary {
  return {
    projectId,
    projectPath: conn.projectPath,
    name: conn.name,
    ...(conn.reviewTokenExpiresAt ? { reviewTokenExpiresAt: conn.reviewTokenExpiresAt } : {}),
    ...(authorityEnabled &&
    (!conn.contextOwnerUserId || !conn.instanceOrigin || !conn.authorityExternalId || !conn.authorityClaimToken)
      ? { contextReconnectRequired: true as const }
      : {}),
  }
}

// ── GET /gitlab/connect/status ─────────────────────────────────────────────────

export async function handleGitLabConnectStatus(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthorized" }, 401)
  const userId = connectUserKey(authed.record)

  const authorized = (await getUserOAuthToken(env, userId)) !== null
  const ids = await getUserConnectionIds(env, userId)
  const projects: ConnectionSummary[] = []
  for (const id of ids) {
    const conn = await getConnection(env, id)
    // Only surface connections THIS user still owns (defensive against a stale index).
    if (conn && conn.userId === userId) projects.push(toSummary(id, conn, contextAuthorityEnabled(env)))
  }
  return json({ authorized, projects })
}

// ── GET /gitlab/connect/projects ────────────────────────────────────────────────

export async function handleGitLabConnectListProjects(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthorized" }, 401)
  const userId = connectUserKey(authed.record)

  const oauthToken = await getUserOAuthToken(env, userId)
  // 409 (not 401) distinguishes "signed in but GitLab authorization expired" from
  // "no session" so the portal shows "Reconnect GitLab" rather than "Sign in".
  if (!oauthToken) return json({ error: "gitlab_reauthorize" }, 409)

  let projects: Awaited<ReturnType<typeof listMaintainerProjects>>
  try {
    projects = await listMaintainerProjects(env.SIGILIX_GITLAB_BASE_URL, oauthToken)
  } catch (err) {
    console.error("gitlab connect list projects failed", { err: err instanceof Error ? err.message : "unknown" })
    return json({ error: "gitlab_list_failed" }, 502)
  }

  const rows = []
  for (const p of projects) {
    const conn = await getConnection(env, p.id)
    rows.push({
      id: p.id,
      path: p.path_with_namespace,
      name: p.name,
      accessLevel: p.accessLevel,
      // "connected" only when THIS user owns it — a project connected by another
      // tenant reads as not-connectable-here (the POST will 409).
      connected: conn?.userId === userId,
      connectedByOther: conn != null && conn.userId !== userId,
      contextReconnectRequired:
        contextAuthorityEnabled(env) &&
        conn?.userId === userId &&
        (!conn.contextOwnerUserId || !conn.instanceOrigin || !conn.authorityExternalId || !conn.authorityClaimToken),
    })
  }
  return json({ projects: rows })
}

// ── POST /gitlab/connect/projects ────────────────────────────────────────────────

export async function handleGitLabConnectProject(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthorized" }, 401)
  const userId = connectUserKey(authed.record)
  const authorityEnabled = contextAuthorityEnabled(env)
  const contextOwnerUserId = authed.record.userId
  if (authorityEnabled && !contextOwnerUserId) return json({ error: "session_reauthenticate" }, 409)
  if (authorityEnabled && !env.SIGILIX_PLATFORM_DB) return json({ error: "repository_context_unavailable" }, 503)

  // CSRF defense (Codex P1): require application/json so a cross-origin "simple"
  // request (text/plain, no preflight) can't drive this credentialed mutation —
  // application/json forces a preflight our portal-only CORS grant gates. Mirrors
  // account-routes.ts's mutation guard.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  let projectId: number
  try {
    const body = (await request.json()) as { projectId?: unknown }
    projectId = typeof body.projectId === "number" ? body.projectId : Number(body.projectId)
  } catch {
    return json({ error: "invalid_body" }, 400)
  }
  if (!Number.isInteger(projectId) || projectId <= 0) return json({ error: "invalid_project_id" }, 400)

  const oauthToken = await getUserOAuthToken(env, userId)
  if (!oauthToken) return json({ error: "gitlab_reauthorize" }, 409)

  // Idempotency + tenant isolation: refuse a project owned by another user; a
  // re-connect by the SAME owner is a no-op success (never a duplicate hook).
  const existing = await getConnection(env, projectId)
  if (existing) {
    if (existing.userId !== userId) return json({ error: "already_connected_other" }, 409)
    if (authorityEnabled) {
      const currentInstanceOrigin = normalizeGitLabInstanceOrigin(env.SIGILIX_GITLAB_BASE_URL)
      if (
        !contextOwnerUserId ||
        existing.contextOwnerUserId !== contextOwnerUserId ||
        !existing.instanceOrigin ||
        !existing.authorityExternalId ||
        !existing.authorityClaimToken
      ) {
        return json({ error: "gitlab_context_reconnect_required" }, 409)
      }
      const resumed = await activateGitLabRepositoryAuthority(env.SIGILIX_PLATFORM_DB!, {
        scopeId: contextOwnerUserId,
        externalId: existing.authorityExternalId,
        claimToken: existing.authorityClaimToken,
      })
      if (resumed.status === "unavailable") return json({ error: "repository_context_unavailable" }, 503)
      if (resumed.status === "lost_or_expired_claim") {
        const reviewToken = await getProjectReviewToken(env, projectId, existing.authorityClaimToken)
        if (reviewToken) {
          await deleteHookWithReviewToken({
            baseUrl: existing.instanceOrigin,
            reviewToken,
            projectId,
            hookId: existing.hookId,
          })
          if (typeof existing.patId === "number") {
            await revokeProjectAccessToken({
              baseUrl: existing.instanceOrigin,
              reviewToken,
              projectId,
              patId: existing.patId,
            })
          }
        }
        await abandonGitLabRepositoryAuthorityClaim(env.SIGILIX_PLATFORM_DB!, {
          scopeId: contextOwnerUserId,
          externalId: existing.authorityExternalId,
          claimToken: existing.authorityClaimToken,
        })
        await purgeConnectionGeneration(env, userId, projectId, existing.authorityClaimToken)
        return json({ error: "gitlab_context_reconnect_required" }, 409)
      }
      if (!currentInstanceOrigin || existing.instanceOrigin !== currentInstanceOrigin) {
        return json({ error: "gitlab_context_reconnect_required" }, 409)
      }
      try {
        await addUserConnectionId(env, userId, projectId)
      } catch {
        return json({ error: "persist_failed" }, 502)
      }
    }
    return json({ connected: true, projectId, projectPath: existing.projectPath, alreadyConnected: true })
  }

  // Re-verify membership + Maintainer access with the USER's own token — a
  // group/PAT can't be steered here, and an id they can't maintain is rejected.
  // One application deadline bounds the complete remote side-effect window;
  // stale D1 claims are not reclaimable until 15 minutes later.
  const sideEffectDeadline = AbortSignal.timeout(90_000)
  let project: Awaited<ReturnType<typeof fetchProject>>
  try {
    project = await fetchProject(env.SIGILIX_GITLAB_BASE_URL, oauthToken, projectId, {
      signal: sideEffectDeadline,
    })
  } catch (err) {
    console.error("gitlab connect project fetch failed", { err: err instanceof Error ? err.message : "unknown" })
    return json({ error: "gitlab_fetch_failed" }, 502)
  }
  if (!project) return json({ error: "not_a_member" }, 403)
  if ((project.accessLevel ?? 0) < MAINTAINER_ACCESS_LEVEL) return json({ error: "insufficient_access" }, 403)

  let authority: AuthorityGeneration | null = null
  if (authorityEnabled) {
    const instanceOrigin = normalizeGitLabInstanceOrigin(env.SIGILIX_GITLAB_BASE_URL)
    if (!instanceOrigin || !contextOwnerUserId) return json({ error: "repository_context_unavailable" }, 503)
    const claimed = await claimGitLabRepositoryAuthority(env.SIGILIX_PLATFORM_DB!, {
      scopeId: contextOwnerUserId,
      instanceOrigin,
      sourceId: projectId,
      fullName: project.path_with_namespace,
    })
    if (claimed.status === "unavailable") return json({ error: "repository_context_unavailable" }, 503)
    if (claimed.status === "owned_by_other") return json({ error: "already_connected_other" }, 409)
    if (claimed.status === "claim_in_progress") return json({ error: "connect_in_progress" }, 409)
    if (claimed.status === "already_active_same_scope") {
      return json({ error: "gitlab_context_reconnect_required" }, 409)
    }
    authority = {
      scopeId: contextOwnerUserId,
      externalId: claimed.repository.externalId,
      claimToken: claimed.claimToken,
      instanceOrigin,
    }
  }

  const abandonAuthority = async () => {
    if (!authority || !env.SIGILIX_PLATFORM_DB) return
    await abandonGitLabRepositoryAuthorityClaim(env.SIGILIX_PLATFORM_DB, {
      scopeId: authority.scopeId,
      externalId: authority.externalId,
      claimToken: authority.claimToken,
    })
  }

  // 1. Provision the webhook (per-project secret) FIRST so we can roll it back if
  //    the review-token step fails.
  const webhookSecret = generateWebhookSecret()
  let hookId: number
  try {
    const hook = await createMergeRequestHook({
      ...baseUrlOpt(env),
      token: oauthToken,
      projectId,
      webhookUrl: webhookUrl(env),
      webhookSecret,
      signal: sideEffectDeadline,
    })
    hookId = hook.id
  } catch (err) {
    await abandonAuthority()
    console.error("gitlab connect create hook failed", { err: err instanceof Error ? err.message : "unknown" })
    return json({ error: "hook_create_failed" }, 502)
  }

  // 2. Provision the STABLE review credential (project access token). On failure,
  //    roll back the hook so we never leave a half-connected project.
  const expiresAtIso = reviewTokenExpiryIso()
  let pat: Awaited<ReturnType<typeof createProjectAccessToken>>
  try {
    pat = await createProjectAccessToken({
      ...baseUrlOpt(env),
      token: oauthToken,
      projectId,
      name: `sigilix-review-${Date.now()}`,
      expiresAtIso,
      signal: sideEffectDeadline,
    })
  } catch (err) {
    await deleteMergeRequestHook({ ...baseUrlOpt(env), token: oauthToken, projectId, hookId })
    await abandonAuthority()
    console.error("gitlab connect create review token failed", {
      err: err instanceof Error ? err.message : "unknown",
    })
    // Most common cause: project access tokens disabled / access too low on
    // self-managed or restricted instances (Codex sign-off #1).
    return json({ error: "review_token_failed" }, 502)
  }

  // Roll back BOTH remote resources we just created (best-effort). Used when a
  // concurrent claim wins the race, or KV persistence fails — so we never leave
  // an orphaned hook + review token behind (Codex P1/P2).
  const rollbackRemote = async () => {
    await deleteMergeRequestHook({ ...baseUrlOpt(env), token: oauthToken, projectId, hookId })
    await revokeProjectAccessToken({ ...baseUrlOpt(env), reviewToken: pat.token, projectId, patId: pat.id })
  }

  // 3. Concurrency guard (Codex P1): KV has no transaction, so re-read the
  //    connection record after the (slow) remote provisioning. If another Sigilix
  //    account claimed this project in the window, back OUT our own remote
  //    resources instead of silently overwriting their ownership record. This
  //    shrinks the last-write-wins takeover to a detect-and-rollback; a true lock
  //    (a per-project DO) is the complete fix and is tracked as a follow-up.
  const raced = await getConnection(env, projectId)
  if (raced && raced.userId !== userId) {
    await rollbackRemote()
    await abandonAuthority()
    console.warn(JSON.stringify({ event: "gitlab-connect-project-race-lost", project_id: projectId }))
    return json({ error: "already_connected_other" }, 409)
  }

  // 4. Persist (review token + webhook secret + connection record + user index).
  //    On ANY persistence failure, roll back the remote hook + token AND purge
  //    partial KV so a disconnect-less orphan can never survive (Codex P2).
  const conn: GitLabConnection = {
    userId,
    projectPath: project.path_with_namespace,
    name: project.name,
    hookId,
    patId: pat.id,
    reviewTokenExpiresAt: expiresAtIso,
    connectedAt: new Date().toISOString(),
    ...(authority
      ? {
          contextOwnerUserId: authority.scopeId,
          instanceOrigin: authority.instanceOrigin,
          authorityExternalId: authority.externalId,
          authorityClaimToken: authority.claimToken,
        }
      : {}),
  }
  try {
    await putProjectReviewToken(env, projectId, pat.token, authority?.claimToken)
    await putProjectWebhookSecret(env, projectId, webhookSecret, authority?.claimToken)
    await putConnection(env, projectId, conn)
  } catch (err) {
    await rollbackRemote()
    await deleteProjectReviewToken(env, projectId, authority?.claimToken)
    await deleteProjectWebhookSecret(env, projectId, authority?.claimToken)
    await deleteConnection(env, projectId)
    await removeUserConnectionId(env, userId, projectId)
    await abandonAuthority()
    console.error("gitlab connect persist failed", { err: err instanceof Error ? err.message : "unknown" })
    return json({ error: "persist_failed" }, 502)
  }

  if (authority) {
    const activated = await activateGitLabRepositoryAuthority(env.SIGILIX_PLATFORM_DB!, {
      scopeId: authority.scopeId,
      externalId: authority.externalId,
      claimToken: authority.claimToken,
    })
    if (activated.status === "unavailable") {
      // The D1 commit may have succeeded even if its acknowledgement was lost.
      // Preserve this exact generation so the idempotent POST retry can resume.
      return json({ error: "repository_context_unavailable" }, 503)
    }
    if (activated.status === "lost_or_expired_claim") {
      await rollbackRemote()
      await purgeConnectionGeneration(env, userId, projectId, authority.claimToken)
      return json({ error: "repository_scope_changed" }, 409)
    }
  }

  try {
    // The per-user index is status/navigation cache only and is published after
    // strong authority activation. Repository-context GET/PUT never reads it.
    await addUserConnectionId(env, userId, projectId)
  } catch (err) {
    console.error("gitlab connect index persist failed", { err: err instanceof Error ? err.message : "unknown" })
    return json({ error: "persist_failed" }, 502)
  }

  console.log(
    JSON.stringify({
      event: "gitlab-connect-project-connected",
      project_id: projectId,
      project: project.path_with_namespace,
    }),
  )
  return json({ connected: true, projectId, projectPath: project.path_with_namespace })
}

// ── DELETE /gitlab/connect/projects/:id ──────────────────────────────────────────

export async function handleGitLabConnectDisconnect(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  projectId: number,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthorized" }, 401)
  const userId = connectUserKey(authed.record)

  const conn = await getConnection(env, projectId)
  // 404 (not 403) when owned by another user — never leak that it's connected.
  if (!conn || conn.userId !== userId) return json({ error: "not_found" }, 404)

  // Once a connection carries D1 authority metadata, disconnect must revoke it
  // even if the context API rollout is temporarily off; otherwise re-enabling
  // the API could resurrect a repository the user already disconnected.
  if (conn.authorityExternalId && conn.authorityClaimToken) {
    const contextOwnerUserId = authed.record.userId
    if (!contextOwnerUserId || contextOwnerUserId !== conn.contextOwnerUserId) return json({ error: "not_found" }, 404)
    if (!env.SIGILIX_PLATFORM_DB) return json({ error: "repository_context_unavailable" }, 503)
    const released = await releaseGitLabRepositoryAuthority(env.SIGILIX_PLATFORM_DB, {
      scopeId: contextOwnerUserId,
      externalId: conn.authorityExternalId,
      claimToken: conn.authorityClaimToken,
    })
    if (released.status === "unavailable") return json({ error: "repository_context_unavailable" }, 503)
    if (released.status === "lost_claim") return json({ error: "repository_scope_changed" }, 409)
    ctx.waitUntil(
      reconcileGitLabRepositoryContextAfterAuthorityChange(env.SIGILIX_PLATFORM_DB, contextOwnerUserId)
        .then((result) => {
          if (result === "unavailable") {
            console.warn(
              JSON.stringify({
                event: "gitlab-repository-context-disconnect-reconcile-unavailable",
                scopeId: contextOwnerUserId,
                project_id: projectId,
              }),
            )
          }
        })
        .catch((error: unknown) => {
          console.warn(
            JSON.stringify({
              event: "gitlab-repository-context-disconnect-reconcile-threw",
              scopeId: contextOwnerUserId,
              project_id: projectId,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
        }),
    )
  }

  // Clean up on GitLab with the long-lived review token (the OAuth token may have
  // expired by now — Codex sign-off #4). Best-effort; KV is purged regardless so
  // reviews STOP even if the remote cleanup fails (a stale hook 401s once its
  // secret is gone).
  const reviewToken = await getProjectReviewToken(env, projectId, conn.authorityClaimToken)
  if (reviewToken) {
    const storedBaseUrl = conn.instanceOrigin ?? env.SIGILIX_GITLAB_BASE_URL
    const storedBaseUrlOpt = storedBaseUrl ? { baseUrl: storedBaseUrl } : {}
    await deleteHookWithReviewToken({ ...storedBaseUrlOpt, reviewToken, projectId, hookId: conn.hookId })
    if (typeof conn.patId === "number") {
      await revokeProjectAccessToken({ ...storedBaseUrlOpt, reviewToken, projectId, patId: conn.patId })
    }
  }

  await deleteProjectReviewToken(env, projectId, conn.authorityClaimToken)
  await deleteProjectWebhookSecret(env, projectId, conn.authorityClaimToken)
  await deleteConnection(env, projectId)
  await removeUserConnectionId(env, userId, projectId)

  console.log(JSON.stringify({ event: "gitlab-connect-project-disconnected", project_id: projectId }))
  return json({ disconnected: true, projectId })
}

async function purgeConnectionGeneration(
  env: Env,
  userId: string,
  projectId: number,
  claimToken: string,
): Promise<void> {
  const current = await getConnection(env, projectId)
  if (current?.userId !== userId || current.authorityClaimToken !== claimToken) return
  await deleteProjectReviewToken(env, projectId, claimToken)
  await deleteProjectWebhookSecret(env, projectId, claimToken)
  await deleteConnection(env, projectId)
  await removeUserConnectionId(env, userId, projectId)
}
