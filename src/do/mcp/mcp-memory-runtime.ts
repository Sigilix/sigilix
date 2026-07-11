import { embedText } from "@/src/shared/adapters/model"
import type { OfficialMcpVendor, RuntimeMcpAppDefinition } from "@/src/shared/domain/runtime-app-registry"
import type { Env } from "@/src/shared/types/env"
import {
  curatedReadToolForVendor,
  mcpMemoryIndexEnabled,
  mcpSurfaceEnabled,
  type EffectiveMcpPolicy,
  type McpRuntimeSurface,
} from "./runtime-policy"
import { effectiveBrokerPolicy, type McpPolicyEnvelope } from "./mcp-connections-support"
import {
  MCP_MEMORY_MAX_CONTENT_CHARS,
  MCP_MEMORY_TTL_MS,
  TenantMcpMemoryIndex,
  canonicalMcpInputHash,
  mcpMemoryRecordId,
  scoreMcpMemoryRecords,
  type ScoredMcpMemoryRecord,
} from "./mcp-memory-index"
import type { SanitizedMcpResult } from "./runtime-data"
import type { TenantMcpGrant, TenantMcpGrantRegistry } from "./tenant-mcp-grant-registry"
import {
  resolveMcpRuntimeAppSelector,
  runtimeAppAllowsTool,
  runtimeAppMatchesEndpoint,
  type RuntimeAppSelector,
} from "./runtime-app-routing"

const MAX_MEMORY_QUERY_CHARS = 4_000
const MAX_MEMORY_RESULTS = 8
const MAX_GRANTS = 32

export interface McpMemoryProvenance {
  installationId: number
  grantId: string
  provider: OfficialMcpVendor
  toolName: string
  inputHash: string
  sourceAt: string
  expiresAt: string
}

export interface McpMemoryEvidence extends McpMemoryProvenance {
  content: string
  score: number
}

interface MemoryAuthorization {
  grant: TenantMcpGrant
  policy: EffectiveMcpPolicy
}

interface BaseMemoryArgs {
  env: Env
  installationId: number
  grants: TenantMcpGrantRegistry
  memory: TenantMcpMemoryIndex
  readOwnerPolicy: (grant: TenantMcpGrant) => Promise<McpPolicyEnvelope | null>
}

export async function indexMcpResult(
  args: BaseMemoryArgs & {
    grant: TenantMcpGrant
    policy: EffectiveMcpPolicy
    toolName: string
    toolArguments: Record<string, unknown>
    result: SanitizedMcpResult
  },
): Promise<McpMemoryProvenance | null> {
  if (!validInstallationId(args.installationId) || !memoryToolAllowed(args.policy, args.toolName)) return null
  const content = args.result.content
    .map((item) => item.text)
    .join("\n")
    .slice(0, MCP_MEMORY_MAX_CONTENT_CHARS)
  if (!content.trim()) return null

  let inputHash: string
  let id: string
  let embedding: number[]
  try {
    inputHash = await canonicalMcpInputHash(args.toolArguments)
    id = await mcpMemoryRecordId({
      installationId: args.installationId,
      grantId: args.grant.grantId,
      provider: args.policy.vendor as OfficialMcpVendor,
      toolName: args.toolName,
      inputHash,
    })
    embedding = await embedText(args.env.AI, content)
  } catch (err) {
    emit("mcp-memory-index-failed", args.installationId, { stage: "prepare", error: errMessage(err) })
    return null
  }

  const sourceAt = Date.now()
  const expiresAt = sourceAt + MCP_MEMORY_TTL_MS
  try {
    await args.env.OPENCLAW_JOBS.send(
      { type: "mcp-memory-expire", installationId: args.installationId, memoryId: id, expectedExpiresAt: expiresAt },
      { delaySeconds: Math.floor(MCP_MEMORY_TTL_MS / 1_000) },
    )
  } catch (err) {
    emit("mcp-memory-index-failed", args.installationId, { stage: "schedule", error: errMessage(err) })
    return null
  }

  const owner = await args.readOwnerPolicy(args.grant)
  if (!owner) return null
  const expectedGrant = args.grants.getActive(args.grant.grantId)
  if (!expectedGrant) return null
  const expectedPolicy = effectiveBrokerPolicy(expectedGrant, owner)
  if (!memoryToolAllowed(expectedPolicy, args.toolName) || expectedPolicy.vendor !== args.policy.vendor) return null
  let finalPolicy: EffectiveMcpPolicy | null = null
  const write = args.memory.writeIfAuthorized(
    {
      id,
      installationId: args.installationId,
      grantId: args.grant.grantId,
      provider: args.policy.vendor as OfficialMcpVendor,
      toolName: args.toolName,
      inputHash,
      content,
      embedding,
      sourceAt,
      expiresAt,
      policyVersion: expectedPolicy.version,
    },
    () => {
      const current = args.grants.getActive(args.grant.grantId)
      if (!current || current.policy.version !== expectedPolicy.version) return false
      finalPolicy = effectiveBrokerPolicy(current, owner)
      return memoryToolAllowed(finalPolicy, args.toolName) && finalPolicy.vendor === args.policy.vendor
    },
  )
  emit("mcp-memory-index-result", args.installationId, { outcome: write.outcome })
  if ((write.outcome !== "stored" && write.outcome !== "replaced") || !finalPolicy) return null
  return provenance({
    installationId: args.installationId,
    grantId: args.grant.grantId,
    provider: args.policy.vendor as OfficialMcpVendor,
    toolName: args.toolName,
    inputHash,
    sourceAt,
    expiresAt,
  })
}

export async function queryMcpMemory(
  args: BaseMemoryArgs & { query: string; topK: number; surface: McpRuntimeSurface; appId?: unknown },
): Promise<McpMemoryEvidence[]> {
  const query = args.query.trim()
  const selector = resolveMcpRuntimeAppSelector(args.appId)
  if (
    selector.kind === "invalid" ||
    selector.kind === "unavailable" ||
    !validInstallationId(args.installationId) ||
    !query ||
    query.length > MAX_MEMORY_QUERY_CHARS ||
    !Number.isSafeInteger(args.topK) ||
    args.topK < 1 ||
    args.topK > MAX_MEMORY_RESULTS
  ) {
    return []
  }

  const initial = await resolveEligibleGrants(args, selector)
  if (initial.size === 0) return []
  let queryEmbedding: number[]
  try {
    queryEmbedding = await embedText(args.env.AI, query)
  } catch (err) {
    emit("mcp-memory-query-failed", args.installationId, { stage: "embed", error: errMessage(err) })
    return []
  }
  const records = args.memory
    .listCandidates(args.installationId, [...initial.keys()], Date.now())
    .filter((record) => recordAllowed(record.grantId, record.provider, record.toolName, initial, selectedApp(selector)))
  const scored = scoreMcpMemoryRecords(records, queryEmbedding)

  // Resolve policy again after all awaits and before the top-K cutoff. A
  // revoked/disabled grant is removed from the complete scored set, so its
  // similarity can never crowd out an eligible record.
  const final = await resolveEligibleGrants(args, selector, new Set(scored.map((item) => item.record.grantId)))
  const finalNow = Date.now()
  return scored
    .filter(
      (item) =>
        recordAllowed(item.record.grantId, item.record.provider, item.record.toolName, final, selectedApp(selector)) &&
        item.record.expiresAt > finalNow,
    )
    .slice(0, args.topK)
    .map(renderEvidence)
}

async function resolveEligibleGrants(
  args: BaseMemoryArgs & { surface: McpRuntimeSurface },
  selector: RuntimeAppSelector,
  selected?: ReadonlySet<string>,
): Promise<Map<string, MemoryAuthorization>> {
  const eligible = new Map<string, MemoryAuthorization>()
  for (const candidate of args.grants
    .listOpen()
    .filter((grant) => grant.status === "active" && (!selected || selected.has(grant.grantId)))
    .slice(0, MAX_GRANTS)) {
    const owner = await args.readOwnerPolicy(candidate)
    if (!owner) continue
    const current = args.grants.getActive(candidate.grantId)
    if (!current) continue
    const policy = effectiveBrokerPolicy(current, owner)
    if (
      mcpMemoryIndexEnabled(policy) &&
      mcpSurfaceEnabled(policy, args.surface) &&
      (selector.kind !== "resolved" ||
        (runtimeAppMatchesEndpoint(selector.app, current.serverUrl) &&
          policy.allowedReadTools.some((toolName) => runtimeAppAllowsTool(selector.app, policy.vendor, toolName))))
    ) {
      eligible.set(current.grantId, { grant: current, policy })
    }
  }
  return eligible
}

function recordAllowed(
  grantId: string,
  provider: string,
  toolName: string,
  eligible: ReadonlyMap<string, MemoryAuthorization>,
  app?: RuntimeMcpAppDefinition,
): boolean {
  const authorization = eligible.get(grantId)
  return (
    !!authorization &&
    authorization.policy.vendor === provider &&
    memoryToolAllowed(authorization.policy, toolName) &&
    (!app || runtimeAppAllowsTool(app, provider, toolName))
  )
}

function selectedApp(selector: RuntimeAppSelector): RuntimeMcpAppDefinition | undefined {
  return selector.kind === "resolved" ? selector.app : undefined
}

function memoryToolAllowed(policy: EffectiveMcpPolicy, toolName: string): boolean {
  return (
    policy.vendor !== "custom" &&
    mcpMemoryIndexEnabled(policy) &&
    policy.allowedReadTools.includes(toolName) &&
    curatedReadToolForVendor(policy.vendor, toolName) !== null
  )
}

function renderEvidence(item: ScoredMcpMemoryRecord): McpMemoryEvidence {
  return {
    ...provenance(item.record),
    content: item.record.content,
    score: item.score,
  }
}

function provenance(value: {
  installationId: number
  grantId: string
  provider: OfficialMcpVendor
  toolName: string
  inputHash: string
  sourceAt: number
  expiresAt: number
}): McpMemoryProvenance {
  return {
    installationId: value.installationId,
    grantId: value.grantId,
    provider: value.provider,
    toolName: value.toolName,
    inputHash: value.inputHash,
    sourceAt: new Date(value.sourceAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
  }
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function emit(event: string, installationId: number, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, installationId, ...fields }))
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
