import { sanitizeMcpInputSchema, sanitizeMcpResult, type SanitizedMcpResult } from "@/src/do/mcp/runtime-data"
import { MCP_MEMORY_MAX_CONTENT_CHARS } from "@/src/do/mcp/mcp-memory-index"
import { curatedReadToolForVendor } from "@/src/do/mcp/runtime-policy"
import { isTenantRuntimeScope } from "@/src/lib/runtime-principal"
import {
  isToolCompatibleWithRuntimeApp,
  resolveRuntimeApp,
  type RuntimeAppId,
} from "@/src/shared/domain/runtime-app-registry"
import type { Env } from "@/src/shared/types/env"
import { postBoundedMcpJson } from "@/src/shared/adapters/mcp-runtime-transport"

// Every schema is independently capped at 12 KiB by sanitizeMcpInputSchema;
// sixteen descriptors therefore bound the selector's schema payload to at
// most 192 KiB before JSON/message overhead. The current verified catalog has
// only three capabilities, so this leaves room for reviewed additions without
// letting connection count grow model context without bound.
const MAX_CATALOG_TOOLS = 16
const MAX_INTERNAL_RESPONSE_BYTES = 256_000
// Runtime invokes inside the MCP DO are capped at 10 seconds. Allow a small
// amount of internal-hop overhead while still bounding both headers and body.
const INTERNAL_MCP_TIMEOUT_MS = 12_000

export interface ResearchMcpTool {
  serverId: string
  vendor: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ResearchMcpRuntime {
  catalog(): Promise<ResearchMcpTool[]>
  explicitCatalog?: () => Promise<ResearchExplicitAppCatalog>
  queryMemory(query: string, topK?: number): Promise<ResearchMcpMemoryEvidence[]>
  invoke(args: {
    serverId: string
    toolName: string
    arguments: Record<string, unknown>
  }): Promise<SanitizedMcpResult | null>
}

export interface ResearchMcpMemoryEvidence {
  installationId: number
  grantId: string
  provider: string
  toolName: string
  inputHash: string
  sourceAt: string
  expiresAt: string
  content: string
  score: number
}

export type ResearchExplicitAppCatalog =
  | { kind: "ready"; tools: ResearchMcpTool[] }
  | { kind: "unavailable"; reason: "app_unavailable" | "app_ambiguous" }

/**
 * Bind research execution to the exact installation-owned MCP broker. A
 * session identity is never a tenant scope; invalid scopes receive no runtime,
 * and every transport/protocol failure degrades to no evidence.
 */
export function buildResearchMcpRuntime(
  env: Env,
  tenantScope: string,
  runId: string,
  surface: "chat" | "deep-research",
  appId?: RuntimeAppId,
): ResearchMcpRuntime | undefined {
  if (
    !isTenantRuntimeScope(tenantScope) ||
    !env.MCP_CONNECTIONS ||
    !safeRunId(runId) ||
    (surface !== "chat" && surface !== "deep-research")
  ) {
    return undefined
  }
  const selectedApp = appId ? resolveRuntimeApp(appId) : null
  const installationId = Number(tenantScope.slice("tenant:".length))
  if (appId && !selectedApp?.executable) {
    return {
      catalog: async () => [],
      explicitCatalog: async () => ({ kind: "unavailable", reason: "app_unavailable" }),
      queryMemory: async () => [],
      invoke: async () => null,
    }
  }
  const stub = env.MCP_CONNECTIONS.get(env.MCP_CONNECTIONS.idFromName(tenantScope))
  const basePath = `/broker/runtime/${surface}`

  async function loadCatalog(): Promise<ResearchMcpTool[]> {
    const response = await postJson(stub, `${basePath}/catalog`, appId ? { appId } : {})
    if (!response?.ok || !isPlainObject(response.value) || !Array.isArray(response.value.tools)) return []
    const tools: ResearchMcpTool[] = []
    const seen = new Set<string>()
    for (const candidate of response.value.tools) {
      if (tools.length >= MAX_CATALOG_TOOLS) break
      if (!isPlainObject(candidate)) continue
      const serverId = typeof candidate.serverId === "string" ? candidate.serverId : ""
      const vendor = typeof candidate.vendor === "string" ? candidate.vendor : ""
      const name = typeof candidate.name === "string" ? candidate.name : ""
      const curated = curatedReadToolForVendor(vendor, name)
      const inputSchema = sanitizeMcpInputSchema(candidate.inputSchema)
      const key = `${serverId}\u0000${name}`
      if (
        !safeIdentifier(serverId) ||
        !curated ||
        !inputSchema ||
        seen.has(key) ||
        (appId !== undefined && !isToolCompatibleWithRuntimeApp(appId, vendor, name))
      ) {
        continue
      }
      seen.add(key)
      tools.push({ serverId, vendor, name, description: curated.description, inputSchema })
    }
    return tools
  }

  return {
    catalog: loadCatalog,

    async queryMemory(query, topK = 4) {
      const trimmed = query.trim()
      if (!trimmed || trimmed.length > 4_000 || !Number.isSafeInteger(topK) || topK < 1 || topK > 8) return []
      const response = await postJson(stub, "/broker/memory/query", {
        surface,
        query: trimmed,
        topK,
        ...(appId ? { appId } : {}),
      })
      if (!response?.ok || !isPlainObject(response.value) || !Array.isArray(response.value.results)) return []
      const evidence: ResearchMcpMemoryEvidence[] = []
      for (const candidate of response.value.results) {
        if (evidence.length >= topK) break
        const parsed = parseMemoryEvidence(candidate, installationId, appId)
        if (parsed) evidence.push(parsed)
      }
      return evidence
    },

    ...(appId
      ? {
          async explicitCatalog(): Promise<ResearchExplicitAppCatalog> {
            const response = await postJson(stub, `${basePath}/catalog`, { appId })
            if (!response?.ok) {
              const error = isPlainObject(response?.value) ? response.value.error : undefined
              return {
                kind: "unavailable",
                reason: error === "app_ambiguous" ? "app_ambiguous" : "app_unavailable",
              }
            }
            const tools = await loadCatalogFromValue(response.value, appId)
            return tools.length > 0 ? { kind: "ready", tools } : { kind: "unavailable", reason: "app_unavailable" }
          },
        }
      : {}),

    async invoke(args) {
      const response = await postJson(stub, `${basePath}/invoke`, {
        runId,
        serverId: args.serverId,
        toolName: args.toolName,
        arguments: args.arguments,
        ...(appId ? { appId } : {}),
      })
      if (!response?.ok || !isPlainObject(response.value)) return null
      return sanitizeMcpResult(response.value.result)
    },
  }
}

function parseMemoryEvidence(
  value: unknown,
  installationId: number,
  appId?: RuntimeAppId,
): ResearchMcpMemoryEvidence | null {
  if (!isPlainObject(value)) return null
  const grantId = typeof value.grantId === "string" ? value.grantId : ""
  const provider = typeof value.provider === "string" ? value.provider : ""
  const toolName = typeof value.toolName === "string" ? value.toolName : ""
  const inputHash = typeof value.inputHash === "string" ? value.inputHash : ""
  const sourceAt = typeof value.sourceAt === "string" ? value.sourceAt : ""
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : ""
  const content = typeof value.content === "string" ? value.content : ""
  const score = typeof value.score === "number" ? value.score : Number.NaN
  const sourceTime = Date.parse(sourceAt)
  const expiryTime = Date.parse(expiresAt)
  if (
    value.installationId !== installationId ||
    !safeIdentifier(grantId) ||
    !safeIdentifier(provider) ||
    !safeIdentifier(toolName) ||
    !/^[a-f0-9]{64}$/.test(inputHash) ||
    !Number.isFinite(sourceTime) ||
    !Number.isFinite(expiryTime) ||
    expiryTime <= sourceTime ||
    expiryTime <= Date.now() ||
    !content.trim() ||
    content.length > MCP_MEMORY_MAX_CONTENT_CHARS ||
    !Number.isFinite(score) ||
    score < -1 ||
    score > 1 ||
    (appId !== undefined && !isToolCompatibleWithRuntimeApp(appId, provider, toolName))
  ) {
    return null
  }
  return {
    installationId,
    grantId,
    provider,
    toolName,
    inputHash,
    sourceAt: new Date(sourceTime).toISOString(),
    expiresAt: new Date(expiryTime).toISOString(),
    content,
    score,
  }
}

async function loadCatalogFromValue(value: unknown, appId: RuntimeAppId): Promise<ResearchMcpTool[]> {
  if (!isPlainObject(value) || !Array.isArray(value.tools)) return []
  const tools: ResearchMcpTool[] = []
  const seen = new Set<string>()
  for (const candidate of value.tools) {
    if (tools.length >= MAX_CATALOG_TOOLS) break
    if (!isPlainObject(candidate)) continue
    const serverId = typeof candidate.serverId === "string" ? candidate.serverId : ""
    const vendor = typeof candidate.vendor === "string" ? candidate.vendor : ""
    const name = typeof candidate.name === "string" ? candidate.name : ""
    const curated = curatedReadToolForVendor(vendor, name)
    const inputSchema = sanitizeMcpInputSchema(candidate.inputSchema)
    const key = `${serverId}\u0000${name}`
    if (
      !safeIdentifier(serverId) ||
      !curated ||
      !inputSchema ||
      seen.has(key) ||
      !isToolCompatibleWithRuntimeApp(appId, vendor, name)
    ) {
      continue
    }
    seen.add(key)
    tools.push({ serverId, vendor, name, description: curated.description, inputSchema })
  }
  return tools
}

async function postJson(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; value: unknown } | null> {
  const result = await postBoundedMcpJson(stub, path, body, {
    timeoutMs: INTERNAL_MCP_TIMEOUT_MS,
    maxResponseBytes: MAX_INTERNAL_RESPONSE_BYTES,
  })
  if (result.status === null) {
    console.warn(
      JSON.stringify({
        event: "research-mcp-runtime-failed",
        path,
        err: result.errorName,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      }),
    )
    return null
  }
  if (!result.ok) {
    console.warn(
      JSON.stringify({
        event: "research-mcp-runtime-rejected",
        path,
        status: result.status,
        durationMs: result.durationMs,
      }),
    )
  }
  return result
}

function safeIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
}

function safeRunId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
