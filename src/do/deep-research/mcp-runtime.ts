import { sanitizeMcpInputSchema, sanitizeMcpResult, type SanitizedMcpResult } from "@/src/do/mcp/runtime-data"
import { curatedReadToolForVendor } from "@/src/do/mcp/runtime-policy"
import { isTenantRuntimeScope } from "@/src/lib/runtime-principal"
import {
  isToolCompatibleWithRuntimeApp,
  resolveRuntimeApp,
  type RuntimeAppId,
} from "@/src/shared/domain/runtime-app-registry"
import type { Env } from "@/src/shared/types/env"

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
  invoke(args: {
    serverId: string
    toolName: string
    arguments: Record<string, unknown>
  }): Promise<SanitizedMcpResult | null>
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
  if (appId && !selectedApp?.executable) {
    return {
      catalog: async () => [],
      explicitCatalog: async () => ({ kind: "unavailable", reason: "app_unavailable" }),
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

interface InternalMcpResponse {
  ok: boolean
  status: number
  value: unknown
}

async function postJson(stub: DurableObjectStub, path: string, body: unknown): Promise<InternalMcpResponse | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTERNAL_MCP_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const fetchOperation = stub.fetch(
      new Request(`https://mcp.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    )
    // A defensive race also bounds test doubles/transports that ignore the
    // signal. If such a fetch eventually returns, discard its unread body.
    void fetchOperation.then(
      (lateResponse) => {
        if (controller.signal.aborted) void lateResponse.body?.cancel().catch(() => undefined)
      },
      () => undefined,
    )
    const response = await raceAbort(fetchOperation, controller.signal)
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: "research-mcp-runtime-rejected",
          path,
          status: response.status,
          durationMs: Date.now() - startedAt,
        }),
      )
    }
    const text = await readResponseCapped(response, MAX_INTERNAL_RESPONSE_BYTES, controller.signal)
    if (text === null) return null
    return { ok: response.ok, status: response.status, value: JSON.parse(text) as unknown }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "research-mcp-runtime-failed",
        path,
        err: err instanceof Error ? err.name : "unknown",
        timedOut: controller.signal.aborted,
        durationMs: Date.now() - startedAt,
      }),
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Enforce a byte cap while consuming the internal response. The declared
 * length is only a cheap early rejection; the streamed count is authoritative. */
async function readResponseCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<string | null> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const declaredBytes = Number(declared)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      void response.body?.cancel().catch(() => undefined)
      return null
    }
  }
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal)
      if (done) {
        complete = true
        break
      }
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) return null
      chunks.push(value)
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // A timed-out read may remain pending even after cancellation is asked.
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged)
  } catch {
    return null
  }
}

/** Race an operation against abort while detaching the listener on every exit.
 * The rejection handler also observes a losing operation that settles later. */
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => {
      cleanup()
      reject(Object.assign(new Error("MCP runtime timeout"), { name: "AbortError" }))
    }
    void operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err: unknown) => {
        cleanup()
        reject(err)
      },
    )
    signal.addEventListener("abort", abort, { once: true })
    // Covers a signal that was already aborted before listener registration;
    // duplicate rejection is harmless because Promise settlement is one-shot.
    if (signal.aborted) abort()
  })
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
