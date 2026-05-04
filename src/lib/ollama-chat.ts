// FRAGILE: GLM-5.1 via Ollama Turbo tool_call format is experimental.
//
// Ollama Turbo `/api/chat` client. Mirrors `ollama.ts`'s shape but uses
// the chat endpoint (which supports `tools`) instead of `/api/generate`.
// Used by the Phase 3 agent loop.
//
// Endpoint: https://ollama.com/api/chat
// Auth:     Authorization: Bearer <OLLAMA_API_KEY>
//
// Streaming: same NDJSON shape as `/api/generate`, same reason — Cloudflare's
// edge has a ~100s outgoing-connection idle timeout that long generations
// blow past with `stream: false`.
//
// Accumulator semantics — read this carefully if you're maintaining:
//
//   `message.content` accumulates by string concatenation across chunks (delta).
//   `message.tool_calls` is a SNAPSHOT per chunk — replace, don't append.
//   `message.tool_calls[].function.arguments` may arrive as a JSON string OR
//   an object depending on Ollama version; we PRESERVE the raw value (no
//   JSON.parse, no throw). The agent loop's per-tool-call validator handles
//   parse failures so the model gets a single retry on bad args instead of
//   the whole loop dying as `chat_error`.

const OLLAMA_TURBO_URL = "https://ollama.com/api/chat"

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /** For role="assistant": tool calls the model wants to make. */
  tool_calls?: ToolCall[]
  /** For role="tool": the call_id this response answers. Ollama pairs
   *  tool responses to calls primarily via message ordering, but
   *  supplying tool_call_id explicitly lets us validate pairings
   *  before sending and lets future Ollama versions enforce strict
   *  pairing without breaking us. */
  tool_call_id?: string
  /** For role="tool": the function name (clarity in logs + lets us
   *  cross-check the tool_call_id pairing). */
  tool_name?: string
}

export interface ToolCall {
  /** Provider-supplied. Some providers omit; loop falls back to index. */
  id?: string
  function: {
    name: string
    /** RAW value as returned by Ollama. May be a JSON string OR an object
     *  (version-dependent). Loop's `parseToolArguments` handles the parse
     *  + validation; we don't touch it here. */
    arguments: string | Record<string, unknown>
  }
}

export interface ChatToolDef {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown> // JSON Schema
  }
}

export interface ChatArgs {
  model: string
  apiKey: string
  messages: ChatMessage[]
  tools?: ChatToolDef[]
  /** Optional structured-output schema for the FINAL answer. Loop callers
   *  must NOT pass `format` on tool-call turns — it can suppress tool
   *  emission. */
  format?: Record<string, unknown>
  temperature?: number
  /** Wall-clock cap. Default 600_000ms (10min) — same as `generate()`.
   *  The agent loop's outer 120s cap still applies via `signal`. */
  timeoutMs?: number
  /** Per-call kill-switch. When "off", `chat()` throws a synchronous
   *  ChatDisabledError before any network call. The agent loop also
   *  reads OLLAMA_CHAT_ENABLE from env at entry and refuses to start
   *  in the same way; this arg lets ad-hoc callers honor the kill
   *  without re-reading env themselves. */
  chatEnabled?: "on" | "off"
  /** External AbortSignal. Composed with `timeoutMs` — either source
   *  aborts the request. Loop callers pass their loop-wide signal here. */
  signal?: AbortSignal
}

export interface ChatResult {
  /** The assistant message the model emitted this turn. */
  message: ChatMessage
  /** True iff `Array.isArray(message.tool_calls) && message.tool_calls.length > 0`.
   *  Empty array unambiguously means final-answer (no tool calls). */
  hasToolCalls: boolean
}

/**
 * Distinct error class so the agent loop can map kill-switch rejection
 * to its own `chat_disabled` failure reason without parsing message text.
 */
export class ChatDisabledError extends Error {
  constructor() {
    super("OLLAMA_CHAT_ENABLE=off — /api/chat path is disabled")
    this.name = "ChatDisabledError"
  }
}

export function isChatDisabledError(error: unknown): boolean {
  return error instanceof ChatDisabledError
}

interface OllamaChatChunk {
  message?: {
    role?: string
    content?: string
    tool_calls?: ToolCall[]
  }
  done?: boolean
  error?: string
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  if (args.chatEnabled === "off") {
    throw new ChatDisabledError()
  }

  const timeoutMs = args.timeoutMs ?? 600_000
  const internalCtrl = new AbortController()
  const timer = setTimeout(() => internalCtrl.abort(), timeoutMs)

  // Compose the external signal (loop-wide AbortController) with the
  // internal timeout signal so either source can abort the fetch.
  // Install the listener BEFORE checking `aborted` so we don't miss an
  // abort that fires between the boolean read and the addEventListener
  // call (race window).
  const onExternalAbort = (): void => internalCtrl.abort()
  args.signal?.addEventListener("abort", onExternalAbort, { once: true })
  if (args.signal?.aborted) internalCtrl.abort()

  // Default temperature: 0 when format is set (deterministic JSON),
  // 0.2 otherwise (mild creativity for free-form / tool-use prose).
  const effectiveTemperature = args.temperature ?? (args.format ? 0 : 0.2)

  const requestBody: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: true,
    options: { temperature: effectiveTemperature },
  }
  if (args.tools && args.tools.length > 0) requestBody.tools = args.tools
  if (args.format) requestBody.format = args.format

  try {
    const res = await fetch(OLLAMA_TURBO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: internalCtrl.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    if (!res.body) {
      throw new Error("Ollama response missing body")
    }

    const message = await accumulateStream(res.body)
    return {
      message,
      hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
    }
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener("abort", onExternalAbort)
  }
}

/**
 * Read the NDJSON stream and accumulate into a single `ChatMessage`.
 *
 * Each chunk is a JSON object like:
 *
 *   { "model": "...", "message": { "role": "assistant", "content": "Hello" }, "done": false }
 *   { "model": "...", "message": { "role": "assistant", "content": " world" }, "done": false }
 *   { "model": "...", "message": { "role": "assistant", "tool_calls": [...] }, "done": true }
 *
 * Critical accumulator rules (snapshot vs delta — different per field):
 *
 * - `message.content` chunks are DELTAS — concatenate as strings.
 * - `message.tool_calls` chunks are SNAPSHOTS — replace the in-progress array
 *   with each chunk's snapshot. Final chunk's snapshot is the truth.
 *
 * If a chunk has an `error` field, throw — that propagates to the agent
 * loop's `chat_error` mapping.
 */
async function accumulateStream(body: ReadableStream<Uint8Array>): Promise<ChatMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let accumulatedContent = ""
  let lastToolCallsSnapshot: ToolCall[] | undefined = undefined
  let done = false
  let saw = false

  while (!done) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })

    // Process complete lines; keep any partial line in the buffer for
    // the next iteration.
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (!line) continue
      saw = true
      let chunk: OllamaChatChunk
      try {
        chunk = JSON.parse(line) as OllamaChatChunk
      } catch {
        // Malformed line — skip rather than abort.
        continue
      }
      if (chunk.error) {
        throw new Error(`Ollama stream error: ${chunk.error.slice(0, 500)}`)
      }
      const msg = chunk.message
      if (msg) {
        if (typeof msg.content === "string") {
          accumulatedContent += msg.content
        }
        if (Array.isArray(msg.tool_calls)) {
          // SNAPSHOT — replace, don't append.
          lastToolCallsSnapshot = msg.tool_calls
        }
      }
      if (chunk.done) done = true
    }
  }

  // Flush any trailing buffered line (rare — Ollama always ends with `\n`).
  const tail = buffer.trim()
  if (tail) {
    try {
      const chunk = JSON.parse(tail) as OllamaChatChunk
      if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error.slice(0, 500)}`)
      const msg = chunk.message
      if (msg) {
        if (typeof msg.content === "string") accumulatedContent += msg.content
        if (Array.isArray(msg.tool_calls)) lastToolCallsSnapshot = msg.tool_calls
      }
      saw = true
    } catch {
      // Ignored — incomplete final line.
    }
  }

  if (!saw) {
    throw new Error("Ollama stream produced no chunks")
  }

  const out: ChatMessage = {
    role: "assistant",
    content: accumulatedContent,
  }
  if (lastToolCallsSnapshot !== undefined) out.tool_calls = lastToolCallsSnapshot
  return out
}
