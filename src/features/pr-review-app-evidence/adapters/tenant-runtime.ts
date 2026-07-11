import { sanitizeMcpResult } from "@/src/do/mcp/runtime-data"
import { postBoundedMcpJson } from "@/src/shared/adapters/mcp-runtime-transport"
import type { Env } from "@/src/shared/types/env"
import type { PrReviewMcpResult, PrReviewMcpToolDescriptor } from "@/src/features/pr-review-app-evidence/domain/types"
import type { PrReviewMcpRuntimePort } from "@/src/features/pr-review-app-evidence/ports/runtime"

const MAX_CATALOG_TOOLS = 64
const MAX_INTERNAL_RESPONSE_BYTES = 256_000
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export function buildPrReviewMcpRuntime(
  env: Env,
  tenantScope: string,
  runId: string,
): PrReviewMcpRuntimePort | undefined {
  if (!isTenantRuntimeScope(tenantScope) || !env.MCP_CONNECTIONS || !SAFE_ID_RE.test(runId)) return undefined
  const stub = env.MCP_CONNECTIONS.get(env.MCP_CONNECTIONS.idFromName(tenantScope))
  return {
    async catalog(signal) {
      const response = await post(stub, "/broker/runtime/pr-review/catalog", {}, signal)
      if (!response?.ok || !isPlainObject(response.value) || !Array.isArray(response.value.tools)) return null
      if (response.value.tools.length > MAX_CATALOG_TOOLS) return null
      const tools: PrReviewMcpToolDescriptor[] = []
      for (const value of response.value.tools) {
        if (!isPlainObject(value)) continue
        const serverId = typeof value.serverId === "string" ? value.serverId : ""
        const vendor = typeof value.vendor === "string" ? value.vendor : ""
        const name = typeof value.name === "string" ? value.name : ""
        if (!SAFE_ID_RE.test(serverId) || !SAFE_ID_RE.test(vendor) || !SAFE_ID_RE.test(name)) continue
        tools.push({ serverId, vendor, name })
      }
      return tools
    },
    async invoke(args, signal) {
      const response = await post(
        stub,
        "/broker/runtime/pr-review/invoke",
        {
          runId,
          serverId: args.serverId,
          toolName: args.toolName,
          arguments: args.arguments,
        },
        signal,
      )
      if (!response?.ok || !isPlainObject(response.value)) return null
      const sanitized = sanitizeMcpResult(response.value.result)
      return sanitized ? ({ content: sanitized.content } satisfies PrReviewMcpResult) : null
    },
  }
}

async function post(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ ok: boolean; value: unknown } | null> {
  const response = await postBoundedMcpJson(stub, path, body, {
    timeoutMs: 5_000,
    maxResponseBytes: MAX_INTERNAL_RESPONSE_BYTES,
    signal,
  })
  return response.status === null ? null : response
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTenantRuntimeScope(scope: string): boolean {
  if (!scope.startsWith("tenant:")) return false
  const rawId = scope.slice("tenant:".length)
  if (!/^\d+$/.test(rawId)) return false
  const installationId = Number(rawId)
  return Number.isSafeInteger(installationId) && installationId > 0
}
