// SIG-242 — admin/session-gated Linear connection settings.
//
// GET|PUT /v1/org/:installationId/linear-config is scoped by the caller's
// exact GitHub App installation, the connected immutable Linear organization,
// and the live intersection of Linear teams + GitHub repositories. A stale
// revision returns 409. Dark settings are rejected rather than accepted as
// placebo UI.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { listGithubUserInstallationRepos } from "@/src/lib/github-user-repo-scope"
import { getValidAgentTokenViaBroker } from "@/src/lib/linear-token-broker-client"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import {
  DEFAULT_LINEAR_CONFIG,
  fetchLinearWorkspaceIdentity,
  getLinearIntegrationSnapshot,
  listLinearInstallationRepos,
  updateLinearConfig,
  validateLinearConfigInput,
  type LinearIntegrationSnapshot,
} from "@/src/features/linear-integration"
import type { Env } from "@/src/shared/types/env"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface AdminContext {
  session: AuthedSession
  accessToken: string
}

async function authenticateAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<{ ok: true; value: AdminContext } | { ok: false; response: Response }> {
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    return { ok: false, response: json({ error: "misconfigured" }, 503) }
  }
  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch {
    return { ok: false, response: json({ error: "linear_config_failed" }, 500) }
  }
  if (!(await isAdminOfInstallation(accessToken, session.record.login, installationId))) {
    return { ok: false, response: json({ error: "forbidden" }, 403) }
  }
  return { ok: true, value: { session, accessToken } }
}

interface EligibleRepo {
  githubRepoId: number
  fullName: string
}

function responseBody(snapshot: LinearIntegrationSnapshot, repositories: EligibleRepo[]): Record<string, unknown> {
  return {
    connection: snapshot.connection,
    teams: snapshot.teams.map((team) => ({
      ...team,
      warning: team.githubRepoId > 0 && team.githubRepoFullName ? null : "missing_repo_binding",
    })),
    repositories,
    config: snapshot.config ?? { ...DEFAULT_LINEAR_CONFIG, revision: 0 },
  }
}

async function listEligibleRepos(
  env: Env,
  installationId: number,
  accessToken: string,
): Promise<EligibleRepo[] | null> {
  const githubScope = await listGithubUserInstallationRepos(accessToken)
  if (!githubScope.ok) return null
  const current = new Map(
    githubScope.repos
      .filter((repo) => repo.installationId === installationId)
      .map((repo) => [`${repo.owner}/${repo.repo}`.toLowerCase(), repo]),
  )
  const registered = await listLinearInstallationRepos(env, installationId)
  return registered.flatMap((repo) => {
    const live = current.get(repo.fullName.toLowerCase())
    if (!live) return []
    if (live.repoId !== undefined && live.repoId !== repo.id) return []
    return [{ githubRepoId: repo.id, fullName: repo.fullName }]
  })
}

export async function handleGetLinearConfig(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  const auth = await authenticateAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "linear_store_unavailable" }, 503)
  try {
    const repositories = await listEligibleRepos(env, installationId, auth.value.accessToken)
    if (!repositories) return json({ error: "github_repo_scope_unavailable" }, 503)
    return json(responseBody(await getLinearIntegrationSnapshot(env, installationId), repositories), 200)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "linear-config-read-failed",
        installationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "linear_config_failed" }, 500)
  }
}

export async function handleSetLinearConfig(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const auth = await authenticateAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "linear_store_unavailable" }, 503)

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return json({ error: "invalid_config", reason: "invalid-shape" }, 400)
  }
  const rawRecord = raw as Record<string, unknown>
  if (
    Object.keys(rawRecord).sort().join(",") !==
    "bindings,contextMode,createIssue,planning,prValidation,revision,scope,writeback"
  ) {
    return json({ error: "invalid_config", reason: "invalid-shape" }, 400)
  }
  const { bindings: rawBindings, ...rawConfig } = rawRecord
  const parsed = validateLinearConfigInput(rawConfig)
  if (!parsed.ok) return json({ error: "invalid_config", reason: parsed.reason }, 400)
  if (!Array.isArray(rawBindings)) return json({ error: "invalid_bindings" }, 400)
  const bindings: Array<{ teamId: string; githubRepoId: number }> = []
  for (const binding of rawBindings) {
    if (
      typeof binding !== "object" ||
      binding === null ||
      Array.isArray(binding) ||
      Object.keys(binding).sort().join(",") !== "githubRepoId,teamId"
    ) {
      return json({ error: "invalid_bindings" }, 400)
    }
    const item = binding as { teamId?: unknown; githubRepoId?: unknown }
    if (
      typeof item.teamId !== "string" ||
      !item.teamId ||
      !Number.isSafeInteger(item.githubRepoId) ||
      Number(item.githubRepoId) <= 0
    ) {
      return json({ error: "invalid_bindings" }, 400)
    }
    bindings.push({ teamId: item.teamId, githubRepoId: Number(item.githubRepoId) })
  }
  if (new Set(bindings.map((binding) => binding.teamId)).size !== bindings.length) {
    return json({ error: "invalid_bindings" }, 400)
  }

  let snapshot: LinearIntegrationSnapshot
  try {
    snapshot = await getLinearIntegrationSnapshot(env, installationId)
  } catch {
    return json({ error: "linear_config_failed" }, 500)
  }
  if (!snapshot.connection || snapshot.connection.status !== "active") {
    return json({ error: "linear_not_connected" }, 409)
  }

  // Re-read the Linear actor's CURRENT team access before accepting scope.
  const token = await getValidAgentTokenViaBroker(
    env,
    { organizationId: snapshot.connection.organizationId, installationId },
    { readOnly: false },
  )
  if (!token) return json({ error: "linear_token_unavailable" }, 503)
  const identity = await fetchLinearWorkspaceIdentity(token)
  if (
    !identity ||
    !identity.viewer.app ||
    identity.organization.id !== snapshot.connection.organizationId ||
    identity.viewer.id !== snapshot.connection.appUserId
  ) {
    return json({ error: "linear_access_changed" }, 409)
  }
  const currentTeamIds = new Set(identity.teams.map((team) => team.id))
  if (parsed.value.scope.teamIds.some((teamId) => !currentTeamIds.has(teamId))) {
    return json({ error: "linear_team_not_accessible" }, 409)
  }

  // Intersect the selected team bindings with the session user's exact GitHub
  // installation repositories. Visibility of an installation alone is not
  // enough because an App may be installed on selected repositories only.
  const repositories = await listEligibleRepos(env, installationId, auth.value.accessToken)
  if (!repositories) return json({ error: "github_repo_scope_unavailable" }, 503)
  const reposById = new Map(repositories.map((repo) => [repo.githubRepoId, repo]))
  const allowedTeams = snapshot.teams.filter((team) => team.accessState === "allowed")
  const allowedTeamIds = new Set(allowedTeams.map((team) => team.teamId))
  if (
    bindings.length !== allowedTeams.length ||
    bindings.some((binding) => !allowedTeamIds.has(binding.teamId) || !currentTeamIds.has(binding.teamId)) ||
    allowedTeams.some((team) => !bindings.some((binding) => binding.teamId === team.teamId))
  ) {
    return json({ error: "linear_team_access_changed" }, 409)
  }
  const resolvedBindings: Array<{ teamId: string; githubRepoId: number; githubRepoFullName: string }> = []
  for (const binding of bindings) {
    const repo = reposById.get(binding.githubRepoId)
    if (!repo) return json({ error: "linear_team_repo_binding_invalid", teamId: binding.teamId }, 409)
    resolvedBindings.push({
      teamId: binding.teamId,
      githubRepoId: repo.githubRepoId,
      githubRepoFullName: repo.fullName,
    })
  }

  const result = await updateLinearConfig(env, {
    installationId,
    input: parsed.value,
    bindings: resolvedBindings,
    updatedBy: auth.value.session.record.login,
    nowIso: new Date().toISOString(),
  })
  if (!result.ok) {
    const status = result.reason === "not-connected" ? 404 : 409
    return json({ error: result.reason }, status)
  }
  return json(responseBody(await getLinearIntegrationSnapshot(env, installationId), repositories), 200)
}
