import type { Env } from "@/src/shared/types/env"
import { areBoundedMcpArguments, sanitizeMcpResult } from "./runtime-data"
import { isMcpRuntimeSurface, mcpSurfaceEnabled, type McpRuntimeSurface } from "./runtime-policy"
import { indexMcpResult } from "./mcp-memory-runtime"
import type { TenantMcpMemoryIndex } from "./mcp-memory-index"
import type { TenantMcpGrant, TenantMcpGrantRegistry } from "./tenant-mcp-grant-registry"
import {
  JSON_HEADERS,
  effectiveBrokerPolicy,
  json,
  parseSafeId,
  type McpPolicyEnvelope,
} from "./mcp-connections-support"
import { resolveExplicitBrokerGrant } from "./broker-runtime-catalog"
import { resolveMcpRuntimeAppSelector, runtimeAppAllowsTool, runtimeAppMatchesEndpoint } from "./runtime-app-routing"

const BROKER_OWNER_TIMEOUT_MS = 12_000

interface BrokerRuntimeInvokeArgs {
  body: Record<string, unknown>
  installationId: number
  fixedSurface?: Exclude<McpRuntimeSurface, "cli">
  env: Env
  grants: TenantMcpGrantRegistry
  memory: TenantMcpMemoryIndex
  activeInvocations: Map<string, Set<Promise<void>>>
  ownerStub: (ownerScope: string) => DurableObjectStub
  readOwnerPolicy: (grant: TenantMcpGrant) => Promise<McpPolicyEnvelope | null>
  reserveRuntimeCall: (runId: string, grantId: string, surface: McpRuntimeSurface, maximum: number) => boolean
}

export async function handleBrokerRuntimeInvoke(args: BrokerRuntimeInvokeArgs): Promise<Response> {
  const grantId = parseSafeId(args.body.serverId)
  const toolName = parseSafeId(args.body.toolName)
  const runId = parseSafeId(args.body.runId)
  const surface = args.fixedSurface ?? args.body.surface
  if (!isMcpRuntimeSurface(surface) || !grantId || !toolName || !runId) {
    return json({ error: "invalid_request" }, 400)
  }
  if (!args.fixedSurface && surface !== "cli") return json({ error: "surface_not_allowed" }, 403)
  if (!areBoundedMcpArguments(args.body.arguments)) return json({ error: "invalid_arguments" }, 400)
  const selector = resolveMcpRuntimeAppSelector(args.body.appId)
  if (selector.kind === "invalid") return json({ error: "invalid_app" }, 400)
  if (selector.kind === "unavailable") return json({ error: "app_unavailable" }, 409)
  let grant = args.grants.getActive(grantId)
  if (!grant) return json({ error: "tool_not_allowed" }, 403)
  if (selector.kind === "resolved") {
    if (
      !runtimeAppMatchesEndpoint(selector.app, grant.serverUrl) ||
      !runtimeAppAllowsTool(selector.app, selector.app.vendor, toolName)
    ) {
      return json({ error: "app_unavailable" }, 409)
    }
    const selected = await resolveExplicitBrokerGrant({
      app: selector.app,
      surface,
      grants: args.grants.listOpen(),
      readActiveGrant: (candidateGrantId) => args.grants.getActive(candidateGrantId),
      readOwnerPolicy: args.readOwnerPolicy,
    })
    if (selected.kind !== "ready") return json({ error: selected.error }, 409)
    if (selected.grantId !== grantId) return json({ error: "app_unavailable" }, 409)
    grant = args.grants.getActive(grantId)
    if (!grant) return json({ error: "app_unavailable" }, 409)
  }

  let release!: () => void
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  const active = args.activeInvocations.get(grantId) ?? new Set<Promise<void>>()
  active.add(admitted)
  args.activeInvocations.set(grantId, active)
  try {
    const ownerEnvelope = await args.readOwnerPolicy(grant)
    if (!ownerEnvelope) return json({ error: "broker_unavailable" }, 502)
    const currentGrant = args.grants.getActive(grantId)
    if (!currentGrant) return denied(selector.kind)
    if (selector.kind === "resolved" && !runtimeAppMatchesEndpoint(selector.app, currentGrant.serverUrl)) {
      return json({ error: "app_unavailable" }, 409)
    }
    const effective = effectiveBrokerPolicy(currentGrant, ownerEnvelope)
    if (!mcpSurfaceEnabled(effective, surface) || !effective.allowedReadTools.includes(toolName)) {
      return denied(selector.kind)
    }
    if (selector.kind === "resolved" && !runtimeAppAllowsTool(selector.app, effective.vendor, toolName)) {
      return json({ error: "app_unavailable" }, 409)
    }
    if (!args.reserveRuntimeCall(runId, grantId, surface, effective.maxCallsPerRun)) {
      return json({ error: "max_calls_per_run_exceeded" }, 429)
    }
    const response = await invokeOwner(args.ownerStub(currentGrant.ownerScope), {
      runId,
      surface,
      serverId: currentGrant.serverId,
      toolName,
      arguments: args.body.arguments,
    })
    const text = await response.text()
    if (!response.ok) return new Response(text, { status: response.status, headers: JSON_HEADERS })

    const value = parseObject(text)
    const result = value ? sanitizeMcpResult(value.result) : null
    if (!value || !result) {
      return new Response(text, { status: response.status, headers: JSON_HEADERS })
    }
    const memory = await indexMcpResult({
      env: args.env,
      installationId: args.installationId,
      grants: args.grants,
      memory: args.memory,
      readOwnerPolicy: args.readOwnerPolicy,
      grant: currentGrant,
      policy: effective,
      toolName,
      toolArguments: args.body.arguments,
      result,
    })
    return json(memory ? { ...value, memory } : value)
  } catch (err) {
    console.warn("mcp-broker: invoke owner failed", err instanceof Error ? err.message : err)
    return json({ error: "broker_unavailable" }, 502)
  } finally {
    release()
    active.delete(admitted)
    if (active.size === 0) args.activeInvocations.delete(grantId)
  }
}

async function invokeOwner(stub: DurableObjectStub, body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BROKER_OWNER_TIMEOUT_MS)
  try {
    return await stub.fetch(
      new Request("https://mcp-connections.do/runtime/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    )
  } finally {
    clearTimeout(timer)
  }
}

function denied(selector: "generic" | "resolved"): Response {
  return selector === "resolved" ? json({ error: "app_unavailable" }, 409) : json({ error: "tool_not_allowed" }, 403)
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
