// SIG-298 — the engine's model-call wrapper. Reuses the in-worker model-adapter
// seam (`chat` from src/shared/adapters/model) exactly like other features
// (e.g. learnings extractor, triage) — an in-process function call, NOT an HTTP
// self-call to our own Worker. Per-role model ids come from the resolved config
// (env-overridable); the provider API key is selected by model-id shape
// (OpenRouter id → OPENROUTER_API_KEY, `:cloud` tag → OLLAMA_API_KEY), the same
// shape routing the ensemble uses.

import { chat, isOpenRouterModel } from "@/src/shared/adapters/model"
import type { ChatArgs, ChatMessage, ChatToolDef, ToolCall } from "@/src/shared/ports/model"
import type { Env } from "@/src/shared/types/env"
import { stripThinking } from "./text-utils"
import type { ResearchConfig, ResearchModelRole } from "./types"

/** One model round-trip result: cleaned text + an estimated token count used
 *  for run-level budgeting. */
export interface ModelCallResult {
  text: string
  tokens: number
  toolCalls?: ToolCall[]
}

/** The injectable model function the engine depends on (fakeable in tests). */
export type ResearchModelFn = (
  role: ResearchModelRole,
  messages: ChatMessage[],
  tools?: ChatToolDef[],
) => Promise<ModelCallResult>

/** Rough token estimate when the provider doesn't report usage (~4 chars/token). */
function estimateTokens(messages: ChatMessage[], output: string): number {
  const inputChars = messages.reduce((n, m) => n + m.content.length, 0)
  return Math.ceil((inputChars + output.length) / 4)
}

/** Per-role model id from the resolved config. */
function modelForRole(config: ResearchConfig, role: ResearchModelRole): string {
  return config.models[role]
}

/**
 * Build the real model function bound to `env` + `config`. Throws
 * `MissingModelKeyError` when the selected provider's key is unset so the engine
 * fails fast with a clear error event rather than a confusing provider error.
 */
export function buildModelFn(env: Env, config: ResearchConfig): ResearchModelFn {
  const chatEnabled = env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off"
  return async (role, messages, tools) => {
    const model = modelForRole(config, role)
    const apiKey = isOpenRouterModel(model) ? env.OPENROUTER_API_KEY : env.OLLAMA_API_KEY
    if (!apiKey) throw new MissingModelKeyError(model)

    const args: ChatArgs = { model, apiKey, messages }
    if (tools?.length) {
      args.tools = tools
      // Tool selection is an auxiliary, single-pass decision and must not
      // inherit the provider adapter's ten-minute default.
      args.timeoutMs = 20_000
    }
    // OpenRouter models ignore chatEnabled; Ollama honors the kill-switch.
    if (!isOpenRouterModel(model)) args.chatEnabled = chatEnabled
    const result = await chat(args)
    const text = stripThinking(result.message.content ?? "")
    const reported = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
    const tokens = reported > 0 ? reported : estimateTokens(messages, text)
    return {
      text,
      tokens,
      ...(result.message.tool_calls?.length ? { toolCalls: result.message.tool_calls } : {}),
    }
  }
}

/** Thrown when a role's model has no configured provider key. */
export class MissingModelKeyError extends Error {
  constructor(model: string) {
    super(`no provider API key configured for research model "${model}"`)
    this.name = "MissingModelKeyError"
  }
}
