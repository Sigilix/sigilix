// Bedrock-ensemble migration — the AWS Bedrock Runtime `Converse` adapter.
//
// Implements the SAME `chat(args: ChatArgs): Promise<ChatResult>` contract as
// `ollama-chat.ts` / `openrouter-chat.ts` so consumers (and the model port) are
// untouched. The barrel's router picks this adapter for Bedrock-shaped model
// ids (a known vendor/geo prefix before the first ".", e.g. "deepseek.v3.2",
// "us.anthropic.claude-sonnet-5") — see `isBedrockModel` in `./index.ts`.
//
// Endpoint: https://bedrock-runtime.<region>.amazonaws.com/model/<id>/converse
// Auth:     AWS SigV4 (hand-rolled Web-Crypto signer — the AWS Node SDK's HTTP
//           stack does not run on workerd; `@/src/shared/adapters/aws-sigv4` is
//           the same signer the boreas-gateway Bedrock leg uses, test-verified
//           against an independent node:crypto reimplementation).
//
// CREDENTIALS — the packed-key envelope: the entire ensemble plumbing threads a
// single `apiKey: string` per call (runWithRetryAndFallback → attemptChat →
// chat). Bedrock needs THREE values (key id + secret + region), so
// `packBedrockApiKey` (below) serializes them into one JSON envelope string
// that rides the existing `apiKey` slot; this adapter unpacks it. The envelope
// is produced ONLY by `modelApiKeys(env)` from Worker secrets — it is never
// logged, persisted, or echoed in an error message.
//
// COST — Bedrock reports token counts but NO per-call cost (OpenRouter's
// `usage.cost` has no Converse equivalent). This adapter COMPUTES `usage.costUsd`
// from the `MODEL_PRICING` table (`computeCostUsd`) on every priced response.
// Load-bearing: `usage_ledger.cost_usd` and the SIGILIX_RATE_LIMIT_MODE=enforce
// cost gate are fed from this value — a $0 here would silently disarm
// enforcement. Belt-and-suspenders: the same table rows also back the
// `computeReviewCost` unpriced-token estimate, so even a future code path that
// drops `costUsd` still prices Bedrock tokens correctly.
//
// KNOWN LIMITATIONS (deliberate v1 scope, mirrored on the boreas-gateway leg):
//   - NON-STREAMING: `converse-stream` uses `vnd.amazon.eventstream` binary
//     framing (not SSE); v1 buffers the single Converse response. The four
//     migrated roles run FAST models (founder's latency pick) and the
//     per-attempt cap + OpenRouter fallback leg bound a hung read.
//   - `format` (JSON Schema): Converse has no `response_format`; the schema is
//     injected as a hard system instruction. A malformed answer is a normal
//     parse failure → same-model retry → cross-provider OpenRouter fallback.
//   - `reasoning`: no portable Converse knob across the migrated models —
//     ignored (the OpenRouter default path is unaffected; security runs
//     reasoning-off by design and the founder chose the FAST DeepSeek here).
//   - `provider` routing (SIG-460): OpenRouter-only concept — ignored.
//
// Error wording is `Bedrock HTTP <status>: ...` so the shared classifiers
// (`isPermanentFailure` — generic `HTTP \d{3}` match) route 4xx to break-early
// and 5xx/429 to retry/fallback exactly like the other adapters; 429/503 throw
// the typed `ProviderRateLimitError` (SIG-455 backpressure).

import type { ChatArgs, ChatMessage, ChatResult, LlmUsage, ToolCall } from "@/src/shared/ports/model"
import { signAwsRequestV4 } from "@/src/shared/adapters/aws-sigv4"
import { parseRetryAfterMs } from "@/src/shared/util/retry-after"
import { ProviderRateLimitError } from "@/src/shared/adapters/model/provider-errors"
import { isAnthropicModel, sanitizeSchemaForAnthropic } from "@/src/shared/adapters/model/anthropic-schema"
import { computeCostUsd } from "@/src/shared/domain/model-pricing"

/** SigV4 service name for the Bedrock RUNTIME data plane. */
const BEDROCK_SIGV4_SERVICE = "bedrock"

/** Default cooldown when no `Retry-After` header is present on a 429/503. */
const DEFAULT_PROVIDER_COOLDOWN_MS = 20_000

// Converse `inferenceConfig.maxTokens`. Sized for the largest structured verdict
// we emit (specialist/synth JSON, well under 8k tokens) while staying inside
// every migrated model's output ceiling — a too-large value is a Bedrock
// ValidationException (HTTP 400 = permanent) on the smaller models, which would
// hard-fail the role instead of degrading. A `max_tokens` stop throws below
// (transient) rather than salvaging a truncated verdict.
const DEFAULT_MAX_TOKENS = 8_192

export interface BedrockCredentials {
  accessKeyId: string
  secretAccessKey: string
  region: string
}

/**
 * Serialize Bedrock credentials into the single-string `apiKey` envelope (see
 * file header). Versioned so a future shape change is detectable at unpack.
 */
export function packBedrockApiKey(creds: BedrockCredentials): string {
  return JSON.stringify({ v: 1, ...creds })
}

/** Unpack the envelope; throws a NON-retryable (400-worded) error on a
 *  malformed value — a bad envelope is a config bug, not a transient. */
export function unpackBedrockApiKey(apiKey: string): BedrockCredentials {
  try {
    const parsed = JSON.parse(apiKey) as Partial<BedrockCredentials> & { v?: number }
    if (
      parsed.v === 1 &&
      typeof parsed.accessKeyId === "string" &&
      typeof parsed.secretAccessKey === "string" &&
      typeof parsed.region === "string"
    ) {
      return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey, region: parsed.region }
    }
  } catch {
    // fall through to the structured throw below
  }
  // Deliberately echoes NOTHING from the input (it may be a real key of the
  // wrong provider). "HTTP 400" wording → isPermanentFailure → break-early.
  throw new Error("Bedrock HTTP 400: apiKey is not a packed Bedrock credential envelope (see modelApiKeys)")
}

/** The Converse data-plane URL. The model id is URI-encoded — inference-profile
 *  ids ("us.anthropic....") and versioned ids ("...-v1:0") carry `.`/`:`. */
export function bedrockConverseUrl(region: string, modelId: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`
}

// ── request translation ──────────────────────────────────────────────

type ConverseContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }> } }

interface ConverseMessage {
  role: "user" | "assistant"
  content: ConverseContentBlock[]
}

function parseToolInput(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args !== "string") return args
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // fall through — Converse requires an object input
  }
  return {}
}

/**
 * Translate the port's `ChatMessage[]` into Converse `system` + `messages`.
 * Converse requires STRICTLY ALTERNATING user/assistant turns, has no system
 * role inside `messages`, and models tool exchanges as content blocks:
 * assistant `tool_calls` → `toolUse` blocks; role:"tool" replies → a USER turn
 * of `toolResult` blocks. Adjacent same-role turns are MERGED (text turns
 * concatenate; block turns append) and empty text turns are dropped — the same
 * discipline the boreas-gateway translator uses.
 */
export function chatMessagesToConverse(messages: ChatMessage[]): {
  system: Array<{ text: string }>
  converseMessages: ConverseMessage[]
} {
  const system: Array<{ text: string }> = []
  const out: ConverseMessage[] = []
  const push = (role: "user" | "assistant", blocks: ConverseContentBlock[]): void => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  let syntheticToolId = 0
  // Code-reviewer catch: when the provider omitted BOTH `call.id` and the
  // reply's `tool_call_id`, a shared counter would mint DIFFERENT ids for the
  // toolUse and its toolResult (Converse rejects the unpaired result). Queue
  // each synthetic toolUse id so the next id-less toolResult REUSES it —
  // Ollama pairs by message ordering, which is exactly this FIFO.
  const pendingSyntheticIds: string[] = []
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) system.push({ text: m.content })
      continue
    }
    if (m.role === "tool") {
      push("user", [
        {
          toolResult: {
            toolUseId: m.tool_call_id ?? pendingSyntheticIds.shift() ?? `tool-${syntheticToolId++}`,
            content: [{ text: m.content }],
          },
        },
      ])
      continue
    }
    const blocks: ConverseContentBlock[] = []
    if (m.content) blocks.push({ text: m.content })
    if (m.role === "assistant" && m.tool_calls) {
      for (const call of m.tool_calls) {
        let toolUseId = call.id
        if (toolUseId === undefined) {
          toolUseId = `tool-${syntheticToolId++}`
          pendingSyntheticIds.push(toolUseId)
        }
        blocks.push({
          toolUse: {
            toolUseId,
            name: call.function.name,
            input: parseToolInput(call.function.arguments),
          },
        })
      }
    }
    push(m.role === "assistant" ? "assistant" : "user", blocks)
  }
  return { system, converseMessages: out }
}

// ── response translation ─────────────────────────────────────────────

interface ConverseResponse {
  output?: {
    message?: {
      content?: Array<{
        text?: string
        toolUse?: { toolUseId?: string; name?: string; input?: Record<string, unknown> }
        reasoningContent?: { reasoningText?: { text?: string } }
      }>
    }
  }
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

// ── the adapter ──────────────────────────────────────────────────────

export async function chat(args: ChatArgs): Promise<ChatResult> {
  if (args.chatEnabled === "off") {
    throw new Error("OPENCLAW chat disabled (chatEnabled=off)")
  }
  const creds = unpackBedrockApiKey(args.apiKey)

  const timeoutMs = args.timeoutMs ?? 600_000
  const internalCtrl = new AbortController()
  const timer = setTimeout(() => internalCtrl.abort(), timeoutMs)
  const onExternalAbort = (): void => internalCtrl.abort()
  args.signal?.addEventListener("abort", onExternalAbort, { once: true })
  if (args.signal?.aborted) internalCtrl.abort()

  try {
    const { system, converseMessages } = chatMessagesToConverse(args.messages)
    const usesTools = Boolean(args.tools && args.tools.length > 0)
    if (!usesTools && args.format) {
      // Converse has no response_format — enforce the schema by instruction
      // (see file header; a glitch is a normal parse failure → retry/fallback).
      // Anthropic-on-Bedrock rejects the JSON-Schema validation keyword family
      // (min/max, minItems/maxItems, pattern, format, …) on typed nodes, so strip
      // them from the copy embedded for Anthropic ids only; every other Bedrock
      // id embeds the original `args.format` — byte-identical to today.
      const schema = isAnthropicModel(args.model) ? sanitizeSchemaForAnthropic(args.format) : args.format
      system.push({
        text:
          "You MUST respond with a SINGLE JSON object that conforms to this JSON Schema. " +
          "No markdown fences, no prose before or after the object.\n" +
          JSON.stringify(schema),
      })
    }
    const body: Record<string, unknown> = {
      messages: converseMessages,
      inferenceConfig: {
        temperature: args.temperature ?? (args.format ? 0 : 0.2),
        maxTokens: DEFAULT_MAX_TOKENS,
      },
    }
    if (system.length > 0) body.system = system
    if (usesTools) {
      body.toolConfig = {
        tools: args.tools!.map((t) => ({
          toolSpec: {
            name: t.function.name,
            description: t.function.description,
            inputSchema: { json: t.function.parameters },
          },
        })),
      }
    }

    const url = bedrockConverseUrl(creds.region, args.model)
    const bodyStr = JSON.stringify(body)
    const signed = await signAwsRequestV4({
      method: "POST",
      url,
      region: creds.region,
      service: BEDROCK_SIGV4_SERVICE,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      extraHeaders: { "content-type": "application/json" },
      body: bodyStr,
    })

    const res = await fetch(url, {
      method: "POST",
      headers: signed.headers,
      body: bodyStr,
      signal: internalCtrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (res.status === 429 || res.status === 503) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), Date.now(), DEFAULT_PROVIDER_COOLDOWN_MS)
        throw new ProviderRateLimitError(`Bedrock HTTP ${res.status}: ${text.slice(0, 500)}`, retryAfterMs)
      }
      throw new Error(`Bedrock HTTP ${res.status}: ${text.slice(0, 500)}`)
    }

    const parsed = (await res.json()) as ConverseResponse
    const blocks = parsed.output?.message?.content ?? []
    const text = blocks.map((b) => b.text ?? "").join("")
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.toolUse?.name)
      .map((b, i) => ({
        id: b.toolUse!.toolUseId ?? `tool-${i}`,
        function: { name: b.toolUse!.name!, arguments: b.toolUse!.input ?? {} },
      }))
    // Mirror the OpenRouter truncation guard: a `max_tokens` stop means the
    // verdict JSON is CUT — jsonrepair would auto-close it into a 0-finding
    // "clean" review (a silent false sign-off). Throw transient (no HTTP token)
    // so the retry ladder / OpenRouter fallback re-runs instead.
    if (parsed.stopReason === "max_tokens" && toolCalls.length === 0) {
      throw new Error("Bedrock response hit maxTokens (truncated output)")
    }

    const usage: LlmUsage = {}
    if (typeof parsed.usage?.inputTokens === "number") usage.inputTokens = parsed.usage.inputTokens
    if (typeof parsed.usage?.outputTokens === "number") usage.outputTokens = parsed.usage.outputTokens
    // Compute the per-call cost Bedrock doesn't report (see file header). Omit —
    // never zero-fill — when Bedrock reported no token counts at all, so the
    // downstream aggregation falls back to its unpriced-token estimate.
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
      usage.costUsd = computeCostUsd(args.model, usage.inputTokens, usage.outputTokens)
    }

    const thinkingChars = blocks.reduce((n, b) => n + (b.reasoningContent?.reasoningText?.text?.length ?? 0), 0)
    const message: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }
    const result: ChatResult = { message, hasToolCalls: toolCalls.length > 0, usage }
    if (thinkingChars > 0) result.thinkingChars = thinkingChars
    return result
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener("abort", onExternalAbort)
  }
}
