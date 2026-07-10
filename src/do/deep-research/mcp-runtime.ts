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
      void response.body?.cancel().catch(() => undefined)
      console.warn(
        JSON.stringify({
          event: "research-mcp-runtime-rejected",
          path,
          status: response.status,
          durationMs: Date.now() - startedAt,
        }),
      )
      return null
    }
    const text = await readResponseCapped(response, MAX_INTERNAL_RESPONSE_BYTES, controller.signal)
    if (text === null) return null
    return JSON.parse(text) as unknown
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
