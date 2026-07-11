import type { PrReviewAppEvidence, SupabaseAdvisorEvidence, VercelDeploymentEvidence } from "./types"

export function renderConnectedAppEvidence(evidence: readonly PrReviewAppEvidence[]): string | null {
  if (evidence.length === 0) return null
  const lines = ["### Connected app evidence", ""]
  for (const item of evidence) {
    lines.push(item.kind === "vercel-deployment-status" ? renderVercel(item) : renderSupabase(item))
  }
  return lines.join("\n")
}

function renderVercel(evidence: VercelDeploymentEvidence): string {
  if (evidence.state === "not_found") return "- **Vercel:** No deployment exactly matches this commit."
  const count = evidence.matchingDeployments
  const noun = count === 1 ? "deployment" : "deployments"
  const verb = count === 1 ? "is" : "are"
  const state =
    evidence.state === "mixed"
      ? "in mixed states"
      : evidence.state === "unknown"
        ? "in an unrecognized state"
        : evidence.state
  return `- **Vercel:** ${count} exact-match ${noun} ${verb} ${state}.`
}

function renderSupabase(evidence: SupabaseAdvisorEvidence): string {
  const label = evidence.advisorType === "security" ? "security" : "performance"
  return `- **Supabase ${label}:** ${evidence.total} advisor ${plural(evidence.total, "lint")} (${evidence.errors} ${plural(evidence.errors, "error")}, ${evidence.warnings} ${plural(evidence.warnings, "warning")}, ${evidence.infos} info).`
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}
