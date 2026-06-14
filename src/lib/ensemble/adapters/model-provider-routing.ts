// SIG-405 (OpenRouter migration, Phase 2) — provider/key routing primitives.
//
// Split out of `model-provider.ts` to keep that adapter <=1000 lines (the same
// budget reason `model-provider-internals.ts` exists). PURE helpers with NO
// dependency on the `SPECIALIST_CONFIGS` lineup: the per-role provider override
// (logic→openai/o3 when the flag selects it), the env→key-set builder, and the
// per-config key selector that keeps the Ollama key off the OpenRouter route (and
// vice versa). `model-provider.ts` composes `specialistProviderOverride` with its
// local `SPECIALIST_CONFIGS` (override ?? lineup[role]), so this module needs no
// import from it — the dependency is one-way (no cycle).

import { isOpenRouterModel } from "@/src/shared/adapters/model"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"
import type { ModelProvider } from "@/src/lib/ensemble/domain/config"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

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
 * Logic on OpenRouter (`openai/o3`). `retries: 1` covers 429/502/503/network on
 * the new route (Codex #8); `fallback: null` because OpenRouter routes across
 * upstreams itself (and one key then serves the whole config — see
 * `selectConfigApiKey`); keeps logic's 120s per-attempt budget. Reasoning is
 * orthogonal (the SIG-287 harness): set `OPENCLAW_REASONING_*` to pin o3 at the
 * locked-lineup medium effort.
 */
const LOGIC_OPENROUTER_CONFIG: ModelConfig = {
  primary: "openai/o3",
  retries: 1,
  fallback: null,
  perAttemptTimeoutMs: 120_000,
}

/**
 * The provider-flag OVERRIDE config for a role, or `null` to use the default
 * `SPECIALIST_CONFIGS` Ollama lineup. logic→`openai/o3` when `providerByRole`
 * selects "openrouter"; `null` otherwise (and for every non-logic role today).
 * The empty map (default) always returns `null` → byte-identical to today.
 */
export function specialistProviderOverride(
  role: SpecialistRole,
  providerByRole: ReadonlyMap<SpecialistRole, ModelProvider>,
): ModelConfig | null {
  if (role === "logic" && providerByRole.get("logic") === "openrouter") return LOGIC_OPENROUTER_CONFIG
  return null
}

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
