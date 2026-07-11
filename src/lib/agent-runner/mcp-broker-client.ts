import type { Env } from "@/src/shared/types/env"

const MAX_RESPONSE_BYTES = 256_000
const INTERNAL_TIMEOUT_MS = 12_000

export interface AgentMcpBrokerResponse {
  ok: boolean
  status: number
  value: unknown
}

export async function fetchAgentMcpBroker(
  env: Env,
  installationId: number,
  action: "catalog" | "invoke",
  body: Record<string, unknown>,
): Promise<AgentMcpBrokerResponse | null> {
  const stub = env.MCP_CONNECTIONS.get(env.MCP_CONNECTIONS.idFromName(`tenant:${installationId}`))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS)
  try {
    const operation = stub.fetch(
      new Request(`https://mcp.internal/broker/runtime/agent/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    )
    const response = await raceAbort(operation, controller.signal)
    const value = await readResponseJsonCapped(response, controller.signal)
    return value === null ? null : { ok: response.ok, status: response.status, value }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function readResponseJsonCapped(response: Response, signal: AbortSignal): Promise<unknown | null> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    for (;;) {
      const chunk = await raceAbort(reader.read(), signal)
      if (chunk.done) {
        complete = true
        break
      }
      if (!chunk.value) continue
      total += chunk.value.byteLength
      if (total > MAX_RESPONSE_BYTES) return null
      chunks.push(chunk.value)
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // A timed-out read can still own the lock while cancellation propagates.
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged)) as unknown
  } catch {
    return null
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(Object.assign(new Error("agent MCP timeout"), { name: "AbortError" }))
    }
    signal.addEventListener("abort", abort, { once: true })
    void operation.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
