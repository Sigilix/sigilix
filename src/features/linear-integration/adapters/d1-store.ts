import type { LinearConfig, LinearConfigInput } from "@/src/features/linear-integration/domain/config"
import type {
  LinearConnection,
  LinearIntegrationSnapshot,
  LinearRepoRef,
  LinearTeamBinding,
} from "@/src/features/linear-integration/domain/types"
import type { Env } from "@/src/shared/types/env"

type DbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

interface ConnectionRow {
  installation_id: number
  linear_organization_id: string
  organization_name: string
  app_user_id: string
  status: string
  source: string
  granted_scopes_json: string
  can_access_all_public_teams: number
  installed_by_user_id: string
  installed_by_login: string
  installed_at: string
  updated_at: string
}

interface TeamRow {
  linear_organization_id: string
  team_id: string
  installation_id: number
  team_key: string
  team_name: string
  access_state: string
  selected: number
  github_repo_id: number
  github_repo_full_name: string
  use_all_repos: number
  synced_at: string
  updated_at: string
}

interface TeamRepoRow {
  team_id: string
  github_repo_id: number
  github_repo_full_name: string
}

interface ConfigRow {
  installation_id: number
  linear_organization_id: string
  revision: number
  context_mode: string
  scope_mode: string
  pr_validation_enabled: number
  create_issue_mode: string
  planning_enabled: number
  writeback_comments: number
  writeback_status: number
  writeback_labels: number
}

function db(env: DbEnv): D1Database {
  if (!env.SIGILIX_PLATFORM_DB) throw new Error("linear integration: SIGILIX_PLATFORM_DB binding absent")
  return env.SIGILIX_PLATFORM_DB
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

function toConnection(row: ConnectionRow): LinearConnection {
  return {
    installationId: Number(row.installation_id),
    organizationId: row.linear_organization_id,
    organizationName: row.organization_name,
    appUserId: row.app_user_id,
    status: row.status === "active" ? "active" : "revoked",
    source: row.source === "oauth" ? "oauth" : "legacy-migration",
    grantedScopes: parseScopes(row.granted_scopes_json),
    canAccessAllPublicTeams: Number(row.can_access_all_public_teams) === 1,
    installedByUserId: row.installed_by_user_id,
    installedByLogin: row.installed_by_login,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  }
}

function toTeam(row: TeamRow, repos: LinearRepoRef[] = []): LinearTeamBinding {
  return {
    organizationId: row.linear_organization_id,
    teamId: row.team_id,
    installationId: Number(row.installation_id),
    teamKey: row.team_key,
    teamName: row.team_name,
    accessState: row.access_state === "allowed" ? "allowed" : "revoked",
    selected: Number(row.selected) === 1,
    githubRepoId: Number(row.github_repo_id),
    githubRepoFullName: row.github_repo_full_name,
    useAllRepos: Number(row.use_all_repos) === 1,
    repos,
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
  }
}

const TEAM_COLUMNS =
  "linear_organization_id, team_id, installation_id, team_key, team_name, access_state," +
  " selected, github_repo_id, github_repo_full_name, use_all_repos, synced_at, updated_at"

const TEAM_COLUMNS_B =
  "b.linear_organization_id, b.team_id, b.installation_id, b.team_key, b.team_name," +
  " b.access_state, b.selected, b.github_repo_id, b.github_repo_full_name, b.use_all_repos," +
  " b.synced_at, b.updated_at"

/**
 * The explicit multi-repo selection for a team, always including the primary
 * `linear_team_binding.github_repo_id` (deduped) so a team backfilled with only
 * a legacy single binding still reports its repo. Ordered by repo id for
 * determinism. Does NOT expand `useAllRepos` — that expansion is repo-table
 * scoped and lives in `resolveLinearTeamEffectiveRepos`.
 */
async function loadTeamRepos(env: DbEnv, installationId: number): Promise<Map<string, LinearRepoRef[]>> {
  const result = await db(env)
    .prepare(
      "SELECT team_id, github_repo_id, github_repo_full_name FROM linear_team_repo" +
        " WHERE installation_id = ? ORDER BY team_id, github_repo_id",
    )
    .bind(installationId)
    .all<TeamRepoRow>()
  const byTeam = new Map<string, LinearRepoRef[]>()
  for (const row of result.results ?? []) {
    const id = Number(row.github_repo_id)
    if (!Number.isSafeInteger(id) || id <= 0 || typeof row.github_repo_full_name !== "string") continue
    const list = byTeam.get(row.team_id) ?? []
    list.push({ githubRepoId: id, githubRepoFullName: row.github_repo_full_name })
    byTeam.set(row.team_id, list)
  }
  return byTeam
}

/** Union a team's primary binding into its explicit repo set, deduped by id. */
function withPrimaryRepo(row: TeamRow, repos: LinearRepoRef[]): LinearRepoRef[] {
  const out = [...repos]
  const primaryId = Number(row.github_repo_id)
  if (Number.isSafeInteger(primaryId) && primaryId > 0 && !out.some((r) => r.githubRepoId === primaryId)) {
    out.push({ githubRepoId: primaryId, githubRepoFullName: row.github_repo_full_name })
  }
  return out
}

function toConfig(row: ConfigRow, selectedTeamIds: string[]): LinearConfig {
  return {
    revision: Number(row.revision),
    contextMode: row.context_mode === "enabled" || row.context_mode === "disabled" ? row.context_mode : "auto",
    scope: {
      mode: row.scope_mode === "explicit" ? "explicit" : "auto",
      teamIds: row.scope_mode === "explicit" ? selectedTeamIds : [],
    },
    prValidation: Number(row.pr_validation_enabled) === 1,
    createIssue:
      row.create_issue_mode === "disabled" || row.create_issue_mode === "auto" ? row.create_issue_mode : "manual",
    planning: Number(row.planning_enabled) === 1,
    writeback: {
      comments: Number(row.writeback_comments) === 1,
      status: Number(row.writeback_status) === 1,
      labels: Number(row.writeback_labels) === 1,
    },
  }
}

const CONNECTION_COLUMNS =
  "installation_id, linear_organization_id, organization_name, app_user_id, status, source," +
  " granted_scopes_json, can_access_all_public_teams, installed_by_user_id, installed_by_login," +
  " installed_at, updated_at"

export async function getLinearConnectionByInstallation(
  env: DbEnv,
  installationId: number,
): Promise<LinearConnection | null> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return null
  const row = await db(env)
    .prepare(`SELECT ${CONNECTION_COLUMNS} FROM linear_connection WHERE installation_id = ?`)
    .bind(installationId)
    .first<ConnectionRow>()
  return row ? toConnection(row) : null
}

export async function getLinearConnectionByOrganization(
  env: DbEnv,
  organizationId: string,
): Promise<LinearConnection | null> {
  if (!organizationId) return null
  const row = await db(env)
    .prepare(`SELECT ${CONNECTION_COLUMNS} FROM linear_connection WHERE linear_organization_id = ?`)
    .bind(organizationId)
    .first<ConnectionRow>()
  return row ? toConnection(row) : null
}

async function listTeams(env: DbEnv, installationId: number): Promise<LinearTeamBinding[]> {
  const [result, reposByTeam] = await Promise.all([
    db(env)
      .prepare(
        `SELECT ${TEAM_COLUMNS} FROM linear_team_binding` +
          " WHERE installation_id = ? ORDER BY lower(team_name), team_id",
      )
      .bind(installationId)
      .all<TeamRow>(),
    loadTeamRepos(env, installationId),
  ])
  return (result.results ?? []).map((row) => toTeam(row, withPrimaryRepo(row, reposByTeam.get(row.team_id) ?? [])))
}

export async function getLinearConfig(env: DbEnv, installationId: number): Promise<LinearConfig | null> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return null
  const row = await db(env)
    .prepare(
      "SELECT installation_id, linear_organization_id, revision, context_mode, scope_mode," +
        " pr_validation_enabled, create_issue_mode, planning_enabled, writeback_comments," +
        " writeback_status, writeback_labels FROM linear_config WHERE installation_id = ?",
    )
    .bind(installationId)
    .first<ConfigRow>()
  if (!row) return null
  const selected = await db(env)
    .prepare(
      "SELECT team_id FROM linear_team_binding" +
        " WHERE installation_id = ? AND selected = 1 AND access_state = 'allowed' ORDER BY team_id",
    )
    .bind(installationId)
    .all<{ team_id: string }>()
  return toConfig(
    row,
    (selected.results ?? []).map((team) => team.team_id),
  )
}

export async function getLinearIntegrationSnapshot(
  env: DbEnv,
  installationId: number,
): Promise<LinearIntegrationSnapshot> {
  const connection = await getLinearConnectionByInstallation(env, installationId)
  if (!connection) return { connection: null, teams: [], config: null }
  const [teams, config] = await Promise.all([listTeams(env, installationId), getLinearConfig(env, installationId)])
  return { connection, teams, config }
}

export interface ConnectLinearOrganizationInput {
  installationId: number
  organizationId: string
  organizationName: string
  appUserId: string
  source: "oauth" | "legacy-migration"
  grantedScopes: string[]
  canAccessAllPublicTeams: boolean
  installedByUserId: string
  installedByLogin: string
  teams: Array<{
    id: string
    key: string
    name: string
    githubRepoId: number
    githubRepoFullName: string
  }>
  nowIso: string
}

export interface LinearInstallationRepo {
  id: number
  fullName: string
}

export async function listLinearInstallationRepos(
  env: DbEnv,
  installationId: number,
): Promise<LinearInstallationRepo[]> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return []
  const result = await db(env)
    .prepare("SELECT repo_id, full_name FROM repo WHERE installation_id = ? ORDER BY lower(full_name), repo_id")
    .bind(installationId)
    .all<{ repo_id: number; full_name: string }>()
  return (result.results ?? []).flatMap((row) =>
    Number.isSafeInteger(Number(row.repo_id)) && Number(row.repo_id) > 0 && typeof row.full_name === "string"
      ? [{ id: Number(row.repo_id), fullName: row.full_name }]
      : [],
  )
}

export type ConnectLinearOrganizationResult =
  | { ok: true }
  | { ok: false; reason: "installation-conflict" | "organization-conflict" | "app-user-conflict" }

/** Reserve one immutable Linear-org ↔ GitHub-installation boundary and refresh its team snapshot. */
export async function connectLinearOrganization(
  env: DbEnv,
  input: ConnectLinearOrganizationInput,
): Promise<ConnectLinearOrganizationResult> {
  const store = db(env)
  const [byInstallation, byOrganization] = await Promise.all([
    getLinearConnectionByInstallation(env, input.installationId),
    getLinearConnectionByOrganization(env, input.organizationId),
  ])
  if (byInstallation && byInstallation.organizationId !== input.organizationId) {
    return { ok: false, reason: "installation-conflict" }
  }
  if (byOrganization && byOrganization.installationId !== input.installationId) {
    return { ok: false, reason: "organization-conflict" }
  }
  const appUser = await store
    .prepare("SELECT installation_id FROM linear_connection WHERE app_user_id = ?")
    .bind(input.appUserId)
    .first<{ installation_id: number }>()
  if (appUser && Number(appUser.installation_id) !== input.installationId) {
    return { ok: false, reason: "app-user-conflict" }
  }

  const statements: D1PreparedStatement[] = [
    store
      .prepare(
        "INSERT INTO linear_connection" +
          " (installation_id, linear_organization_id, organization_name, app_user_id, status, source," +
          " granted_scopes_json, can_access_all_public_teams, installed_by_user_id, installed_by_login," +
          " installed_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(installation_id) DO UPDATE SET" +
          " organization_name = excluded.organization_name, app_user_id = excluded.app_user_id," +
          " status = 'active', source = excluded.source, granted_scopes_json = excluded.granted_scopes_json," +
          " can_access_all_public_teams = excluded.can_access_all_public_teams," +
          " installed_by_user_id = excluded.installed_by_user_id," +
          " installed_by_login = excluded.installed_by_login, updated_at = excluded.updated_at" +
          " WHERE linear_connection.linear_organization_id = excluded.linear_organization_id",
      )
      .bind(
        input.installationId,
        input.organizationId,
        input.organizationName,
        input.appUserId,
        input.source,
        JSON.stringify([...new Set(input.grantedScopes)].sort()),
        input.canAccessAllPublicTeams ? 1 : 0,
        input.installedByUserId,
        input.installedByLogin,
        input.nowIso,
        input.nowIso,
      ),
    store
      .prepare(
        "INSERT INTO linear_config" +
          " (installation_id, linear_organization_id, revision, context_mode, scope_mode," +
          " pr_validation_enabled, create_issue_mode, planning_enabled, writeback_comments," +
          " writeback_status, writeback_labels, updated_by, updated_at, update_token)" +
          " SELECT ?, ?, 1, 'auto', 'auto', 0, 'manual', 1, 1, 0, 1, ?, ?, ?" +
          " WHERE EXISTS (SELECT 1 FROM linear_connection c" +
          " WHERE c.installation_id = ? AND c.linear_organization_id = ? AND c.status = 'active')" +
          " ON CONFLICT(installation_id) DO NOTHING",
      )
      .bind(
        input.installationId,
        input.organizationId,
        input.installedByLogin,
        input.nowIso,
        crypto.randomUUID(),
        input.installationId,
        input.organizationId,
      ),
    store
      .prepare(
        "UPDATE linear_team_binding SET access_state = 'revoked', selected = 0, synced_at = ?, updated_at = ?" +
          " WHERE installation_id = ?" +
          " AND EXISTS (SELECT 1 FROM linear_connection c" +
          " WHERE c.installation_id = ? AND c.linear_organization_id = ? AND c.status = 'active')",
      )
      .bind(input.nowIso, input.nowIso, input.installationId, input.installationId, input.organizationId),
  ]
  for (const team of input.teams) {
    statements.push(
      store
        .prepare(
          "INSERT INTO linear_team_binding" +
            " (linear_organization_id, team_id, installation_id, team_key, team_name, access_state," +
            " selected, github_repo_id, github_repo_full_name, synced_at, updated_at)" +
            " SELECT ?, ?, ?, ?, ?, 'allowed', 0, ?, ?, ?, ?" +
            " WHERE EXISTS (SELECT 1 FROM linear_connection c" +
            " WHERE c.installation_id = ? AND c.linear_organization_id = ? AND c.status = 'active')" +
            " ON CONFLICT(linear_organization_id, team_id) DO UPDATE SET" +
            " team_key = excluded.team_key, team_name = excluded.team_name, access_state = 'allowed'," +
            " github_repo_id = CASE WHEN linear_team_binding.github_repo_id > 0" +
            "   THEN linear_team_binding.github_repo_id ELSE excluded.github_repo_id END," +
            " github_repo_full_name = CASE WHEN linear_team_binding.github_repo_id > 0" +
            "   THEN linear_team_binding.github_repo_full_name ELSE excluded.github_repo_full_name END," +
            " synced_at = excluded.synced_at, updated_at = excluded.updated_at",
        )
        .bind(
          input.organizationId,
          team.id,
          input.installationId,
          team.key,
          team.name,
          team.githubRepoId,
          team.githubRepoFullName,
          input.nowIso,
          input.nowIso,
          input.installationId,
          input.organizationId,
        ),
    )
  }
  const results = await store.batch(statements)
  const connectionChanges = Number((results[0]?.meta as { changes?: unknown } | undefined)?.changes ?? 0)
  if (connectionChanges !== 1) return { ok: false, reason: "installation-conflict" }
  return { ok: true }
}

/** The explicit repo set for one team (primary unioned in), for a resolved binding. */
async function loadTeamReposFor(
  env: DbEnv,
  installationId: number,
  organizationId: string,
  teamId: string,
): Promise<LinearRepoRef[]> {
  const result = await db(env)
    .prepare(
      "SELECT team_id, github_repo_id, github_repo_full_name FROM linear_team_repo" +
        " WHERE installation_id = ? AND linear_organization_id = ? AND team_id = ? ORDER BY github_repo_id",
    )
    .bind(installationId, organizationId, teamId)
    .all<TeamRepoRow>()
  const out: LinearRepoRef[] = []
  for (const row of result.results ?? []) {
    const id = Number(row.github_repo_id)
    if (Number.isSafeInteger(id) && id > 0 && typeof row.github_repo_full_name === "string") {
      out.push({ githubRepoId: id, githubRepoFullName: row.github_repo_full_name })
    }
  }
  return out
}

export async function resolveLinearTeamBinding(
  env: DbEnv,
  organizationId: string,
  teamId: string,
): Promise<LinearTeamBinding | null> {
  const row = await db(env)
    .prepare(
      `SELECT ${TEAM_COLUMNS_B}` +
        " FROM linear_team_binding b JOIN linear_connection c" +
        " ON c.installation_id = b.installation_id AND c.linear_organization_id = b.linear_organization_id" +
        " WHERE b.linear_organization_id = ? AND b.team_id = ?" +
        " AND b.access_state = 'allowed' AND c.status = 'active'",
    )
    .bind(organizationId, teamId)
    .first<TeamRow>()
  if (!row) return null
  const repos = await loadTeamReposFor(env, Number(row.installation_id), row.linear_organization_id, row.team_id)
  return toTeam(row, withPrimaryRepo(row, repos))
}

export async function resolveLinearTeamBindingForRepo(
  env: DbEnv,
  installationId: number,
  repoFullName: string,
): Promise<LinearTeamBinding | null> {
  const normalizedRepo = repoFullName.trim()
  if (normalizedRepo.length > 256 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepo)) return null
  const row = await db(env)
    .prepare(
      `SELECT ${TEAM_COLUMNS_B}` +
        " FROM linear_team_binding b JOIN linear_connection c" +
        " ON c.installation_id = b.installation_id AND c.linear_organization_id = b.linear_organization_id" +
        " WHERE b.installation_id = ? AND (" +
        " lower(b.github_repo_full_name) = lower(?)" +
        " OR EXISTS (SELECT 1 FROM linear_team_repo tr" +
        "   WHERE tr.installation_id = b.installation_id" +
        "   AND tr.linear_organization_id = b.linear_organization_id" +
        "   AND tr.team_id = b.team_id" +
        "   AND lower(tr.github_repo_full_name) = lower(?))" +
        " OR (b.use_all_repos = 1 AND EXISTS (SELECT 1 FROM repo r" +
        "   WHERE r.installation_id = b.installation_id" +
        "   AND lower(r.full_name) = lower(?)))" +
        ")" +
        " AND b.access_state = 'allowed' AND c.status = 'active'" +
        " ORDER BY b.selected DESC, lower(b.team_name), b.team_id LIMIT 1",
    )
    .bind(installationId, normalizedRepo, normalizedRepo, normalizedRepo)
    .first<TeamRow>()
  if (!row) return null
  const repos = await loadTeamReposFor(env, Number(row.installation_id), row.linear_organization_id, row.team_id)
  return toTeam(row, withPrimaryRepo(row, repos))
}

/**
 * Resolve the EFFECTIVE GitHub repo set a Linear team grounds triage in.
 * `useAllRepos` expands to every repo registered under the installation (the
 * `repo` table); otherwise it is the team's explicit `repos` selection. Result
 * is deduped by repo id and ordered so the team's designated PRIMARY repo
 * (`binding.githubRepoId`) leads — triage weights the first namespace highest —
 * with the remainder sorted by full name for determinism. `useAllRepos` has no
 * designated primary (id 0), so it is purely alphabetical. Empty ⇒ the team has
 * no accessible repo and triage must fail closed.
 */
export async function resolveLinearTeamEffectiveRepos(
  env: DbEnv,
  binding: LinearTeamBinding,
): Promise<LinearRepoRef[]> {
  const source = binding.useAllRepos
    ? await listLinearInstallationRepos(env, binding.installationId).then((repos) =>
        repos.map((r) => ({ githubRepoId: r.id, githubRepoFullName: r.fullName })),
      )
    : binding.repos
  const byId = new Map<number, LinearRepoRef>()
  for (const repo of source) {
    if (Number.isSafeInteger(repo.githubRepoId) && repo.githubRepoId > 0 && repo.githubRepoFullName) {
      byId.set(repo.githubRepoId, repo)
    }
  }
  const primaryId = binding.githubRepoId
  return [...byId.values()].sort((a, b) => {
    const rankA = a.githubRepoId === primaryId ? 0 : 1
    const rankB = b.githubRepoId === primaryId ? 0 : 1
    return rankA - rankB || a.githubRepoFullName.localeCompare(b.githubRepoFullName)
  })
}

export type LinearConfigUpdateResult =
  | { ok: true; config: LinearConfig }
  | { ok: false; reason: "not-connected" | "stale-revision" | "team-not-allowed" | "binding-invalid" }

export interface LinearTeamRepoBinding {
  teamId: string
  /** Explicit repo selection (ignored when `useAllRepos` is true). */
  repos: LinearRepoRef[]
  /** Ground triage in EVERY repo in the installation instead of an explicit set. */
  useAllRepos: boolean
}

/** A team's PRIMARY repo (back-compat column): the first explicit repo, or a
 * null primary when the team is bound via `useAllRepos`. */
function primaryRepoOf(binding: LinearTeamRepoBinding): LinearRepoRef {
  if (binding.useAllRepos || binding.repos.length === 0) return { githubRepoId: 0, githubRepoFullName: "" }
  return binding.repos[0]!
}

function bindingsInvalid(bindings: LinearTeamRepoBinding[], allowedTeamIds: string[]): boolean {
  const bindingTeamIds = new Set(bindings.map((binding) => binding.teamId))
  if (bindingTeamIds.size !== bindings.length) return true
  if (allowedTeamIds.some((teamId) => !bindingTeamIds.has(teamId))) return true
  return bindings.some((binding) => {
    if (!allowedTeamIds.includes(binding.teamId)) return true
    const repoIds = binding.repos.map((repo) => repo.githubRepoId)
    const repoInvalid = binding.repos.some(
      (repo) => !Number.isSafeInteger(repo.githubRepoId) || repo.githubRepoId <= 0 || !repo.githubRepoFullName,
    )
    if (repoInvalid || new Set(repoIds).size !== repoIds.length) return true
    // A non-"all repos" team must bind at least one explicit repo; "all repos"
    // ignores the explicit set entirely.
    return !binding.useAllRepos && binding.repos.length === 0
  })
}

export async function updateLinearConfig(
  env: DbEnv,
  args: {
    installationId: number
    input: LinearConfigInput
    bindings: LinearTeamRepoBinding[]
    updatedBy: string
    nowIso: string
  },
): Promise<LinearConfigUpdateResult> {
  const snapshot = await getLinearIntegrationSnapshot(env, args.installationId)
  if (!snapshot.connection || snapshot.connection.status !== "active" || !snapshot.config) {
    return { ok: false, reason: "not-connected" }
  }
  const byId = new Map(snapshot.teams.map((team) => [team.teamId, team]))
  for (const teamId of args.input.scope.teamIds) {
    const team = byId.get(teamId)
    if (!team || team.accessState !== "allowed") {
      return { ok: false, reason: "team-not-allowed" }
    }
  }
  const allowedTeamIds = snapshot.teams.filter((team) => team.accessState === "allowed").map((team) => team.teamId)
  if (bindingsInvalid(args.bindings, allowedTeamIds)) {
    return { ok: false, reason: "binding-invalid" }
  }

  const organizationId = snapshot.connection.organizationId
  const updateToken = crypto.randomUUID()
  const store = db(env)
  const placeholders = args.input.scope.teamIds.map(() => "?").join(",")
  const selectedExpr =
    args.input.scope.mode === "explicit" ? `CASE WHEN team_id IN (${placeholders}) THEN 1 ELSE 0 END` : "0"
  const selectedBinds = args.input.scope.mode === "explicit" ? args.input.scope.teamIds : []
  const bindingTeamPlaceholders = args.bindings.map(() => "?").join(",")
  // Every explicit repo id across all bindings must exist under the installation
  // (`useAllRepos` teams contribute none — their set expands from `repo` at read
  // time). Validated atomically so a repo revoked between snapshot and write
  // fails the update rather than persisting a dangling binding.
  const uniqueRepoIds = [...new Set(args.bindings.flatMap((binding) => binding.repos.map((repo) => repo.githubRepoId)))]
  const repoPlaceholders = uniqueRepoIds.map(() => "?").join(",")
  const repoGuard =
    uniqueRepoIds.length > 0
      ? ` AND (SELECT COUNT(*) FROM repo r WHERE r.installation_id = ?` + ` AND r.repo_id IN (${repoPlaceholders})) = ?`
      : ""
  const atomicGuards =
    args.bindings.length === 0
      ? " AND NOT EXISTS (SELECT 1 FROM linear_team_binding b WHERE b.installation_id = ? AND b.access_state = 'allowed')"
      : ` AND (SELECT COUNT(*) FROM linear_team_binding b WHERE b.installation_id = ?` +
        ` AND b.linear_organization_id = ? AND b.access_state = 'allowed'` +
        ` AND b.team_id IN (${bindingTeamPlaceholders})) = ?` +
        ` AND (SELECT COUNT(*) FROM linear_team_binding b2 WHERE b2.installation_id = ?` +
        ` AND b2.linear_organization_id = ? AND b2.access_state = 'allowed') = ?` +
        repoGuard
  const atomicGuardBinds: unknown[] =
    args.bindings.length === 0
      ? [args.installationId]
      : [
          args.installationId,
          organizationId,
          ...args.bindings.map((binding) => binding.teamId),
          args.bindings.length,
          args.installationId,
          organizationId,
          args.bindings.length,
          ...(uniqueRepoIds.length > 0 ? [args.installationId, ...uniqueRepoIds, uniqueRepoIds.length] : []),
        ]
  const statements: D1PreparedStatement[] = [
    store
      .prepare(
        "UPDATE linear_config SET revision = revision + 1, context_mode = ?, scope_mode = ?," +
          " pr_validation_enabled = ?, create_issue_mode = ?, planning_enabled = ?," +
          " writeback_comments = ?, writeback_status = ?, writeback_labels = ?," +
          " updated_by = ?, updated_at = ?, update_token = ?" +
          " WHERE installation_id = ? AND linear_organization_id = ? AND revision = ?" +
          atomicGuards,
      )
      .bind(
        args.input.contextMode,
        args.input.scope.mode,
        args.input.prValidation ? 1 : 0,
        args.input.createIssue,
        args.input.planning ? 1 : 0,
        args.input.writeback.comments ? 1 : 0,
        args.input.writeback.status ? 1 : 0,
        args.input.writeback.labels ? 1 : 0,
        args.updatedBy,
        args.nowIso,
        updateToken,
        args.installationId,
        organizationId,
        args.input.revision,
        ...atomicGuardBinds,
      ),
    store
      .prepare(
        `UPDATE linear_team_binding SET selected = ${selectedExpr}, updated_at = ?` +
          " WHERE installation_id = ? AND access_state = 'allowed'" +
          " AND EXISTS (SELECT 1 FROM linear_config c WHERE c.installation_id = ? AND c.update_token = ?)",
      )
      .bind(...selectedBinds, args.nowIso, args.installationId, args.installationId, updateToken),
  ]
  // Every team-scoped write is gated on the freshly-written `update_token`, so a
  // lost revision race (config UPDATE affects 0 rows) leaves the binding/join
  // rows untouched too — the whole change is atomic, not just the config row.
  for (const binding of args.bindings) {
    const primary = primaryRepoOf(binding)
    statements.push(
      store
        .prepare(
          "UPDATE linear_team_binding SET github_repo_id = ?, github_repo_full_name = ?," +
            " use_all_repos = ?, updated_at = ?" +
            " WHERE installation_id = ? AND linear_organization_id = ? AND team_id = ?" +
            " AND access_state = 'allowed'" +
            " AND EXISTS (SELECT 1 FROM linear_config c WHERE c.installation_id = ? AND c.update_token = ?)",
        )
        .bind(
          primary.githubRepoId,
          primary.githubRepoFullName,
          binding.useAllRepos ? 1 : 0,
          args.nowIso,
          args.installationId,
          organizationId,
          binding.teamId,
          args.installationId,
          updateToken,
        ),
      // Replace the team's explicit repo set: delete then re-insert, both gated
      // on the update token so the set is only rewritten when the config commit won.
      store
        .prepare(
          "DELETE FROM linear_team_repo" +
            " WHERE installation_id = ? AND linear_organization_id = ? AND team_id = ?" +
            " AND EXISTS (SELECT 1 FROM linear_config c WHERE c.installation_id = ? AND c.update_token = ?)",
        )
        .bind(args.installationId, organizationId, binding.teamId, args.installationId, updateToken),
    )
    // `useAllRepos` teams keep NO explicit rows — their effective set expands
    // from the `repo` table at read time, so any passed `repos` are ignored here
    // for consistency with the documented contract (the DELETE above cleared them).
    const reposToWrite = binding.useAllRepos ? [] : binding.repos
    for (const repo of reposToWrite) {
      statements.push(
        store
          .prepare(
            "INSERT INTO linear_team_repo" +
              " (linear_organization_id, team_id, installation_id, github_repo_id," +
              " github_repo_full_name, synced_at, updated_at)" +
              " SELECT ?, ?, ?, ?, ?, ?, ?" +
              " WHERE EXISTS (SELECT 1 FROM linear_config c WHERE c.installation_id = ? AND c.update_token = ?)" +
              " ON CONFLICT(linear_organization_id, team_id, github_repo_id) DO UPDATE SET" +
              " github_repo_full_name = excluded.github_repo_full_name," +
              " synced_at = excluded.synced_at, updated_at = excluded.updated_at",
          )
          .bind(
            organizationId,
            binding.teamId,
            args.installationId,
            repo.githubRepoId,
            repo.githubRepoFullName,
            args.nowIso,
            args.nowIso,
            args.installationId,
            updateToken,
          ),
      )
    }
  }
  const results = await store.batch(statements)
  const changes = Number((results[0]?.meta as { changes?: unknown } | undefined)?.changes ?? 0)
  if (changes !== 1) return { ok: false, reason: "stale-revision" }
  const config = await getLinearConfig(env, args.installationId)
  if (!config) return { ok: false, reason: "not-connected" }
  return { ok: true, config }
}

export type LinearDeliveryClaim = "acquired" | "duplicate"

export async function claimLinearDelivery(
  env: DbEnv,
  args: { deliveryId: string; organizationId: string; eventType: string; nowMs: number; leaseMs?: number },
): Promise<LinearDeliveryClaim> {
  const nowIso = new Date(args.nowMs).toISOString()
  const leaseUntil = args.nowMs + (args.leaseMs ?? 30_000)
  const result = await db(env)
    .prepare(
      "INSERT INTO linear_delivery_lease" +
        " (delivery_id, linear_organization_id, event_type, status, lease_until_ms, attempts," +
        " received_at, enqueued_at, updated_at) VALUES (?, ?, ?, 'leased', ?, 1, ?, NULL, ?)" +
        " ON CONFLICT(delivery_id) DO UPDATE SET" +
        " status = 'leased', lease_until_ms = excluded.lease_until_ms," +
        " attempts = linear_delivery_lease.attempts + 1, updated_at = excluded.updated_at" +
        " WHERE linear_delivery_lease.linear_organization_id = excluded.linear_organization_id" +
        " AND linear_delivery_lease.status = 'leased'" +
        " AND linear_delivery_lease.lease_until_ms < ?",
    )
    .bind(args.deliveryId, args.organizationId, args.eventType, leaseUntil, nowIso, nowIso, args.nowMs)
    .run()
  return Number((result.meta as { changes?: unknown }).changes ?? 0) === 1 ? "acquired" : "duplicate"
}

export async function completeLinearDelivery(
  env: DbEnv,
  args: { deliveryId: string; organizationId: string; nowMs: number },
): Promise<void> {
  const nowIso = new Date(args.nowMs).toISOString()
  await db(env)
    .prepare(
      "UPDATE linear_delivery_lease SET status = 'enqueued', enqueued_at = ?, updated_at = ?" +
        " WHERE delivery_id = ? AND linear_organization_id = ? AND status = 'leased'",
    )
    .bind(nowIso, nowIso, args.deliveryId, args.organizationId)
    .run()
}

export async function releaseLinearDelivery(
  env: DbEnv,
  args: { deliveryId: string; organizationId: string; nowMs: number },
): Promise<void> {
  await db(env)
    .prepare(
      "UPDATE linear_delivery_lease SET lease_until_ms = 0, updated_at = ?" +
        " WHERE delivery_id = ? AND linear_organization_id = ? AND status = 'leased'",
    )
    .bind(new Date(args.nowMs).toISOString(), args.deliveryId, args.organizationId)
    .run()
}
