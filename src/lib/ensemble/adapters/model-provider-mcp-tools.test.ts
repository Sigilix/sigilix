import { beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, chat: (args: unknown) => mockChat(args) }
})

import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import type { ChatArgs } from "@/src/shared/ports/model"

const perfCtx = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 408,
  headSha: "a".repeat(40),
}

const validVerdict = JSON.stringify({
  summary: "Security review used grep evidence.",
  confidence: 4,
  confidenceReason: "file_grep confirmed all visible callers.",
  findings: [],
})

describe("runSpecialist MCP tool integration", () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it("lets an approved security specialist call file_grep and reason over the injected result", async () => {
    mockChat.mockImplementation(async (args: ChatArgs) => {
      if (args.tools?.some((t) => t.function.name === "file_grep")) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "grep-removed-helper",
                function: { name: "file_grep", arguments: { query: "removedHelper", pathGlob: "src/auth/**" } },
              },
            ],
          },
          hasToolCalls: true,
          usage: { inputTokens: 10, outputTokens: 2 },
        }
      }

      const toolMessages = args.messages.filter((m) => m.role === "tool")
      expect(toolMessages).toHaveLength(1)
      expect(toolMessages[0]?.tool_name).toBe("file_grep")
      expect(JSON.parse(toolMessages[0]!.content)).toMatchObject({
        ok: true,
        status: "complete",
        matches: expect.arrayContaining([{ path: "src/auth/session.ts", line: 1, snippet: expect.any(String) }]),
      })
      expect(args.tools).toBeUndefined()
      expect(args.format).toBeDefined()
      return {
        message: { role: "assistant", content: validVerdict },
        hasToolCalls: false,
        usage: { inputTokens: 20, outputTokens: 5 },
      }
    })

    const result = await runSpecialist({
      role: "security",
      apiKeys: { openrouter: "test-key", ollama: undefined },
      systemPrompt: "security system",
      initialMessage: [
        "src/auth/session.ts:1 export function removedHelper() {}",
        "src/auth/caller.ts:2 removedHelper()",
      ].join("\n"),
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
      mcpTools: { toolIds: ["file_grep"] },
    })

    expect(result.verdict?.summary).toBe("Security review used grep evidence.")
    expect(mockChat).toHaveBeenCalledTimes(2)
  })

  it("does not expose tools when a specialist has no resolved permissions", async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: validVerdict },
      hasToolCalls: false,
      usage: { inputTokens: 1, outputTokens: 1 },
    })

    const result = await runSpecialist({
      role: "tests",
      apiKeys: { openrouter: "test-key", ollama: undefined },
      systemPrompt: "tests system",
      initialMessage: "review",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
      mcpTools: { toolIds: [] },
    })

    expect(result.verdict).not.toBeNull()
    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(mockChat.mock.calls[0]?.[0].tools).toBeUndefined()
  })
})
