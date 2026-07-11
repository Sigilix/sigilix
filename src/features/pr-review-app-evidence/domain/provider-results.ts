import type {
  PrReviewMcpResult,
  SupabaseAdvisorEvidence,
  VercelDeploymentEvidence,
  VercelDeploymentState,
} from "./types"

const MAX_COUNT = 64

export function parseVercelDeploymentEvidence(
  result: PrReviewMcpResult,
  headSha: string,
): VercelDeploymentEvidence | null {
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) return null
  const value = oneJsonValue(result)
  const deployments = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.deployments)
      ? value.deployments
      : null
  if (!deployments) return null
  const states: VercelDeploymentState[] = []
  for (const deployment of deployments) {
    if (states.length >= MAX_COUNT) break
    if (!isPlainObject(deployment) || !isPlainObject(deployment.meta)) continue
    if (deployment.meta.githubCommitSha !== headSha) continue
    states.push(vercelState(deployment.state))
  }
  if (states.length === 0) {
    return { kind: "vercel-deployment-status", state: "not_found", matchingDeployments: 0 }
  }
  const unique = new Set(states)
  return {
    kind: "vercel-deployment-status",
    state: unique.size === 1 ? states[0]! : "mixed",
    matchingDeployments: states.length,
  }
}

export function parseSupabaseAdvisorEvidence(
  result: PrReviewMcpResult,
  advisorType: "security" | "performance",
): SupabaseAdvisorEvidence | null {
  const value = oneJsonValue(result)
  if (!isPlainObject(value) || !Array.isArray(value.lints)) return null
  let errors = 0
  let warnings = 0
  let infos = 0
  for (const lint of value.lints) {
    if (errors + warnings + infos >= MAX_COUNT) break
    if (!isPlainObject(lint)) continue
    if (lint.level === "ERROR") errors += 1
    else if (lint.level === "WARN") warnings += 1
    else if (lint.level === "INFO") infos += 1
  }
  return {
    kind: "supabase-advisors",
    advisorType,
    total: errors + warnings + infos,
    errors,
    warnings,
    infos,
  }
}

function oneJsonValue(result: PrReviewMcpResult): unknown | null {
  const values: unknown[] = []
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue
    try {
      values.push(JSON.parse(item.text) as unknown)
    } catch {
      // Free text is deliberately discarded rather than interpreted.
    }
  }
  return values.length === 1 ? values[0] : null
}

function vercelState(value: unknown): VercelDeploymentState {
  if (value === "READY") return "ready"
  if (value === "ERROR") return "failed"
  if (value === "BUILDING" || value === "INITIALIZING") return "building"
  if (value === "QUEUED") return "queued"
  if (value === "CANCELED") return "canceled"
  return "unknown"
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
