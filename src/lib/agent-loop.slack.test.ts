// Task 7 — surface union widening: slack-mention.
//
// Mirrors the stubbing approach in agent-loop.test.ts (same vi.mock of
// ollama-chat, same makeArgs/makeSink helpers). The test drives a single-
// shot happy-path run with surface:"slack-mention" and verifies:
//   (a) the run completes successfully,
//   (b) the log "start" event carries surface:"slack-mention",
//   (c) the telemetry sink receives surface:"slack-mention".
//
// There are also compile-time-only assertions (not callable at runtime)
// that "slack-mention" is assignable to all three union sites so a type
// regression is caught even if the runtime test were somehow skipped.

import { describe, expect, it, vi } from "vitest"

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

import { runAgentLoop, type AgentLoopArgs, type AgentLoopTelemetryRecordInput } from "@/src/lib/agent-loop"
import type { AgentToolsContext } from "@/src/lib/agent-tools"
import type { Env } from "@/src/shared/types/env"

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

// ──────────────────────────────────────────────────────────── compile-time type assertions
// `satisfies` gives TS error pre-widening (TS2677) if "slack-mention" is
// not in the union; compiles clean post-widening. `void` suppresses unused
// expression warnings. No variable declaration → no TS6133.
void ("slack-mention" satisfies AgentLoopArgs["surface"])
void ("slack-mention" satisfies AgentLoopTelemetryRecordInput["surface"])
void ("slack-mention" satisfies AgentToolsContext["surface"])

// ──────────────────────────────────────────────────────────── runtime tests

describe("runAgentLoop — slack-mention surface", () => {
  it("completes a single-shot run and surfaces slack-mention in log + telemetry", async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: '{"answer":"ok from slack","confidence":5,"abstain":false}',
      },
      hasToolCalls: false,
    })

    const capturedEvents: Array<{ kind: string; surface?: string }> = []
    // Use an object property (not a let) so TypeScript doesn't narrow
    // the type through the callback closure (mirrors agent-loop.test.ts).
    const captured = { telemetry: null as AgentLoopTelemetryRecordInput | null }

    const args: AgentLoopArgs = {
      model: "glm-5.1:cloud",
      apiKey: "x",
      env: makeEnv(),
      surface: "slack-mention",
      commentId: "slack-C123-1234567890",
      systemPrompt: "You are Sigilix. Answer the question.",
      initialUserMessage: "hello from slack",
      tools: [],
      maxToolTurns: 3,
      finalAnswerSchema: { type: "object" },
      telemetry: {
        async record(input) {
          captured.telemetry = input
        },
      },
      telemetryContext: {
        singleShotPrompt: "single-shot prompt",
        singleShotSchema: { type: "object" },
        promptBuilderVersion: "1.0.0",
        promptBuilderSource: "// slack-mention source",
      },
      log: (e) => capturedEvents.push(e as { kind: string; surface?: string }),
    }

    const result = await runAgentLoop(args)

    // (a) run completes
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answer).toEqual({ answer: "ok from slack", confidence: 5, abstain: false })

    // (b) "start" log event carries surface: "slack-mention"
    const startEvent = capturedEvents.find((e) => e.kind === "start")
    expect(startEvent).toBeDefined()
    expect(startEvent?.surface).toBe("slack-mention")

    // (c) telemetry sink receives surface: "slack-mention"
    expect(captured.telemetry).not.toBeNull()
    expect(captured.telemetry?.surface).toBe("slack-mention")
  })
})
