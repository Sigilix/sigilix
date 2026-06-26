// SIG-455 (PR B Task 5) — SET-ON-429 seam: verify that runWithRetryAndFallback
// captures the max providerRateLimitMs seen across primary + fallback attempts
// and surfaces it on every return path.
//
// Mirrors the mock harness in model-provider-retry-exclude.test.ts:
// vi.mock("@/src/shared/adapters/model") + runSpecialist.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderRateLimitError } from "@/src/shared/adapters/model/provider-errors"

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
// Use tests role (retries:1, fallback:null) for predictable retry count.
const override: ModelConfig = { primary: "deepseek/deepseek-v4-pro", retries: 1, fallback: null }

describe("runWithRetryAndFallback — providerRateLimitMs capture (SIG-455 Task 5)", () => {
  beforeEach(() => mockChat.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it("primary throws ProviderRateLimitError(7000) then succeeds → providerRateLimitMs === 7000", async () => {
    mockChat
      .mockRejectedValueOnce(new ProviderRateLimitError("OpenRouter HTTP 429: x", 7000))
      .mockResolvedValueOnce(okResult)

    const res = await runSpecialist({ role: "tests", apiKeys: BOTH_KEYS, modelOverride: override, ...baseArgs })

    expect(res.verdict).not.toBeNull()
    expect(res.providerRateLimitMs).toBe(7000)
  })

  it("all attempts exhaust on 429 → providerRateLimitMs set to the max seen", async () => {
    // retries:1 → 2 total attempts; first at 7000ms, second at 9000ms → max is 9000
    mockChat
      .mockRejectedValueOnce(new ProviderRateLimitError("OpenRouter HTTP 429: x", 7000))
      .mockRejectedValueOnce(new ProviderRateLimitError("OpenRouter HTTP 429: y", 9000))

    const res = await runSpecialist({ role: "tests", apiKeys: BOTH_KEYS, modelOverride: override, ...baseArgs })

    expect(res.verdict).toBeNull()
    expect(res.providerRateLimitMs).toBe(9000)
  })

  it("non-429 failure (HTTP 503) → providerRateLimitMs is undefined", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("OpenRouter HTTP 503: upstream overloaded"))
      .mockResolvedValueOnce(okResult)

    const res = await runSpecialist({ role: "tests", apiKeys: BOTH_KEYS, modelOverride: override, ...baseArgs })

    // Whether it recovered on retry or not, the important check is no rate-limit signal.
    expect(res.providerRateLimitMs).toBeUndefined()
  })

  it("first attempt succeeds with no 429 → providerRateLimitMs is undefined", async () => {
    mockChat.mockResolvedValueOnce(okResult)

    const res = await runSpecialist({ role: "tests", apiKeys: BOTH_KEYS, modelOverride: override, ...baseArgs })

    expect(res.verdict).not.toBeNull()
    expect(res.providerRateLimitMs).toBeUndefined()
  })
})
