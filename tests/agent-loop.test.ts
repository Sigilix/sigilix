// Agent loop tests. Mocks `chat()` to drive runLoopBody through
// every documented exit path and verify telemetry runs on each.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()

vi.mock("../src/lib/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ollama-chat")>(
    "../src/lib/ollama-chat",
  )
  return {
    ...actual,
    chat: (args: unknown) => mockChat(args),
  }
})

import {
  buildTelemetryRecordInput,
  runAgentLoop,
  withComposedTimeout,
  type AgentLoopArgs,
  type AgentLoopResult,
  type AgentLoopTelemetryRecordInput,
  type AgentLoopTelemetrySink,
  type LoopTelemetryState,
} from "../src/lib/agent-loop"
import type { AgentTool } from "../src/lib/agent-tools"
import { ChatDisabledError } from "../src/lib/ollama-chat"
import type { Env } from "../src/index"

beforeEach(() => {
  mockChat.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ──────────────────────────────────────────────────────────── helpers

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
    OPENCLAW_JOBS: {} as Queue<never>,
    LINEAR_API_KEY: "x",
    LINEAR_WEBHOOK_SECRET: "x",
    OLLAMA_API_KEY: "x",
    OLLAMA_CHAT_ENABLE: "on",
    ...overrides,
  } as Env
}

interface CapturedTelemetry {
  payload: AgentLoopTelemetryRecordInput | null
  callCount: number
}

function makeSink(): { sink: AgentLoopTelemetrySink; captured: CapturedTelemetry } {
  const captured: CapturedTelemetry = { payload: null, callCount: 0 }
  return {
    sink: {
      async record(input) {
        captured.payload = input
        captured.callCount += 1
      },
    },
    captured,
  }
}

function makeArgs(overrides: Partial<AgentLoopArgs> = {}): {
  args: AgentLoopArgs
  captured: CapturedTelemetry
  events: Array<{ kind: string }>
} {
  const { sink, captured } = makeSink()
  const events: Array<{ kind: string }> = []
  const args: AgentLoopArgs = {
    model: "glm-5.1:cloud",
    apiKey: "x",
    env: makeEnv(),
    surface: "linear-mention",
    commentId: "comment-1",
    systemPrompt: "you are arc",
    initialUserMessage: "hello",
    tools: [],
    maxToolTurns: 3,
    finalAnswerSchema: { type: "object" },
    telemetry: sink,
    telemetryContext: {
      singleShotPrompt: "single-shot prompt",
      singleShotSchema: { type: "object" },
      promptBuilderVersion: "1.0.0",
      promptBuilderSource: "// pretend source",
    },
    log: (e) => events.push(e),
    ...overrides,
  }
  return { args, captured, events }
}

function abortError(): Error & { name: string } {
  const e = new Error("aborted") as Error & { name: string }
  e.name = "AbortError"
  return e
}

// ──────────────────────────────────────────────────────────── happy path

describe("runAgentLoop — happy paths", () => {
  it("returns ok with parsed answer when model emits final-answer turn 1", async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: '{"answer":"yes","confidence":5,"abstain":false}' },
      hasToolCalls: false,
    })
    const { args, captured } = makeArgs()
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answer).toEqual({ answer: "yes", confidence: 5, abstain: false })
    expect(result.stats.toolTurns).toBe(0)
    expect(result.stats.toolCallCount).toBe(0)
    expect(captured.callCount).toBe(1)
    expect(captured.payload?.fallback).toBeUndefined()
  })

  it("makes one tool call → result fed back → final answer turn 2", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "get code chunks",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute() {
        return { ok: true, chunks: [{ path: "x.ts", content: "..." }], count: 1 }
      },
    }
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", function: { name: "retrieve_codebase", arguments: '{"query":"foo"}' } },
          ],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: '{"answer":"found","confidence":5,"abstain":false}' },
        hasToolCalls: false,
      })

    const { args, captured } = makeArgs({ tools: [tool] })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stats.toolTurns).toBe(1)
    expect(result.stats.toolCallCount).toBe(1)
    expect(captured.payload?.toolCalls).toHaveLength(1)
    expect(captured.payload?.toolCalls[0]?.name).toBe("retrieve_codebase")
    expect(captured.payload?.toolCalls[0]?.ok).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────── failure paths

describe("runAgentLoop — failure paths (telemetry on each)", () => {
  it("chat() throws → chat_error → telemetry recorded", async () => {
    mockChat.mockRejectedValueOnce(new Error("boom"))
    const { args, captured } = makeArgs()
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("chat_error")
    expect(captured.callCount).toBe(1)
    expect(captured.payload?.fallback).toBe("chat_error")
  })

  it("chat() throws AbortError → wall_clock_exceeded → telemetry recorded", async () => {
    mockChat.mockRejectedValueOnce(abortError())
    const { args, captured } = makeArgs()
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("wall_clock_exceeded")
    expect(captured.callCount).toBe(1)
    expect(captured.payload?.fallback).toBe("wall_clock_exceeded")
  })

  it("chat() throws ChatDisabledError → chat_disabled → telemetry recorded", async () => {
    mockChat.mockRejectedValueOnce(new ChatDisabledError())
    const { args, captured } = makeArgs()
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("chat_disabled")
    expect(captured.callCount).toBe(1)
  })

  it("OLLAMA_CHAT_ENABLE=off at entry → chat_disabled → telemetry recorded", async () => {
    const { args, captured } = makeArgs({ env: makeEnv({ OLLAMA_CHAT_ENABLE: "off" }) })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("chat_disabled")
    expect(captured.callCount).toBe(1)
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("model emits unknown tool → unknown_tool → telemetry recorded", async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "nonexistent_tool", arguments: "{}" } },
        ],
      },
      hasToolCalls: true,
    })
    const { args, captured } = makeArgs()
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("unknown_tool")
    if (result.reason !== "unknown_tool") return
    expect(result.toolName).toBe("nonexistent_tool")
    expect(captured.callCount).toBe(1)
  })

  it("malformed tool args → bad-args retry path (NOT chat_error)", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "x",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute() {
        return { ok: true }
      },
    }
    // Turn 1: malformed JSON → loop appends validation-error tool message
    // Turn 2: valid args → loop continues
    // Turn 3: final answer
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", function: { name: "retrieve_codebase", arguments: "{not valid json" } },
          ],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c2", function: { name: "retrieve_codebase", arguments: '{"query":"x"}' } },
          ],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: '{"answer":"ok","confidence":4,"abstain":false}' },
        hasToolCalls: false,
      })
    const { args, captured } = makeArgs({ tools: [tool] })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true) // loop recovered, NOT chat_error
    if (!result.ok) return
    expect(result.stats.toolTurns).toBe(2)
    expect(captured.payload?.fallback).toBeUndefined()
  })

  it("two consecutive turns of bad args → tool_args_invalid_after_retry", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "x",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute() {
        return { ok: true }
      },
    }
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "retrieve_codebase", arguments: "{bad json 1" } }],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c2", function: { name: "retrieve_codebase", arguments: "{bad json 2" } }],
        },
        hasToolCalls: true,
      })
    const { args, captured } = makeArgs({ tools: [tool] })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("tool_args_invalid_after_retry")
    expect(captured.callCount).toBe(1)
  })

  it("tool execute() throws → tool_execution_failed → telemetry recorded", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "x",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute() {
        throw new Error("network down")
      },
    }
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "retrieve_codebase", arguments: '{"query":"x"}' } },
        ],
      },
      hasToolCalls: true,
    })
    const { args, captured } = makeArgs({ tools: [tool] })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("tool_execution_failed")
    expect(captured.callCount).toBe(1)
  })

  it("tool returns recoverable {ok:false, error} → loop continues (NOT failure)", async () => {
    const tool: AgentTool = {
      name: "fetch_pr",
      description: "x",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { ok: false, error: "Repo torvalds/linux is outside the allowed set" }
      },
    }
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "fetch_pr", arguments: "{}" } }],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: '{"answer":"ok","confidence":3,"abstain":false}' },
        hasToolCalls: false,
      })
    const { args } = makeArgs({ tools: [tool] })
    const result = await runAgentLoop(args)
    // Loop should NOT exit with tool_execution_failed — recoverable returns
    // are appended as tool messages and the model course-corrects.
    expect(result.ok).toBe(true)
  })

  it("hits maxToolTurns → forced final-answer (no orphan tool_calls in messages sent)", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "x",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute() {
        return { ok: true, chunks: [] }
      },
    }
    let lastForcedCall: { messages: unknown[]; tools: unknown[]; format: unknown } | null = null
    mockChat.mockImplementation(async (callArgs: { messages: unknown[]; tools?: unknown[]; format?: unknown }) => {
      // Track whether this is the forced-final call (has empty tools array AND format).
      if (Array.isArray(callArgs.tools) && callArgs.tools.length === 0 && callArgs.format) {
        lastForcedCall = {
          messages: callArgs.messages,
          tools: callArgs.tools,
          format: callArgs.format,
        }
        return {
          message: { role: "assistant", content: '{"answer":"forced","confidence":2,"abstain":false}' },
          hasToolCalls: false,
        }
      }
      // Normal turn: emit a tool call to keep the loop going.
      return {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c", function: { name: "retrieve_codebase", arguments: '{"query":"x"}' } }],
        },
        hasToolCalls: true,
      }
    })
    const { args } = makeArgs({ tools: [tool], maxToolTurns: 2 })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true)
    expect(lastForcedCall).not.toBeNull()
    // Crucial: the messages sent to the forced-final chat() call MUST
    // NOT end with an orphan assistant tool_calls message. The last
    // message should be the budget-exhausted system note.
    const msgs = lastForcedCall!.messages as Array<{ role: string; tool_calls?: unknown }>
    const last = msgs[msgs.length - 1]!
    expect(last.role).toBe("system")
    expect(last.tool_calls).toBeUndefined()
  })

  it("forced final-answer returns tool_calls anyway → final_answer_did_not_parse", async () => {
    const tool: AgentTool = {
      name: "retrieve_codebase",
      description: "x",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute() {
        return { ok: true }
      },
    }
    mockChat.mockImplementation(async (callArgs: { tools?: unknown[]; format?: unknown }) => {
      if (Array.isArray(callArgs.tools) && callArgs.tools.length === 0 && callArgs.format) {
        // Forced final-answer turn — defy expectations and emit tool_calls.
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "x", function: { name: "retrieve_codebase", arguments: "{}" } }],
          },
          hasToolCalls: true,
        }
      }
      return {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c", function: { name: "retrieve_codebase", arguments: '{"query":"x"}' } }],
        },
        hasToolCalls: true,
      }
    })
    const { args, captured } = makeArgs({ tools: [tool], maxToolTurns: 1 })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("final_answer_did_not_parse")
    expect(captured.callCount).toBe(1)
  })

  it("final-answer doesn't parse as JSON → final_answer_did_not_parse", async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: "this is not json" },
      hasToolCalls: false,
    })
    const { args, captured } = makeArgs()
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("final_answer_did_not_parse")
    expect(captured.callCount).toBe(1)
  })

  it("unexpected throw from runLoopBody → internal_error → telemetry STILL records", async () => {
    // Force a throw from chat() that's NOT AbortError or ChatDisabledError
    // (those have specific handling). Any other throw type should still
    // make it through chat_error path. To trigger internal_error we need
    // a throw OUTSIDE the inner try blocks — simulate by making the tool
    // throw a non-Error value that our string conversion still wraps.
    // The path: makeArgs.tools is iterated for toolsByName; if a tool's
    // properties access blows up, that's an internal_error.
    const blowUpTool = {
      get name(): string {
        throw new Error("kaboom")
      },
    } as unknown as AgentTool
    const { args, captured } = makeArgs({ tools: [blowUpTool] })
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("internal_error")
    expect(captured.callCount).toBe(1)
    expect(captured.payload?.fallback).toBe("internal_error")
  })
})

// ──────────────────────────────────────────────────────────── telemetry

describe("buildTelemetryRecordInput", () => {
  it("builds payload with all fields populated on success", () => {
    const { args } = makeArgs()
    const result: AgentLoopResult = {
      ok: true,
      answer: { x: 1 },
      stats: { toolTurns: 2, totalMs: 1000, toolCallCount: 3 },
    }
    const state: LoopTelemetryState = {
      startMs: Date.now() - 1000,
      turns: 2,
      toolCalls: [{ name: "x", ok: true, elapsedMs: 100, argsHash: "abc" }],
    }
    const payload = buildTelemetryRecordInput(result, args, state)
    expect(payload.schemaVersion).toBe(2)
    expect(payload.surface).toBe("linear-mention")
    expect(payload.commentId).toBe("comment-1")
    expect(payload.agentInitialUserMessage).toBe("hello")
    expect(payload.singleShotPrompt).toBe("single-shot prompt")
    expect(payload.promptBuilderSource).toBe("// pretend source")
    expect(payload.turns).toBe(2)
    expect(payload.toolCalls).toHaveLength(1)
    expect(payload.finalAnswer).toEqual({ x: 1 })
    expect(payload.fallback).toBeUndefined()
    expect(payload.totalMs).toBeGreaterThanOrEqual(900)
  })

  it("sets fallback + null finalAnswer on failure", () => {
    const { args } = makeArgs()
    const result: AgentLoopResult = { ok: false, reason: "wall_clock_exceeded" }
    const state: LoopTelemetryState = { startMs: Date.now(), turns: 0, toolCalls: [] }
    const payload = buildTelemetryRecordInput(result, args, state)
    expect(payload.fallback).toBe("wall_clock_exceeded")
    expect(payload.finalAnswer).toBe(null)
  })

  it("includes prNumber when provided", () => {
    const { args } = makeArgs({ prNumber: 162 })
    const result: AgentLoopResult = { ok: false, reason: "chat_error", error: "x" }
    const state: LoopTelemetryState = { startMs: Date.now(), turns: 0, toolCalls: [] }
    const payload = buildTelemetryRecordInput(result, args, state)
    expect(payload.prNumber).toBe(162)
  })

  it("includes failureRawAnswer ONLY on final_answer_did_not_parse", () => {
    const { args } = makeArgs()
    const state: LoopTelemetryState = { startMs: Date.now(), turns: 3, toolCalls: [] }

    // The failure mode we instrumented for: model returned something
    // that didn't parse as JSON OR didn't match the schema.
    const parseFail: AgentLoopResult = {
      ok: false,
      reason: "final_answer_did_not_parse",
      rawAnswer: "Sure, here's my answer: { \"answer\": 42 }",
    }
    expect(buildTelemetryRecordInput(parseFail, args, state).failureRawAnswer).toBe(
      "Sure, here's my answer: { \"answer\": 42 }",
    )

    // Other failure modes don't carry rawAnswer — the field stays absent.
    const wallClock: AgentLoopResult = { ok: false, reason: "wall_clock_exceeded" }
    expect(buildTelemetryRecordInput(wallClock, args, state).failureRawAnswer).toBeUndefined()

    const success: AgentLoopResult = {
      ok: true,
      answer: { x: 1 },
      stats: { toolTurns: 1, totalMs: 100, toolCallCount: 1 },
    }
    expect(buildTelemetryRecordInput(success, args, state).failureRawAnswer).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────── withComposedTimeout

describe("withComposedTimeout", () => {
  it("resolves when factory returns before timeout", async () => {
    const value = await withComposedTimeout(async () => 42, 1_000)
    expect(value).toBe(42)
  })

  it("HARD timeout: factory ignoring its signal still gets killed", async () => {
    // Factory that NEVER resolves and NEVER reads its signal — pure
    // setTimeout that doesn't honor abort.
    const slowFactory = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve("late"), 10_000))
    const start = Date.now()
    await expect(withComposedTimeout(slowFactory, 50)).rejects.toThrow(/aborted/)
    expect(Date.now() - start).toBeLessThan(500) // killed in ~50ms, not 10s
  })

  it("composes parent signal — parent abort kills the call", async () => {
    const parent = new AbortController()
    const factory = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve("late"), 10_000))
    const promise = withComposedTimeout(factory, 60_000, parent.signal)
    setTimeout(() => parent.abort(), 30)
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it("pre-aborted parent rejects immediately (round-5/6 race fix)", async () => {
    const parent = new AbortController()
    parent.abort() // already aborted BEFORE call
    const factory = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve("late"), 10_000))
    const start = Date.now()
    await expect(withComposedTimeout(factory, 60_000, parent.signal)).rejects.toThrow(/aborted/)
    expect(Date.now() - start).toBeLessThan(100)
  })

  it("propagates non-Abort errors", async () => {
    await expect(withComposedTimeout(async () => { throw new Error("boom") }, 1_000)).rejects.toThrow("boom")
  })
})

// ──────────────────────────────────────────────────────────── single-source-of-truth telemetry

describe("runAgentLoop — telemetry runs on EVERY exit path", () => {
  // Parameterized: run a different scenario for each documented failure
  // reason and assert telemetry.record was called exactly once.
  const cases: Array<{
    name: string
    setup: () => { args: AgentLoopArgs; captured: CapturedTelemetry }
    expectedReason: string
  }> = [
    {
      name: "chat_disabled (env at entry)",
      setup: () => makeArgs({ env: makeEnv({ OLLAMA_CHAT_ENABLE: "off" }) }) as ReturnType<typeof makeArgs>,
      expectedReason: "chat_disabled",
    },
  ]
  for (const c of cases) {
    it(`records telemetry on ${c.name}`, async () => {
      const { args, captured } = c.setup()
      const result = await runAgentLoop(args)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe(c.expectedReason)
      expect(captured.callCount).toBe(1)
      expect(captured.payload?.fallback).toBe(c.expectedReason)
    })
  }

  it("records telemetry even when sink itself rejects (soft-fail)", async () => {
    const sink: AgentLoopTelemetrySink = {
      async record() {
        throw new Error("KV write failed")
      },
    }
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: '{"answer":"ok","confidence":5,"abstain":false}' },
      hasToolCalls: false,
    })
    const events: Array<{ kind: string }> = []
    const args: AgentLoopArgs = {
      ...makeArgs().args,
      telemetry: sink,
      log: (e) => events.push(e),
    }
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true) // reply still returned even though sink failed
    expect(events.some((e) => e.kind === "telemetry-soft-fail")).toBe(true)
  })
})
