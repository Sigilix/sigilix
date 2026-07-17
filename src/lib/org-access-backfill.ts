import {
  backfillOrgWorkspaceAccess,
  isOrgWorkspaceGithubUserId,
  listOrgWorkspaceAccess,
  type OrgWorkspaceAccess,
} from "@/src/features/org-membership"
import { createCompleteInstallationRosterSnapshot, fetchInstallationRoster } from "@/src/lib/org-members-roster"
import { getAppInstallation, getExactOrgMembershipRole } from "@/src/shared/adapters/github/github-app"
import type { Env } from "@/src/shared/types/env"

const MAX_LINKED_IDENTITIES = 100

interface LinkedIdentityRow {
  github_user_id: unknown
}

export interface OrgAccessBackfillReport {
  installationId: number
  applied: boolean
  ready: boolean
  canApply: boolean
  counts: {
    linked: number
    currentLinked: number
    staleLinked: number
    coveredCurrentLinked: number
    activeCurrentLinked: number
    revokedCurrentLinked: number
    reachableAdmins: number
    liveAdminCandidates: number
  }
  actions: { bootstrapAdmin: boolean; seedMembers: number }
  bootstrapSelection: "existing_reachable_admin" | "lowest_live_admin_id" | "unavailable"
}

export class OrgAccessBackfillError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message)
  }
}

export async function runOrgAccessBackfill(
  env: Env,
  args: { installationId: number; apply: boolean },
): Promise<OrgAccessBackfillReport> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db || !env.OPENCLAW_STATE || !env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new OrgAccessBackfillError("org_access_unavailable", 503)
  }
  const tenant = await db
    .prepare("SELECT installation_id FROM tenant WHERE installation_id = ?")
    .bind(args.installationId)
    .first<{ installation_id: unknown }>()
  if (tenant === null) throw new OrgAccessBackfillError("installation_not_found", 404)
  if (tenant.installation_id !== args.installationId) throw new Error("malformed tenant installation")

  const installation = await getAppInstallation(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, args.installationId)
  if (installation === null) throw new OrgAccessBackfillError("installation_not_found", 404)
  const roster = await fetchInstallationRoster(
    env,
    args.installationId,
    installation.accountLogin,
    installation.accountType,
  )
  const expectedSource = installation.accountType === "Organization" ? "org" : "collaborators"
  const rosterSnapshot = createCompleteInstallationRosterSnapshot(roster)
  if (rosterSnapshot === null || roster.source !== expectedSource) {
    throw new OrgAccessBackfillError("org_roster_unavailable", 503)
  }

  const { results } = await db
    .prepare(
      "SELECT github_user_id FROM account_tenant WHERE installation_id = ?" +
        " ORDER BY length(github_user_id), github_user_id LIMIT ?",
    )
    .bind(args.installationId, MAX_LINKED_IDENTITIES + 1)
    .all<LinkedIdentityRow>()
  if (results.length > MAX_LINKED_IDENTITIES) {
    throw new OrgAccessBackfillError("linked_identity_limit_exceeded", 409)
  }
  const linkedIds = results.map((row) => {
    if (!isOrgWorkspaceGithubUserId(row.github_user_id)) throw new Error("malformed linked GitHub identity")
    return row.github_user_id
  })
  const rosterById = new Map(roster.members.map((member) => [member.githubUserId, member]))
  const currentLinkedIds = linkedIds.filter((githubUserId) => rosterById.has(githubUserId))

  const liveRoles = new Map<string, "admin" | "member">()
  if (installation.accountType === "Organization") {
    await Promise.all(
      currentLinkedIds.map(async (githubUserId) => {
        const member = rosterById.get(githubUserId)
        if (!member) throw new Error("roster identity disappeared")
        const role = await getExactOrgMembershipRole({
          kv: env.OPENCLAW_STATE!,
          appId: env.GITHUB_APP_ID!,
          privateKey: env.GITHUB_PRIVATE_KEY!,
          installationId: args.installationId,
          orgLogin: installation.accountLogin,
          expectedOrgId: installation.accountId,
          userLogin: member.login,
          expectedGithubUserId: githubUserId,
        })
        liveRoles.set(githubUserId, role)
      }),
    )
  } else {
    for (const githubUserId of currentLinkedIds) {
      liveRoles.set(githubUserId, githubUserId === String(installation.accountId) ? "admin" : "member")
    }
  }

  const before = buildReport(
    args.installationId,
    false,
    linkedIds,
    currentLinkedIds,
    liveRoles,
    rosterSnapshot.memberIds,
    await listOrgWorkspaceAccess(db, args.installationId),
  )
  emitReport("org-access-backfill-dry-run", before)
  if (!args.apply) return before
  if (!before.canApply) throw new OrgAccessBackfillError("org_access_backfill_not_ready", 409)

  const adminGithubUserId =
    before.bootstrapSelection === "lowest_live_admin_id"
      ? (currentLinkedIds.find((githubUserId) => liveRoles.get(githubUserId) === "admin") ?? null)
      : null
  await backfillOrgWorkspaceAccess(db, {
    installationId: args.installationId,
    currentLinkedGithubUserIds: currentLinkedIds,
    adminGithubUserId,
    nowIso: new Date().toISOString(),
    updatedBy: "system:org-access-backfill",
    rosterSnapshot,
  })

  const after = buildReport(
    args.installationId,
    true,
    linkedIds,
    currentLinkedIds,
    liveRoles,
    rosterSnapshot.memberIds,
    await listOrgWorkspaceAccess(db, args.installationId),
  )
  if (!after.ready) throw new OrgAccessBackfillError("org_access_backfill_not_ready", 503)
  emitReport("org-access-backfill-applied", after)
  return after
}

function buildReport(
  installationId: number,
  applied: boolean,
  linkedIds: readonly string[],
  currentLinkedIds: readonly string[],
  liveRoles: ReadonlyMap<string, "admin" | "member">,
  rosterIds: readonly string[],
  accessRows: readonly OrgWorkspaceAccess[],
): OrgAccessBackfillReport {
  const byId = new Map(accessRows.map((row) => [row.githubUserId, row]))
  const rosterSet = new Set(rosterIds)
  const currentAccess = currentLinkedIds
    .map((githubUserId) => byId.get(githubUserId))
    .filter(Boolean) as OrgWorkspaceAccess[]
  const reachableAdmins = accessRows.filter(
    (row) => row.revokedAt === null && row.role === "admin" && rosterSet.has(row.githubUserId),
  ).length
  const liveAdminCandidates = currentLinkedIds.filter((githubUserId) => {
    const access = byId.get(githubUserId)
    return liveRoles.get(githubUserId) === "admin" && (access === undefined || access.revokedAt === null)
  }).length
  const missing = currentLinkedIds.length - currentAccess.length
  const bootstrapAdmin = reachableAdmins === 0
  const canApply = reachableAdmins > 0 || liveAdminCandidates > 0
  const ready = missing === 0 && reachableAdmins > 0
  return {
    installationId,
    applied,
    ready,
    canApply,
    counts: {
      linked: linkedIds.length,
      currentLinked: currentLinkedIds.length,
      staleLinked: linkedIds.length - currentLinkedIds.length,
      coveredCurrentLinked: currentAccess.length,
      activeCurrentLinked: currentAccess.filter((row) => row.revokedAt === null).length,
      revokedCurrentLinked: currentAccess.filter((row) => row.revokedAt !== null).length,
      reachableAdmins,
      liveAdminCandidates,
    },
    actions: { bootstrapAdmin, seedMembers: missing },
    bootstrapSelection:
      reachableAdmins > 0
        ? "existing_reachable_admin"
        : liveAdminCandidates > 0
          ? "lowest_live_admin_id"
          : "unavailable",
  }
}

function emitReport(event: string, report: OrgAccessBackfillReport): void {
  console.log(
    JSON.stringify({
      event,
      installationId: report.installationId,
      ready: report.ready,
      canApply: report.canApply,
      candidateCount: report.counts.liveAdminCandidates,
      bootstrapSelected: report.bootstrapSelection,
      warning:
        report.bootstrapSelection === "lowest_live_admin_id" ? "verify_human_operator_matches_selection" : undefined,
    }),
  )
}
