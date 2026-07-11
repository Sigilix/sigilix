import type { TenantMcpGrant } from "./tenant-mcp-grant-registry"
import type { RuntimeMcpAppDefinition } from "@/src/shared/domain/runtime-app-registry"
import type { McpRuntimeSurface } from "./runtime-policy"
import { mcpSurfaceEnabled } from "./runtime-policy"
import {
  brokerDescriptor,
  effectiveBrokerPolicy,
  isPolicyEnvelope,
  type McpPolicyEnvelope,
  type McpRuntimeToolDescriptor,
} from "./mcp-connections-support"
import {
  hasRuntimeAppPolicyTool,
  resolveMcpRuntimeAppSelector,
  runtimeAppAllowsTool,
  runtimeAppMatchesEndpoint,
} from "./runtime-app-routing"

export interface BrokerRuntimeCatalogResult {
  status: 200 | 400 | 409
  body: { tools: McpRuntimeToolDescriptor[]; partial: boolean } | { error: string }
}

interface BrokerRuntimeCatalogArgs {
  appId: unknown
  surface: McpRuntimeSurface
  grants: TenantMcpGrant[]
  readActiveGrant: (grantId: string) => TenantMcpGrant | null
  readOwnerPolicy: (grant: TenantMcpGrant) => Promise<McpPolicyEnvelope | null>
  readOwnerCatalog: (grant: TenantMcpGrant, surface: McpRuntimeSurface) => Promise<unknown[] | null>
}

export async function buildBrokerRuntimeCatalog(args: BrokerRuntimeCatalogArgs): Promise<BrokerRuntimeCatalogResult> {
  const selector = resolveMcpRuntimeAppSelector(args.appId)
  if (selector.kind === "invalid") return { status: 400, body: { error: "invalid_app" } }
  if (selector.kind === "unavailable") return { status: 409, body: { error: "app_unavailable" } }
  const candidates = args.grants
    .filter(
      (grant) =>
        grant.status === "active" &&
        (selector.kind !== "resolved" || runtimeAppMatchesEndpoint(selector.app, grant.serverUrl)),
    )
    .slice(0, 32)
  const eligible: Array<{ grant: TenantMcpGrant }> = []
  let partial = false
  for (const grant of candidates) {
    const owner = await args.readOwnerPolicy(grant)
    if (!owner) {
      partial = true
      continue
    }
    const currentGrant = args.readActiveGrant(grant.grantId)
    if (
      !currentGrant ||
      (selector.kind === "resolved" && !runtimeAppMatchesEndpoint(selector.app, currentGrant.serverUrl))
    ) {
      continue
    }
    const policy = effectiveBrokerPolicy(currentGrant, owner)
    if (!mcpSurfaceEnabled(policy, args.surface)) continue
    if (selector.kind === "resolved" && !hasRuntimeAppPolicyTool(selector.app, policy.allowedReadTools)) continue
    eligible.push({ grant: currentGrant })
  }
  if (selector.kind === "resolved" && (partial || eligible.length !== 1)) {
    return {
      status: 409,
      body: { error: eligible.length > 1 ? "app_ambiguous" : "app_unavailable" },
    }
  }

  const tools: McpRuntimeToolDescriptor[] = []
  for (const { grant } of eligible) {
    const remoteTools = await args.readOwnerCatalog(grant, args.surface)
    if (!remoteTools) {
      partial = true
      continue
    }
    // Both policy and grant may change during the awaited owner catalog hop.
    const owner = await args.readOwnerPolicy(grant)
    if (!owner) {
      partial = true
      continue
    }
    const currentGrant = args.readActiveGrant(grant.grantId)
    if (
      !currentGrant ||
      (selector.kind === "resolved" && !runtimeAppMatchesEndpoint(selector.app, currentGrant.serverUrl))
    ) {
      continue
    }
    const currentPolicy = effectiveBrokerPolicy(currentGrant, owner)
    if (!mcpSurfaceEnabled(currentPolicy, args.surface)) continue
    if (selector.kind === "resolved" && !hasRuntimeAppPolicyTool(selector.app, currentPolicy.allowedReadTools)) continue
    for (const candidate of remoteTools) {
      const descriptor = brokerDescriptor(candidate, currentGrant)
      if (
        descriptor &&
        currentPolicy.allowedReadTools.includes(descriptor.name) &&
        (selector.kind !== "resolved" || runtimeAppAllowsTool(selector.app, descriptor.vendor, descriptor.name))
      ) {
        tools.push(descriptor)
      }
    }
  }
  if (selector.kind === "resolved" && (partial || tools.length === 0)) {
    return { status: 409, body: { error: "app_unavailable" } }
  }
  return { status: 200, body: { tools, partial } }
}

export async function resolveExplicitBrokerGrant(args: {
  app: RuntimeMcpAppDefinition
  surface: McpRuntimeSurface
  grants: TenantMcpGrant[]
  readActiveGrant: (grantId: string) => TenantMcpGrant | null
  readOwnerPolicy: (grant: TenantMcpGrant) => Promise<McpPolicyEnvelope | null>
}): Promise<{ kind: "ready"; grantId: string } | { kind: "error"; error: "app_unavailable" | "app_ambiguous" }> {
  const eligible: string[] = []
  for (const grant of args.grants
    .filter((candidate) => candidate.status === "active" && runtimeAppMatchesEndpoint(args.app, candidate.serverUrl))
    .slice(0, 32)) {
    const owner = await args.readOwnerPolicy(grant)
    if (!owner) return { kind: "error", error: "app_unavailable" }
    const currentGrant = args.readActiveGrant(grant.grantId)
    if (!currentGrant || !runtimeAppMatchesEndpoint(args.app, currentGrant.serverUrl)) continue
    const policy = effectiveBrokerPolicy(currentGrant, owner)
    if (mcpSurfaceEnabled(policy, args.surface) && hasRuntimeAppPolicyTool(args.app, policy.allowedReadTools)) {
      eligible.push(grant.grantId)
    }
  }
  if (eligible.length !== 1) {
    return { kind: "error", error: eligible.length > 1 ? "app_ambiguous" : "app_unavailable" }
  }
  return { kind: "ready", grantId: eligible[0]! }
}

export async function readBrokerOwnerPolicy(
  stub: DurableObjectStub,
  grant: TenantMcpGrant,
): Promise<McpPolicyEnvelope | null> {
  try {
    const response = await stub.fetch(`https://mcp-connections.do/servers/${encodeURIComponent(grant.serverId)}/policy`)
    if (!response.ok) return null
    const value = (await response.json()) as unknown
    return isPolicyEnvelope(value) ? value : null
  } catch {
    return null
  }
}
