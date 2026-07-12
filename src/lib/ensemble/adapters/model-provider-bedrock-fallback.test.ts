// Bedrock-ensemble migration — the cross-provider RUNNER wiring: per-leg key
// selection (`modelApiKeys`/`selectModelApiKey`/`resolveConfigKeys`), the
// Bedrock→OpenRouter degrade leg through `runWithRetryAndFallback`
// (`fallbackApiKey`), fail-closed key behavior, and the cost flow — a Bedrock
// attempt's computed `costUsd` must reach `perfCtx.recordTokens` NON-ZERO
// (`usage_ledger.cost_usd` and the enforce gate hang off it).

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, chat: (args: unknown) => mockChat(args) }
})

import { runSpecialist, runSynthesizer, modelApiKeys, resolveConfigKeys, selectModelApiKey } from "./model-provider"
import { BEDROCK_SPECIALIST_CONFIGS, BEDROCK_SYNTHESIZER_CONFIG } from "./model-provider-bedrock"
import { packBedrockApiKey } from "@/src/shared/adapters/model/bedrock-chat"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"

const BEDROCK_KEY = packBedrockApiKey({ accessKeyId: "AKID", secretAccessKey: "sec", region: "us-east-1" })
const KEYS = { ollama: "ollama-key", openrouter: "openrouter-key", bedrock: BEDROCK_KEY }
const VALID = JSON.stringify({ summary: "ok", confidence: 3, findings: [] })

describe("modelApiKeys — the Bedrock envelope joins the key set", () => {
  it("packs the envelope only when ALL THREE AWS values are set", () => {
    expect(
      modelApiKeys({
        OLLAMA_API_KEY: "o",
        OPENROUTER_API_KEY: "r",
        AWS_ACCESS_KEY_ID: "AKID",
        AWS_SECRET_ACCESS_KEY: "sec",
        AWS_REGION: "us-east-1",
      }).bedrock,
    ).toBe(BEDROCK_KEY)
    expect(modelApiKeys({ OLLAMA_API_KEY: "o", AWS_ACCESS_KEY_ID: "AKID" }).bedrock).toBeUndefined()
    expect(modelApiKeys({ OLLAMA_API_KEY: "o" }).bedrock).toBeUndefined()
  })
})

describe("selectModelApiKey / resolveConfigKeys — per-leg key routing", () => {
  it("routes by id shape: Bedrock registry id → envelope; slash id → OpenRouter; tag → Ollama", () => {
    expect(selectModelApiKey("deepseek.v3.2", KEYS)).toBe(BEDROCK_KEY)
    expect(selectModelApiKey("deepseek/deepseek-v4-flash", KEYS)).toBe("openrouter-key")
    expect(selectModelApiKey("deepseek-v4-pro:cloud", KEYS)).toBe("ollama-key")
  })
  it("cross-provider config → primary key + fallbackApiKey for the OpenRouter leg", () => {
    const resolved = resolveConfigKeys(BEDROCK_SPECIALIST_CONFIGS.security, KEYS)
    expect(resolved.apiKey).toBe(BEDROCK_KEY)
    expect(resolved.fallbackApiKey).toBe("openrouter-key")
    expect(resolved.config.fallback).toBe("deepseek/deepseek-v4-flash")
  })
  it("same-provider config → single key, no fallbackApiKey (today's behavior byte-identical)", () => {
    const resolved = resolveConfigKeys({ primary: "a/b", retries: 1, fallback: "c/d" }, KEYS)
    expect(resolved.apiKey).toBe("openrouter-key")
    expect(resolved.fallbackApiKey).toBeUndefined()
  })
  it("fallback leg with NO key is STRIPPED — the primary still runs (fail-closed per leg)", () => {
    const resolved = resolveConfigKeys(BEDROCK_SPECIALIST_CONFIGS.security, { ...KEYS, openrouter: undefined })
    expect(resolved.apiKey).toBe(BEDROCK_KEY)
    expect(resolved.config.fallback).toBeNull()
    expect(resolved.fallbackApiKey).toBeUndefined()
  })
})

describe("runSpecialist on the Bedrock lineup", () => {
  const perfCtx: EnsembleRunCtx = { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) }
  const baseArgs = {
    role: "security" as const,
    apiKeys: KEYS,
    systemPrompt: "system",
    initialMessage: "user",
    chatEnabled: "on" as const,
    signal: new AbortController().signal,
    perfCtx,
    modelOverride: BEDROCK_SPECIALIST_CONFIGS.security,
  }

  beforeEach(() => {
    mockChat.mockReset()
  })

  it("routes the Bedrock model + the packed envelope, and feeds recordTokens a NON-ZERO costUsd", async () => {
    mockChat.mockResolvedValue({
      message: { role: "assistant", content: VALID },
      hasToolCalls: false,
      // What the real bedrock-chat adapter returns: computed cost, non-zero.
      usage: { inputTokens: 25_000, outputTokens: 3_000, costUsd: 0.02105 },
    })
    const recordTokens = vi.fn()
    const res = await runSpecialist({ ...baseArgs, perfCtx: { ...perfCtx, recordTokens } })
    expect(res.verdict).not.toBeNull()
    expect(res.modelUsed).toBe("deepseek.v3.2")
    const call = mockChat.mock.calls[0]![0] as { model: string; apiKey: string }
    expect(call.model).toBe("deepseek.v3.2")
    expect(call.apiKey).toBe(BEDROCK_KEY)
    expect(recordTokens).toHaveBeenCalledWith("deepseek.v3.2", 25_000, 3_000, 0.02105)
    expect((recordTokens.mock.calls[0]! as unknown[])[3]).toBeGreaterThan(0)
  })

  it("DEGRADES to the OpenRouter leg (its own key) when Bedrock fails — never fails the role outright", async () => {
    mockChat.mockImplementation((args: { model: string }) => {
      if (args.model === "deepseek.v3.2") return Promise.reject(new Error("Bedrock HTTP 500: internal"))
      return Promise.resolve({
        message: { role: "assistant", content: VALID },
        hasToolCalls: false,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      })
    })
    const res = await runSpecialist(baseArgs)
    expect(res.verdict).not.toBeNull()
    expect(res.modelUsed).toBe("deepseek/deepseek-v4-flash") // today's security primary
    const fallbackCall = mockChat.mock.calls.at(-1)![0] as { model: string; apiKey: string }
    expect(fallbackCall.model).toBe("deepseek/deepseek-v4-flash")
    expect(fallbackCall.apiKey).toBe("openrouter-key") // the OpenRouter key, NOT the envelope
    // primary attempts (1 + 2 retries) all used the Bedrock envelope
    for (const [args] of mockChat.mock.calls.slice(0, -1) as Array<[{ apiKey: string }]>) {
      expect(args.apiKey).toBe(BEDROCK_KEY)
    }
  })

  it("fails CLOSED (missing_api_key) when the Bedrock envelope is absent — never borrows another key", async () => {
    const res = await runSpecialist({
      ...baseArgs,
      apiKeys: { ollama: "ollama-key", openrouter: "openrouter-key", bedrock: undefined },
    })
    expect(res.failureReason).toBe("missing_api_key")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("SYNTH degrade leg: nemotron-super on Bedrock fails → nemotron-ultra on OpenRouter with the OpenRouter key", async () => {
    const validSynth = JSON.stringify({
      verdict: { summary: "ok", confidence: 3, findings: [] },
      provenance: { findings: [], dropped: [] },
    })
    mockChat.mockImplementation((args: { model: string }) =>
      args.model === "nvidia.nemotron-super-3-120b"
        ? Promise.reject(new Error("Bedrock HTTP 503: throttled"))
        : Promise.resolve({
            message: { role: "assistant", content: validSynth },
            hasToolCalls: false,
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          }),
    )
    const resolved = resolveConfigKeys(BEDROCK_SYNTHESIZER_CONFIG, KEYS)
    const res = await runSynthesizer({
      apiKey: resolved.apiKey,
      ...(resolved.fallbackApiKey !== undefined ? { fallbackApiKey: resolved.fallbackApiKey } : {}),
      configOverride: resolved.config,
      systemPrompt: "system",
      userMessage: "user",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
    })
    expect(res.verdict).not.toBeNull()
    expect(res.modelUsed).toBe("nvidia/nemotron-3-ultra-550b-a55b") // today's synth (OpenRouter)
    const fallbackCall = mockChat.mock.calls.at(-1)![0] as { apiKey: string }
    expect(fallbackCall.apiKey).toBe("openrouter-key")
  })
})
