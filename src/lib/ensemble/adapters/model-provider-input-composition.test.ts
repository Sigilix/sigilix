// SIG-369(b) PR-1 — integration test for the logic-input-composition capture
// through the REAL specialist path (runSpecialist → runWithRetryAndFallback →
// attemptChat → the protected onAttempt → onInputComposition recorder).
//
// Proves the per-CALL input split surfaces correctly for: single-shot (one
// call), the tool conversation (two calls, the final re-sends everything), and
// the retry ladder (every settled attempt counted, so the sum reconciles with
// the `tokenUsageByModel` accumulator semantics). Also proves the off path
// (no observer) is a pure no-op.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, chat: (args: unknown) => mockChat(args) }
})

import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import {
  buildLogicInputComposition,
  makeLogicInputCompositionRecorder,
  type LogicInputCompositionRecorder,
} from "@/src/lib/ensemble/domain/logic-input-composition"
import { makeTokenRecorder, type TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"
import type { ChatArgs } from "@/src/shared/ports/model"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"

const validVerdict = JSON.stringify({
  summary: "Logic review.",
  confidence: 4,
  confidenceReason: "ok",
  findings: [],
})

/** A perfCtx whose recordTokens feeds a TokenUsageByModel sink, so each test can
 *  assert the composition's `summedInputTokens` reconciles with the per-model
 *  accumulator (both fed by the same per-call usage). */
function perfCtxWithSink(sink: TokenUsageByModel): EnsembleRunCtx {
  return {
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 568,
    headSha: "a".repeat(40),
    recordTokens: makeTokenRecorder(sink),
  }
}

/** The observer specialists.ts wires for the logic role in shadow mode. */
function observerFor(recorder: LogicInputCompositionRecorder) {
  return (info: { perCallInputTokens: Array<number | undefined>; toolCallsMade: number; toolResultTokens: number }) => {
    for (const inputTokens of info.perCallInputTokens) recorder.recordCall(inputTokens)
    recorder.recordToolActivity(info.toolCallsMade, info.toolResultTokens)
  }
}

describe("runSpecialist → logic-input-composition capture", () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it("single-shot (no tools): one per-call entry, no tool loop, reconciles with tokenUsageByModel", async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: validVerdict },
      hasToolCalls: false,
      usage: { inputTokens: 140_000, outputTokens: 500 },
    })
    const recorder = makeLogicInputCompositionRecorder()
    const sink: TokenUsageByModel = {}

    const result = await runSpecialist({
      role: "logic",
      apiKeys: { openrouter: "test-key", ollama: "test-key" },
      systemPrompt: "logic system",
      initialMessage: "[DIFF]\n@@ +1 @@\n+ const x = 1",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: perfCtxWithSink(sink),
      mcpTools: { toolIds: [] },
      onInputComposition: observerFor(recorder),
    })

    expect(result.verdict).not.toBeNull()
    expect(mockChat).toHaveBeenCalledTimes(1)
    expect(recorder.perCallInputTokens).toEqual([140_000])
    expect(recorder.summedInputTokens).toBe(140_000)
    expect(recorder.callsMissingInputUsage).toBe(0)
    expect(recorder.toolCallsMade).toBe(0)
    expect(recorder.toolResultTokens).toBe(0)

    const composition = buildLogicInputComposition({
      systemPrompt: "logic system",
      initialMessage: "[DIFF]\n@@ +1 @@\n+ const x = 1",
      toolsAvailable: false,
      recorder,
    })
    expect(composition.toolLoop).toEqual({ toolsAvailable: false, toolCallsMade: 0, toolResultTokens: 0 })
    // The reconciliation invariant the spec requires: summedInputTokens ===
    // tokenUsageByModel[logic model].inputTokens (same per-call usage feeds both).
    expect(composition.summedInputTokens).toBe(sink["deepseek/deepseek-v4-pro"]?.inputTokens)
  })

  it("tool conversation: two per-call entries (tool-turn + final) so the doubling is visible", async () => {
    mockChat.mockImplementation(async (args: ChatArgs) => {
      if (args.tools?.some((t) => t.function.name === "file_grep")) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "g", function: { name: "file_grep", arguments: { query: "x", pathGlob: "src/**" } } }],
          },
          hasToolCalls: true,
          usage: { inputTokens: 13_000, outputTokens: 30 },
        }
      }
      // final call re-sends everything → larger input
      return {
        message: { role: "assistant", content: validVerdict },
        hasToolCalls: false,
        usage: { inputTokens: 21_000, outputTokens: 60 },
      }
    })
    const recorder = makeLogicInputCompositionRecorder()
    const sink: TokenUsageByModel = {}

    const result = await runSpecialist({
      role: "logic",
      apiKeys: { openrouter: "test-key", ollama: "test-key" },
      systemPrompt: "logic system",
      initialMessage: "src/auth.ts:1 export function f() {}",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: perfCtxWithSink(sink),
      mcpTools: { toolIds: ["file_grep"] },
      onInputComposition: observerFor(recorder),
    })

    expect(result.verdict).not.toBeNull()
    expect(mockChat).toHaveBeenCalledTimes(2)
    // BOTH calls' inputs captured separately — the tool-turn + the final.
    expect(recorder.perCallInputTokens).toEqual([13_000, 21_000])
    expect(recorder.summedInputTokens).toBe(34_000)
    expect(recorder.toolCallsMade).toBe(1)
    expect(recorder.toolResultTokens).toBeGreaterThan(0)
    // Reconciliation: the per-call sum equals what tokenUsageByModel accumulated
    // (attemptChat folds both tool calls into one onAttempt usage = 34_000).
    expect(recorder.summedInputTokens).toBe(sink["deepseek/deepseek-v4-pro"]?.inputTokens)
  })

  it("retry ladder: a transient failure (thrown, no call completed) then a recorded success", async () => {
    // First attempt: a retryable (503) failure that THROWS before any chat
    // result — the exception path returns no per-call data, so it contributes
    // nothing (it was not a completed call). Second attempt: success with usage.
    // This matches tokenUsageByModel, which also only sums settled usage.
    mockChat.mockRejectedValueOnce(new Error("OpenRouter HTTP 503: overloaded")).mockResolvedValueOnce({
      message: { role: "assistant", content: validVerdict },
      hasToolCalls: false,
      usage: { inputTokens: 99_000, outputTokens: 10 },
    })
    const recorder = makeLogicInputCompositionRecorder()
    const sink: TokenUsageByModel = {}

    const result = await runSpecialist({
      role: "logic",
      apiKeys: { openrouter: "test-key", ollama: "test-key" },
      systemPrompt: "logic system",
      initialMessage: "[DIFF]\n+ x",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: perfCtxWithSink(sink),
      mcpTools: { toolIds: [] },
      onInputComposition: observerFor(recorder),
    })

    expect(result.verdict).not.toBeNull()
    expect(result.attemptsUsed).toBe(2)
    expect(mockChat).toHaveBeenCalledTimes(2)
    // The thrown attempt produced NO chat result → no per-call entry AND not
    // counted as missing (it wasn't a completed call). Only the successful call
    // is recorded — exactly what tokenUsageByModel sees too.
    expect(recorder.perCallInputTokens).toEqual([99_000])
    expect(recorder.summedInputTokens).toBe(99_000)
    expect(recorder.callsMissingInputUsage).toBe(0)
    // Still reconciles with tokenUsageByModel (failed attempt added no tokens).
    expect(recorder.summedInputTokens).toBe(sink["deepseek/deepseek-v4-pro"]?.inputTokens)
  })

  it("a completed call that reports NO usage is counted as missing, not zero-filled", async () => {
    // A torn-stream-style success: the chat() call completed (returned a parseable
    // message) but the provider reported no usage. This IS a completed call, so it
    // increments callsMissingInputUsage and stays absent from perCallInputTokens.
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: validVerdict },
      hasToolCalls: false,
      // usage omitted entirely
    })
    const recorder = makeLogicInputCompositionRecorder()

    const result = await runSpecialist({
      role: "logic",
      apiKeys: { openrouter: "test-key", ollama: "test-key" },
      systemPrompt: "logic system",
      initialMessage: "[DIFF]\n+ x",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "c".repeat(40) },
      mcpTools: { toolIds: [] },
      onInputComposition: observerFor(recorder),
    })

    expect(result.verdict).not.toBeNull()
    expect(recorder.perCallInputTokens).toEqual([])
    expect(recorder.summedInputTokens).toBe(0)
    expect(recorder.callsMissingInputUsage).toBe(1)
  })

  it("off path (no observer): runSpecialist behaves identically, recorder untouched", async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: validVerdict },
      hasToolCalls: false,
      usage: { inputTokens: 12_345, outputTokens: 5 },
    })
    const recorder = makeLogicInputCompositionRecorder()

    const result = await runSpecialist({
      role: "logic",
      apiKeys: { openrouter: "test-key", ollama: "test-key" },
      systemPrompt: "logic system",
      initialMessage: "[DIFF]\n+ x",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: { owner: "o", repo: "r", prNumber: 1, headSha: "b".repeat(40) },
      mcpTools: { toolIds: [] },
      // onInputComposition intentionally omitted (the `off` path)
    })

    expect(result.verdict).not.toBeNull()
    // Nothing observed — pure no-op.
    expect(recorder.perCallInputTokens).toEqual([])
    expect(recorder.summedInputTokens).toBe(0)
    expect(recorder.callsMissingInputUsage).toBe(0)
  })
})
