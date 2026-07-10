import type { LinearConfig, LinearConfigInput } from "@/src/features/linear-integration/domain/config"
import type {
  LinearConnection,
  LinearIntegrationSnapshot,
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
  synced_at: string
  updated_at: string
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

function toTeam(row: TeamRow): LinearTeamBinding {
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
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
  }
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
  const result = await db(env)
    .prepare(
      "SELECT linear_organization_id, team_id, installation_id, team_key, team_name, access_state," +
        " selected, github_repo_id, github_repo_full_name, synced_at, updated_at" +
        " FROM linear_team_binding WHERE installation_id = ? ORDER BY lower(team_name), team_id",
    )
    .bind(installationId)
    .all<TeamRow>()
  return (result.results ?? []).map(toTeam)
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
          " VALUES (?, ?, 1, 'auto', 'auto', 0, 'manual', 1, 1, 0, 1, ?, ?, ?)" +
          " ON CONFLICT(installation_id) DO NOTHING",
      )
      .bind(input.installationId, input.organizationId, input.installedByLogin, input.nowIso, crypto.randomUUID()),
    store
      .prepare(
        "UPDATE linear_team_binding SET access_state = 'revoked', selected = 0, synced_at = ?, updated_at = ?" +
          " WHERE installation_id = ?",
      )
      .bind(input.nowIso, input.nowIso, input.installationId),
  ]
  for (const team of input.teams) {
    statements.push(
      store
        .prepare(
          "INSERT INTO linear_team_binding" +
            " (linear_organization_id, team_id, installation_id, team_key, team_name, access_state," +
            " selected, github_repo_id, github_repo_full_name, synced_at, updated_at)" +
            " VALUES (?, ?, ?, ?, ?, 'allowed', 0, ?, ?, ?, ?)" +
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
        ),
    )
  }
  await store.batch(statements)
  return { ok: true }
}

export async function resolveLinearTeamBinding(
  env: DbEnv,
  organizationId: string,
  teamId: string,
): Promise<LinearTeamBinding | null> {
  const row = await db(env)
    .prepare(
      "SELECT b.linear_organization_id, b.team_id, b.installation_id, b.team_key, b.team_name," +
        " b.access_state, b.selected, b.github_repo_id, b.github_repo_full_name, b.synced_at, b.updated_at" +
        " FROM linear_team_binding b JOIN linear_connection c" +
        " ON c.installation_id = b.installation_id AND c.linear_organization_id = b.linear_organization_id" +
        " WHERE b.linear_organization_id = ? AND b.team_id = ? AND c.status = 'active'",
    )
    .bind(organizationId, teamId)
    .first<TeamRow>()
  return row ? toTeam(row) : null
}

export async function resolveLinearTeamBindingForRepo(
  env: DbEnv,
  installationId: number,
  repoFullName: string,
): Promise<LinearTeamBinding | null> {
  const row = await db(env)
    .prepare(
      "SELECT b.linear_organization_id, b.team_id, b.installation_id, b.team_key, b.team_name," +
        " b.access_state, b.selected, b.github_repo_id, b.github_repo_full_name, b.synced_at, b.updated_at" +
        " FROM linear_team_binding b JOIN linear_connection c" +
        " ON c.installation_id = b.installation_id AND c.linear_organization_id = b.linear_organization_id" +
        " WHERE b.installation_id = ? AND lower(b.github_repo_full_name) = lower(?)" +
        " AND b.access_state = 'allowed' AND c.status = 'active'" +
        " ORDER BY b.selected DESC, lower(b.team_name), b.team_id LIMIT 1",
    )
    .bind(installationId, repoFullName)
    .first<TeamRow>()
  return row ? toTeam(row) : null
}

export type LinearConfigUpdateResult =
  | { ok: true; config: LinearConfig }
  | { ok: false; reason: "not-connected" | "stale-revision" | "team-not-allowed" | "binding-invalid" }

export async function updateLinearConfig(
  env: DbEnv,
  args: {
    installationId: number
    input: LinearConfigInput
    bindings: Array<{ teamId: string; githubRepoId: number; githubRepoFullName: string }>
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
  const bindingTeamIds = new Set(args.bindings.map((binding) => binding.teamId))
  if (
    bindingTeamIds.size !== args.bindings.length ||
    args.bindings.some(
      (binding) =>
        !allowedTeamIds.includes(binding.teamId) ||
        !Number.isSafeInteger(binding.githubRepoId) ||
        binding.githubRepoId <= 0 ||
        !binding.githubRepoFullName,
    ) ||
    allowedTeamIds.some((teamId) => !bindingTeamIds.has(teamId))
  ) {
    return { ok: false, reason: "binding-invalid" }
  }

  const updateToken = crypto.randomUUID()
  const store = db(env)
  const placeholders = args.input.scope.teamIds.map(() => "?").join(",")
  const selectedExpr =
    args.input.scope.mode === "explicit" ? `CASE WHEN team_id IN (${placeholders}) THEN 1 ELSE 0 END` : "0"
  const selectedBinds = args.input.scope.mode === "explicit" ? args.input.scope.teamIds : []
  const bindingTeamPlaceholders = args.bindings.map(() => "?").join(",")
  const uniqueRepoIds = [...new Set(args.bindings.map((binding) => binding.githubRepoId))]
  const repoPlaceholders = uniqueRepoIds.map(() => "?").join(",")
  const atomicGuards =
    args.bindings.length === 0
      ? " AND NOT EXISTS (SELECT 1 FROM linear_team_binding b WHERE b.installation_id = ? AND b.access_state = 'allowed')"
      : ` AND (SELECT COUNT(*) FROM linear_team_binding b WHERE b.installation_id = ?` +
        ` AND b.linear_organization_id = ? AND b.access_state = 'allowed'` +
        ` AND b.team_id IN (${bindingTeamPlaceholders})) = ?` +
        ` AND (SELECT COUNT(*) FROM linear_team_binding b2 WHERE b2.installation_id = ?` +
        ` AND b2.linear_organization_id = ? AND b2.access_state = 'allowed') = ?` +
        ` AND (SELECT COUNT(*) FROM repo r WHERE r.installation_id = ?` +
        ` AND r.repo_id IN (${repoPlaceholders})) = ?`
  const atomicGuardBinds: unknown[] =
    args.bindings.length === 0
      ? [args.installationId]
      : [
          args.installationId,
          snapshot.connection.organizationId,
          ...args.bindings.map((binding) => binding.teamId),
          args.bindings.length,
          args.installationId,
          snapshot.connection.organizationId,
          args.bindings.length,
          args.installationId,
          ...uniqueRepoIds,
          uniqueRepoIds.length,
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
        snapshot.connection.organizationId,
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
  for (const binding of args.bindings) {
    statements.push(
      store
        .prepare(
          "UPDATE linear_team_binding SET github_repo_id = ?, github_repo_full_name = ?, updated_at = ?" +
            " WHERE installation_id = ? AND linear_organization_id = ? AND team_id = ?" +
            " AND access_state = 'allowed'" +
            " AND EXISTS (SELECT 1 FROM linear_config c WHERE c.installation_id = ? AND c.update_token = ?)",
        )
        .bind(
          binding.githubRepoId,
          binding.githubRepoFullName,
          args.nowIso,
          args.installationId,
          snapshot.connection.organizationId,
          binding.teamId,
          args.installationId,
          updateToken,
        ),
    )
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
