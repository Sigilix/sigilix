// SIG-405/406 — per-model API-key selection (key-by-id-shape).
//
// PURE helpers (no dependency on the `SPECIALIST_CONFIGS` lineup): the env→key-set
// builder + the per-config key selector that routes the OpenRouter key to OpenRouter
// ids and the Ollama key to `:cloud` tags. That shape routing is what lets a LOCAL
// eval run hit Ollama Turbo (a `:cloud` model override → the Ollama key) with NO
// OpenRouter spend, while prod runs all-OpenRouter.

import { isOpenRouterModel } from "@/src/shared/adapters/model"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"

/** The provider API keys, selected per model by `selectConfigApiKey`. Both
 *  optional: a run that selects a provider whose key is unset fails closed. */
export interface ModelApiKeys {
  ollama: string | undefined
  openrouter: string | undefined
}

/** Build the key set from the Worker env — the single definition of which env
 *  fields are model API keys (narrow structural param, no full `Env` import). */
export function modelApiKeys(env: { OLLAMA_API_KEY: string; OPENROUTER_API_KEY?: string | undefined }): ModelApiKeys {
  return { ollama: env.OLLAMA_API_KEY, openrouter: env.OPENROUTER_API_KEY }
}

/**
 * Logic on OpenRouter (`moonshotai/kimi-k2.7-code`, SIG-450 — was `openai/o3`).
 * `retries: 1` covers 429/502/503/network on the route (Codex #8); `fallback: null`
 * because OpenRouter routes across upstreams itself (and one key then serves the
 * whole config — see `selectConfigApiKey`); keeps logic's 120s per-attempt budget.
 * Reasoning is orthogonal (the SIG-287 harness): set `OPENCLAW_REASONING_*` to pin
 * logic at the screened HIGH effort (per-role `logic:high` token).
 */
/**
 * The single API key that serves an entire `ModelConfig` (primary + any
 * fallback). The runner uses ONE key for every attempt, so this enforces the
 * invariant: a non-null fallback MUST be the same provider as the primary (both
 * Ollama tags, or both OpenRouter ids). Returns `undefined` when the selected
 * provider's key is unset → the caller fails closed (never substitutes the other
 * provider's key). THROWS on a cross-provider primary+fallback — a config bug the
 * one-key runner cannot serve; fail loud rather than send the wrong key. No
 * shipped config trips this (proven by the invariant test); the guard protects
 * future edits.
 */
export function selectConfigApiKey(config: ModelConfig, keys: ModelApiKeys): string | undefined {
  if (config.fallback !== null && isOpenRouterModel(config.fallback) !== isOpenRouterModel(config.primary)) {
    throw new Error(
      `model config mixes providers (primary=${config.primary}, fallback=${config.fallback}); ` +
        `the single-key runner cannot serve both — drop the fallback or keep both on one provider`,
    )
  }
  return isOpenRouterModel(config.primary) ? keys.openrouter : keys.ollama
}
