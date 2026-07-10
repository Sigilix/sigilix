import type { LinearConfig } from "./config"

export interface LinearConnection {
  installationId: number
  organizationId: string
  organizationName: string
  appUserId: string
  status: "active" | "revoked"
  source: "oauth" | "legacy-migration"
  grantedScopes: string[]
  canAccessAllPublicTeams: boolean
  installedByUserId: string
  installedByLogin: string
  installedAt: string
  updatedAt: string
}

export interface LinearTeamBinding {
  organizationId: string
  teamId: string
  installationId: number
  teamKey: string
  teamName: string
  accessState: "allowed" | "revoked"
  selected: boolean
  githubRepoId: number
  githubRepoFullName: string
  syncedAt: string
  updatedAt: string
}

export interface LinearIntegrationSnapshot {
  connection: LinearConnection | null
  teams: LinearTeamBinding[]
  config: LinearConfig | null
}

export interface LinearTenantContext {
  organizationId: string
  installationId: number
  teamId?: string
  deliveryId?: string
}

export function linearTenantContextFromJob(job: {
  organizationId?: string
  installationId?: number
  teamId?: string
  deliveryId?: string
}): LinearTenantContext | undefined {
  if (
    typeof job.organizationId !== "string" ||
    !job.organizationId ||
    !Number.isSafeInteger(job.installationId) ||
    Number(job.installationId) <= 0
  ) {
    return undefined
  }
  return {
    organizationId: job.organizationId,
    installationId: Number(job.installationId),
    ...(job.teamId ? { teamId: job.teamId } : {}),
    ...(job.deliveryId ? { deliveryId: job.deliveryId } : {}),
  }
}
