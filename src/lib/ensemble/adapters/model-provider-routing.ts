// SIG-405/406 — per-model API-key selection (key-by-id-shape).
//
// PURE helpers (no dependency on the `SPECIALIST_CONFIGS` lineup): the env→key-set
// builder + the per-config key selector that routes the OpenRouter key to OpenRouter
// ids and the Ollama key to `:cloud` tags. That shape routing is what lets a LOCAL
// eval run hit Ollama Turbo (a `:cloud` model override → the Ollama key) with NO
// OpenRouter spend, while prod runs all-OpenRouter.
//
// Bedrock-ensemble migration: a THIRD provider joins the key set — AWS Bedrock,
// whose "key" is the packed credential envelope (`packBedrockApiKey`) riding the
// single-string `apiKey` slot the whole retry plumbing already threads. Because
// the Bedrock lineup deliberately falls back CROSS-PROVIDER to today's OpenRouter
// models (Bedrock outage → degrade, not fail), `resolveConfigKeys` (below) selects
// a key PER LEG — the one-key `selectConfigApiKey` remains for the single-provider
// callers (extractors, CI triage) and keeps its mixed-provider throw.

import { isBedrockModel, isOpenRouterModel } from "@/src/shared/adapters/model"
import { packBedrockApiKey } from "@/src/shared/adapters/model/bedrock-chat"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"

/** The provider API keys, selected per model by `selectModelApiKey`. All
 *  optional: a run that selects a provider whose key is unset fails closed.
 *  `bedrock` is the packed credential envelope, present only when ALL THREE
 *  AWS values are configured (never a partial credential). */
export interface ModelApiKeys {
  ollama: string | undefined
  openrouter: string | undefined
  bedrock?: string | undefined
}

/** Build the key set from the Worker env — the single definition of which env
 *  fields are model API keys (narrow structural param, no full `Env` import). */
export function modelApiKeys(env: {
  OLLAMA_API_KEY: string
  OPENROUTER_API_KEY?: string | undefined
  AWS_ACCESS_KEY_ID?: string | undefined
  AWS_SECRET_ACCESS_KEY?: string | undefined
  AWS_REGION?: string | undefined
}): ModelApiKeys {
  // Bedrock needs all three (id + secret + region); any one missing → the
  // provider is simply unconfigured (undefined → fail closed per call, and the
  // Bedrock lineup itself never activates — see resolveBedrockSpecialistConfig).
  const bedrock =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION
      ? packBedrockApiKey({
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          region: env.AWS_REGION,
        })
      : undefined
  return { ollama: env.OLLAMA_API_KEY, openrouter: env.OPENROUTER_API_KEY, bedrock }
}

type ModelProvider = "bedrock" | "openrouter" | "ollama"

function providerOf(model: string): ModelProvider {
  if (isBedrockModel(model)) return "bedrock"
  return isOpenRouterModel(model) ? "openrouter" : "ollama"
}

/** The key for ONE model, by id shape (Bedrock registry id → the packed Bedrock
 *  envelope; slash id → OpenRouter; else Ollama). `undefined` when that
 *  provider's key is unset → the caller fails closed (never substitutes). */
export function selectModelApiKey(model: string, keys: ModelApiKeys): string | undefined {
  const provider = providerOf(model)
  if (provider === "bedrock") return keys.bedrock
  return provider === "openrouter" ? keys.openrouter : keys.ollama
}

/**
 * The single API key that serves an entire `ModelConfig` (primary + any
 * fallback). For callers that thread ONE key for every attempt, so this enforces
 * the invariant: a non-null fallback MUST be the same provider as the primary.
 * Returns `undefined` when the selected provider's key is unset → the caller
 * fails closed (never substitutes another provider's key). THROWS on a
 * cross-provider primary+fallback — a config bug the one-key path cannot serve;
 * fail loud rather than send the wrong key. No shipped single-key config trips
 * this (proven by the invariant test); the guard protects future edits. The
 * cross-provider Bedrock lineup does NOT use this — it goes through
 * `resolveConfigKeys`, which selects a key per leg.
 */
export function selectConfigApiKey(config: ModelConfig, keys: ModelApiKeys): string | undefined {
  if (config.fallback !== null && providerOf(config.fallback) !== providerOf(config.primary)) {
    throw new Error(
      `model config mixes providers (primary=${config.primary}, fallback=${config.fallback}); ` +
        `the single-key runner cannot serve both — drop the fallback or keep both on one provider`,
    )
  }
  return selectModelApiKey(config.primary, keys)
}

/**
 * Bedrock-ensemble migration: per-LEG key resolution for the retry runner.
 * Selects the primary's key and — when the config carries a fallback — the
 * fallback's key by ITS OWN id shape, so a Bedrock primary can degrade to the
 * OpenRouter fallback leg. Fail-closed per leg, never per config: a fallback
 * whose provider key is unset STRIPS the fallback (the primary still runs)
 * rather than failing the whole role or borrowing the wrong key.
 * `fallbackApiKey` is set only when it differs from the primary key (the
 * same-provider case keeps today's single-key behavior byte-identical).
 */
export function resolveConfigKeys(
  config: ModelConfig,
  keys: ModelApiKeys,
): { config: ModelConfig; apiKey: string | undefined; fallbackApiKey?: string } {
  const apiKey = selectModelApiKey(config.primary, keys)
  if (config.fallback === null) return { config, apiKey }
  const fallbackKey = selectModelApiKey(config.fallback, keys)
  if (fallbackKey === undefined) return { config: { ...config, fallback: null }, apiKey }
  return fallbackKey === apiKey ? { config, apiKey } : { config, apiKey, fallbackApiKey: fallbackKey }
}
