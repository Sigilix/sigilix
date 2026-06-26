// SIG-369(b) PR-1 — the single-model-attempt helper (`attemptChat`), lifted out
// of `./model-provider.ts` to keep that adapter under the 1k COMPLIANCE.md §4 cap
// (the SIG-386 spill-sibling pattern). Relocation + the SIG-369(b) per-call
// telemetry additions; the model-call / parse / usage-capture behavior is
// unchanged. `model-provider.ts`'s `runWithRetryAndFallback` imports it.
//
// One LLM round-trip: either a single-shot `chat()` (the usual path) or the
// two-call tool conversation (`runSpecialistToolConversation`, when MCP tools +
// a final schema are present). Returns the parsed verdict (or a structured
// parse/exception failure) plus the usage + SIG-369(b) per-call input split so
// the caller can both charge cost and decompose the logic input.

import { chat } from "@/src/shared/adapters/model"
import type { ChatArgs, ChatMessage, ChatResult } from "@/src/shared/ports/model"
import { isProviderRateLimit } from "@/src/shared/adapters/model/provider-errors"
import {
  runSpecialistToolConversation,
  type SpecialistRuntimeTool,
  type ToolConversationStats,
} from "./specialist-tool-loop"

export interface AttemptChatArgs<T> {
  model: string
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
  /** SIG-287: bounded reasoning level for THIS attempt. Only the primary loop
   *  passes it; the fallback attempt omits it (stays `think:false`). */
  reasoning?: "high" | "medium" | "low"
  /** SIG-460: OpenRouter provider-routing for THIS attempt — `runWithRetryAndFallback`
   *  passes `{ ignore: [<slug>] }` to steer a retry off a provider that failed mid-
   *  stream on a prior attempt. Threaded to BOTH the single-shot and tool-conversation
   *  `chat` calls. (In practice only the single-shot stream path produces the
   *  `Upstream error from <provider>` failures that populate the exclusion — the tool
   *  path is non-streaming — but threading both keeps the routing consistent.) */
  provider?: ChatArgs["provider"]
  specialistTools?: SpecialistRuntimeTool[]
}

export interface AttemptChatResult<T> {
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  // SIG-212: usage is present on BOTH success and parse-failure paths
  // (chat() round-trip completed, model consumed tokens producing the
  // output — even if that output didn't parse). Absent on the
  // exception path where no tokens were exchanged.
  inputTokens?: number
  outputTokens?: number
  // SIG-417: actual per-call cost (credits ≈ USD), same paths as the tokens.
  costUsd?: number
  // SIG-287: cumulative thinking-char count from the adapter (length only).
  thinkingChars?: number
  // SIG-369(b): per-CALL input split + tool-loop stats (see AttemptCallbackInfo).
  // Single-shot: perCallInputTokens has one entry; tool path: two (tool-turn,
  // final). Absent on the exception path. Telemetry only.
  perCallInputTokens?: Array<number | undefined>
  toolCallsMade?: number
  toolResultTokens?: number
  // SIG-455 (PR B Task 5): the Retry-After delay (ms) when the provider returned
  // a 429/503. Absent when the failure was not a provider rate-limit.
  providerRateLimitMs?: number
}

export async function attemptChat<T>(args: AttemptChatArgs<T>): Promise<AttemptChatResult<T>> {
  try {
    const usesTools = Boolean(args.specialistTools && args.specialistTools.length > 0 && args.format)
    // SIG-369(b): capture the tool conversation's per-call stats from the
    // typed tool-branch result, so the two model calls (tool-turn + final) are
    // visible separately. Undefined on the single-shot path.
    let toolConversation: ToolConversationStats | undefined
    let result: ChatResult
    if (usesTools) {
      const toolResult = await runSpecialistToolConversation({
        chat,
        model: args.model,
        messages: args.messages,
        apiKey: args.apiKey,
        signal: args.signal,
        chatEnabled: args.chatEnabled,
        tools: args.specialistTools!,
        format: args.format!,
        ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}), // SIG-460
        temperature: 0,
      })
      toolConversation = toolResult.toolConversation
      result = toolResult
    } else {
      result = await chat({
        model: args.model,
        messages: args.messages,
        apiKey: args.apiKey,
        signal: args.signal,
        chatEnabled: args.chatEnabled,
        ...(args.format ? { format: args.format } : {}),
        // SIG-287: byte-identical when undefined (default-off → think:false).
        ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
        // SIG-460: byte-identical when undefined (first attempt); set on a retry that
        // is steering off a provider which failed mid-stream on a prior attempt.
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        temperature: 0,
      })
    }
    // SIG-212: capture token usage from chat()'s result. Forward on
    // BOTH success and parse-failure paths so cost telemetry stays
    // accurate even when the model produced unparseable output.
    // `usage` is optional on ChatResult to keep test mocks lightweight;
    // the production accumulator always returns `usage: {...}`. SIG-287:
    // thinkingChars rides alongside usage on the same paths.
    const usagePayload: { inputTokens?: number; outputTokens?: number; costUsd?: number; thinkingChars?: number } = {}
    if (result.usage?.inputTokens !== undefined) usagePayload.inputTokens = result.usage.inputTokens
    if (result.usage?.outputTokens !== undefined) usagePayload.outputTokens = result.usage.outputTokens
    // SIG-417: capture the actual per-call cost when the provider reported it.
    if (result.usage?.costUsd !== undefined) usagePayload.costUsd = result.usage.costUsd
    if (result.thinkingChars !== undefined) usagePayload.thinkingChars = result.thinkingChars
    // SIG-369(b): the per-call input split. The tool conversation reports both
    // calls (`toolConversation`); the single-shot path is one call whose input
    // tokens are this result's `usage.inputTokens` (kept undefined-preserving so
    // a no-usage call stays distinct from a 0-token one).
    const compositionPayload: {
      perCallInputTokens: Array<number | undefined>
      toolCallsMade?: number
      toolResultTokens?: number
    } =
      toolConversation !== undefined
        ? {
            perCallInputTokens: toolConversation.perCallInputTokens,
            toolCallsMade: toolConversation.toolCallsMade,
            toolResultTokens: toolConversation.toolResultTokens,
          }
        : { perCallInputTokens: [result.usage?.inputTokens] }
    const verdict = args.parseAnswer(result.message.content)
    if (!verdict) {
      return {
        verdict: null,
        failureReason: args.parseFailureLabel,
        failureRawAnswer: result.message.content.slice(0, 32_000),
        ...usagePayload,
        ...compositionPayload,
      }
    }
    return { verdict, ...usagePayload, ...compositionPayload }
  } catch (e) {
    return {
      verdict: null,
      failureReason: e instanceof Error ? e.message : String(e),
      ...(isProviderRateLimit(e) ? { providerRateLimitMs: e.retryAfterMs } : {}),
    }
  }
}
