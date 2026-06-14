// Port: the model-provider contract (LLM `generate` + `chat`). Pure leaf,
// type-only — the seam that lets the concrete provider (Ollama today,
// OpenRouter later) be swapped without touching consumers (SIG-381 / SIG-318).
// The adapter in `src/shared/adapters/model` implements this; consumers depend
// on these types, never on a concrete provider module. Imports nothing.

/** SIG-212: token usage surfaced on `GenerateResult` / `ChatResult`.
 *  Fields are optional because non-Ollama providers may not surface
 *  them; emitters should omit rather than zero-fill (zero would skew
 *  aggregations). Shared by the generate + chat adapters. */
export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  /** SIG-417: actual per-call cost as reported by the provider's `usage.cost`
   *  (OpenRouter only; Ollama omits it). Denominated in OpenRouter CREDITS,
   *  which we treat as USD-equivalent (≈USD, not guaranteed — see
   *  `computeReviewCost`). Omitted — never zero-filled — when the provider
   *  didn't report it, so cost aggregation falls back to the `MODEL_PRICING`
   *  token estimate rather than logging a misleading $0. */
  costUsd?: number
}

export interface GenerateResult {
  text: string
  usage: LlmUsage
  /** SIG-287 (reasoning-on harness): cumulative LENGTH of the model's
   *  `thinking` field across the stream — never the CoT text itself, only
   *  its char count, so the soak can size reasoning time per role without
   *  ever logging chain-of-thought. Omitted when the model emitted no
   *  thinking (the default-off `think:false` path → 0 or absent). */
  thinkingChars?: number
}

export interface GenerateArgs {
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
  /**
   * SIG-287 (reasoning-on harness): the bounded DeepSeek reasoning level.
   * Set on a schema-constrained (`format`) call to send `think:"<level>"`
   * instead of the default `think:false`; undefined → `think:false` (the
   * byte-identical current behavior). `"high" | "medium" | "low"` are the
   * BOUNDED levels (a finite CoT then the answer) — never `think:true`
   * (unbounded), which SIG-287 proved stalls the per-attempt cap. Ignored
   * on free-form (format-less) calls, which keep the model default.
   */
  reasoning?: "high" | "medium" | "low"
}

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
  /** SIG-287 (reasoning-on harness): bounded DeepSeek reasoning level for a
   *  schema-constrained (`format`) call. Same semantics as `GenerateArgs.reasoning`
   *  — undefined → `think:false` (byte-identical current behavior); set →
   *  `think:"<level>"`. Ignored on format-less / tool-call turns. */
  reasoning?: "high" | "medium" | "low"
}

export interface ChatResult {
  /** The assistant message the model emitted this turn. */
  message: ChatMessage
  /** True iff `Array.isArray(message.tool_calls) && message.tool_calls.length > 0`.
   *  Empty array unambiguously means final-answer (no tool calls). */
  hasToolCalls: boolean
  /** SIG-212: token usage as reported by Ollama's final stream chunk.
   *  Optional on the type so test mocks and alternative `ChatResult`
   *  producers don't have to provide it. The production `chat()` path
   *  ALWAYS sets this field (possibly to `{}` when neither count was
   *  reported), so callers in the ensemble can safely assume it
   *  exists for real LLM round-trips. Aggregators treat each missing
   *  field within `usage` as "no data," not zero. */
  usage?: LlmUsage
  /** SIG-287 (reasoning-on harness): cumulative LENGTH of the assistant
   *  message's `thinking` field across the stream — char count only, never
   *  the CoT text. Omitted when the model emitted no thinking (default-off
   *  `think:false` path). Optional so test mocks / non-Ollama producers
   *  needn't supply it. */
  thinkingChars?: number
}

/**
 * The model-provider seam. An adapter (Ollama today, OpenRouter later)
 * implements this; the app/consumers depend on the interface. Mirrors the
 * current free-function call shape exactly — zero behavior change.
 */
export interface ModelProviderPort {
  generate(args: GenerateArgs): Promise<GenerateResult>
  chat(args: ChatArgs): Promise<ChatResult>
}
