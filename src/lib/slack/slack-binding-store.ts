// Slack workspace→org + channel→repo D1 store (migration 0019) — the Slack
// counterpart of the Linear team→repo model. The OAuth callback records which
// Sigilix org (GitHub App installation) owns a Slack workspace install, and the
// portal's channel→repo picker persists per-channel repo bindings here. The
// scope resolver (slack-scope.ts) reads these tables FIRST and falls back to
// the SIGILIX_SLACK_SCOPE_MAP env var, so the founder's beta channel keeps
// working while customers self-serve. Fail-closed: every read returns null /
// [] when SIGILIX_PLATFORM_DB is unbound or the tables don't exist yet.

import type { Env } from "@/src/shared/types/env"

type StoreEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

export interface SlackWorkspaceRecord {
  teamId: string
  installationId: number
  installedBy: string
  installedAt: string
}

export interface SlackRepoRef {
  githubRepoId: number
  githubRepoFullName: string
}

export interface SlackChannelBinding {
  channelId: string
  useAllRepos: boolean
  /** Explicit repo selection — empty when `useAllRepos`. */
  repos: SlackRepoRef[]
}

/** Link a Slack workspace to the Sigilix org that installed it. Idempotent; a
 *  re-install by a DIFFERENT installation takes over the team and clears the
 *  previous org's channel bindings (stale bindings must never leak across orgs). */
export async function upsertSlackWorkspace(
  env: StoreEnv,
  args: { teamId: string; installationId: number; installedBy: string; nowIso: string },
): Promise<void> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) throw new Error("SIGILIX_PLATFORM_DB unbound")
  const existing = await db
    .prepare("SELECT installation_id FROM slack_workspace WHERE team_id = ?")
    .bind(args.teamId)
    .first<{ installation_id: number }>()
  const statements: D1PreparedStatement[] = []
  if (existing && existing.installation_id !== args.installationId) {
    statements.push(db.prepare("DELETE FROM slack_channel_repo WHERE team_id = ?").bind(args.teamId))
    statements.push(db.prepare("DELETE FROM slack_channel_binding WHERE team_id = ?").bind(args.teamId))
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT(team_id) DO UPDATE SET installation_id = excluded.installation_id," +
          " installed_by = excluded.installed_by, updated_at = excluded.updated_at",
      )
      .bind(args.teamId, args.installationId, args.installedBy, args.nowIso, args.nowIso),
  )
  await db.batch(statements)
}

/** The installation's connected Slack workspace, or null. */
export async function getSlackWorkspaceForInstallation(
  env: StoreEnv,
  installationId: number,
): Promise<SlackWorkspaceRecord | null> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return null
  try {
    const row = await db
      .prepare(
        "SELECT team_id, installation_id, installed_by, installed_at FROM slack_workspace" +
          " WHERE installation_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .bind(installationId)
      .first<{ team_id: string; installation_id: number; installed_by: string; installed_at: string }>()
    if (!row) return null
    return {
      teamId: row.team_id,
      installationId: row.installation_id,
      installedBy: row.installed_by,
      installedAt: row.installed_at,
    }
  } catch {
    // Table absent (migration not applied yet) — fail closed to "not connected".
    return null
  }
}

/** All channel→repo bindings for an installation, sorted for a stable UI. */
export async function listSlackChannelBindings(env: StoreEnv, installationId: number): Promise<SlackChannelBinding[]> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return []
  try {
    const bindings = await db
      .prepare(
        "SELECT channel_id, use_all_repos FROM slack_channel_binding" +
          " WHERE installation_id = ? ORDER BY channel_id",
      )
      .bind(installationId)
      .all<{ channel_id: string; use_all_repos: number }>()
    const repos = await db
      .prepare(
        "SELECT channel_id, github_repo_id, github_repo_full_name FROM slack_channel_repo" +
          " WHERE installation_id = ? ORDER BY channel_id, lower(github_repo_full_name)",
      )
      .bind(installationId)
      .all<{ channel_id: string; github_repo_id: number; github_repo_full_name: string }>()
    const reposByChannel = new Map<string, SlackRepoRef[]>()
    for (const row of repos.results) {
      const list = reposByChannel.get(row.channel_id) ?? []
      list.push({ githubRepoId: row.github_repo_id, githubRepoFullName: row.github_repo_full_name })
      reposByChannel.set(row.channel_id, list)
    }
    return bindings.results.map((row) => ({
      channelId: row.channel_id,
      useAllRepos: row.use_all_repos === 1,
      repos: row.use_all_repos === 1 ? [] : (reposByChannel.get(row.channel_id) ?? []),
    }))
  } catch {
    return []
  }
}

/** Atomically replace the installation's channel bindings (delete + insert in
 *  one batch). The caller has already validated channel ids and repo ownership;
 *  this only writes rows scoped to (installationId, teamId). */
export async function replaceSlackChannelBindings(
  env: StoreEnv,
  args: { installationId: number; teamId: string; bindings: SlackChannelBinding[]; nowIso: string },
): Promise<void> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) throw new Error("SIGILIX_PLATFORM_DB unbound")
  const statements: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM slack_channel_repo WHERE team_id = ? AND installation_id = ?")
      .bind(args.teamId, args.installationId),
    db
      .prepare("DELETE FROM slack_channel_binding WHERE team_id = ? AND installation_id = ?")
      .bind(args.teamId, args.installationId),
  ]
  for (const binding of args.bindings) {
    statements.push(
      db
        .prepare(
          "INSERT INTO slack_channel_binding" +
            " (team_id, channel_id, installation_id, use_all_repos, created_at, updated_at)" +
            " VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          args.teamId,
          binding.channelId,
          args.installationId,
          binding.useAllRepos ? 1 : 0,
          args.nowIso,
          args.nowIso,
        ),
    )
    for (const repo of binding.repos) {
      statements.push(
        db
          .prepare(
            "INSERT INTO slack_channel_repo" +
              " (team_id, channel_id, installation_id, github_repo_id, github_repo_full_name, created_at, updated_at)" +
              " VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            args.teamId,
            binding.channelId,
            args.installationId,
            repo.githubRepoId,
            repo.githubRepoFullName,
            args.nowIso,
            args.nowIso,
          ),
      )
    }
  }
  await db.batch(statements)
}

/** Repos registered for an installation (shared `repo` table) — the candidate
 *  set for the portal's picker and the `useAllRepos` expansion. */
export async function listSlackInstallationRepos(env: StoreEnv, installationId: number): Promise<SlackRepoRef[]> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return []
  const rows = await db
    .prepare("SELECT repo_id, full_name FROM repo WHERE installation_id = ? ORDER BY lower(full_name), repo_id")
    .bind(installationId)
    .all<{ repo_id: number; full_name: string }>()
  return rows.results.map((row) => ({ githubRepoId: row.repo_id, githubRepoFullName: row.full_name }))
}

export interface SlackChannelDbScope {
  installationId: number
  repos: SlackRepoRef[]
}

/** The effective repo set for one team:channel, or null when the channel has no
 *  DB binding (the resolver then falls back to the env scope map). Returns
 *  null — never throws — when the DB is unbound, the migration hasn't been
 *  applied yet, or the query fails, so the env fallback always stays reachable. */
export async function getSlackChannelDbScope(
  env: StoreEnv,
  args: { teamId: string; channelId: string },
): Promise<SlackChannelDbScope | null> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return null
  try {
    const binding = await db
      .prepare("SELECT installation_id, use_all_repos FROM slack_channel_binding WHERE team_id = ? AND channel_id = ?")
      .bind(args.teamId, args.channelId)
      .first<{ installation_id: number; use_all_repos: number }>()
    if (!binding) return null
    if (binding.use_all_repos === 1) {
      const repos = await listSlackInstallationRepos(env, binding.installation_id)
      return { installationId: binding.installation_id, repos }
    }
    const rows = await db
      .prepare(
        "SELECT github_repo_id, github_repo_full_name FROM slack_channel_repo" +
          " WHERE team_id = ? AND channel_id = ? ORDER BY lower(github_repo_full_name)",
      )
      .bind(args.teamId, args.channelId)
      .all<{ github_repo_id: number; github_repo_full_name: string }>()
    return {
      installationId: binding.installation_id,
      repos: rows.results.map((row) => ({
        githubRepoId: row.github_repo_id,
        githubRepoFullName: row.github_repo_full_name,
      })),
    }
  } catch {
    return null
  }
}
