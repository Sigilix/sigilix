const DEFAULT_MAX_RESPONSE_BYTES = 256_000

export interface BoundedMcpJsonResponse {
  ok: boolean
  status: number
  value: unknown
  durationMs: number
}

export interface BoundedMcpJsonFailure {
  ok: false
  status: null
  errorName: string
  timedOut: boolean
  durationMs: number
}

export type BoundedMcpJsonResult = BoundedMcpJsonResponse | BoundedMcpJsonFailure

interface BoundedMcpJsonOptions {
  timeoutMs: number
  maxResponseBytes?: number
  signal?: AbortSignal
}

/**
 * Shared, bounded transport for tenant MCP Durable Object hops. It applies the
 * same deadline to headers and streamed bodies, caps bytes independently of a
 * declared Content-Length, rejects invalid UTF-8/JSON, and discards late
 * response bodies after cancellation.
 */
export async function postBoundedMcpJson(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
  options: BoundedMcpJsonOptions,
): Promise<BoundedMcpJsonResult> {
  const startedAt = Date.now()
  if (options.signal?.aborted) {
    return { ok: false, status: null, errorName: "AbortError", timedOut: false, durationMs: 0 }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return { ok: false, status: null, errorName: "AbortError", timedOut: true, durationMs: 0 }
  }
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  if (options.signal?.aborted) abortFromCaller()
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort(new Error("MCP runtime timeout"))
    },
    Math.max(0, options.timeoutMs),
  )
  try {
    const fetchOperation = stub.fetch(
      new Request(`https://mcp.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    )
    void fetchOperation.then(
      (lateResponse) => {
        if (controller.signal.aborted) void lateResponse.body?.cancel().catch(() => undefined)
      },
      () => undefined,
    )
    const response = await raceAbort(fetchOperation, controller.signal)
    const text = await readResponseCapped(
      response,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      controller.signal,
    )
    if (text === null) throw Object.assign(new Error("MCP response rejected"), { name: "McpResponseRejected" })
    return {
      ok: response.ok,
      status: response.status,
      value: JSON.parse(text) as unknown,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      ok: false,
      status: null,
      errorName: err instanceof Error ? err.name : "unknown",
      timedOut,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abortFromCaller)
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
    if (signal.aborted) abort()
  })
}
