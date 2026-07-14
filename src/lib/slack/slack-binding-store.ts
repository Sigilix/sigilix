// Slack workspace→org + channel→repo D1 store (migration 0019) — the Slack
// counterpart of the Linear team→repo model. The OAuth callback records which
// Sigilix org (GitHub App installation) owns a Slack workspace install, and the
// portal's channel→repo picker persists per-channel repo bindings here. The
// scope resolver (slack-scope.ts) reads these tables FIRST. It distinguishes a
// healthy missing row from a schema/query failure so only genuine absence may
// use the legacy env map; invalid or unavailable authority stays fail-closed.
// Portal-facing list reads retain their documented null/[] soft-failure shape.

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

export type UpsertSlackWorkspaceResult = { ok: true } | { ok: false; reason: "team-linked-to-other-installation" }

/** Link a Slack workspace to the Sigilix org that installed it. Idempotent for
 *  the SAME installation (re-installs refresh the row). A team already linked
 *  to a DIFFERENT installation is REFUSED — never taken over — because the
 *  install flow only proves the caller admins the installation they named, not
 *  the workspace's current owner. Unlinking is an explicit owner-side action.
 *  The guard is atomic: the conditional upsert and the verify read tolerate
 *  concurrent callbacks (last-writer for the same installation only). */
export async function upsertSlackWorkspace(
  env: StoreEnv,
  args: { teamId: string; installationId: number; installedBy: string; nowIso: string },
): Promise<UpsertSlackWorkspaceResult> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) throw new Error("SIGILIX_PLATFORM_DB unbound")
  // Insert a fresh link, or refresh the row ONLY when the team already belongs
  // to this same installation. A conflicting row owned by another installation
  // is left untouched (the WHERE clause makes the update a no-op).
  await db
    .prepare(
      "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT(team_id) DO UPDATE SET" +
        " installed_by = excluded.installed_by, updated_at = excluded.updated_at" +
        " WHERE slack_workspace.installation_id = excluded.installation_id",
    )
    .bind(args.teamId, args.installationId, args.installedBy, args.nowIso, args.nowIso)
    .run()
  const row = await db
    .prepare("SELECT installation_id FROM slack_workspace WHERE team_id = ?")
    .bind(args.teamId)
    .first<{ installation_id: number }>()
  if (!row || row.installation_id !== args.installationId) {
    return { ok: false, reason: "team-linked-to-other-installation" }
  }
  return { ok: true }
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
 *  one batch). The caller has already validated channel ids and repo ownership.
 *  Deletes are scoped by installation ONLY (not team) so the delete scope
 *  matches `listSlackChannelBindings` exactly — removing a channel in the UI
 *  removes it even if the org's workspace link moved to a new team since. */
export async function replaceSlackChannelBindings(
  env: StoreEnv,
  args: { installationId: number; teamId: string; bindings: SlackChannelBinding[]; nowIso: string },
): Promise<void> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) throw new Error("SIGILIX_PLATFORM_DB unbound")
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM slack_channel_repo WHERE installation_id = ?").bind(args.installationId),
    db.prepare("DELETE FROM slack_channel_binding WHERE installation_id = ?").bind(args.installationId),
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

/** Best-effort registration of an installation's live GitHub repos into the
 *  shared `repo` table. `repo` rows are otherwise webhook-lazy, so a fresh
 *  installation has none — which would leave the picker empty and make a
 *  `useAllRepos` binding expand to nothing at resolve time. Failures (e.g. a
 *  missing `tenant` row for the FK) are swallowed: callers fall back to
 *  whatever is already registered. */
export async function registerInstallationRepos(
  env: StoreEnv,
  installationId: number,
  repos: Array<{ repoId: number; fullName: string }>,
  nowIso: string,
): Promise<void> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db || repos.length === 0) return
  try {
    await db.batch(
      repos.map((repo) =>
        db
          .prepare(
            "INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, ?)" +
              " ON CONFLICT(repo_id) DO UPDATE SET installation_id = excluded.installation_id," +
              " full_name = excluded.full_name, updated_at = excluded.updated_at",
          )
          .bind(repo.repoId, installationId, repo.fullName, nowIso),
      ),
    )
  } catch {
    // Best-effort — the caller intersects against the existing rows regardless.
  }
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

export interface BoundSlackChannelDbScope {
  kind: "bound"
  installationId: number
  useAllRepos: boolean
  repos: SlackRepoRef[]
}

export type SlackChannelDbScopeResult =
  | { kind: "unbound" }
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "invalid" }
  | BoundSlackChannelDbScope

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function parsePositiveSafeIntegerText(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number(value)
  return isPositiveSafeInteger(parsed) ? parsed : null
}

function isValidGithubRepoFullName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false
  }
  const slash = value.indexOf("/")
  return slash > 0 && slash === value.lastIndexOf("/") && slash < value.length - 1
}

/** The effective repo authority for one team:channel. The discriminant is
 *  load-bearing: only `unbound` and a healthy
 *  `absent` result may use the legacy env map. Once a binding row is observed,
 *  every workspace/repo installation must agree; corrupt data is authoritative
 *  denial rather than an excuse to switch authority sources. Query failures are
 *  also distinct from absence so a D1 outage cannot activate legacy scope. */
export async function getSlackChannelDbScope(
  env: StoreEnv,
  args: { teamId: string; channelId: string },
): Promise<SlackChannelDbScopeResult> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) return { kind: "unbound" }
  let binding: { installation_id_text: string; use_all_repos: number } | null
  try {
    binding = await db
      .prepare(
        "SELECT CAST(installation_id AS TEXT) AS installation_id_text, use_all_repos" +
          " FROM slack_channel_binding WHERE team_id = ? AND channel_id = ?",
      )
      .bind(args.teamId, args.channelId)
      .first<{ installation_id_text: string; use_all_repos: number }>()
  } catch {
    return { kind: "unavailable" }
  }
  if (!binding) return { kind: "absent" }
  const bindingInstallationId = parsePositiveSafeIntegerText(binding.installation_id_text)
  if (bindingInstallationId === null || ![0, 1].includes(binding.use_all_repos)) {
    return { kind: "invalid" }
  }

  try {
    const workspace = await db
      .prepare("SELECT CAST(installation_id AS TEXT) AS installation_id_text FROM slack_workspace WHERE team_id = ?")
      .bind(args.teamId)
      .first<{ installation_id_text: string }>()
    const workspaceInstallationId = parsePositiveSafeIntegerText(workspace?.installation_id_text)
    if (workspaceInstallationId === null || workspaceInstallationId !== bindingInstallationId) {
      return { kind: "invalid" }
    }
    const rows = await db
      .prepare(
        "SELECT CAST(installation_id AS TEXT) AS installation_id_text," +
          " CAST(github_repo_id AS TEXT) AS github_repo_id_text, github_repo_full_name FROM slack_channel_repo" +
          " WHERE team_id = ? AND channel_id = ? ORDER BY lower(github_repo_full_name)",
      )
      .bind(args.teamId, args.channelId)
      .all<{ installation_id_text: string; github_repo_id_text: string; github_repo_full_name: string }>()
    for (const row of rows.results) {
      const rowInstallationId = parsePositiveSafeIntegerText(row.installation_id_text)
      const githubRepoId = parsePositiveSafeIntegerText(row.github_repo_id_text)
      if (
        rowInstallationId !== bindingInstallationId ||
        githubRepoId === null ||
        !isValidGithubRepoFullName(row.github_repo_full_name)
      ) {
        return { kind: "invalid" }
      }
    }
    return {
      kind: "bound",
      installationId: bindingInstallationId,
      useAllRepos: binding.use_all_repos === 1,
      repos:
        binding.use_all_repos === 1
          ? []
          : rows.results.map((row) => {
              const githubRepoId = parsePositiveSafeIntegerText(row.github_repo_id_text)
              if (githubRepoId === null) throw new Error("validated repository id became invalid")
              return { githubRepoId, githubRepoFullName: row.github_repo_full_name }
            }),
    }
  } catch {
    return { kind: "unavailable" }
  }
}
