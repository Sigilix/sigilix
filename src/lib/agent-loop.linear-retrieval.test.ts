import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()

vi.mock("@/src/shared/adapters/model/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model/ollama-chat")>(
    "@/src/shared/adapters/model/ollama-chat",
  )
  return {
    ...actual,
    chat: (args: unknown) => mockChat(args),
  }
})

import {
  runAgentLoop,
  type AgentLoopArgs,
  type AgentLoopTelemetryRecordInput,
  type AgentLoopTelemetrySink,
} from "@/src/lib/agent-loop"
import type { AgentTool } from "@/src/lib/agent-tools"
import type { Env } from "@/src/shared/types/env"

interface CapturedTelemetry {
  payload: AgentLoopTelemetryRecordInput | null
}

function makeEnv(): Env {
  return {
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
    OPENCLAW_JOBS: {} as Queue<never>,
    LINEAR_API_KEY: "x",
    LINEAR_WEBHOOK_SECRET: "x",
    OLLAMA_API_KEY: "x",
    OLLAMA_CHAT_ENABLE: "on",
  } as Env
}

function makeArgs(overrides: Partial<AgentLoopArgs> = {}): {
  args: AgentLoopArgs
  captured: CapturedTelemetry
} {
  const captured: CapturedTelemetry = { payload: null }
  const telemetry: AgentLoopTelemetrySink = {
    async record(input) {
      captured.payload = input
    },
  }
  const args: AgentLoopArgs = {
    model: "glm-5.1:cloud",
    apiKey: "x",
    env: makeEnv(),
    surface: "linear-mention",
    commentId: "comment-1",
    systemPrompt: "you are sigilix",
    initialUserMessage: "hello",
    tools: [],
    maxToolTurns: 3,
    finalAnswerSchema: { type: "object" },
    telemetry,
    telemetryContext: {
      singleShotPrompt: "single-shot prompt",
      singleShotSchema: { type: "object" },
      promptBuilderVersion: "1.0.0",
      promptBuilderSource: "// pretend source",
      linearMentionRetrieval: {
        availableRepos: ["sigilix/sigilix"],
        mappedRepo: "sigilix/sigilix",
        repoStatus: "mapped_indexed",
        initialRetrievalNamespace: "sigilix/sigilix",
        initialChunkCount: 0,
      },
    },
    log: () => {},
    ...overrides,
  }
  return { args, captured }
}

beforeEach(() => {
  mockChat.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("runAgentLoop — Linear retrieval telemetry", () => {
  it("keeps initial retrieval separate when the agent never calls retrieve_codebase", async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: '{"answer":"yes","confidence":5,"abstain":false}' },
      hasToolCalls: false,
    })
    const { args, captured } = makeArgs({
      telemetryContext: {
        singleShotPrompt: "single-shot prompt",
        singleShotSchema: { type: "object" },
        promptBuilderVersion: "1.0.0",
        promptBuilderSource: "// pretend source",
        linearMentionRetrieval: {
          availableRepos: ["sigilix/sigilix"],
          mappedRepo: "sigilix/sigilix",
          repoStatus: "mapped_indexed",
          initialRetrievalNamespace: "sigilix/sigilix",
          initialChunkCount: 3,
        },
      },
    } as Partial<AgentLoopArgs>)

    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true)
    expect(captured.payload?.linearMentionRetrieval).toMatchObject({
      initialRetrievalNamespace: "sigilix/sigilix",
      initialChunkCount: 3,
      calledRetrieveCodebase: false,
      retrieveCodebaseCallCount: 0,
      retrievalNamespace: null,
      chunkCount: 0,
    })
  })

  it("does not report initial chunks as tool success when retrieve_codebase is rejected", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "get code chunks",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { ok: false, error: "repo 'evil/private' is not in the indexed namespace set" }
      },
    }
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "bad", function: { name: "retrieve_codebase", arguments: "{}" } }],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: '{"answer":"no","confidence":2,"abstain":true}' },
        hasToolCalls: false,
      })

    const { args, captured } = makeArgs({
      tools: [tool],
      telemetryContext: {
        singleShotPrompt: "single-shot prompt",
        singleShotSchema: { type: "object" },
        promptBuilderVersion: "1.0.0",
        promptBuilderSource: "// pretend source",
        linearMentionRetrieval: {
          availableRepos: ["sigilix/sigilix"],
          mappedRepo: "sigilix/sigilix",
          repoStatus: "mapped_indexed",
          initialRetrievalNamespace: "sigilix/sigilix",
          initialChunkCount: 3,
        },
      },
    } as Partial<AgentLoopArgs>)

    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true)
    expect(captured.payload?.linearMentionRetrieval).toMatchObject({
      calledRetrieveCodebase: true,
      retrieveCodebaseCallCount: 1,
      retrievalNamespace: null,
      chunkCount: 0,
      toolRetrievals: [{ ok: false, error: "repo 'evil/private' is not in the indexed namespace set" }],
    })
  })

  it("keeps the successful retrieval summary even when stored details are capped", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "get code chunks",
      parameters: { type: "object", properties: { i: { type: "number" } }, required: ["i"] },
      async execute(args) {
        return args.i === 6
          ? { ok: true, repo: "sigilix/sigilix", count: 2 }
          : { ok: false, error: `miss ${String(args.i)}` }
      },
    }
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: Array.from({ length: 6 }, (_, i) => ({
            id: `call-${i + 1}`,
            function: { name: "retrieve_codebase", arguments: JSON.stringify({ i: i + 1 }) },
          })),
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: '{"answer":"yes","confidence":5,"abstain":false}' },
        hasToolCalls: false,
      })

    const { args, captured } = makeArgs({ tools: [tool] })

    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true)
    expect(captured.payload?.linearMentionRetrieval).toMatchObject({
      retrieveCodebaseCallCount: 6,
      retrievalNamespace: "sigilix/sigilix",
      chunkCount: 2,
    })
    expect(captured.payload?.linearMentionRetrieval?.toolRetrievals).toHaveLength(5)
  })

  it("summarizes thrown retrieve_codebase failures in telemetry", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "get code chunks",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        throw new Error("vectorize unavailable")
      },
    }
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "boom", function: { name: "retrieve_codebase", arguments: "{}" } }],
      },
      hasToolCalls: true,
    })
    const { args, captured } = makeArgs({ tools: [tool] })

    const result = await runAgentLoop(args)
    expect(result).toMatchObject({ ok: false, reason: "tool_execution_failed", toolName: "retrieve_codebase" })
    expect(captured.payload?.linearMentionRetrieval).toMatchObject({
      calledRetrieveCodebase: true,
      retrieveCodebaseCallCount: 1,
      retrievalNamespace: null,
      chunkCount: 0,
      toolRetrievals: [{ ok: false, error: "Error: vectorize unavailable" }],
    })
  })

  it("serializes non-Error retrieve_codebase rejections for telemetry", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "get code chunks",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return Promise.reject({ code: 503, message: "vectorize unavailable" })
      },
    }
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "boom", function: { name: "retrieve_codebase", arguments: "{}" } }],
      },
      hasToolCalls: true,
    })
    const { args, captured } = makeArgs({ tools: [tool] })

    const result = await runAgentLoop(args)
    expect(result).toMatchObject({ ok: false, reason: "tool_execution_failed", toolName: "retrieve_codebase" })
    expect(captured.payload?.linearMentionRetrieval?.toolRetrievals[0]?.error).toContain("vectorize unavailable")
  })

  it("uses a stable telemetry error for undefined retrieve_codebase rejections", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "get code chunks",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return Promise.reject(undefined)
      },
    }
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "boom", function: { name: "retrieve_codebase", arguments: "{}" } }],
      },
      hasToolCalls: true,
    })
    const { args, captured } = makeArgs({ tools: [tool] })

    const result = await runAgentLoop(args)
    expect(result).toMatchObject({ ok: false, reason: "tool_execution_failed", toolName: "retrieve_codebase" })
    expect(captured.payload?.linearMentionRetrieval?.toolRetrievals[0]?.error).toBe("null")
  })
})
