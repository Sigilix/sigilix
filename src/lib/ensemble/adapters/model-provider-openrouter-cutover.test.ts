// SIG-406 (OpenRouter alpha): per-provider API-key selection for the all-OpenRouter
// lineup. Proves the key is selected by model-id shape, that no path can send the
// wrong provider's key (fail-closed), and that `runSpecialist` routes the role's
// OpenRouter model + the OpenRouter key (or fails closed when that key is unset).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the model barrel so we can assert WHICH model + apiKey reach `chat()`.
// `...actual` keeps the real `isOpenRouterModel` (the router heuristic under test).
const mockChat = vi.fn()
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, chat: (args: unknown) => mockChat(args) }
})

import {
  SPECIALIST_CONFIGS,
  SYNTHESIZER_CONFIG,
  CLAIM_EXTRACTOR_CONFIG,
  selectConfigApiKey,
  modelApiKeys,
  runSpecialist,
} from "@/src/lib/ensemble/adapters/model-provider"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"

const BOTH_KEYS = { ollama: "ollama-key", openrouter: "openrouter-key" }

describe("modelApiKeys — env → key set", () => {
  it("maps OLLAMA_API_KEY / OPENROUTER_API_KEY (openrouter undefined when unset)", () => {
    expect(modelApiKeys({ OLLAMA_API_KEY: "o" })).toEqual({ ollama: "o", openrouter: undefined })
    expect(modelApiKeys({ OLLAMA_API_KEY: "o", OPENROUTER_API_KEY: "r" })).toEqual({ ollama: "o", openrouter: "r" })
  })
})

describe("selectConfigApiKey — per-provider key, fail-closed, mixed-provider guard", () => {
  const o3: ModelConfig = { primary: "openai/o3", retries: 1, fallback: null }
  const ollama: ModelConfig = { primary: "deepseek-v4-pro:cloud", retries: 0, fallback: "qwen3-coder-next:cloud" }

  it("OpenRouter primary → the OpenRouter key; Ollama primary → the Ollama key", () => {
    expect(selectConfigApiKey(o3, BOTH_KEYS)).toBe("openrouter-key")
    expect(selectConfigApiKey(ollama, BOTH_KEYS)).toBe("ollama-key")
  })

  it("returns undefined (fail closed) when the SELECTED provider's key is unset — never substitutes the other", () => {
    expect(selectConfigApiKey(o3, { ollama: "ollama-key", openrouter: undefined })).toBeUndefined()
    expect(selectConfigApiKey(ollama, { ollama: undefined, openrouter: "openrouter-key" })).toBeUndefined()
  })

  it("THROWS on a cross-provider primary+fallback (the one-key runner cannot serve both)", () => {
    expect(() =>
      selectConfigApiKey({ primary: "openai/o3", retries: 0, fallback: "deepseek-v4-pro:cloud" }, BOTH_KEYS),
    ).toThrow(/mixes providers/)
    expect(() =>
      selectConfigApiKey({ primary: "deepseek-v4-pro:cloud", retries: 0, fallback: "openai/o3" }, BOTH_KEYS),
    ).toThrow(/mixes providers/)
  })
})

describe("invariant: no shipped config mixes providers", () => {
  it("selectConfigApiKey never throws for any reachable config", () => {
    const reachable: ModelConfig[] = [...Object.values(SPECIALIST_CONFIGS), SYNTHESIZER_CONFIG, CLAIM_EXTRACTOR_CONFIG]
    for (const config of reachable) {
      expect(() => selectConfigApiKey(config, BOTH_KEYS)).not.toThrow()
    }
  })

  it("every shipped config resolves to the OpenRouter key (the all-OpenRouter alpha lineup)", () => {
    // SIG-406: specialists + synth + the claim-extractor are ALL on OpenRouter, so the
    // key selector must return the OpenRouter key for each. Reverting any to a `:cloud`
    // model without re-wiring its call site to the Ollama key would resurface the
    // claim-extractor key-leak class (the call site passes a key the config doesn't match).
    const reachable: ModelConfig[] = [...Object.values(SPECIALIST_CONFIGS), SYNTHESIZER_CONFIG, CLAIM_EXTRACTOR_CONFIG]
    for (const config of reachable) {
      expect(selectConfigApiKey(config, BOTH_KEYS)).toBe("openrouter-key")
    }
  })
})

describe("runSpecialist — routes the role's OpenRouter model to the OpenRouter key", () => {
  const validVerdict = JSON.stringify({ summary: "ok", confidence: 3, findings: [] })
  const perfCtx: EnsembleRunCtx = { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) }
  const baseArgs = {
    systemPrompt: "system",
    initialMessage: "user",
    chatEnabled: "on" as const,
    signal: new AbortController().signal,
    perfCtx,
  }

  beforeEach(() => {
    mockChat.mockReset()
    mockChat.mockResolvedValue({
      message: { role: "assistant", content: validVerdict },
      hasToolCalls: false,
      usage: {},
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("logic → chat gets model moonshotai/kimi-k2.7-code + the OpenRouter key", async () => {
    await runSpecialist({ role: "logic", apiKeys: BOTH_KEYS, ...baseArgs })
    expect(mockChat).toHaveBeenCalledTimes(1)
    const call = mockChat.mock.calls[0]![0] as { model: string; apiKey: string }
    expect(call.model).toBe("moonshotai/kimi-k2.7-code")
    expect(call.apiKey).toBe("openrouter-key")
  })

  it("logic but OPENROUTER_API_KEY unset → fails closed, never calls chat with the Ollama key", async () => {
    const res = await runSpecialist({
      role: "logic",
      apiKeys: { ollama: "ollama-key", openrouter: undefined },
      ...baseArgs,
    })
    expect(res.failureReason).toBe("missing_api_key")
    expect(res.modelUsed).toBe("moonshotai/kimi-k2.7-code")
    expect(mockChat).not.toHaveBeenCalled()
  })

  // SIG-369(b): a per-call modelOverride replaces SPECIALIST_CONFIGS[role].
  it("modelOverride present → chat gets the override model (key still by id-shape); modelUsed reflects it", async () => {
    const override: ModelConfig = { primary: "deepseek/deepseek-v4-pro", retries: 1, fallback: null }
    const res = await runSpecialist({ role: "logic", apiKeys: BOTH_KEYS, modelOverride: override, ...baseArgs })
    expect(mockChat).toHaveBeenCalledTimes(1)
    const call = mockChat.mock.calls[0]![0] as { model: string; apiKey: string }
    expect(call.model).toBe("deepseek/deepseek-v4-pro")
    // deepseek/* is an OpenRouter id → still the OpenRouter key (no leak).
    expect(call.apiKey).toBe("openrouter-key")
    expect(res.modelUsed).toBe("deepseek/deepseek-v4-pro")
  })

  it("modelOverride absent → byte-identical to the role default (moonshotai/kimi-k2.7-code)", async () => {
    const res = await runSpecialist({ role: "logic", apiKeys: BOTH_KEYS, ...baseArgs })
    const call = mockChat.mock.calls[0]![0] as { model: string }
    expect(call.model).toBe("moonshotai/kimi-k2.7-code")
    expect(res.modelUsed).toBe("moonshotai/kimi-k2.7-code")
  })
})
