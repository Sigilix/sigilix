// SIG-460: provider retry-exclude — when an attempt fails MID-STREAM with an error
// that names the upstream provider ("Upstream error from WandB"), the next same-model
// attempt of the SAME run must steer off that provider via `provider: { ignore: [slug] }`.
// OpenRouter's automatic failover only covers request-time errors, so a plain retry can
// re-pick the same dead provider. Mirrors the chat-mock harness in
// model-provider-openrouter-cutover.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, chat: (args: unknown) => mockChat(args) }
})

import { runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import type { ModelConfig } from "@/src/lib/ensemble/domain/model-policy"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"

const BOTH_KEYS = { ollama: "ollama-key", openrouter: "openrouter-key" }
const validVerdict = JSON.stringify({ summary: "ok", confidence: 3, findings: [] })
const okResult = { message: { role: "assistant", content: validVerdict }, hasToolCalls: false, usage: {} }
const perfCtx: EnsembleRunCtx = { owner: "o", repo: "r", prNumber: 1, headSha: "a".repeat(40) }
const baseArgs = {
  systemPrompt: "system",
  initialMessage: "user",
  chatEnabled: "on" as const,
  signal: new AbortController().signal,
  perfCtx,
}
// deepseek-v4-pro (tests' model) — the one WandB serves; retries:1 → one recovery attempt.
const override: ModelConfig = { primary: "deepseek/deepseek-v4-pro", retries: 1, fallback: null }

describe("runWithRetryAndFallback — provider retry-exclude (SIG-460)", () => {
  beforeEach(() => mockChat.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("excludes a mid-stream-failed provider on the retry; first attempt carries no provider", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("OpenRouter stream error: Upstream error from WandB: Internal server error"))
      .mockResolvedValueOnce(okResult)

    const res = await runSpecialist({ role: "tests", apiKeys: BOTH_KEYS, modelOverride: override, ...baseArgs })

    expect(mockChat).toHaveBeenCalledTimes(2)
    const call1 = mockChat.mock.calls[0]![0] as { provider?: unknown }
    const call2 = mockChat.mock.calls[1]![0] as { provider?: { ignore?: string[] } }
    // First attempt is byte-identical to today — no provider routing.
    expect(call1.provider).toBeUndefined()
    // Retry steers off the dead provider.
    expect(call2.provider).toEqual({ ignore: ["wandb"] })
    // And the run recovers (verdict parsed on the WandB-free retry).
    expect(res.verdict).not.toBeNull()
  })

  it("adds NO provider exclusion when the failure names no provider (HTTP 5xx)", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("OpenRouter HTTP 503: upstream overloaded"))
      .mockResolvedValueOnce(okResult)

    await runSpecialist({ role: "tests", apiKeys: BOTH_KEYS, modelOverride: override, ...baseArgs })

    expect(mockChat).toHaveBeenCalledTimes(2)
    const call2 = mockChat.mock.calls[1]![0] as { provider?: unknown }
    expect(call2.provider).toBeUndefined()
  })
})
