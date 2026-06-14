import { describe, it, expect, vi } from "vitest"
import type { ChatArgs, ChatResult } from "@/src/shared/ports/model"

vi.mock("@/src/shared/adapters/model/ollama-chat", () => ({
  chat: vi.fn(
    async (): Promise<ChatResult> => ({
      message: { role: "assistant", content: "ollama" },
      hasToolCalls: false,
      usage: {},
    }),
  ),
}))
vi.mock("@/src/shared/adapters/model/openrouter-chat", () => ({
  chat: vi.fn(
    async (): Promise<ChatResult> => ({
      message: { role: "assistant", content: "openrouter" },
      hasToolCalls: false,
      usage: {},
    }),
  ),
}))

import { chat, isOpenRouterModel } from "@/src/shared/adapters/model"

const argsFor = (model: string): ChatArgs => ({
  model,
  apiKey: "k",
  messages: [{ role: "user", content: "x" }],
  chatEnabled: "on",
})

describe("model adapter router (OpenRouter migration)", () => {
  it("isOpenRouterModel: provider-prefixed (slash) → true, Ollama tag → false", () => {
    expect(isOpenRouterModel("openai/o3")).toBe(true)
    expect(isOpenRouterModel("nvidia/nemotron-3-ultra-550b-a55b")).toBe(true)
    expect(isOpenRouterModel("deepseek-v4-pro:cloud")).toBe(false)
    expect(isOpenRouterModel("glm-5.1:cloud")).toBe(false)
  })

  it("routes slash-models to the OpenRouter adapter and Ollama tags to the Ollama adapter", async () => {
    expect((await chat(argsFor("openai/o3"))).message.content).toBe("openrouter")
    expect((await chat(argsFor("nvidia/nemotron-3-ultra-550b-a55b"))).message.content).toBe("openrouter")
    expect((await chat(argsFor("deepseek-v4-pro:cloud"))).message.content).toBe("ollama")
    expect((await chat(argsFor("glm-5.1:cloud"))).message.content).toBe("ollama")
  })
})
