import type { AgentMcpCapabilityDO, AgentMcpCapabilityRecord } from "@/src/do/agent-mcp-capability"
import { sanitizeMcpInputSchema } from "@/src/do/mcp/runtime-data"
import { curatedReadToolForVendor } from "@/src/do/mcp/runtime-policy"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { Env } from "@/src/shared/types/env"
import { fetchAgentMcpBroker } from "./mcp-broker-client"

const MAX_TOOLS = 16
const MAX_CALLS = 4
const MIN_TTL_MS = 30_000
const MAX_TTL_MS = 15 * 60_000
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AgentMcpTaskCapability {
  endpoint: string
  capability: string
}

export async function mintAgentMcpCapability(args: {
  env: Env
  runId: string
  installationId: number
  owner: string
  repo: string
  timeoutMs: number
}): Promise<AgentMcpTaskCapability | undefined> {
  const base = args.env.SIGILIX_AGENT_MCP_ENDPOINT ?? args.env.OPENCLAW_AGENT_MCP_ENDPOINT
  const endpoint = base ? agentMcpEndpoint(base, args.runId) : null
  const requestedTtl = Math.trunc(args.timeoutMs)
  if (
    !RUN_ID_PATTERN.test(args.runId) ||
    !endpoint ||
    !args.env.MCP_CONNECTIONS ||
    !args.env.AGENT_MCP_CAPABILITY ||
    !Number.isSafeInteger(requestedTtl) ||
    requestedTtl < MIN_TTL_MS
  ) {
    return undefined
  }
  try {
    const catalog = await fetchAgentMcpBroker(args.env, args.installationId, "catalog", {})
    if (!catalog?.ok || !isPlainObject(catalog.value) || !Array.isArray(catalog.value.tools)) {
      logDegraded(args, "catalog_unavailable")
      return undefined
    }
    const tools: AgentMcpCapabilityRecord["tools"] = []
    const seen = new Set<string>()
    for (const candidate of catalog.value.tools) {
      if (tools.length >= MAX_TOOLS) break
      if (!isPlainObject(candidate)) continue
      const grantId = typeof candidate.serverId === "string" ? candidate.serverId : ""
      const vendor = typeof candidate.vendor === "string" ? candidate.vendor : ""
      const toolName = typeof candidate.name === "string" ? candidate.name : ""
      const curated = curatedReadToolForVendor(vendor, toolName)
      const inputSchema = sanitizeMcpInputSchema(candidate.inputSchema)
      const tuple = `${grantId}\u0000${vendor}\u0000${toolName}`
      if (!safeIdentifier(grantId) || !curated || !inputSchema || seen.has(tuple)) continue
      seen.add(tuple)
      tools.push({
        localName: `mcp_${tools.length}`,
        grantId,
        vendor,
        toolName,
        description: curated.description,
        inputSchema,
      })
    }
    if (tools.length === 0) return undefined

    const capability = randomHex(32)
    const now = Date.now()
    const ttl = Math.min(MAX_TTL_MS, requestedTtl)
    const expiresAt = now + ttl
    const record: AgentMcpCapabilityRecord = {
      version: 1,
      capabilityHash: await sha256Hex(capability),
      runId: args.runId,
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      surface: "agent",
      tools,
      expiresAt,
      maxCalls: MAX_CALLS,
      callsUsed: 0,
      catalogReadsUsed: 0,
    }
    const created = await capabilityStub(args.env, args.runId).initialize(record)
    if (!created) {
      logDegraded(args, "capability_conflict")
      return undefined
    }
    console.log(
      JSON.stringify({
        event: "agent-mcp-capability-minted",
        runId: args.runId,
        installationId: args.installationId,
        owner: args.owner,
        repo: args.repo,
        toolCount: tools.length,
        expiresAt,
      }),
    )
    return { endpoint, capability }
  } catch {
    logDegraded(args, "capability_unavailable")
    return undefined
  }
}

export async function revokeAgentMcpCapability(env: Env, runId: string): Promise<void> {
  if (!env.AGENT_MCP_CAPABILITY) return
  try {
    await capabilityStub(env, runId).revoke()
    console.log(JSON.stringify({ event: "agent-mcp-capability-revoked", runId }))
  } catch {
    console.warn(JSON.stringify({ event: "agent-mcp-capability-revoke-failed", runId }))
  }
}

function capabilityStub(env: Env, runId: string): DurableObjectStub<AgentMcpCapabilityDO> {
  return env.AGENT_MCP_CAPABILITY.get(
    env.AGENT_MCP_CAPABILITY.idFromName(runId),
  ) as DurableObjectStub<AgentMcpCapabilityDO>
}

function agentMcpEndpoint(rawBase: string, runId: string): string | null {
  try {
    const base = new URL(rawBase)
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null
    base.pathname = `/internal/agent-runs/${encodeURIComponent(runId)}/mcp`
    return base.toString()
  } catch {
    return null
  }
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
}

function safeIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function logDegraded(
  args: Pick<Parameters<typeof mintAgentMcpCapability>[0], "runId" | "installationId" | "owner" | "repo">,
  reason: string,
): void {
  console.warn(
    JSON.stringify({
      event: "agent-mcp-capability-degraded",
      runId: args.runId,
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      reason,
    }),
  )
}
