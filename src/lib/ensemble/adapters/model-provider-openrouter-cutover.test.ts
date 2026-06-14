// SIG-405 (OpenRouter migration, Phase 2): the cutover resolver + per-provider
// key selection. Proves logic→openai/o3 is gated by the provider map, that the
// OFF path is byte-identical, that the key is selected by model-id shape, and
// that no path can send the wrong provider's key.

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
import { specialistProviderOverride } from "@/src/lib/ensemble/adapters/model-provider-routing"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"
import type { ModelProvider } from "@/src/lib/ensemble/domain/config"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"

const ALL_ROLES: SpecialistRole[] = ["logic", "security", "performance", "tests"]
const LOGIC_OR = new Map<SpecialistRole, ModelProvider>([["logic", "openrouter"]])
const EMPTY = new Map<SpecialistRole, ModelProvider>()
const BOTH_KEYS = { ollama: "ollama-key", openrouter: "openrouter-key" }

describe("specialistProviderOverride — provider-gated config override", () => {
  it("logic + {logic:openrouter} → openai/o3 on the OpenRouter route (retries:1, no fallback)", () => {
    expect(specialistProviderOverride("logic", LOGIC_OR)).toEqual({
      primary: "openai/o3",
      retries: 1,
      fallback: null,
      perAttemptTimeoutMs: 120_000,
    })
  })

  it("logic + empty map → null (runner falls back to the SPECIALIST_CONFIGS Ollama lineup)", () => {
    expect(specialistProviderOverride("logic", EMPTY)).toBeNull()
  })

  it('logic + {logic:"ollama"} → null (only "openrouter" overrides)', () => {
    const ollamaMap = new Map<SpecialistRole, ModelProvider>([["logic", "ollama"]])
    expect(specialistProviderOverride("logic", ollamaMap)).toBeNull()
  })

  it("non-logic roles → null even when logic is on OpenRouter", () => {
    for (const role of ["security", "performance", "tests"] as SpecialistRole[]) {
      expect(specialistProviderOverride(role, LOGIC_OR)).toBeNull()
    }
  })

  it("OFF path: no override for any role on the empty map (→ runner uses SPECIALIST_CONFIGS, byte-identical)", () => {
    for (const role of ALL_ROLES) {
      expect(specialistProviderOverride(role, EMPTY)).toBeNull()
    }
  })
})

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

describe("invariant: no shipped/effective config mixes providers", () => {
  it("selectConfigApiKey never throws for any reachable config", () => {
    const reachable: ModelConfig[] = [
      ...Object.values(SPECIALIST_CONFIGS),
      SYNTHESIZER_CONFIG,
      CLAIM_EXTRACTOR_CONFIG,
      specialistProviderOverride("logic", LOGIC_OR)!, // the o3 cutover config
    ]
    for (const config of reachable) {
      expect(() => selectConfigApiKey(config, BOTH_KEYS)).not.toThrow()
    }
  })
})

describe("runSpecialist — routes the right model to the right key", () => {
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

  it("logic on OpenRouter → chat gets model openai/o3 + the OpenRouter key", async () => {
    await runSpecialist({ role: "logic", apiKeys: BOTH_KEYS, providerByRole: LOGIC_OR, ...baseArgs })
    expect(mockChat).toHaveBeenCalledTimes(1)
    const call = mockChat.mock.calls[0]![0] as { model: string; apiKey: string }
    expect(call.model).toBe("openai/o3")
    expect(call.apiKey).toBe("openrouter-key")
  })

  it("logic OFF (empty map) → chat gets the Ollama model + the Ollama key", async () => {
    await runSpecialist({ role: "logic", apiKeys: BOTH_KEYS, providerByRole: EMPTY, ...baseArgs })
    const call = mockChat.mock.calls[0]![0] as { model: string; apiKey: string }
    expect(call.model).toBe("deepseek-v4-pro:cloud")
    expect(call.apiKey).toBe("ollama-key")
  })

  it("logic on OpenRouter but OPENROUTER_API_KEY unset → fails closed, never calls chat with the Ollama key", async () => {
    const res = await runSpecialist({
      role: "logic",
      apiKeys: { ollama: "ollama-key", openrouter: undefined },
      providerByRole: LOGIC_OR,
      ...baseArgs,
    })
    expect(res.failureReason).toBe("missing_api_key")
    expect(res.modelUsed).toBe("openai/o3")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("mixed-provider run: same map, logic→o3/openrouter while security→deepseek/ollama", async () => {
    await runSpecialist({ role: "security", apiKeys: BOTH_KEYS, providerByRole: LOGIC_OR, ...baseArgs })
    const call = mockChat.mock.calls[0]![0] as { model: string; apiKey: string }
    expect(call.model).toBe("deepseek-v4-flash:cloud")
    expect(call.apiKey).toBe("ollama-key")
  })
})
