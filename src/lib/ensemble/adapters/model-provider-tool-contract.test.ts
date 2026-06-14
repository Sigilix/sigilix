import { beforeEach, describe, expect, it, vi } from "vitest"

const runSpecialistToolConversationMock = vi.hoisted(() => vi.fn())

vi.mock("@/src/lib/ensemble/adapters/specialist-tool-loop", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/ensemble/adapters/specialist-tool-loop")>(
    "@/src/lib/ensemble/adapters/specialist-tool-loop",
  )
  return {
    ...actual,
    runSpecialistToolConversation: runSpecialistToolConversationMock,
  }
})

import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"

const perfCtx = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 408,
  headSha: "a".repeat(40),
}

const validVerdict = JSON.stringify({
  summary: "Tool path stayed deterministic.",
  confidence: 4,
  confidenceReason: "The tool-loop provider call used temperature zero.",
  findings: [],
})

describe("runSpecialist MCP tool provider contract", () => {
  beforeEach(() => {
    runSpecialistToolConversationMock.mockReset()
    runSpecialistToolConversationMock.mockResolvedValue({
      message: { role: "assistant", content: validVerdict },
      hasToolCalls: false,
      usage: { inputTokens: 5, outputTokens: 3 },
    })
  })

  it("passes the deterministic temperature contract into the tool-loop branch", async () => {
    const result = await runSpecialist({
      role: "security",
      apiKeys: { openrouter: "test-key", ollama: undefined },
      systemPrompt: "security system",
      initialMessage: "src/auth/session.ts:1 export function removedHelper() {}",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
      mcpTools: { toolIds: ["file_grep"] },
    })

    expect(result.verdict?.summary).toBe("Tool path stayed deterministic.")
    expect(runSpecialistToolConversationMock).toHaveBeenCalledOnce()
    expect(runSpecialistToolConversationMock.mock.calls[0]?.[0]).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      temperature: 0,
    })
  })
})
