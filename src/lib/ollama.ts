// Ollama Turbo client. Streams the response so Cloudflare's edge
// doesn't 524 on long generations.
//
// Endpoint: https://ollama.com/api/generate
// Auth:     Authorization: Bearer <OLLAMA_API_KEY>
//
// Why streaming: Cloudflare's outgoing connection timeout is ~100s. With
// `stream: false`, Ollama waits for the full generation to finish and
// only then returns the response — for our ~37KB prompts, Kimi often
// takes 60-180s to produce the full structured output, which blows
// past the 100s edge timeout and triggers `Ollama HTTP 524`. With
// `stream: true`, Ollama sends NDJSON chunks every few hundred
// milliseconds; the connection stays warm because data is always
// flowing, and we accumulate the chunks ourselves.
//
// Output is a single string (the model's full response text), same
// as the non-streaming version, so callers don't have to change.

const OLLAMA_TURBO_URL = "https://ollama.com/api/generate"

interface GenerateArgs {
  model: string
  prompt: string
  apiKey: string
  temperature?: number
  /** Wall-clock timeout. Cloud routes can take 30-180s on long prompts; default 10min. */
  timeoutMs?: number
  /**
   * JSON Schema enforced by Ollama during decoding. Eliminates the
   * class of parse failures we previously hit ("verdict did not
   * parse") because the runtime literally cannot emit malformed
   * output — every token is constrained to the schema.
   *
   * When set, temperature defaults to 0 unless overridden, since
   * structured output is deterministic by design.
   *
   * Reference: https://docs.ollama.com/structured-outputs
   */
  format?: Record<string, unknown>
  /**
   * SIG-216 fix-up: optional external abort signal. Aborting this
   * signal aborts the in-flight fetch (cancels the streaming read)
   * so the caller can reclaim wall-clock when a higher-level deadline
   * fires — e.g. the inline-overview retry helper cancelling the
   * first attempt before launching the second. Combined with the
   * existing `timeoutMs` via a linked controller; whichever fires
   * first wins.
   */
  signal?: AbortSignal
}

interface OllamaStreamChunk {
  response?: string
  done?: boolean
  error?: string
}

export async function generate({
  model,
  prompt,
  apiKey,
  temperature,
  timeoutMs = 600_000,
  format,
  signal,
}: GenerateArgs): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // SIG-216 fix-up: link the external abort signal (if any) into the
  // local controller so the in-flight fetch cancels when either the
  // local timeout OR the external deadline fires.
  let externalAbortHandler: (() => void) | null = null
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason as unknown)
    } else {
      externalAbortHandler = (): void => controller.abort(signal.reason as unknown)
      signal.addEventListener("abort", externalAbortHandler, { once: true })
    }
  }

  // Default temperature: 0 when format is set (deterministic JSON),
  // 0.2 otherwise (mild creativity for free-form prose).
  const effectiveTemperature = temperature ?? (format ? 0 : 0.2)

  const requestBody: Record<string, unknown> = {
    model,
    prompt,
    stream: true,
    options: { temperature: effectiveTemperature },
  }
  if (format) requestBody.format = format

  try {
    const res = await fetch(OLLAMA_TURBO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    if (!res.body) {
      throw new Error("Ollama response missing body")
    }

    return await accumulateStream(res.body)
  } finally {
    clearTimeout(timer)
    if (signal && externalAbortHandler) {
      signal.removeEventListener("abort", externalAbortHandler)
    }
  }
}

/**
 * Read the NDJSON stream and accumulate the `response` field across
 * chunks. Each line in the stream is a JSON object like:
 *
 *   { "model": "...", "response": "Hello", "done": false }
 *   { "model": "...", "response": " world", "done": false }
 *   { "model": "...", "response": "", "done": true, ... }
 *
 * The final chunk has `done: true`. We concatenate all `response`
 * values and return the result. If a chunk has an `error` field, we
 * throw — that propagates to the queue retry path.
 */
async function accumulateStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let accumulated = ""
  let done = false
  let saw = false

  while (!done) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })

    // Process complete lines; keep any partial line in the buffer for
    // the next iteration (NDJSON lines are usually fully delivered per
    // chunk, but TCP framing isn't guaranteed).
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (!line) continue
      saw = true
      let chunk: OllamaStreamChunk
      try {
        chunk = JSON.parse(line) as OllamaStreamChunk
      } catch {
        // Malformed line — skip rather than abort the whole generation.
        continue
      }
      if (chunk.error) {
        throw new Error(`Ollama stream error: ${chunk.error.slice(0, 500)}`)
      }
      if (typeof chunk.response === "string") {
        accumulated += chunk.response
      }
      if (chunk.done) done = true
    }
  }

  // Flush any trailing buffered line (rare — Ollama always ends with `\n`).
  const tail = buffer.trim()
  if (tail) {
    try {
      const chunk = JSON.parse(tail) as OllamaStreamChunk
      if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error.slice(0, 500)}`)
      if (typeof chunk.response === "string") accumulated += chunk.response
      saw = true
    } catch {
      // Ignored — incomplete final line, what we already accumulated is what we got.
    }
  }

  if (!saw) {
    throw new Error("Ollama stream produced no chunks")
  }
  return accumulated
}
