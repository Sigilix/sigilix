import { sanitizeMcpInputSchema, sanitizeMcpResult, type SanitizedMcpResult } from "@/src/do/mcp/runtime-data"
import { curatedReadToolForVendor, type McpSurface } from "@/src/do/mcp/runtime-policy"
import { isStableRuntimeScope } from "@/src/lib/runtime-principal"
import type { Env } from "@/src/shared/types/env"

// Every schema is independently capped at 12 KiB by sanitizeMcpInputSchema;
// sixteen descriptors therefore bound the selector's schema payload to at
// most 192 KiB before JSON/message overhead. The current verified catalog has
// only three capabilities, so this leaves room for reviewed additions without
// letting connection count grow model context without bound.
const MAX_CATALOG_TOOLS = 16
const MAX_INTERNAL_RESPONSE_CHARS = 256_000

export interface ResearchMcpTool {
  serverId: string
  vendor: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ResearchMcpRuntime {
  catalog(surface: McpSurface): Promise<ResearchMcpTool[]>
  invoke(args: {
    surface: McpSurface
    serverId: string
    toolName: string
    arguments: Record<string, unknown>
  }): Promise<SanitizedMcpResult | null>
}

/**
 * Bind research execution to the exact MCP Durable Object that owns the
 * authenticated creator's connections. Invalid/anonymous creators receive no
 * runtime at all, and every transport/protocol failure degrades to no evidence.
 */
export function buildResearchMcpRuntime(env: Env, creator: string, runId: string): ResearchMcpRuntime | undefined {
  if (!isStableRuntimeScope(creator) || !env.MCP_CONNECTIONS || !safeRunId(runId)) return undefined
  const stub = env.MCP_CONNECTIONS.get(env.MCP_CONNECTIONS.idFromName(creator))

  return {
    async catalog(surface) {
      const value = await postJson(stub, "/runtime/catalog", { surface })
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
        if (!safeIdentifier(serverId) || !curated || !inputSchema || seen.has(key)) continue
        seen.add(key)
        tools.push({ serverId, vendor, name, description: curated.description, inputSchema })
      }
      return tools
    },

    async invoke(args) {
      const value = await postJson(stub, "/runtime/invoke", {
        runId,
        surface: args.surface,
        serverId: args.serverId,
        toolName: args.toolName,
        arguments: args.arguments,
      })
      if (!isPlainObject(value)) return null
      return sanitizeMcpResult(value.result)
    },
  }
}

async function postJson(stub: DurableObjectStub, path: string, body: unknown): Promise<unknown> {
  try {
    const response = await stub.fetch(
      new Request(`https://mcp.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    if (!response.ok) {
      console.warn(JSON.stringify({ event: "research-mcp-runtime-rejected", path, status: response.status }))
      return null
    }
    const text = await response.text()
    if (text.length > MAX_INTERNAL_RESPONSE_CHARS) return null
    return JSON.parse(text) as unknown
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "research-mcp-runtime-failed",
        path,
        err: err instanceof Error ? err.name : "unknown",
      }),
    )
    return null
  }
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
