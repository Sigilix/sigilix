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

import type { LlmUsage, ChatMessage, ToolCall, ChatArgs, ChatResult } from "@/src/shared/ports/model"

const OLLAMA_TURBO_URL = "https://ollama.com/api/chat"

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
    // SIG-287 (reasoning-on harness): the `/api/chat` schema nests the
    // reasoning CoT under `message.thinking` (vs the top-level `thinking`
    // on `/api/generate`). We read its LENGTH ONLY (never the text).
    thinking?: string
  }
  done?: boolean
  error?: string
  // SIG-212: token usage counters. Present on the final `done: true`
  // chunk per the Ollama API. Mirrors the OllamaStreamChunk shape in
  // `ollama.ts`.
  prompt_eval_count?: number
  eval_count?: number
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
  if (args.format) {
    requestBody.format = args.format
    // SIG-287: disable the reasoning/"thinking" phase for schema-constrained
    // calls — see the matching note in ollama.ts. A reasoning model otherwise
    // streams an unbounded chain-of-thought (separate `thinking` field, never
    // read here) and emits zero structured output until the per-attempt cap
    // aborts it. `format` is omitted on tool-call turns (so those keep their
    // thinking); set only alongside `format` here. Non-reasoning models ignore
    // `think`, so this is safe.
    //
    // SIG-287 reopener (reasoning-on harness): `args.reasoning` opts a role
    // into a BOUNDED reasoning level (`think:"high"|"medium"|"low"`); undefined
    // → `think:false` EXACTLY as before (byte-identical default-off). See the
    // matching note in ollama.ts.
    requestBody.think = args.reasoning ?? false
  }

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

    const { message, usage, thinkingChars } = await accumulateStream(res.body)
    const result: ChatResult = {
      message,
      hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
      usage,
    }
    // SIG-287: surface the thinking-char count only when the model reasoned;
    // omitted on the default-off `think:false` path so the result is
    // byte-identical to before for non-reasoning calls.
    if (thinkingChars > 0) result.thinkingChars = thinkingChars
    return result
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
async function accumulateStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ message: ChatMessage; usage: LlmUsage; thinkingChars: number }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let accumulatedContent = ""
  let lastToolCallsSnapshot: ToolCall[] | undefined = undefined
  let done = false
  let saw = false
  // SIG-287 (reasoning-on harness): cumulative LENGTH of `message.thinking`
  // across chunks (CoT arrives as deltas like `content`). Char count only —
  // the text is never retained.
  let thinkingChars = 0
  // SIG-212: token usage counters from the final `done: true` chunk.
  let promptEvalCount: number | undefined
  let evalCount: number | undefined

  const captureCounts = (chunk: OllamaChatChunk): void => {
    if (typeof chunk.prompt_eval_count === "number") promptEvalCount = chunk.prompt_eval_count
    if (typeof chunk.eval_count === "number") evalCount = chunk.eval_count
  }

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
        if (typeof msg.thinking === "string") thinkingChars += msg.thinking.length
        if (Array.isArray(msg.tool_calls)) {
          // SNAPSHOT — replace, don't append.
          lastToolCallsSnapshot = msg.tool_calls
        }
      }
      captureCounts(chunk)
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
        if (typeof msg.thinking === "string") thinkingChars += msg.thinking.length
        if (Array.isArray(msg.tool_calls)) lastToolCallsSnapshot = msg.tool_calls
      }
      captureCounts(chunk)
      saw = true
    } catch {
      // Ignored — incomplete final line.
    }
  }

  if (!saw) {
    throw new Error("Ollama stream produced no chunks")
  }

  const message: ChatMessage = {
    role: "assistant",
    content: accumulatedContent,
  }
  if (lastToolCallsSnapshot !== undefined) message.tool_calls = lastToolCallsSnapshot
  const usage: LlmUsage = {}
  if (promptEvalCount !== undefined) usage.inputTokens = promptEvalCount
  if (evalCount !== undefined) usage.outputTokens = evalCount
  return { message, usage, thinkingChars }
}
