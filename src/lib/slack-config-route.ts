// Slack channel→repo binding settings — the Slack counterpart of
// linear-config-route.ts.
//
//   GET /v1/org/:installationId/slack-config → connected workspace + bindings
//   PUT /v1/org/:installationId/slack-config → replace channel→repo bindings
//
// AUTH — SESSION-ONLY, admin-gated, PER-INSTALLATION (mirrors
// linear-config-route.ts): a portal session cookie is required and the caller
// must be an admin of THIS exact installation via `isAdminOfInstallation`,
// which enforces the admin gate AND tenant isolation in one check.
//
// ORG ISOLATION — a binding may only reference repos in the live intersection
// of (a) the session user's exact GitHub installation repositories and (b) the
// installation's registered `repo` rows. One org can never bind another org's
// repos, and bindings are only written against the org's OWN slack_workspace.

import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { listGithubUserInstallationRepos } from "@/src/lib/github-user-repo-scope"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import {
  getSlackWorkspaceForInstallation,
  listSlackChannelBindings,
  listSlackInstallationRepos,
  registerInstallationRepos,
  replaceSlackChannelBindings,
  type SlackChannelBinding,
} from "@/src/lib/slack/slack-binding-store"
import type { Env } from "@/src/shared/types/env"

// Slack channel ids look like C0BEL8ZAARE / G… (private groups). Closed charset,
// bounded length — rejects anything that isn't a plausible Slack channel id.
const CHANNEL_ID_RE = /^[A-Z][A-Z0-9]{4,31}$/

// Bounds on one PUT — keeps the replace batch far under D1's statement limits.
const MAX_CHANNEL_BINDINGS = 100
const MAX_REPOS_PER_CHANNEL = 200

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
    return { ok: false, response: json({ error: "slack_config_failed" }, 500) }
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

/** The live intersection of the session user's exact GitHub installation repos
 *  and the installation's registered `repo` rows — mirrors the Linear route.
 *  Live repos are first registered (best-effort) into the `repo` table because
 *  its rows are otherwise webhook-lazy: a fresh install would see an empty
 *  picker and a `useAllRepos` binding would expand to nothing at resolve time. */
async function listEligibleRepos(
  env: Env,
  installationId: number,
  accessToken: string,
): Promise<EligibleRepo[] | null> {
  const githubScope = await listGithubUserInstallationRepos(accessToken)
  if (!githubScope.ok) return null
  const live = githubScope.repos.filter((repo) => repo.installationId === installationId)
  const current = new Map(live.map((repo) => [`${repo.owner}/${repo.repo}`.toLowerCase(), repo]))
  await registerInstallationRepos(
    env,
    installationId,
    live.flatMap((repo) =>
      repo.repoId !== undefined ? [{ repoId: repo.repoId, fullName: `${repo.owner}/${repo.repo}` }] : [],
    ),
    new Date().toISOString(),
  )
  const registered = await listSlackInstallationRepos(env, installationId)
  return registered.flatMap((repo) => {
    const live = current.get(repo.githubRepoFullName.toLowerCase())
    if (!live) return []
    if (live.repoId !== undefined && live.repoId !== repo.githubRepoId) return []
    return [{ githubRepoId: repo.githubRepoId, fullName: repo.githubRepoFullName }]
  })
}

async function responseBody(env: Env, installationId: number, repositories: EligibleRepo[]): Promise<Response> {
  const workspace = await getSlackWorkspaceForInstallation(env, installationId)
  const bindings = await listSlackChannelBindings(env, installationId)
  return json(
    {
      workspace: workspace ? { teamId: workspace.teamId, installedAt: workspace.installedAt } : null,
      bindings: bindings.map((binding) => ({
        channelId: binding.channelId,
        useAllRepos: binding.useAllRepos,
        repos: binding.repos.map((repo) => ({ githubRepoId: repo.githubRepoId, fullName: repo.githubRepoFullName })),
      })),
      repositories,
    },
    200,
  )
}

export async function handleGetSlackConfig(
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
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "slack_store_unavailable" }, 503)
  try {
    const repositories = await listEligibleRepos(env, installationId, auth.value.accessToken)
    if (!repositories) return json({ error: "github_repo_scope_unavailable" }, 503)
    return await responseBody(env, installationId, repositories)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "slack-config-read-failed",
        installationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "slack_config_failed" }, 500)
  }
}

interface ParsedChannelBinding {
  channelId: string
  /** Explicit repo ids (empty when `useAllRepos`). Resolved to full names later. */
  repoIds: number[]
  useAllRepos: boolean
}

/**
 * Parse the PUT `bindings` array. Two closed shapes per entry (exact-key
 * checked, mirroring the Linear route's parseBindings):
 *   { channelId, githubRepoIds: number[] }  — explicit repo set (non-empty)
 *   { channelId, useAllRepos: true }        — all installation repos
 * Returns null on any malformed entry or a duplicate channel id.
 */
function parseChannelBindings(raw: unknown[]): ParsedChannelBinding[] | null {
  if (raw.length > MAX_CHANNEL_BINDINGS) return null
  const out: ParsedChannelBinding[] = []
  for (const binding of raw) {
    if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return null
    const keys = Object.keys(binding).sort().join(",")
    const item = binding as { channelId?: unknown; githubRepoIds?: unknown; useAllRepos?: unknown }
    if (typeof item.channelId !== "string" || !CHANNEL_ID_RE.test(item.channelId)) return null
    if (keys === "channelId,githubRepoIds") {
      if (
        !Array.isArray(item.githubRepoIds) ||
        item.githubRepoIds.length === 0 ||
        item.githubRepoIds.length > MAX_REPOS_PER_CHANNEL
      )
        return null
      const repoIds = item.githubRepoIds.map((id) => Number(id))
      if (repoIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(repoIds).size !== repoIds.length) {
        return null
      }
      out.push({ channelId: item.channelId, repoIds, useAllRepos: false })
    } else if (keys === "channelId,useAllRepos") {
      if (item.useAllRepos !== true) return null
      out.push({ channelId: item.channelId, repoIds: [], useAllRepos: true })
    } else {
      return null
    }
  }
  if (new Set(out.map((binding) => binding.channelId)).size !== out.length) return null
  return out
}

export async function handleSetSlackConfig(
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
  if (!env.SIGILIX_PLATFORM_DB) return json({ error: "slack_store_unavailable" }, 503)

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return json({ error: "invalid_bindings" }, 400)
  }
  const rawRecord = raw as Record<string, unknown>
  if (Object.keys(rawRecord).sort().join(",") !== "bindings" || !Array.isArray(rawRecord.bindings)) {
    return json({ error: "invalid_bindings" }, 400)
  }
  const parsedBindings = parseChannelBindings(rawRecord.bindings)
  if (!parsedBindings) return json({ error: "invalid_bindings" }, 400)

  // The org must have a linked Slack workspace (written by the OAuth callback).
  const workspace = await getSlackWorkspaceForInstallation(env, installationId)
  if (!workspace) return json({ error: "slack_not_connected" }, 409)

  // Resolve every explicit repo id against THIS org's eligible set — a repo id
  // outside it (another org's repo, or one the caller can't see) is rejected.
  const repositories = await listEligibleRepos(env, installationId, auth.value.accessToken)
  if (!repositories) return json({ error: "github_repo_scope_unavailable" }, 503)
  const reposById = new Map(repositories.map((repo) => [repo.githubRepoId, repo]))
  const resolvedBindings: SlackChannelBinding[] = []
  for (const binding of parsedBindings) {
    // A `useAllRepos` binding over an empty eligible set would be a live-looking
    // dead binding (it expands to nothing at resolve time) — reject it too.
    if (binding.useAllRepos && repositories.length === 0) {
      return json({ error: "slack_channel_repo_binding_invalid", channelId: binding.channelId }, 409)
    }
    const repos: SlackChannelBinding["repos"] = []
    for (const repoId of binding.repoIds) {
      const repo = reposById.get(repoId)
      if (!repo) return json({ error: "slack_channel_repo_binding_invalid", channelId: binding.channelId }, 409)
      repos.push({ githubRepoId: repo.githubRepoId, githubRepoFullName: repo.fullName })
    }
    resolvedBindings.push({ channelId: binding.channelId, repos, useAllRepos: binding.useAllRepos })
  }

  try {
    await replaceSlackChannelBindings(env, {
      installationId,
      teamId: workspace.teamId,
      bindings: resolvedBindings,
      nowIso: new Date().toISOString(),
    })
    return await responseBody(env, installationId, repositories)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "slack-config-write-failed",
        installationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "slack_config_failed" }, 500)
  }
}
