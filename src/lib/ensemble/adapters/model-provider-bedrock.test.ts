// Bedrock-ensemble migration — flag-resolution + lineup tests. The
// load-bearing invariants: (1) unset/unknown flag = the shipped OpenRouter
// default, byte-identical; (2) LOGIC never moves on the global flag; (3) no
// creds → no Bedrock (degrade, not fail); (4) the SIG-406 decorrelation
// families survive; (5) attempt-count parity keeps MAX_CALLS_PER_ENSEMBLE_RUN
// a true worst-case; (6) every Bedrock model is priced (a missing row would
// bill at DEFAULT_PRICING and skew the cost gate).

import { describe, expect, it } from "vitest"

import {
  BEDROCK_SPECIALIST_CONFIGS,
  BEDROCK_SYNTHESIZER_CONFIG,
  resolveBedrockSpecialistConfig,
  resolveBedrockSynthConfig,
  resolveEnsembleProvider,
} from "./model-provider-bedrock"
import { SPECIALIST_CONFIGS, SYNTHESIZER_CONFIG } from "./model-provider"
import { maxAttempts } from "@/src/lib/ensemble/domain/model-policy"
import { MODEL_PRICING, computeCostUsd, DEFAULT_PRICING } from "@/src/shared/domain/model-pricing"
import { ALL_SPECIALISTS } from "@/src/shared/domain/specialist-role"

const CREDS = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1" }
const ROLES = ["logic", "security", "performance", "tests", "synth"] as const

describe("resolveEnsembleProvider — defaults MUST stay openrouter", () => {
  it("unset → openrouter for every role", () => {
    for (const role of ROLES) expect(resolveEnsembleProvider({}, role)).toBe("openrouter")
  })
  it("UNKNOWN values (typo'd flag) → openrouter, never a crash or a guess", () => {
    for (const role of ROLES) {
      expect(resolveEnsembleProvider({ SIGILIX_ENSEMBLE_PROVIDER: "bedrok" }, role)).toBe("openrouter")
      expect(resolveEnsembleProvider({ SIGILIX_ENSEMBLE_PROVIDER: "" }, role)).toBe("openrouter")
    }
  })
  it("global bedrock migrates the four screened roles but NEVER logic (bake-off pending)", () => {
    const env = { SIGILIX_ENSEMBLE_PROVIDER: "bedrock" }
    expect(resolveEnsembleProvider(env, "security")).toBe("bedrock")
    expect(resolveEnsembleProvider(env, "tests")).toBe("bedrock")
    expect(resolveEnsembleProvider(env, "performance")).toBe("bedrock")
    expect(resolveEnsembleProvider(env, "synth")).toBe("bedrock")
    expect(resolveEnsembleProvider(env, "logic")).toBe("openrouter")
  })
  it("per-role flag beats the global (both directions), and logic is reachable ONLY per-role", () => {
    expect(
      resolveEnsembleProvider(
        { SIGILIX_ENSEMBLE_PROVIDER: "bedrock", SIGILIX_ENSEMBLE_PROVIDER_SECURITY: "openrouter" },
        "security",
      ),
    ).toBe("openrouter")
    expect(resolveEnsembleProvider({ SIGILIX_ENSEMBLE_PROVIDER_TESTS: "bedrock" }, "tests")).toBe("bedrock")
    expect(resolveEnsembleProvider({ SIGILIX_ENSEMBLE_PROVIDER_LOGIC: "bedrock" }, "logic")).toBe("bedrock")
  })
})

describe("resolveBedrockSpecialistConfig / resolveBedrockSynthConfig — activation gating", () => {
  it("flag off/unset → undefined for every role (the shipped OpenRouter path)", () => {
    for (const role of ALL_SPECIALISTS) expect(resolveBedrockSpecialistConfig({ ...CREDS }, role)).toBeUndefined()
    expect(resolveBedrockSynthConfig({ ...CREDS })).toBeUndefined()
  })
  it("flag on but AWS creds INCOMPLETE → undefined (degrade to OpenRouter, never a failed role)", () => {
    const flag = { SIGILIX_ENSEMBLE_PROVIDER: "bedrock" }
    for (const partial of [
      flag,
      { ...flag, AWS_ACCESS_KEY_ID: "AKID" },
      { ...flag, AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret" },
      { ...flag, AWS_ACCESS_KEY_ID: "AKID", AWS_REGION: "us-east-1" },
    ]) {
      expect(resolveBedrockSpecialistConfig(partial, "security")).toBeUndefined()
      expect(resolveBedrockSynthConfig(partial)).toBeUndefined()
    }
  })
  it("flag on + full creds → the four migrated roles get the Bedrock lineup; logic stays undefined", () => {
    const env = { SIGILIX_ENSEMBLE_PROVIDER: "bedrock", ...CREDS }
    expect(resolveBedrockSpecialistConfig(env, "security")?.primary).toBe("deepseek.v3.2")
    expect(resolveBedrockSpecialistConfig(env, "tests")?.primary).toBe("deepseek.v3.2")
    expect(resolveBedrockSpecialistConfig(env, "performance")?.primary).toBe("zai.glm-5")
    expect(resolveBedrockSynthConfig(env)?.primary).toBe("nvidia.nemotron-super-3-120b")
    expect(resolveBedrockSpecialistConfig(env, "logic")).toBeUndefined()
  })
  it("logic candidates are SELECTABLE for the bake-off: explicit per-role flag → Claude Sonnet 5; model-id override → Mistral", () => {
    const env = { SIGILIX_ENSEMBLE_PROVIDER_LOGIC: "bedrock", ...CREDS }
    expect(resolveBedrockSpecialistConfig(env, "logic")?.primary).toBe("us.anthropic.claude-sonnet-5")
    expect(
      resolveBedrockSpecialistConfig(
        { ...env, SIGILIX_ENSEMBLE_BEDROCK_MODEL_LOGIC: "mistral.mistral-large-3-675b-instruct" },
        "logic",
      )?.primary,
    ).toBe("mistral.mistral-large-3-675b-instruct")
  })
  it("per-role model-id override replaces the PRIMARY only — the OpenRouter fallback leg is untouched", () => {
    const env = {
      SIGILIX_ENSEMBLE_PROVIDER: "bedrock",
      SIGILIX_ENSEMBLE_BEDROCK_MODEL_SECURITY: "deepseek.v4",
      ...CREDS,
    }
    const config = resolveBedrockSpecialistConfig(env, "security")
    expect(config?.primary).toBe("deepseek.v4")
    expect(config?.fallback).toBe(SPECIALIST_CONFIGS.security.primary)
  })
})

describe("the Bedrock lineup — decorrelation, fallback legs, attempt parity, pricing", () => {
  it("keeps the SIG-406 four-family split: security+tests=DeepSeek, performance=GLM(Z.ai), synth=Nvidia; logic=Ollama-Turbo v4-pro (2026-07-12 default)", () => {
    expect(BEDROCK_SPECIALIST_CONFIGS.security.primary.startsWith("deepseek.")).toBe(true)
    expect(BEDROCK_SPECIALIST_CONFIGS.tests.primary.startsWith("deepseek.")).toBe(true)
    expect(BEDROCK_SPECIALIST_CONFIGS.performance.primary.startsWith("zai.")).toBe(true)
    expect(BEDROCK_SYNTHESIZER_CONFIG.primary.startsWith("nvidia.")).toBe(true)
    // The synth family stays decorrelated from every migrated specialist family.
    for (const role of ["security", "tests", "performance"] as const) {
      expect(BEDROCK_SPECIALIST_CONFIGS[role].primary.split(".")[0]).not.toBe(
        BEDROCK_SYNTHESIZER_CONFIG.primary.split(".")[0],
      )
    }
    // Logic's shipped default moved to Ollama Turbo (2026-07-12): deepseek-v4-pro:cloud.
    expect(SPECIALIST_CONFIGS.logic.primary).toBe("deepseek-v4-pro:cloud")
  })
  it("every fallback leg is TODAY'S shipped model for that role (degrade = the shipped lineup; logic is now Ollama Turbo)", () => {
    expect(BEDROCK_SPECIALIST_CONFIGS.security.fallback).toBe(SPECIALIST_CONFIGS.security.primary)
    expect(BEDROCK_SPECIALIST_CONFIGS.performance.fallback).toBe(SPECIALIST_CONFIGS.performance.primary)
    expect(BEDROCK_SPECIALIST_CONFIGS.tests.fallback).toBe(SPECIALIST_CONFIGS.tests.primary)
    expect(BEDROCK_SPECIALIST_CONFIGS.logic.fallback).toBe(SPECIALIST_CONFIGS.logic.primary)
    expect(BEDROCK_SYNTHESIZER_CONFIG.fallback).toBe(SYNTHESIZER_CONFIG.primary)
  })
  it("attempt-count PARITY with the OpenRouter configs — MAX_CALLS_PER_ENSEMBLE_RUN stays a true worst-case", () => {
    for (const role of ALL_SPECIALISTS) {
      expect(maxAttempts(BEDROCK_SPECIALIST_CONFIGS[role]), role).toBe(maxAttempts(SPECIALIST_CONFIGS[role]))
    }
    expect(maxAttempts(BEDROCK_SYNTHESIZER_CONFIG)).toBe(maxAttempts(SYNTHESIZER_CONFIG))
  })
  it("every Bedrock primary (incl. both logic candidates) has an explicit pricing row — never DEFAULT_PRICING", () => {
    const models = [
      ...Object.values(BEDROCK_SPECIALIST_CONFIGS).map((c) => c.primary),
      BEDROCK_SYNTHESIZER_CONFIG.primary,
      "mistral.mistral-large-3-675b-instruct",
    ]
    for (const model of models) {
      expect(MODEL_PRICING[model], model).toBeDefined()
      const cost = computeCostUsd(model, 25_000, 3_000)
      expect(cost, model).toBeGreaterThan(0)
      expect(cost).not.toBe(computeCostUsd("__unknown__", 25_000, 3_000)) // not the DEFAULT_PRICING path
    }
    // sanity: the default-pricing sentinel above actually uses DEFAULT_PRICING
    expect(computeCostUsd("__unknown__", 1_000_000, 0)).toBeCloseTo(DEFAULT_PRICING.inputPerMTokUsd, 10)
  })
})
