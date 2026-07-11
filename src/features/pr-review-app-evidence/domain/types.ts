export type PrReviewAppEvidence = VercelDeploymentEvidence | SupabaseAdvisorEvidence

export type VercelDeploymentState =
  | "ready"
  | "failed"
  | "building"
  | "queued"
  | "canceled"
  | "mixed"
  | "unknown"
  | "not_found"

export interface VercelDeploymentEvidence {
  kind: "vercel-deployment-status"
  state: VercelDeploymentState
  matchingDeployments: number
}

export interface SupabaseAdvisorEvidence {
  kind: "supabase-advisors"
  advisorType: "security" | "performance"
  total: number
  errors: number
  warnings: number
  infos: number
}

export type PrReviewAppManifestEntry = VercelManifestEntry | SupabaseManifestEntry

export interface VercelManifestEntry {
  adapter: "vercel-deployment-status"
  serverId: string
  teamId: string
  projectId: string
}

export interface SupabaseManifestEntry {
  adapter: "supabase-advisors"
  serverId: string
  projectId: string
  advisorType: "security" | "performance"
}

export interface PrReviewAppManifest {
  version: 1
  evidence: PrReviewAppManifestEntry[]
}

export interface PrReviewMcpToolDescriptor {
  serverId: string
  vendor: string
  name: string
}

export interface PrReviewMcpResult {
  content: Array<{ type: "text"; text: string }>
}
