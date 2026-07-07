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

/** The portal-visible summary of one connected project. */
interface ConnectionSummary {
  projectId: number
  projectPath: string
  name: string
  reviewTokenExpiresAt?: string
}

function toSummary(projectId: number, conn: GitLabConnection): ConnectionSummary {
  return {
    projectId,
    projectPath: conn.projectPath,
    name: conn.name,
    ...(conn.reviewTokenExpiresAt ? { reviewTokenExpiresAt: conn.reviewTokenExpiresAt } : {}),
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
    if (conn && conn.userId === userId) projects.push(toSummary(id, conn))
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
    })
  }
  return json({ projects: rows })
}

// ── POST /gitlab/connect/projects ────────────────────────────────────────────────

export async function handleGitLabConnectProject(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthorized" }, 401)
  const userId = connectUserKey(authed.record)

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
    return json({ connected: true, projectId, projectPath: existing.projectPath, alreadyConnected: true })
  }

  // Re-verify membership + Maintainer access with the USER's own token — a
  // group/PAT can't be steered here, and an id they can't maintain is rejected.
  let project: Awaited<ReturnType<typeof fetchProject>>
  try {
    project = await fetchProject(env.SIGILIX_GITLAB_BASE_URL, oauthToken, projectId)
  } catch (err) {
    console.error("gitlab connect project fetch failed", { err: err instanceof Error ? err.message : "unknown" })
    return json({ error: "gitlab_fetch_failed" }, 502)
  }
  if (!project) return json({ error: "not_a_member" }, 403)
  if ((project.accessLevel ?? 0) < MAINTAINER_ACCESS_LEVEL) return json({ error: "insufficient_access" }, 403)

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
    })
    hookId = hook.id
  } catch (err) {
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
    })
  } catch (err) {
    await deleteMergeRequestHook({ ...baseUrlOpt(env), token: oauthToken, projectId, hookId })
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
  }
  try {
    await putProjectReviewToken(env, projectId, pat.token)
    await putProjectWebhookSecret(env, projectId, webhookSecret)
    await putConnection(env, projectId, conn)
    await addUserConnectionId(env, userId, projectId)
  } catch (err) {
    await rollbackRemote()
    await deleteProjectReviewToken(env, projectId)
    await deleteProjectWebhookSecret(env, projectId)
    await deleteConnection(env, projectId)
    await removeUserConnectionId(env, userId, projectId)
    console.error("gitlab connect persist failed", { err: err instanceof Error ? err.message : "unknown" })
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

  // Clean up on GitLab with the long-lived review token (the OAuth token may have
  // expired by now — Codex sign-off #4). Best-effort; KV is purged regardless so
  // reviews STOP even if the remote cleanup fails (a stale hook 401s once its
  // secret is gone).
  const reviewToken = await getProjectReviewToken(env, projectId)
  if (reviewToken) {
    await deleteHookWithReviewToken({ ...baseUrlOpt(env), reviewToken, projectId, hookId: conn.hookId })
    if (typeof conn.patId === "number") {
      await revokeProjectAccessToken({ ...baseUrlOpt(env), reviewToken, projectId, patId: conn.patId })
    }
  }

  await deleteProjectReviewToken(env, projectId)
  await deleteProjectWebhookSecret(env, projectId)
  await deleteConnection(env, projectId)
  await removeUserConnectionId(env, userId, projectId)

  console.log(JSON.stringify({ event: "gitlab-connect-project-disconnected", project_id: projectId }))
  return json({ disconnected: true, projectId })
}
