import { afterEach, describe, expect, it, vi } from "vitest"

import { runSpecialistToolConversation, type SpecialistRuntimeTool } from "./specialist-tool-loop"
import type { ChatArgs, ChatResult } from "@/src/shared/ports/model"

const FINAL_SCHEMA = { type: "object", required: ["summary"] }

const finalResult = (content = '{"summary":"ok"}'): ChatResult => ({
  message: { role: "assistant", content },
  hasToolCalls: false,
  usage: { inputTokens: 3, outputTokens: 4 },
})

const toolResult = (toolCalls: ChatResult["message"]["tool_calls"]): ChatResult => ({
  message: { role: "assistant", content: "", ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}) },
  hasToolCalls: true,
  usage: { inputTokens: 1, outputTokens: 2 },
})

function makeTool(name = "file_grep"): SpecialistRuntimeTool {
  return {
    id: name,
    description: "test tool",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: vi.fn(async () => ({ ok: true, status: "complete", matches: [] })),
  }
}

describe("runSpecialistToolConversation", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("executes at most two tool calls, injects structured over-budget errors, then forces final schema", async () => {
    const tool = makeTool()
    const chat = vi
      .fn<(args: ChatArgs) => Promise<ChatResult>>()
      .mockResolvedValueOnce(
        toolResult([
          { id: "a", function: { name: "file_grep", arguments: { query: "one" } } },
          { id: "b", function: { name: "file_grep", arguments: { query: "two" } } },
          { id: "c", function: { name: "file_grep", arguments: { query: "three" } } },
        ]),
      )
      .mockResolvedValueOnce(finalResult())

    const out = await runSpecialistToolConversation({
      chat,
      model: "model:cloud",
      apiKey: "k",
      messages: [{ role: "user", content: "review" }],
      chatEnabled: "on",
      signal: new AbortController().signal,
      tools: [tool],
      format: FINAL_SCHEMA,
    })

    expect(out.message.content).toBe('{"summary":"ok"}')
    expect(tool.execute).toHaveBeenCalledTimes(2)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[0]?.[0].tools?.map((t) => t.function.name)).toEqual(["file_grep"])
    expect(chat.mock.calls[0]?.[0].format).toBeUndefined()

    const finalCall = chat.mock.calls[1]?.[0]
    expect(finalCall?.tools).toBeUndefined()
    expect(finalCall?.format).toBe(FINAL_SCHEMA)
    const toolMessages = finalCall?.messages.filter((m) => m.role === "tool") ?? []
    expect(toolMessages).toHaveLength(3)
    expect(JSON.parse(toolMessages[2]!.content)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "budget_exceeded" },
    })
    expect(out.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
  })

  it("returns invalid argument errors as tool messages instead of throwing", async () => {
    const tool = makeTool()
    const chat = vi
      .fn<(args: ChatArgs) => Promise<ChatResult>>()
      .mockResolvedValueOnce(toolResult([{ id: "bad", function: { name: "file_grep", arguments: "{not-json" } }]))
      .mockResolvedValueOnce(finalResult())

    await runSpecialistToolConversation({
      chat,
      model: "model:cloud",
      apiKey: "k",
      messages: [{ role: "user", content: "review" }],
      chatEnabled: "on",
      signal: new AbortController().signal,
      tools: [tool],
      format: FINAL_SCHEMA,
    })

    expect(tool.execute).not.toHaveBeenCalled()
    const toolMessage = chat.mock.calls[1]?.[0].messages.find((m) => m.role === "tool")
    expect(JSON.parse(toolMessage!.content)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "invalid_args" },
    })
  })

  it("assigns stable synthetic ids when a provider omits tool call ids", async () => {
    const tool = makeTool()
    const chat = vi
      .fn<(args: ChatArgs) => Promise<ChatResult>>()
      .mockResolvedValueOnce(toolResult([{ function: { name: "file_grep", arguments: { query: "one" } } }]))
      .mockResolvedValueOnce(finalResult())

    await runSpecialistToolConversation({
      chat,
      model: "model:cloud",
      apiKey: "k",
      messages: [{ role: "user", content: "review" }],
      chatEnabled: "on",
      signal: new AbortController().signal,
      tools: [tool],
      format: FINAL_SCHEMA,
    })

    const finalMessages = chat.mock.calls[1]?.[0].messages ?? []
    const assistantMessage = finalMessages.find((m) => m.role === "assistant")
    const toolMessage = finalMessages.find((m) => m.role === "tool")
    expect(assistantMessage?.tool_calls?.[0]?.id).toBe("auto_0")
    expect(toolMessage?.tool_call_id).toBe("auto_0")
  })

  it("serializes circular tool results without dropping the whole result", async () => {
    const tool = makeTool()
    tool.execute = vi.fn(async () => {
      const result: Record<string, unknown> = { ok: true, status: "complete" }
      result.self = result
      return result
    })
    const chat = vi
      .fn<(args: ChatArgs) => Promise<ChatResult>>()
      .mockResolvedValueOnce(
        toolResult([{ id: "circular", function: { name: "file_grep", arguments: { query: "one" } } }]),
      )
      .mockResolvedValueOnce(finalResult())

    await runSpecialistToolConversation({
      chat,
      model: "model:cloud",
      apiKey: "k",
      messages: [{ role: "user", content: "review" }],
      chatEnabled: "on",
      signal: new AbortController().signal,
      tools: [tool],
      format: FINAL_SCHEMA,
    })

    const toolMessage = chat.mock.calls[1]?.[0].messages.find((m) => m.role === "tool")
    expect(JSON.parse(toolMessage!.content)).toMatchObject({
      ok: true,
      status: "complete",
      self: "[Circular]",
    })
  })

  it("converts a slow tool into a structured timeout result", async () => {
    vi.useFakeTimers()
    const tool = makeTool()
    tool.execute = vi.fn(
      (_args, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Operation aborted", "AbortError")), {
            once: true,
          })
        }),
    )
    const chat = vi
      .fn<(args: ChatArgs) => Promise<ChatResult>>()
      .mockResolvedValueOnce(toolResult([{ id: "slow", function: { name: "file_grep", arguments: { query: "x" } } }]))
      .mockResolvedValueOnce(finalResult())

    const promise = runSpecialistToolConversation({
      chat,
      model: "model:cloud",
      apiKey: "k",
      messages: [{ role: "user", content: "review" }],
      chatEnabled: "on",
      signal: new AbortController().signal,
      tools: [tool],
      format: FINAL_SCHEMA,
      toolTimeoutMs: 5,
    })
    await vi.advanceTimersByTimeAsync(6)
    await promise

    const toolMessage = chat.mock.calls[1]?.[0].messages.find((m) => m.role === "tool")
    expect(JSON.parse(toolMessage!.content)).toMatchObject({
      ok: false,
      status: "error",
      error: { code: "timeout" },
    })
  })
})
