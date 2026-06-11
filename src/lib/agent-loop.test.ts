// Agent loop tests. Mocks `chat()` to drive runLoopBody through
// every documented exit path and verify telemetry runs on each.

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
  buildTelemetryRecordInput,
  runAgentLoop,
  withComposedTimeout,
  WITH_COMPOSED_TIMEOUT_ABORT_GRACE_MS,
  type AgentLoopArgs,
  type AgentLoopResult,
  type AgentLoopTelemetryRecordInput,
  type AgentLoopTelemetrySink,
  type LoopTelemetryState,
} from "@/src/lib/agent-loop"
import type { AgentTool } from "@/src/lib/agent-tools"
import { ChatDisabledError } from "@/src/shared/adapters/model/ollama-chat"
import type { Env } from "@/src/shared/types/env"

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
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      async execute() {
        return { ok: true, chunks: [{ path: "x.ts", content: "..." }], count: 1 }
      },
    }
    mockChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "retrieve_codebase", arguments: '{"query":"foo"}' } }],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: '{"answer":"found","confidence":5,"abstain":false}',
        },
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
        tool_calls: [{ id: "c1", function: { name: "nonexistent_tool", arguments: "{}" } }],
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
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
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
          tool_calls: [{ id: "c1", function: { name: "retrieve_codebase", arguments: "{not valid json" } }],
        },
        hasToolCalls: true,
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c2", function: { name: "retrieve_codebase", arguments: '{"query":"x"}' } }],
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
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
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
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      async execute() {
        throw new Error("network down")
      },
    }
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", function: { name: "retrieve_codebase", arguments: '{"query":"x"}' } }],
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
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
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
          message: {
            role: "assistant",
            content: '{"answer":"forced","confidence":2,"abstain":false}',
          },
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
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
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

  it("final-answer with prose preamble + fenced JSON parses successfully (regression: GLM-5.1 on ARC-149)", async () => {
    // Verbatim shape captured from production telemetry (PR #32) — GLM-5.1
    // wrote a prose summary of its tool-call findings, then a ```json
    // fence with the actual final answer. The previous parser required
    // the entire content to be a JSON object (with at most a surrounding
    // fence), so this fell into final_answer_did_not_parse and the loop
    // wasted a single-shot fallback that itself produced the wrong reply.
    const realProsePlusFence = [
      'No mention of "Todd Bowles" found in either the `sigilix-website` or `rubberfit` repos. The `sigilix-website` search returned zero results, and the `rubberfit` search returned only unrelated code chunks with low relevance scores.',
      "",
      "```json",
      '{"answer": "No mention of Todd Bowles found anywhere in the sigilix-website repo (or the other indexed repos).", "confidence": 4, "abstain": false}',
      "```",
    ].join("\n")
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: realProsePlusFence },
      hasToolCalls: false,
    })
    const { args } = makeArgs()
    const result = await runAgentLoop(args)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answer).toEqual({
      answer: expect.stringContaining("No mention of Todd Bowles"),
      confidence: 4,
      abstain: false,
    })
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
      rawAnswer: 'Sure, here\'s my answer: { "answer": 42 }',
    }
    expect(buildTelemetryRecordInput(parseFail, args, state).failureRawAnswer).toBe(
      'Sure, here\'s my answer: { "answer": 42 }',
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
    // setTimeout that doesn't honor abort. Killed at timer + grace.
    const slowFactory = (): Promise<string> => new Promise((resolve) => setTimeout(() => resolve("late"), 10_000))
    const start = Date.now()
    await expect(withComposedTimeout(slowFactory, 50)).rejects.toThrow(/aborted/)
    // Phase 4a.2: grace window allows abort-aware factories to settle;
    // ignored-signal factories die at timer + WITH_COMPOSED_TIMEOUT_ABORT_GRACE_MS.
    const slack = 500
    expect(Date.now() - start).toBeLessThan(50 + WITH_COMPOSED_TIMEOUT_ABORT_GRACE_MS + slack)
  })

  it("composes parent signal — parent abort kills the call", async () => {
    const parent = new AbortController()
    const factory = (): Promise<string> => new Promise((resolve) => setTimeout(() => resolve("late"), 10_000))
    const promise = withComposedTimeout(factory, 60_000, parent.signal)
    setTimeout(() => parent.abort(), 30)
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it("pre-aborted parent rejects synchronously without invoking factory", async () => {
    const parent = new AbortController()
    parent.abort() // already aborted BEFORE call
    let factoryInvoked = false
    const factory = (): Promise<string> => {
      factoryInvoked = true
      return new Promise((resolve) => setTimeout(() => resolve("late"), 10_000))
    }
    const start = Date.now()
    await expect(withComposedTimeout(factory, 60_000, parent.signal)).rejects.toThrow(/aborted/)
    expect(Date.now() - start).toBeLessThan(100)
    // Phase 4a.2: pre-aborted parent means caller asked us to bail
    // before doing any work. Factory should never run.
    expect(factoryInvoked).toBe(false)
  })

  it("propagates non-Abort errors", async () => {
    await expect(
      withComposedTimeout(async () => {
        throw new Error("boom")
      }, 1_000),
    ).rejects.toThrow("boom")
  })

  // ─── Phase 4a.2 grace-window behavior ─────────────────────────

  it("preserves abort-aware factory's structured failure when timer fires", async () => {
    // Phase 4a.2: a factory that respects its signal and produces a
    // structured failure on abort (not a throw) should have its
    // settlement returned, not discarded by the wrapper.
    type Result = { ok: false; reason: string; attemptsUsed: number; modelUsed: string }
    const abortAwareFactory = async (signal: AbortSignal): Promise<Result> => {
      // Simulate a long-running call that resolves cleanly when aborted,
      // returning a structured failure with diagnostic fields populated.
      return await new Promise<Result>((resolve) => {
        const t = setTimeout(
          () =>
            resolve({
              ok: false,
              reason: "should_not_reach",
              attemptsUsed: 0,
              modelUsed: "primary",
            }),
          10_000,
        )
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t)
            resolve({ ok: false, reason: "aborted", attemptsUsed: 1, modelUsed: "primary" })
          },
          { once: true },
        )
      })
    }
    const result = await withComposedTimeout(abortAwareFactory, 50)
    expect(result).toEqual({ ok: false, reason: "aborted", attemptsUsed: 1, modelUsed: "primary" })
  })

  it("preserves abort-aware factory's structured failure when parent aborts mid-flight", async () => {
    type Result = { ok: false; reason: string; modelUsed: string }
    const abortAwareFactory = async (signal: AbortSignal): Promise<Result> =>
      new Promise<Result>((resolve) => {
        const t = setTimeout(() => resolve({ ok: false, reason: "should_not_reach", modelUsed: "primary" }), 10_000)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t)
            resolve({ ok: false, reason: "aborted_by_parent", modelUsed: "primary" })
          },
          { once: true },
        )
      })
    const parent = new AbortController()
    const promise = withComposedTimeout(abortAwareFactory, 60_000, parent.signal)
    setTimeout(() => parent.abort(), 30)
    const result = await promise
    expect(result).toEqual({ ok: false, reason: "aborted_by_parent", modelUsed: "primary" })
  })

  it("grace window expires: signal-ignoring factory still throws", async () => {
    // Factory that ignores its signal AND never resolves on its own
    // within the grace window. Wrapper must throw to unblock the caller.
    const ignoresSignalFactory = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve("late"), 10_000))
    const start = Date.now()
    await expect(withComposedTimeout(ignoresSignalFactory, 50)).rejects.toThrow(/aborted/)
    // Should not wait for full 10s; should throw at ~timer + grace.
    expect(Date.now() - start).toBeLessThan(50 + WITH_COMPOSED_TIMEOUT_ABORT_GRACE_MS + 500)
  })

  it("propagates non-Abort error thrown after the timer fired", async () => {
    // Factory that detects abort but rejects with its own non-Abort
    // error during cleanup. The grace branch must surface the real
    // error, not mask it with the wrapper's abort rejection.
    const failingFactory = (signal: AbortSignal): Promise<string> =>
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error("never-fired")), 10_000)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t)
            reject(new Error("custom_cleanup_error"))
          },
          { once: true },
        )
      })
    await expect(withComposedTimeout(failingFactory, 50)).rejects.toThrow("custom_cleanup_error")
  })

  it("double-abort (parent + timer both fire) is idempotent", async () => {
    // Both the per-call timer and the parent signal fire. The wrapper's
    // `abort()` is guarded by `ctrl.signal.aborted`, so the second call
    // is a no-op. Factory should still receive a single abort and
    // settle once with its structured failure.
    type Result = { reason: string; abortCount: number }
    let abortCount = 0
    const abortAwareFactory = (signal: AbortSignal): Promise<Result> =>
      new Promise<Result>((resolve) => {
        const t = setTimeout(() => resolve({ reason: "should_not_reach", abortCount }), 10_000)
        signal.addEventListener(
          "abort",
          () => {
            abortCount++
            clearTimeout(t)
            resolve({ reason: "aborted", abortCount })
          },
          { once: true },
        )
      })
    const parent = new AbortController()
    // Timer fires at 30ms; parent fires at 35ms — both should call abort.
    setTimeout(() => parent.abort(), 35)
    const result = await withComposedTimeout(abortAwareFactory, 30, parent.signal)
    expect(result.reason).toBe("aborted")
    expect(result.abortCount).toBe(1)
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
