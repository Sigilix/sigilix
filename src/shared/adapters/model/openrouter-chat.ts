// SIG-399 / OpenRouter migration — the OpenRouter `/chat/completions` adapter.
//
// Implements the SAME `chat(args: ChatArgs): Promise<ChatResult>` contract as
// `ollama-chat.ts` so consumers (and the model port) are untouched. The barrel's
// router picks this adapter for OpenRouter-shaped model ids (those containing "/",
// e.g. "openai/o3"); Ollama-tag ids ("deepseek-v4-pro:cloud") keep using ollama-chat.
//
// Endpoint: https://openrouter.ai/api/v1/chat/completions
// Auth:     Authorization: Bearer <OPENROUTER_API_KEY>
//
// Streaming (SSE): same reason ollama-chat streams — Cloudflare's edge has a ~100s
// outgoing-idle timeout that long generations (o3 ~20-50s, slower tails) blow past
// with a single buffered response. Parses the OpenRouter SSE wire format:
//   - lines begin with "data: "; the terminal sentinel is "data: [DONE]"
//   - lines beginning with ":" are HEARTBEAT comments (": OPENROUTER PROCESSING") — SKIP
//   - a data chunk may carry a top-level `error` object — THROW (mirrors the Ollama
//     stream-error path so `isPermanentFailure` / retry classify it)
//   - content accumulates from `choices[0].delta.content`; usage arrives on the final
//     chunk's top-level `usage` ({prompt_tokens, completion_tokens})
//
// Reasoning: `args.reasoning` ("high"|"medium"|"low") → `reasoning: { effort }`, sent
// ONLY on a schema-constrained (`format`) call — mirrors ollama-chat's `think` rule
// (the port says reasoning is ignored on format-less / tool turns). Unlike Ollama
// there is no `think:false`; o-series always reasons, the effort knob is the only lever.
//
// `thinkingChars`: OpenRouter (and o-series in particular) MAY NOT return reasoning
// tokens; we count `delta.reasoning` length ONLY when present and omit the field
// otherwise (never assert it exists).
//
// Tools: NOT supported on this route in Phase 1. OpenRouter streaming tool-call deltas
// do not share Ollama's snapshot semantics, so rather than mis-handle them we reject
// `args.tools` explicitly — the specialist/synth paths are schema-constrained and never
// pass tools; the agent loop (which does) stays on Ollama until a later phase wires
// streaming tool deltas.

import type { LlmUsage, ChatMessage, ChatArgs, ChatResult } from "@/src/shared/ports/model"

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

// o-series reasoning tokens count against the completion budget; a too-small cap
// truncates the structured answer into a parse failure. Default generous; callers
// may not override (ChatArgs has no max_tokens field — this is the single source).
const DEFAULT_MAX_TOKENS = 32_000

interface OpenRouterDelta {
  content?: string
  reasoning?: string
}
interface OpenRouterChunk {
  choices?: Array<{ delta?: OpenRouterDelta; message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; code?: number | string }
}

export async function chat(args: ChatArgs): Promise<ChatResult> {
  if (args.chatEnabled === "off") {
    throw new Error("OPENCLAW chat disabled (chatEnabled=off)")
  }
  if (args.tools && args.tools.length > 0) {
    // Explicit reject (see header) — never silently drop tools on the OR route.
    throw new Error("openrouter-chat: tool calls are not supported on the OpenRouter route in this phase")
  }

  const timeoutMs = args.timeoutMs ?? 600_000
  const internalCtrl = new AbortController()
  const timer = setTimeout(() => internalCtrl.abort(), timeoutMs)
  const onExternalAbort = (): void => internalCtrl.abort()
  args.signal?.addEventListener("abort", onExternalAbort, { once: true })
  if (args.signal?.aborted) internalCtrl.abort()

  const effectiveTemperature = args.temperature ?? (args.format ? 0 : 0.2)
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: true,
    temperature: effectiveTemperature,
    max_tokens: DEFAULT_MAX_TOKENS,
  }
  if (args.format) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "pr_review", strict: false, schema: args.format },
    }
    // Mirror ollama-chat: reasoning level applies only on schema-constrained calls.
    if (args.reasoning !== undefined) body.reasoning = { effort: args.reasoning }
  }

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify(body),
      signal: internalCtrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    if (!res.body) {
      throw new Error("OpenRouter response missing body")
    }
    const { message, usage, thinkingChars } = await accumulateStream(res.body)
    const result: ChatResult = { message, hasToolCalls: false, usage }
    if (thinkingChars > 0) result.thinkingChars = thinkingChars
    return result
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener("abort", onExternalAbort)
  }
}

/**
 * Read the OpenRouter SSE stream and accumulate into one assistant message.
 * Handles `data:` frames, the `[DONE]` sentinel, `:`-prefixed heartbeat comments,
 * and top-level `error` chunks (thrown). `content` chunks are deltas — concatenate.
 */
async function accumulateStream(
  bodyStream: ReadableStream<Uint8Array>,
): Promise<{ message: ChatMessage; usage: LlmUsage; thinkingChars: number }> {
  const reader = bodyStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  let thinkingChars = 0
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let saw = false
  let done = false

  const handleData = (payload: string): void => {
    if (payload === "[DONE]") {
      done = true
      return
    }
    let chunk: OpenRouterChunk
    try {
      chunk = JSON.parse(payload) as OpenRouterChunk
    } catch {
      return // partial/malformed frame — skip
    }
    saw = true
    if (chunk.error) {
      throw new Error(
        `OpenRouter stream error: ${String(chunk.error.message ?? chunk.error.code ?? "unknown").slice(0, 500)}`,
      )
    }
    const delta = chunk.choices?.[0]?.delta
    if (delta) {
      if (typeof delta.content === "string") content += delta.content
      if (typeof delta.reasoning === "string") thinkingChars += delta.reasoning.length
    }
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === "number") promptTokens = chunk.usage.prompt_tokens
      if (typeof chunk.usage.completion_tokens === "number") completionTokens = chunk.usage.completion_tokens
    }
  }

  while (!done) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      if (line.startsWith(":")) continue // heartbeat comment (": OPENROUTER PROCESSING")
      if (line.startsWith("data:")) handleData(line.slice(5).trim())
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith("data:")) handleData(tail.slice(5).trim())

  if (!saw) {
    throw new Error("OpenRouter stream produced no chunks")
  }
  // The stream ended without the `[DONE]` sentinel — the body was cut mid-flight
  // (edge idle-timeout, dropped connection, a partial last frame). Returning the
  // partial `content` would surface a truncated review as a success; throw so retry
  // classifies it as transient and re-runs (mirrors a torn Ollama stream).
  // NOTE: `isPermanentFailure` classifies by message text — it treats an `HTTP <4xx>`
  // substring as permanent. This message intentionally contains no such substring so it
  // stays transient/retryable; do not reword it to include an HTTP-status-shaped token.
  if (!done) {
    throw new Error("OpenRouter stream ended without a [DONE] terminator (likely truncated)")
  }

  const message: ChatMessage = { role: "assistant", content }
  const usage: LlmUsage = {}
  if (promptTokens !== undefined) usage.inputTokens = promptTokens
  if (completionTokens !== undefined) usage.outputTokens = completionTokens
  return { message, usage, thinkingChars }
}
