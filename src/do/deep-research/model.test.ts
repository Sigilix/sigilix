import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ChatArgs, ChatResult } from "@/src/shared/ports/model"
import type { Env } from "@/src/shared/types/env"

// Capture what buildModelFn sends to the model-adapter seam. `vi.mock` is
// hoisted above the imports below, so buildModelFn resolves to this fake `chat`.
const chatMock = vi.fn(
  async (_args: ChatArgs): Promise<ChatResult> => ({
    message: { role: "assistant" as const, content: "answer" },
    hasToolCalls: false,
    usage: {},
  }),
)

vi.mock("@/src/shared/adapters/model", () => ({
  chat: (args: ChatArgs) => chatMock(args),
  isOpenRouterModel: (m: string) => m.includes("/"),
}))

import { buildModelFn, MissingModelKeyError } from "./model"
import { resolveResearchConfig, TIER_MODELS } from "./config"

function env(over: Partial<Env> = {}): Env {
  // Deep-research tier models are OpenRouter ids, so the OpenRouter key is the one
  // that matters; keep an Ollama key too for the `:cloud` override case.
  return { OPENROUTER_API_KEY: "openrouter-key", OLLAMA_API_KEY: "ollama-key", ...over } as unknown as Env
}

beforeEach(() => chatMock.mockClear())

describe("buildModelFn — per-role tier routing", () => {
  it("forwards native tool definitions on the bounded selector call and preserves tool calls", async () => {
    chatMock.mockResolvedValueOnce({
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [{ id: "call-1", function: { name: "sigilix_mcp_0", arguments: { issueId: "SIG-193" } } }],
      },
      hasToolCalls: true,
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    const cfg = resolveResearchConfig(env(), { model: "astraeus" })
    const fn = buildModelFn(env(), cfg)
    const tools = [
      {
        type: "function" as const,
        function: { name: "sigilix_mcp_0", description: "Read comments.", parameters: { type: "object" } },
      },
    ]

    const result = await fn("planner", [{ role: "user", content: "show comments" }], tools)

    expect(chatMock.mock.calls[0]![0]).toMatchObject({ tools, timeoutMs: 20_000 })
    expect(result.toolCalls).toEqual([
      { id: "call-1", function: { name: "sigilix_mcp_0", arguments: { issueId: "SIG-193" } } },
    ])
    expect(result.tokens).toBe(7)
  })

  it("astraeus: heavy roles hit the astraeus model id, classify/extract hit boreas", async () => {
    const cfg = resolveResearchConfig(env(), { model: "astraeus" })
    const fn = buildModelFn(env(), cfg)

    for (const role of ["planner", "synthesis", "stopCheck", "finalReport"] as const) {
      chatMock.mockClear()
      await fn(role, [{ role: "user", content: "x" }])
      expect(chatMock.mock.calls[0]![0].model).toBe(TIER_MODELS.astraeus)
    }
    for (const role of ["classify", "extract"] as const) {
      chatMock.mockClear()
      await fn(role, [{ role: "user", content: "x" }])
      expect(chatMock.mock.calls[0]![0].model).toBe(TIER_MODELS.boreas)
    }
  })

  it("boreas: EVERY role hits the boreas model id", async () => {
    const cfg = resolveResearchConfig(env(), { model: "boreas" })
    const fn = buildModelFn(env(), cfg)
    for (const role of ["planner", "synthesis", "stopCheck", "finalReport", "classify", "extract"] as const) {
      chatMock.mockClear()
      await fn(role, [{ role: "user", content: "x" }])
      expect(chatMock.mock.calls[0]![0].model).toBe(TIER_MODELS.boreas)
    }
  })

  it("pyroeis: heavy roles hit the mid-tier model id", async () => {
    const cfg = resolveResearchConfig(env(), { model: "pyroeis" })
    const fn = buildModelFn(env(), cfg)
    await fn("planner", [{ role: "user", content: "x" }])
    expect(chatMock.mock.calls[0]![0].model).toBe(TIER_MODELS.pyroeis)
  })

  it("selects the OpenRouter key for OpenRouter tier ids", async () => {
    const cfg = resolveResearchConfig(env(), { model: "astraeus" })
    const fn = buildModelFn(env({ OPENROUTER_API_KEY: "the-openrouter-key" }), cfg)
    await fn("planner", [{ role: "user", content: "x" }])
    expect(chatMock.mock.calls[0]![0].apiKey).toBe("the-openrouter-key")
  })

  it("still selects the Ollama key for a :cloud model override", async () => {
    const cfg = resolveResearchConfig(env({ SIGILIX_DEEPRESEARCH_ASTRAEUS_MODEL: "glm-5.2:cloud" }), {
      model: "astraeus",
    })
    const fn = buildModelFn(env({ OLLAMA_API_KEY: "the-ollama-key" }), cfg)
    await fn("planner", [{ role: "user", content: "x" }])
    expect(chatMock.mock.calls[0]![0].apiKey).toBe("the-ollama-key")
  })

  it("throws MissingModelKeyError when the selected provider key is unset", async () => {
    const cfg = resolveResearchConfig(env(), { model: "astraeus" })
    // astraeus is an OpenRouter id, so the OpenRouter key is the one that must be present.
    const fn = buildModelFn({ OPENROUTER_API_KEY: "" } as unknown as Env, cfg)
    await expect(fn("planner", [{ role: "user", content: "x" }])).rejects.toBeInstanceOf(MissingModelKeyError)
  })
})
