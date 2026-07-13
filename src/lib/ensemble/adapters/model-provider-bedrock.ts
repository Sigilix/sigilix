// Bedrock-ensemble migration — the AWS Bedrock review lineup + the
// `SIGILIX_ENSEMBLE_PROVIDER` flag resolution (adapters layer, a
// `model-provider.ts` spill-sibling like `-routing`/`-attempt`).
//
// WHY: the founder pays review model spend personally (~$0.25/review measured
// via `usage_ledger.cost_usd`) and holds ~$1,000 of AWS credits — moving the
// ensemble's Bedrock-servable roles onto Bedrock spends credits instead of
// cash. FOUR roles migrate (security, tests, performance, synth); LOGIC ships on
// OpenRouter v4-pro (`deepseek/deepseek-v4-pro`, 2026-07-13) with an Ollama Turbo
// v4-pro fallback — off Bedrock — so the Bedrock logic entry stays a SELECTABLE
// bake-off candidate only (Claude Sonnet 5 + Mistral Large 3 wired below, nothing
// more; Anthropic Bedrock access is still AccessDenied as of 2026-07-12).
//
// DEFAULT-OFF: with `SIGILIX_ENSEMBLE_PROVIDER` unset (or ANY unrecognized
// value) every resolver here returns `undefined` and the shipped OpenRouter
// lineup (`SPECIALIST_CONFIGS` / `SYNTHESIZER_CONFIG`) runs byte-identically.
// Same when AWS credentials are incomplete — flipping the flag without creds
// degrades to OpenRouter instead of failing roles closed.
//
// DECORRELATION (SIG-406): the migrated-family split survives the migration —
// security+tests=DeepSeek, performance=GLM (Z.ai), synth=Nvidia (logic ships on
// OpenRouter v4-pro, outside this lineup). The synth stays a generalist
// adjudicator decorrelated from every specialist family, so it remains an
// unbiased judge with no self-preference. Do not collapse families when editing
// this lineup.
//
// ATTEMPT-COUNT PARITY: each Bedrock config's `maxAttempts` EQUALS its
// OpenRouter counterpart's (retries traded for the cross-provider OpenRouter
// fallback leg), so `MAX_CALLS_PER_ENSEMBLE_RUN` — derived from the OpenRouter
// configs at admission time — remains a true worst-case bound either way.
//
// FALLBACK = TODAY'S SHIPPED MODEL per role: a Bedrock outage degrades to exactly
// the lineup that runs today (keys resolved per leg by `resolveConfigKeys` — the
// Bedrock envelope for the primary, and the OpenRouter key for the OpenRouter
// fallbacks, incl. logic's `deepseek/deepseek-v4-pro` fallback).

import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"
import { SPECIALIST_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"

/** The roles the provider flag can steer (the four specialists + synth). */
export type EnsembleProviderRole = SpecialistRole | "synth"

export type EnsembleProvider = "openrouter" | "bedrock"

/** Narrow structural env param (no full `Env` import) — the provider flags +
 *  the AWS credential presence check. All optional: absent → OpenRouter. */
export interface EnsembleProviderEnv {
  SIGILIX_ENSEMBLE_PROVIDER?: string | undefined
  SIGILIX_ENSEMBLE_PROVIDER_LOGIC?: string | undefined
  SIGILIX_ENSEMBLE_PROVIDER_SECURITY?: string | undefined
  SIGILIX_ENSEMBLE_PROVIDER_PERFORMANCE?: string | undefined
  SIGILIX_ENSEMBLE_PROVIDER_TESTS?: string | undefined
  SIGILIX_ENSEMBLE_PROVIDER_SYNTH?: string | undefined
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_LOGIC?: string | undefined
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_SECURITY?: string | undefined
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_PERFORMANCE?: string | undefined
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_TESTS?: string | undefined
  SIGILIX_ENSEMBLE_BEDROCK_MODEL_SYNTH?: string | undefined
  AWS_ACCESS_KEY_ID?: string | undefined
  AWS_SECRET_ACCESS_KEY?: string | undefined
  AWS_REGION?: string | undefined
}

/**
 * The Bedrock lineup (us-east-1 ids, live-verified via a real Converse call
 * 2026-07-12). Security keeps the FAST DeepSeek deliberately (founder's
 * latency pick — security is on the review's critical path); logic's entry is
 * a BAKE-OFF CANDIDATE ONLY (see header), reachable solely via the explicit
 * per-role flag, with Mistral Large 3 selectable through the model-id override.
 */
export const BEDROCK_SPECIALIST_CONFIGS: Record<SpecialistRole, ModelConfig> = {
  // logic candidate — us.anthropic.claude-sonnet-5 (an inference-profile id:
  // Anthropic on Bedrock requires the `us.` cross-region profile). NOT the
  // default logic path: it activates only via SIGILIX_ENSEMBLE_PROVIDER_LOGIC.
  logic: {
    primary: "us.anthropic.claude-sonnet-5",
    // retries:2 (2026-07-13): matches prod logic's maxAttempts (1+2 retries+fallback = 4)
    // after logic gained its cross-provider fallback, preserving attempt-count parity.
    retries: 2,
    fallback: "deepseek/deepseek-v4-pro", // today's logic primary (OpenRouter v4-pro, 2026-07-13) — degrade to the shipped model
    perAttemptTimeoutMs: SPECIALIST_TIMEOUT_MS,
  },
  security: {
    primary: "deepseek.v3.2",
    retries: 2,
    fallback: "deepseek/deepseek-v4-flash", // today's security primary (OpenRouter leg)
    perAttemptTimeoutMs: SPECIALIST_TIMEOUT_MS,
  },
  performance: {
    primary: "zai.glm-5",
    retries: 1,
    fallback: "z-ai/glm-5.1", // today's performance primary (OpenRouter leg)
    perAttemptTimeoutMs: SPECIALIST_TIMEOUT_MS,
  },
  tests: {
    primary: "deepseek.v3.2",
    retries: 0,
    fallback: "deepseek/deepseek-v4-pro", // today's tests primary (OpenRouter leg)
    perAttemptTimeoutMs: SPECIALIST_TIMEOUT_MS,
  },
}

export const BEDROCK_SYNTHESIZER_CONFIG: ModelConfig = {
  primary: "nvidia.nemotron-super-3-120b",
  retries: 0,
  fallback: "nvidia/nemotron-3-ultra-550b-a55b", // today's synth (OpenRouter leg)
  perAttemptTimeoutMs: 150_000, // matches SYNTHESIZER_CONFIG's per-attempt cap
}

function normalizeProvider(raw: string | undefined): EnsembleProvider | undefined {
  return raw === "bedrock" || raw === "openrouter" ? raw : undefined
}

function perRoleFlag(env: EnsembleProviderEnv, role: EnsembleProviderRole): string | undefined {
  switch (role) {
    case "logic":
      return env.SIGILIX_ENSEMBLE_PROVIDER_LOGIC
    case "security":
      return env.SIGILIX_ENSEMBLE_PROVIDER_SECURITY
    case "performance":
      return env.SIGILIX_ENSEMBLE_PROVIDER_PERFORMANCE
    case "tests":
      return env.SIGILIX_ENSEMBLE_PROVIDER_TESTS
    case "synth":
      return env.SIGILIX_ENSEMBLE_PROVIDER_SYNTH
  }
}

function perRoleModelOverride(env: EnsembleProviderEnv, role: EnsembleProviderRole): string | undefined {
  switch (role) {
    case "logic":
      return env.SIGILIX_ENSEMBLE_BEDROCK_MODEL_LOGIC
    case "security":
      return env.SIGILIX_ENSEMBLE_BEDROCK_MODEL_SECURITY
    case "performance":
      return env.SIGILIX_ENSEMBLE_BEDROCK_MODEL_PERFORMANCE
    case "tests":
      return env.SIGILIX_ENSEMBLE_BEDROCK_MODEL_TESTS
    case "synth":
      return env.SIGILIX_ENSEMBLE_BEDROCK_MODEL_SYNTH
  }
}

/**
 * The provider a role runs on. Precedence: the per-role flag (when it is a
 * recognized value) → the global flag → "openrouter". Unset/unknown ALWAYS
 * resolves "openrouter" (the shipped default MUST NOT change).
 *
 * LOGIC EXCEPTION: the global flag never flips logic — a global "bedrock"
 * migrates only the four screened roles. Logic moves ONLY via an explicit
 * `SIGILIX_ENSEMBLE_PROVIDER_LOGIC=bedrock` (the future bake-off's lever).
 */
export function resolveEnsembleProvider(env: EnsembleProviderEnv, role: EnsembleProviderRole): EnsembleProvider {
  const perRole = normalizeProvider(perRoleFlag(env, role))
  if (perRole !== undefined) return perRole
  if (role === "logic") return "openrouter"
  return normalizeProvider(env.SIGILIX_ENSEMBLE_PROVIDER) ?? "openrouter"
}

function bedrockCredsPresent(env: EnsembleProviderEnv): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION)
}

function withModelOverride(config: ModelConfig, override: string | undefined): ModelConfig {
  return override ? { ...config, primary: override } : config
}

/**
 * The Bedrock config for a specialist role, or `undefined` when the role stays
 * on the shipped OpenRouter lineup — because the flag doesn't select Bedrock OR
 * because AWS credentials are incomplete (flag-without-creds degrades to
 * OpenRouter rather than failing the role closed; see file header). The caller
 * (`specialists.ts`) passes a defined result as the run's `modelOverride`;
 * `undefined` → it omits the override and the path is byte-identical to today.
 */
export function resolveBedrockSpecialistConfig(
  env: EnsembleProviderEnv,
  role: SpecialistRole,
): ModelConfig | undefined {
  if (resolveEnsembleProvider(env, role) !== "bedrock" || !bedrockCredsPresent(env)) return undefined
  return withModelOverride(BEDROCK_SPECIALIST_CONFIGS[role], perRoleModelOverride(env, role))
}

/** Synth counterpart of `resolveBedrockSpecialistConfig` (same gating). */
export function resolveBedrockSynthConfig(env: EnsembleProviderEnv): ModelConfig | undefined {
  if (resolveEnsembleProvider(env, "synth") !== "bedrock" || !bedrockCredsPresent(env)) return undefined
  return withModelOverride(BEDROCK_SYNTHESIZER_CONFIG, perRoleModelOverride(env, "synth"))
}
