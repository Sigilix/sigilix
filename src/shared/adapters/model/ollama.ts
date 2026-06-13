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

import type { GenerateArgs, GenerateResult, LlmUsage } from "@/src/shared/ports/model"

const OLLAMA_TURBO_URL = "https://ollama.com/api/generate"

interface OllamaStreamChunk {
  response?: string
  done?: boolean
  error?: string
  // SIG-287 (reasoning-on harness): when `think` is on, a reasoning model
  // streams its chain-of-thought here (separate from `response`). We read
  // its LENGTH ONLY (never the text) so the soak can size reasoning time
  // per role without logging CoT.
  thinking?: string
  // SIG-212: token usage counters. Present on the final `done: true`
  // chunk per the Ollama API. Surface them on `GenerateResult.usage`
  // so the ensemble's `model-attempt-completed` events can record
  // per-call cost.
  prompt_eval_count?: number
  eval_count?: number
}

export async function generate({
  model,
  prompt,
  apiKey,
  temperature,
  timeoutMs = 600_000,
  format,
  signal,
  reasoning,
}: GenerateArgs): Promise<GenerateResult> {
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
  if (format) {
    requestBody.format = format
    // SIG-287: disable the reasoning/"thinking" phase for schema-constrained
    // calls. A reasoning model (deepseek-v4-flash, the logic specialist's
    // primary) otherwise streams an unbounded chain-of-thought in a SEPARATE
    // `thinking` field — which `accumulateStream` does not read — emitting
    // ZERO `response` tokens until the per-attempt AbortController fires at
    // the cap. That stalled logic on EVERY review (full-cap abort, no output)
    // and no timeout bump (60→110→240→360s) could fix it, because you can't
    // out-wait an unbounded CoT. Ollama defaults `think:true` when omitted;
    // non-reasoning models silently ignore `think`, so this is safe to set
    // for any structured call — we want the JSON answer, not the CoT. Mirrors
    // the `temperature→0 when format` rule above (deterministic structured
    // output). Free-form (format-less) calls keep the default thinking.
    //
    // SIG-287 reopener (reasoning-on harness): `reasoning` opts a role into a
    // BOUNDED reasoning level (`think:"high"|"medium"|"low"`) — a finite CoT
    // then the answer, which fits the per-attempt cap (unlike `think:true`,
    // the unbounded mode that originally stalled the cap). When `reasoning`
    // is undefined this is `think:false` EXACTLY as before — byte-identical
    // to the prior hardcoded value, so default-off changes nothing.
    requestBody.think = reasoning ?? false
  }

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
async function accumulateStream(body: ReadableStream<Uint8Array>): Promise<GenerateResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let accumulated = ""
  let done = false
  let saw = false
  // SIG-287 (reasoning-on harness): cumulative LENGTH of the `thinking`
  // field across chunks. We add up char counts as the CoT streams (it
  // arrives as deltas, same as `response`) and NEVER retain the text.
  let thinkingChars = 0
  // SIG-212: Ollama emits the token counts on the final `done: true`
  // chunk. Tracking them across all chunks is defensive — only the
  // last non-zero values are used.
  let promptEvalCount: number | undefined
  let evalCount: number | undefined

  const captureCounts = (chunk: OllamaStreamChunk): void => {
    if (typeof chunk.prompt_eval_count === "number") promptEvalCount = chunk.prompt_eval_count
    if (typeof chunk.eval_count === "number") evalCount = chunk.eval_count
  }

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
      if (typeof chunk.thinking === "string") thinkingChars += chunk.thinking.length
      captureCounts(chunk)
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
      if (typeof chunk.thinking === "string") thinkingChars += chunk.thinking.length
      captureCounts(chunk)
      saw = true
    } catch {
      // Ignored — incomplete final line, what we already accumulated is what we got.
    }
  }

  if (!saw) {
    throw new Error("Ollama stream produced no chunks")
  }
  const usage: LlmUsage = {}
  if (promptEvalCount !== undefined) usage.inputTokens = promptEvalCount
  if (evalCount !== undefined) usage.outputTokens = evalCount
  const result: GenerateResult = { text: accumulated, usage }
  // SIG-287: surface the thinking-char count only when the model actually
  // reasoned. Omitted on the default-off `think:false` path (count stays 0)
  // so the result shape is byte-identical to before for non-reasoning calls.
  if (thinkingChars > 0) result.thinkingChars = thinkingChars
  return result
}
